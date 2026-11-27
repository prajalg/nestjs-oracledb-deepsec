const { test } = require('node:test');
const assert = require('node:assert/strict');
const { promisify } = require('node:util');
const { Module } = require('@nestjs/common');
const { ClsModule, ClsService } = require('nestjs-cls');
const { setTimeout: delay } = require('node:timers/promises');
const { NestFactory } = require('@nestjs/core');
const { DeepSecConfiguration } = require('../dist/deepsec/deepsec');
const { AzureLoginService } = require('../dist/auth/azure-login');
const { AzureAuthModule } = require('../dist/auth/azure-auth.module');
const { HealthController } = require('../dist/health.controller');
const { ORACLE_POOL } = require('../dist/database/oracle-pool');
const { EmployeesController } = require('../dist/employees/employees.controller');
const { EmployeesService } = require('../dist/employees/employees.service');
const { AzureSessionGuard } = require('../dist/auth/azure-session.guard');

const loginOptions = {
  clientId: 'test-public-client', authority: 'https://login.microsoftonline.com/test',
  scopes: ['test-middle-tier/read'], secureCookie: false, passportSession: true,
};
function fakeAzure() {
  const pending = [];
  const service = new AzureLoginService(loginOptions, () => ({
    acquireTokenByDeviceCode(request) {
      return new Promise((resolve, reject) => {
        pending.push({ resolve, reject, request });
        request.deviceCodeCallback({
          verificationUri: 'https://login.microsoftonline.com/device',
          userCode: 'TEST-CODE', expiresIn: 600,
        });
      });
    },
  }));
  return { service, pending };
}
function result(token, username = 'test-user') {
  return { accessToken: token, expiresOn: new Date(Date.now() + 3600000), account: { username } };
}
async function flush() { await new Promise(resolve => setImmediate(resolve)); }

async function createApp(login, azureLogin = loginOptions, connectionError) {
  const observed = [];
  let cls;
  const pool = {
    async getConnection() {
      if (connectionError) throw connectionError;
      return {
        async execute() {
          const user = cls.get('user');
          await delay(user.accessToken.endsWith('-a') ? 15 : 1);
          assert.equal(cls.get('user'), user, 'CLS identity survives asynchronous execution');
          observed.push(user.accessToken);
          return { metaData: [{ name: 'DB_USER' }], rows: [{ DB_USER: 'XS$NULL' }] };
        },
        async close() {}, oracleServerVersionString: 'test',
      };
    },
    async close() {},
  };
  const auth = azureLogin ? AzureAuthModule.forRoot(azureLogin) : null;
  if (auth) auth.providers = auth.providers.map(provider =>
    provider.provide === AzureLoginService ? { provide: AzureLoginService, useValue: login } : provider);
  class TestModule {}
  Module({ imports: [...(auth ? [auth] : []), ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    DeepSecConfiguration.forRootAsync({ inject: [ClsService], useFactory: cls => ({
      mapIdentity: () => {
        const user = cls.get('user');
        return user ? { endUserToken: user.accessToken } : null;
      },
    }) })],
    controllers: [EmployeesController, HealthController], providers: [EmployeesService, { provide: ORACLE_POOL, useValue: pool }, AzureSessionGuard] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false, abortOnError: false });
  await app.listen(0, '127.0.0.1');
  cls = app.get(ClsService);
  return { app, base: await app.getUrl(), observed, cls };
}

