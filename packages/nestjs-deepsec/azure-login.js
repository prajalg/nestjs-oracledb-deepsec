'use strict';
const { randomBytes } = require('node:crypto');
const { promisify } = require('node:util');
const { errorDetails } = require('./error-details');
const {
  Controller, Get, Post, Req, Res, Inject, Header,
  ForbiddenException, HttpException, ServiceUnavailableException, NotFoundException,
} = require('@nestjs/common');
const { DeepSecPublic } = require('./tokens');
const COOKIE = 'deepsec_session';
const PENDING_MS = 10 * 60 * 1000;
const invoke = (object, method) => promisify(object[method]).call(object);

// MSAL owns device authentication; express-session owns session IDs/cookies/store.
// Only in-flight MSAL jobs live outside the session store (they are not serializable).
class AzureLoginService {
  constructor(options, clientFactory) {
    this.options = options;
    this.clientFactory = clientFactory || (() => {
      const { PublicClientApplication } = require('@azure/msal-node');
      return new PublicClientApplication({
        auth: { clientId: options.clientId, authority: options.authority },
        system: {
          ...(options.networkClient && { networkClient: options.networkClient }),
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
    const session = require('express-session');
    const MemoryStore = require('memorystore')(session);
    const { LRUCache } = require('lru-cache');
    this.ownsStore = !options.sessionStore;
    this.store = options.sessionStore || new MemoryStore({ checkPeriod: 30000, max: 100 });
    this.pending = new LRUCache({ max: 100, ttl: PENDING_MS, ttlAutopurge: true, noDisposeOnSet: true,
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

  cookieOptions(maxAge) {
    return { httpOnly: true, sameSite: 'strict', secure: this.options?.secureCookie ?? true,
      path: '/', ...(maxAge !== undefined && { maxAge }) };
  }

  assertSameOrigin(request) {
    const origin = request.headers.origin;
    if (request.headers['sec-fetch-site'] === 'cross-site' ||
        (origin && origin !== `${request.protocol}://${request.headers.host}`)) {
      throw new ForbiddenException('Same-origin request required');
    }
  }

  async start(request) {
    if (!this.options) throw new NotFoundException();
    this.assertSameOrigin(request);
    this.pending.delete(request.sessionID);
    if (this.pending.size >= 100) throw new HttpException('Too many sign-in sessions', 429);
    await invoke(request.session, 'regenerate');
    request.session.pendingLogin = true;
    await invoke(request.session, 'save');
    const id = request.sessionID;
    const entry = { state: 'pending' };
    this.pending.set(id, entry);
    let ready, failed;
    const deviceCode = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    const timeout = setTimeout(() => failed(new Error('Sign-in startup timed out')), 20000);
    entry.request = {
      scopes: [...this.options.scopes],
      deviceCodeCallback: data => {
        if (this.pending.get(id) !== entry) return;
        try {
          const uri = new URL(data.verificationUri);
          if (uri.protocol !== 'https:') throw new Error('Invalid verification URI');
          entry.deviceCode = { verificationUri: uri.href, userCode: data.userCode,
            expiresIn: Math.min(data.expiresIn, PENDING_MS / 1000) };
          this.pending.set(id, entry, { ttl: Math.min(data.expiresIn * 1000, PENDING_MS) });
          ready(entry.deviceCode);
        } catch (error) { failed(error); }
      },
    };
    void (async () => {
      try {
        const result = await this.clientFactory().acquireTokenByDeviceCode(entry.request);
        const expiresAt = Math.min(result?.expiresOn?.getTime() - 30000, Date.now() + 3600000);
        if (!result?.accessToken || !(expiresAt > Date.now())) throw new Error('No valid user token');
        if (this.pending.get(id) !== entry) return;
        entry.identity = { token: result.accessToken, username: result.account?.username, expiresAt };
        entry.state = 'authenticated';
        delete entry.deviceCode;
      } catch (error) {
        if (this.pending.get(id) === entry) {
          entry.state = 'failed';
          entry.error = errorDetails(error, 'Azure sign-in failed');
        }
        failed(error);
      } finally { delete entry.request; }
    })();
    try { return await deviceCode; }
    catch (error) {
      this.pending.delete(id);
      await invoke(request.session, 'destroy');
      throw new ServiceUnavailableException(errorDetails(error, 'Could not start Azure sign-in'));
    } finally { clearTimeout(timeout); }
  }

  identityForRequest(request) {
    if (!this.options?.passportSession) return request.session?.identity;
    const user = request.user;
    return user && { token: user.accessToken, expiresAt: user.expiresAt, username: user.username };
  }

  async status(request) {
    const pendingId = request.sessionID;
    const entry = this.pending?.get(pendingId);
    if (entry?.identity && entry.identity.expiresAt > Date.now()) {
      const identity = entry.identity;
      if (this.options.passportSession) {
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
      this.pending.delete(pendingId);
    }
    const identity = this.identityForRequest(request);
    if (identity?.expiresAt > Date.now()) {
      return { enabled: true, state: 'authenticated', username: identity.username };
    }
    return { enabled: Boolean(this.options), state: entry?.state === 'authenticated' ? 'signedOut' :
      entry?.state || 'signedOut', ...(entry?.state === 'failed' && { error: entry.error }), ...(entry?.state === 'pending' && { deviceCode: entry.deviceCode }) };
  }

  tokenForRequest(request) {
    const identity = this.identityForRequest(request);
    return identity?.expiresAt > Date.now() ? identity.token : undefined;
  }

  async logout(request, response) {
    if (!this.options) throw new NotFoundException();
    this.assertSameOrigin(request);
    this.pending.delete(request.sessionID);
    if (this.options.passportSession) await promisify(request.logOut).call(request);
    await invoke(request.session, 'destroy');
    response.clearCookie(COOKIE, this.cookieOptions());
    return { state: 'signedOut' };
  }

  async onApplicationShutdown() {
    this.pending?.clear();
    if (this.ownsStore) {
      this.store.stopInterval?.();
      await invoke(this.store, 'clear');
    }
  }
}

class AzureLoginController {
  constructor(login) { this.login = login; }
  start(request, response) { return this.login.start(request, response); }
  status(request, response) { return this.login.status(request, response); }
  logout(request, response) { return this.login.logout(request, response); }
}
Controller('deepsec/auth')(AzureLoginController);
DeepSecPublic()(AzureLoginController);
Inject(AzureLoginService)(AzureLoginController, undefined, 0);
for (const [name, method] of [['start', Post], ['status', Get], ['logout', Post]]) {
  const descriptor = Object.getOwnPropertyDescriptor(AzureLoginController.prototype, name);
  method(name)(AzureLoginController.prototype, name, descriptor);
  Header('Cache-Control', 'no-store')(AzureLoginController.prototype, name, descriptor);
  Req()(AzureLoginController.prototype, name, 0);
  Res({ passthrough: true })(AzureLoginController.prototype, name, 1);
}
module.exports = { AzureLoginService, AzureLoginController };
