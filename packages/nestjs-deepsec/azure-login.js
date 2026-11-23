'use strict';
const { randomBytes } = require('node:crypto');
const {
  Controller, Get, Post, Req, Res, Inject, Header,
  ForbiddenException, HttpException, ServiceUnavailableException, NotFoundException,
} = require('@nestjs/common');
const { DeepSecPublic } = require('./tokens');
const COOKIE = 'deepsec_session';
const PENDING_MS = 10 * 60 * 1000;

// Optional user-token acquisition. Database-token exchange remains in the driver.
class AzureLoginService {
  constructor(options, clientFactory) {
    this.options = options;
    this.sessions = new Map();
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
    if (options) {
      if (!options.clientId?.trim() || !options.authority?.trim() ||
          !Array.isArray(options.scopes) || !options.scopes.length ||
          !options.scopes.every(scope => typeof scope === 'string' && scope.trim())) {
        throw new TypeError('azureLogin requires clientId, authority and nonempty scopes');
      }
      this.timer = setInterval(() => this.sweep(), 30000);
      this.timer.unref();
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

  sessionId(request) {
    const match = /(?:^|;\s*)deepsec_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '');
    return match?.[1];
  }

  forget(id) {
    const entry = this.sessions.get(id);
    if (entry?.request) entry.request.cancel = true;
    this.sessions.delete(id);
  }

  sweep() {
    for (const [id, entry] of this.sessions) {
      if (entry.expiresAt <= Date.now()) this.forget(id);
    }
  }

  async start(request, response) {
    if (!this.options) throw new NotFoundException();
    this.assertSameOrigin(request);
    this.sweep();
    this.forget(this.sessionId(request));
    if (this.sessions.size >= 100) throw new HttpException('Too many sign-in sessions', 429);
    const id = randomBytes(32).toString('hex');
    const entry = { state: 'pending', expiresAt: Date.now() + PENDING_MS };
    this.sessions.set(id, entry);
    let ready, failed;
    const deviceCode = new Promise((resolve, reject) => { ready = resolve; failed = reject; });
    const timeout = setTimeout(() => failed(new Error('Sign-in startup timed out')), 20000);
    entry.request = {
      scopes: [...this.options.scopes],
      deviceCodeCallback: data => {
        try {
          const verificationUri = new URL(data.verificationUri);
          if (verificationUri.protocol !== 'https:') throw new Error('Invalid verification URI');
          entry.expiresAt = Math.min(entry.expiresAt, Date.now() + data.expiresIn * 1000);
          entry.deviceCode = { verificationUri: verificationUri.href, userCode: data.userCode,
            expiresIn: Math.min(data.expiresIn, PENDING_MS / 1000) };
          ready(entry.deviceCode);
        } catch (error) { failed(error); }
      },
    };
    // Each flow has its own MSAL client; its cache is not retained after completion.
    void (async () => {
      try {
        const result = await this.clientFactory().acquireTokenByDeviceCode(entry.request);
        const expiresAt = result?.expiresOn?.getTime() - 30000;
        if (!result?.accessToken || !(expiresAt > Date.now())) throw new Error('No valid user token');
        if (this.sessions.get(id) !== entry) return;
        entry.token = result.accessToken;
        entry.username = result.account?.username;
        entry.expiresAt = Math.min(expiresAt, Date.now() + 60 * 60 * 1000);
        entry.state = 'authenticated';
        delete entry.deviceCode;
      } catch {
        if (this.sessions.get(id) === entry) entry.state = 'failed';
        failed(new Error('Azure sign-in failed'));
      } finally {
        delete entry.request;
      }
    })();
    try {
      const code = await deviceCode;
      response.cookie(COOKIE, id, this.cookieOptions(PENDING_MS));
      return code;
    } catch {
      this.forget(id);
      throw new ServiceUnavailableException('Could not start Azure sign-in. Try again.');
    } finally {
      clearTimeout(timeout);
    }
  }

  status(request, response) {
    this.sweep();
    const entry = this.sessions.get(this.sessionId(request));
    if (entry?.state === 'authenticated') {
      response.cookie(COOKIE, this.sessionId(request), this.cookieOptions(entry.expiresAt - Date.now()));
      return { enabled: true, state: 'authenticated', username: entry.username };
    }
    return { enabled: Boolean(this.options), state: entry?.state || 'signedOut',
      ...(entry?.state === 'pending' && { deviceCode: entry.deviceCode }) };
  }

  tokenForRequest(request) {
    this.sweep();
    const entry = this.sessions.get(this.sessionId(request));
    return entry?.state === 'authenticated' ? entry.token : undefined;
  }

  logout(request, response) {
    if (!this.options) throw new NotFoundException();
    this.assertSameOrigin(request);
    this.forget(this.sessionId(request));
    response.clearCookie(COOKIE, this.cookieOptions());
    return { state: 'signedOut' };
  }

  onApplicationShutdown() {
    clearInterval(this.timer);
    for (const id of this.sessions.keys()) this.forget(id);
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
