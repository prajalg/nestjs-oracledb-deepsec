import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { Controller, Get, Post, Req, Res, Header, ForbiddenException, HttpException,
  ServiceUnavailableException, NotFoundException, type OnApplicationShutdown } from '@nestjs/common';
import type { Request, Response, CookieOptions, RequestHandler } from 'express';
import type { Store } from 'express-session';
import type { LRUCache } from 'lru-cache';
import { errorDetails, type ErrorDetails } from '../shared/error-details';
import { DeepSecPublic } from 'nestjs-oracledb-deepsec';

// Demo-owned Azure authentication. Existing applications keep their own auth
// library and expose identity through DeepSecModule.mapIdentity instead.
export interface AzureLoginOptions {
  clientId: string;
  authority: string;
  scopes: string[];
  networkClient?: unknown;
  /** Optional persistent session signing secret. Default is random per process. */
  sessionSecret?: string;
  /** Optional Passport session restoration; the app supplies its serializer. */
  passportSession?: boolean;
  /** An express-session compatible server-side store. Local default is bounded memory. */
  sessionStore?: unknown;
  /** Defaults to true. Set false only for local HTTP development. */
  secureCookie?: boolean;
}

interface SessionIdentity { token: string; expiresAt: number; username?: string }
interface LoginUser { accessToken: string; expiresAt: number; username?: string }
export type LoginRequest = Request & { user?: LoginUser };
declare module 'express-session' {
  interface SessionData { identity?: SessionIdentity; pendingLogin?: boolean }
}
interface DeviceCode { verificationUri: string; userCode: string; expiresIn: number }
interface PendingLogin {
  state: 'pending' | 'authenticated' | 'failed';
  request?: DeviceCodeRequest;
  deviceCode?: DeviceCode;
  identity?: SessionIdentity;
  error?: ErrorDetails;
}
interface DeviceCodeRequest {
  scopes: string[];
  cancel?: boolean;
  deviceCodeCallback: (response: DeviceCode) => void;
}
interface LoginResult { accessToken: string; expiresOn: Date | null; account?: { username: string } | null }
type ClientFactory = () => {
  acquireTokenByDeviceCode(request: DeviceCodeRequest): Promise<LoginResult | null>;
};

const COOKIE = 'deepsec_session';
const PENDING_MS = 10 * 60 * 1000;
// express-session and its stores expose callback methods.
const invoke = (object: object, method: string): Promise<void> =>
  promisify((object as Record<string, (callback: (error?: Error) => void) => void>)[method])
    .call(object) as Promise<void>;

// MSAL owns device authentication; express-session owns session IDs/cookies/store.
// Only in-flight MSAL jobs live outside the session store (they are not serializable).
export class AzureLoginService implements OnApplicationShutdown {
  private readonly clientFactory: ClientFactory;
  private ownsStore = false;
  private store?: Store & { stopInterval?: () => void };
  private pending?: LRUCache<string, PendingLogin>;
  readonly middleware?: RequestHandler;
  readonly middlewares: RequestHandler[] = [];

  constructor(private readonly options?: AzureLoginOptions, clientFactory?: ClientFactory) {
    this.clientFactory = clientFactory || (() => {
      const { PublicClientApplication } = require('@azure/msal-node') as typeof import('@azure/msal-node');
      if (!options) throw new NotFoundException();
      return new PublicClientApplication({
        auth: { clientId: options.clientId, authority: options.authority },
        system: {
          ...(options.networkClient ? { networkClient: options.networkClient as import('@azure/msal-node').INetworkModule } : {}),
          loggerOptions: { piiLoggingEnabled: false, loggerCallback: () => {} },
        },
      });
    });
    if (!options) return;
    if (!options.clientId?.trim() || !options.authority?.trim() ||
        !Array.isArray(options.scopes) || !options.scopes.length ||
        !options.scopes.every(scope => typeof scope === 'string' && scope.trim())) {
      throw new TypeError('azureLogin requires clientId, authority and nonempty scopes');
    }
    const session = require('express-session') as typeof import('express-session');
    const MemoryStore = require('memorystore')(session);
    const { LRUCache } = require('lru-cache') as typeof import('lru-cache');
    this.ownsStore = !options.sessionStore;
    this.store = (options.sessionStore as Store | undefined) || new MemoryStore({ checkPeriod: 30000, max: 100 });
    this.pending = new LRUCache<string, PendingLogin>({ max: 100, ttl: PENDING_MS, ttlAutopurge: true, noDisposeOnSet: true,
      dispose: entry => { if (entry.request) entry.request.cancel = true; } });
    this.middleware = session({
      name: COOKIE,
      secret: options.sessionSecret || randomBytes(32).toString('base64url'),
      store: this.store, resave: false, saveUninitialized: false,
      cookie: this.cookieOptions(PENDING_MS),
    });
    this.middlewares = [this.middleware];
    if (options.passportSession) {
      const passport = require('passport');
      this.middlewares.push(passport.initialize(), passport.session());
    }
  }

  cookieOptions(maxAge?: number): CookieOptions {
    return { httpOnly: true, sameSite: 'strict', secure: this.options?.secureCookie ?? true,
      path: '/', ...(maxAge !== undefined && { maxAge }) };
  }

  assertSameOrigin(request: Request) {
    const origin = request.headers.origin;
    if (request.headers['sec-fetch-site'] === 'cross-site' ||
        (origin && origin !== `${request.protocol}://${request.headers.host}`)) {
      throw new ForbiddenException('Same-origin request required');
    }
  }