test('standard Passport session restoration bridges concurrent authenticated users into isolated CLS contexts', async () => {
  const { service, pending } = fakeAzure();
  const { app, base, observed, cls } = await createApp(service);
  try {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    for (const headers of [{}, { Cookie: 'oracle_session=' + '0'.repeat(64) },
      { Authorization: 'Bearer unvalidated-token' }]) {
      assert.equal((await fetch(`${base}/api/query`, { headers })).status, 401);
    }
    assert.equal(observed.length, 0);
    const cookies = [];
    for (let index = 0; index < 2; index++) {
      const start = await fetch(`${base}/auth/start`, { method: 'POST' });
      assert.equal(start.status, 201);
      assert.equal(start.headers.get('cache-control'), 'no-store');
      const cookie = start.headers.get('set-cookie');
      assert.match(cookie, /HttpOnly/);
      assert.match(cookie, /SameSite=Strict/);
      assert.match(cookie, /Path=\//);
      assert.deepEqual(await start.json(), {
        verificationUri: 'https://login.microsoftonline.com/device', userCode: 'TEST-CODE', expiresIn: 600,
      });
      cookies.push(cookie.split(';')[0]);
      const pendingStatus = await fetch(`${base}/auth/status`, {
        headers: { Cookie: cookies[index] },
      });
      const pendingBody = await pendingStatus.json();
      assert.equal(pendingBody.state, 'pending');
      assert.equal(pendingBody.deviceCode.userCode, 'TEST-CODE');
      assert.equal(pendingBody.accessToken, undefined);
      assert.equal((await fetch(`${base}/api/query`, {
        headers: { Cookie: cookies[index] },
      })).status, 401, 'pending sessions must not reach the handler');
    }
    assert.notEqual(cookies[0], cookies[1]);
    // Complete in reverse order to catch accidentally shared login state.
    pending[1].resolve(result('server-only-token-b', 'user-b'));
    pending[0].resolve(result('server-only-token-a', 'user-a'));
    await flush();
    for (const [index, cookie] of cookies.entries()) {
      const status = await fetch(`${base}/auth/status`, { headers: { Cookie: cookie } });
      assert.deepEqual(await status.json(), {
        enabled: true, state: 'authenticated', username: index ? 'user-b' : 'user-a',
      });
      const authenticatedCookie = status.headers.get('set-cookie');
      assert.ok(!authenticatedCookie.includes('server-only-token'));
      const previousCookie = cookies[index];
      cookies[index] = authenticatedCookie.split(';')[0];
      assert.notEqual(cookies[index], previousCookie, 'Passport regenerates the ID after login');
      assert.equal((await fetch(`${base}/api/query`, { headers: { Cookie: previousCookie } })).status, 401);
    }
    // Both users execute concurrently, within separate CLS contexts.
    await Promise.all(cookies.map(async cookie => {
      const query = await fetch(`${base}/api/query`, { headers: { Cookie: cookie } });
      assert.equal(query.status, 200);
      assert.ok(!(await query.text()).includes('server-only-token'));
    }));
    assert.deepEqual(observed.slice().sort(), ['server-only-token-a', 'server-only-token-b']);
    assert.equal(cls.get('user'), undefined, 'identity is absent outside the request scope');
    const invalidHeader = await fetch(`${base}/api/query`, {
      headers: { Cookie: cookies[0], Authorization: 'Basic invalid' },
    });
    assert.equal(invalidHeader.status, 401);
    const spoofedBearer = await fetch(`${base}/api/query`, {
      headers: { Cookie: cookies[0], Authorization: 'Bearer spoofed-token' },
    });
    assert.equal(spoofedBearer.status, 401, 'session auth must not trust raw bearer tokens');
    const tampered = cookies[0].slice(0, -1) + (cookies[0].endsWith('A') ? 'B' : 'A');
    assert.equal((await fetch(`${base}/api/query`, { headers: { Cookie: tampered } })).status, 401,
      'library must reject a tampered signed session cookie');
    const logout = await fetch(`${base}/auth/logout`, {
      method: 'POST', headers: { Cookie: cookies[0] },
    });
    assert.equal(logout.status, 201);
    assert.equal((await fetch(`${base}/api/query`, { headers: { Cookie: cookies[0] } })).status, 401);
    const sessions = await promisify(service.store.all).call(service.store);
    const [expiredId, expiredSession] = Object.entries(sessions)
      .find(([, session]) => session.passport?.user?.username === 'user-b');
    expiredSession.passport.user.expiresAt = Date.now() - 1;
    await promisify(service.store.set).call(service.store, expiredId, expiredSession);
    assert.equal((await fetch(`${base}/api/query`, { headers: { Cookie: cookies[1] } })).status, 401);
    assert.equal(observed.length, 2);
  } finally { await app.close(); }
  assert.equal(service.pending.size, 0);
});

test('login rejects cross-origin requests and cancellation cannot resurrect a logged-out session', async () => {
  const { service, pending } = fakeAzure();
  const { app, base } = await createApp(service);
  try {
    const blocked = await fetch(`${base}/auth/start`, {
      method: 'POST', headers: { Origin: 'https://other.example', 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(blocked.status, 403);
    assert.equal(pending.length, 0);
    const start = await fetch(`${base}/auth/start`, { method: 'POST' });
    const cookie = start.headers.get('set-cookie').split(';')[0];
    const blockedLogout = await fetch(`${base}/auth/logout`, {
      method: 'POST', headers: { Cookie: cookie, Origin: 'https://other.example' },
    });
    assert.equal(blockedLogout.status, 403);
    await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(pending[0].request.cancel, true);
    pending[0].resolve(result('must-not-be-restored'));
    await flush();
    assert.equal((await fetch(`${base}/api/query`, { headers: { Cookie: cookie } })).status, 401);
    assert.equal(service.pending.size, 0);
  } finally { await app.close(); }
});

test('failed sign-in reports the provider message without returning tokens', async () => {
  const { service, pending } = fakeAzure();
  const { app, base } = await createApp(service);
  try {
    const start = await fetch(`${base}/auth/start`, { method: 'POST' });
    const cookie = start.headers.get('set-cookie').split(';')[0];
    pending[0].reject(new Error('AADSTS65001: consent required; access_token=fixture-secret'));
    await flush();
    const status = await fetch(`${base}/auth/status`, { headers: { Cookie: cookie } });
    assert.deepEqual(await status.json(), { enabled: true, state: 'failed', error: { message: 'AADSTS65001: consent required; access_token=[REDACTED]' } });
    assert.equal((await fetch(`${base}/api/query`, { headers: { Cookie: cookie } })).status, 401);
  } finally { await app.close(); }
});

test('secure cookies are the default; invalid login configuration is rejected', async () => {
  const service = new AzureLoginService({ ...loginOptions, secureCookie: undefined });
  try { assert.equal(service.cookieOptions().secure, true); }
  finally { await service.onApplicationShutdown(); }
  assert.throws(() => new AzureLoginService({ clientId: 'x', authority: 'x', scopes: [] }), /azureLogin/);
});


test('application without login fails closed and exposes no usable login flow', async () => {
  const service = new AzureLoginService(undefined);
  const { app, base, observed } = await createApp(service, null);
  try {
    const status = await fetch(`${base}/auth/status`);
    assert.equal(status.status, 404);
    for (const action of ['start', 'logout']) {
      assert.equal((await fetch(`${base}/auth/${action}`, { method: 'POST' })).status, 404);
    }
    assert.equal((await fetch(`${base}/api/query`)).status, 401);
    assert.equal(observed.length, 0);
  } finally { await app.close(); }
});


test('immediate Azure startup failure returns its original diagnostic without credentials', async () => {
  const service = new AzureLoginService(loginOptions, () => ({
    async acquireTokenByDeviceCode() {
      throw Object.assign(new Error('AADSTS700016: Application was not found. client_secret=startup-fixture-secret'), { errorCode: 'unauthorized_client' });
    },
  }));
  const { app, base } = await createApp(service);
  try {
    const response = await fetch(`${base}/auth/start`, { method: 'POST' });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'unauthorized_client');
    assert.match(body.message, /AADSTS700016: Application was not found/);
    assert.ok(!JSON.stringify(body).includes('startup-fixture-secret'));
    assert.equal(service.pending.size, 0);
  } finally { await app.close(); }
});
