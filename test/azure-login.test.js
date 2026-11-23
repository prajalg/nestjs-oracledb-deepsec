const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const oracledb = require('oracledb');
const { DeepSecModule, DEEPSEC_POOL } = require('nestjs-oracledb-deepsec');
const { AzureLoginService } = require('nestjs-oracledb-deepsec/azure-login');
const { AppController } = require('../dist/app.controller');
const { DatabaseService } = require('../dist/database.service');

const loginOptions = {
  clientId: 'test-public-client', authority: 'https://login.microsoftonline.com/test',
  scopes: ['test-middle-tier/read'], secureCookie: false,
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

async function createApp(login) {
  const observed = [];
  const pool = {
    async getConnection() {
      return {
        async execute() {
          observed.push(oracledb.getSecurityContextProvider().getCurrentContext()?.endUserToken);
          return { metaData: [{ name: 'DB_USER' }], rows: [{ DB_USER: 'XS$NULL' }] };
        },
        async close() {}, oracleServerVersionString: 'test',
      };
    },
    async close() {},
  };
  const bridge = DeepSecModule.forRoot({
    azureLogin: loginOptions,
    poolOptions: { endUserSecParams: { spiType: 'azure', authFlow: 'onBehalfOf' } },
  });
  bridge.providers = bridge.providers.map(provider => {
    if (provider.provide === DEEPSEC_POOL) return { provide: DEEPSEC_POOL, useValue: pool };
    if (provider.provide === AzureLoginService) return { provide: AzureLoginService, useValue: login };
    return provider;
  });
  class TestModule {}
  Module({ imports: [bridge], controllers: [AppController], providers: [DatabaseService] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  return { app, base: await app.getUrl(), observed };
}

test('plugin login keeps tokens server-side and supplies isolated cookie identities to unchanged SQL', async () => {
  const { service, pending } = fakeAzure();
  const { app, base, observed } = await createApp(service);
  try {
    const cookies = [];
    for (let index = 0; index < 2; index++) {
      const start = await fetch(`${base}/deepsec/auth/start`, { method: 'POST' });
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
      const pendingStatus = await fetch(`${base}/deepsec/auth/status`, {
        headers: { Cookie: cookies[index] },
      });
      const pendingBody = await pendingStatus.json();
      assert.equal(pendingBody.state, 'pending');
      assert.equal(pendingBody.deviceCode.userCode, 'TEST-CODE');
      assert.equal(pendingBody.accessToken, undefined);
    }
    assert.notEqual(cookies[0], cookies[1]);
    // Complete in reverse order to catch accidentally shared login state.
    pending[1].resolve(result('server-only-token-b', 'user-b'));
    pending[0].resolve(result('server-only-token-a', 'user-a'));
    await flush();
    for (const [index, cookie] of cookies.entries()) {
      const status = await fetch(`${base}/deepsec/auth/status`, { headers: { Cookie: cookie } });
      assert.deepEqual(await status.json(), {
        enabled: true, state: 'authenticated', username: index ? 'user-b' : 'user-a',
      });
      assert.ok(!status.headers.get('set-cookie').includes('server-only-token'));
      const query = await fetch(`${base}/api/query`, { headers: { Cookie: cookie } });
      assert.equal(query.status, 200);
      assert.ok(!(await query.text()).includes('server-only-token'));
    }
    assert.deepEqual(observed, ['server-only-token-a', 'server-only-token-b']);
    const invalidHeader = await fetch(`${base}/api/query`, {
      headers: { Cookie: cookies[0], Authorization: 'Basic invalid' },
    });
    assert.equal(invalidHeader.status, 401);
    const logout = await fetch(`${base}/deepsec/auth/logout`, {
      method: 'POST', headers: { Cookie: cookies[0] },
    });
    assert.equal(logout.status, 201);
    assert.equal((await fetch(`${base}/api/query`, { headers: { Cookie: cookies[0] } })).status, 401);
    service.sessions.get(cookies[1].split('=')[1]).expiresAt = Date.now() - 1;
    assert.equal((await fetch(`${base}/api/query`, { headers: { Cookie: cookies[1] } })).status, 401);
    assert.equal(observed.length, 2);
  } finally { await app.close(); }
  assert.equal(service.sessions.size, 0);
});

test('login rejects cross-origin requests and cancellation cannot resurrect a logged-out session', async () => {
  const { service, pending } = fakeAzure();
  const { app, base } = await createApp(service);
  try {
    const blocked = await fetch(`${base}/deepsec/auth/start`, {
      method: 'POST', headers: { Origin: 'https://other.example', 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(blocked.status, 403);
    assert.equal(pending.length, 0);
    const start = await fetch(`${base}/deepsec/auth/start`, { method: 'POST' });
    const cookie = start.headers.get('set-cookie').split(';')[0];
    const blockedLogout = await fetch(`${base}/deepsec/auth/logout`, {
      method: 'POST', headers: { Cookie: cookie, Origin: 'https://other.example' },
    });
    assert.equal(blockedLogout.status, 403);
    await fetch(`${base}/deepsec/auth/logout`, { method: 'POST', headers: { Cookie: cookie } });
    assert.equal(pending[0].request.cancel, true);
    pending[0].resolve(result('must-not-be-restored'));
    await flush();
    assert.equal((await fetch(`${base}/api/query`, { headers: { Cookie: cookie } })).status, 401);
    assert.equal(service.sessions.size, 0);
  } finally { await app.close(); }
});

test('failed sign-in is reported without returning provider errors or tokens', async () => {
  const { service, pending } = fakeAzure();
  const { app, base } = await createApp(service);
  try {
    const start = await fetch(`${base}/deepsec/auth/start`, { method: 'POST' });
    const cookie = start.headers.get('set-cookie').split(';')[0];
    pending[0].reject(new Error('sensitive provider details'));
    await flush();
    const status = await fetch(`${base}/deepsec/auth/status`, { headers: { Cookie: cookie } });
    assert.deepEqual(await status.json(), { enabled: true, state: 'failed' });
    assert.equal((await fetch(`${base}/api/query`, { headers: { Cookie: cookie } })).status, 401);
  } finally { await app.close(); }
});

test('secure cookies are the default; invalid login configuration is rejected', () => {
  const service = new AzureLoginService({ ...loginOptions, secureCookie: undefined });
  try { assert.equal(service.cookieOptions().secure, true); }
  finally { service.onApplicationShutdown(); }
  assert.throws(() => new AzureLoginService({ clientId: 'x', authority: 'x', scopes: [] }), /azureLogin/);
});