  async start(request: LoginRequest) {
    if (!this.options) throw new NotFoundException();
    this.assertSameOrigin(request);
    this.pending!.delete(request.sessionID);
    if (this.pending!.size >= 100) throw new HttpException('Too many sign-in sessions', 429);
    await invoke(request.session, 'regenerate');
    request.session.pendingLogin = true;
    await invoke(request.session, 'save');
    const id = request.sessionID;
    const entry: PendingLogin = { state: 'pending' };
    this.pending!.set(id, entry);
    let ready!: (code: DeviceCode) => void;
    let failed!: (error: unknown) => void;
    const deviceCode = new Promise<DeviceCode>((resolve, reject) => { ready = resolve; failed = reject; });
    const timeout = setTimeout(() => failed(new Error('Sign-in startup timed out')), 20000);
    entry.request = {
      scopes: [...this.options.scopes],
      deviceCodeCallback: data => {
        if (this.pending!.get(id) !== entry) return;
        try {
          const uri = new URL(data.verificationUri);
          if (uri.protocol !== 'https:') throw new Error('Invalid verification URI');
          entry.deviceCode = { verificationUri: uri.href, userCode: data.userCode,
            expiresIn: Math.min(data.expiresIn, PENDING_MS / 1000) };
          this.pending!.set(id, entry, { ttl: Math.min(data.expiresIn * 1000, PENDING_MS) });
          ready(entry.deviceCode);
        } catch (error) { failed(error); }
      },
    };
    void (async () => {
      try {
        const result = await this.clientFactory().acquireTokenByDeviceCode(entry.request!);
        const expiresAt = Math.min((result?.expiresOn?.getTime() ?? 0) - 30000, Date.now() + 3600000);
        if (!result?.accessToken || !(expiresAt > Date.now())) throw new Error('No valid user token');
        if (this.pending!.get(id) !== entry) return;
        entry.identity = { token: result.accessToken, username: result.account?.username, expiresAt };
        entry.state = 'authenticated';
        delete entry.deviceCode;
      } catch (error) {
        if (this.pending!.get(id) === entry) {
          entry.state = 'failed';
          entry.error = errorDetails(error, 'Azure sign-in failed');
        }
        failed(error);
      } finally { delete entry.request; }
    })();
    try { return await deviceCode; }
    catch (error) {
      this.pending!.delete(id);
      await invoke(request.session, 'destroy');
      throw new ServiceUnavailableException(errorDetails(error, 'Could not start Azure sign-in'));
    } finally { clearTimeout(timeout); }
  }

  identityForRequest(request: LoginRequest): SessionIdentity | undefined {
    if (!this.options?.passportSession) return request.session?.identity;
    const user = request.user;
    return user && { token: user.accessToken, expiresAt: user.expiresAt, username: user.username };
  }

  async status(request: LoginRequest) {
    const pendingId = request.sessionID;
    const entry = this.pending?.get(pendingId);
    if (entry?.identity && entry.identity.expiresAt > Date.now()) {
      const identity = entry.identity;
      if (this.options?.passportSession) {
        // Passport regenerates the session ID and serializes only server-side data.
        await promisify(request.logIn).call(request, {
          accessToken: identity.token, expiresAt: identity.expiresAt, username: identity.username,
        });
      } else {
        request.session.identity = identity;
        delete request.session.pendingLogin;
      }
      request.session.cookie.maxAge = identity.expiresAt - Date.now();
      await invoke(request.session, 'save');
      this.pending!.delete(pendingId);
    }
    const identity = this.identityForRequest(request);
    if (identity && identity.expiresAt > Date.now()) {
      return { enabled: true, state: 'authenticated', username: identity.username };
    }
    return { enabled: Boolean(this.options), state: entry?.state === 'authenticated' ? 'signedOut' :
      entry?.state || 'signedOut', ...(entry?.state === 'failed' && { error: entry.error }), ...(entry?.state === 'pending' && { deviceCode: entry.deviceCode }) };
  }

  tokenForRequest(request: LoginRequest) {
    const identity = this.identityForRequest(request);
    return identity && identity.expiresAt > Date.now() ? identity.token : undefined;
  }

  async logout(request: LoginRequest, response: Response) {
    if (!this.options) throw new NotFoundException();
    this.assertSameOrigin(request);
    this.pending!.delete(request.sessionID);
    if (this.options?.passportSession) await promisify(request.logOut).call(request);
    await invoke(request.session, 'destroy');
    response.clearCookie(COOKIE, this.cookieOptions());
    return { state: 'signedOut' };
  }

  async onApplicationShutdown() {
    this.pending?.clear();
    if (this.ownsStore) {
      this.store?.stopInterval?.();
      await invoke(this.store!, 'clear');
    }
  }
}

@Controller('deepsec/auth')
@DeepSecPublic()
export class AzureLoginController {
  constructor(private readonly login: AzureLoginService) {}

  @Post('start')
  @Header('Cache-Control', 'no-store')
  start(@Req() request: LoginRequest) { return this.login.start(request); }

  @Get('status')
  @Header('Cache-Control', 'no-store')
  status(@Req() request: LoginRequest) { return this.login.status(request); }

  @Post('logout')
  @Header('Cache-Control', 'no-store')
  logout(@Req() request: LoginRequest, @Res({ passthrough: true }) response: Response) {
    return this.login.logout(request, response);
  }
}
