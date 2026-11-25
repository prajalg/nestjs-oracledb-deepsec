const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { NestFactory } = require('@nestjs/core');
const { PublicClientApplication } = require('@azure/msal-node');
const oracledb = require('oracledb');

test('Azure login stays app-side while pool and standalone receive only ordinary Oracle options', async t => {
  const values = {
    NODE_ORACLEDB_USER: 'fixture-user', NODE_ORACLEDB_PASSWORD: 'fixture-password',
    NODE_ORACLEDB_CONNECTIONSTRING: 'localhost:1521/fixture',
    AZURE_USER_CLIENT_ID: 'fixture-login-client',
    AZURE_USER_AUTHORITY: 'https://login.microsoftonline.com/fixture',
    AZURE_USER_SCOPES: 'fixture-user/read',

  };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  let poolCloses = 0, poolReleases = 0, standaloneCloses = 0;
  let app;
  const connection = source => ({
    async execute(sql) {
      await delay(1);
      if (source === 'pool') {
        assert.match(sql, /FROM hr.employees/);
        return { metaData: [{ name: 'EMPLOYEE_ID' }], rows: [{ EMPLOYEE_ID: 100 }] };
      }
      assert.match(sql, /FROM dual/);
      return { metaData: [{ name: 'DATABASE_TIME' }, { name: 'SESSION_USER' }],
        rows: [{ DATABASE_TIME: 'fixture-time', SESSION_USER: 'FIXTURE_USER' }] };
    },
    async close() { if (source === 'pool') poolReleases++; else standaloneCloses++; },
  });
  const pool = {
    async getConnection() { return connection('pool'); },
    async close(drain) { assert.equal(drain, 10); poolCloses++; },
  };
  const connectionKeys = ['user', 'password', 'connectString', 'walletLocation', 'walletPassword', 'connectTimeout'];
  const creates = t.mock.method(oracledb, 'createPool', async options => {
    assert.equal(options.user, values.NODE_ORACLEDB_USER);
    assert.deepEqual(Object.keys(options).sort(), [...connectionKeys, 'poolMin', 'poolMax', 'poolIncrement', 'queueTimeout'].sort());
    return pool;
  });
  const connects = t.mock.method(oracledb, 'getConnection', async options => {
    assert.equal(options.user, values.NODE_ORACLEDB_USER);
    assert.deepEqual(Object.keys(options).sort(), [...connectionKeys].sort());
    return connection('standalone');
  });
  t.mock.method(PublicClientApplication.prototype, 'acquireTokenByDeviceCode', async request => {
    request.deviceCodeCallback({ verificationUri: 'https://login.microsoftonline.com/device',
      userCode: 'FIXTURE-CODE', expiresIn: 600 });
    return { accessToken: 'fixture-server-only-user-token', expiresOn: new Date(Date.now() + 3600000),
      account: { username: 'fixture-user' } };
  });
  try {
    Object.assign(process.env, values);
    const { AppModule } = require('../dist/app.module');
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    for (const path of ['query', 'standalone'])
      assert.equal((await fetch(`${base}/api/${path}`)).status, 401);
    assert.equal(connects.mock.callCount(), 0);
    const start = await fetch(`${base}/auth/start`, { method: 'POST' });
    assert.equal(start.status, 201);
    const pendingCookie = start.headers.get('set-cookie').split(';')[0];
    assert.equal((await start.json()).userCode, 'FIXTURE-CODE');
    const status = await fetch(`${base}/auth/status`, { headers: { Cookie: pendingCookie } });
    assert.equal((await status.json()).state, 'authenticated');
    const cookie = status.headers.get('set-cookie').split(';')[0];
    const responses = await Promise.all(['query', 'standalone'].map(async path => {
      const response = await fetch(`${base}/api/${path}`, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.ok(!JSON.stringify(data).includes('fixture-server-only-user-token'));
      return data;
    }));
    assert.deepEqual(responses[0].rows, [{ EMPLOYEE_ID: 100 }]);
    assert.deepEqual(responses[1].rows, [{ DATABASE_TIME: 'fixture-time', SESSION_USER: 'FIXTURE_USER' }]);
    assert.equal(creates.mock.callCount(), 1);
    assert.equal(connects.mock.callCount(), 1);
    assert.equal(poolReleases, 1);
    assert.equal(standaloneCloses, 1);
    assert.equal(poolCloses, 0);
    assert.equal((await fetch(`${base}/auth/logout`, { method: 'POST', headers: { Cookie: cookie } })).status, 201);
    assert.equal((await fetch(`${base}/api/standalone`, { headers: { Cookie: cookie } })).status, 401);
  } finally {
    if (app) await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.equal(poolCloses, 1, 'the app owns pool shutdown');
  assert.equal(standaloneCloses, 1, 'standalone connection was already closed by its query');
});
