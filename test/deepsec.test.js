const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const oracledb = require('oracledb');
const { DeepSecModule, DEEPSEC_POOL } = require('nestjs-oracledb-deepsec');
const { DatabaseService } = require('../dist/database.service');
const { AppController } = require('../dist/app.controller');
const contextProvider = oracledb.getSecurityContextProvider();

const options = {
  poolOptions: {
    user: 'test', password: 'test', connectString: 'localhost:1521/test', poolMin: 0,
    endUserSecParams: {
      spiType: 'azure', authFlow: 'onBehalfOf',
      clientId: 'test-client', clientSecret: 'test-secret',
      authority: 'https://login.microsoftonline.com/test-tenant',
      scopes: ['test-resource/.default'],
    },
  },
};

test('pool creation installs the real shared driver provider without opening a connection', async () => {
  const dynamicModule = DeepSecModule.forRoot(options);
  const poolProvider = dynamicModule.providers.find(provider => provider.provide === DEEPSEC_POOL);
  const pool = await poolProvider.useFactory();
  try {
    // This assertion deliberately checks the driver hook's installation only.
    // It does not prove Azure exchange or database enforcement.
    assert.equal(typeof pool._securityContextProvider, 'function');
    assert.equal(pool.connectionsOpen, 0);
  } finally {
    await pool.close(0);
  }
});

test('HTTP requests use isolated real driver scopes; missing tokens fail before SQL', async () => {
  let executions = 0;
  let releases = 0;
  let poolCloses = 0;
  const pool = {
    async getConnection() {
      const borrowContext = contextProvider.getCurrentContext();
      assert.ok(borrowContext?.endUserToken);
      return {
        async execute() {
          executions++;
          await delay(borrowContext.endUserToken === 'user-a' ? 30 : 5);
          const executeContext = contextProvider.getCurrentContext();
          assert.equal(executeContext.endUserToken, borrowContext.endUserToken);
          if (executeContext.endUserToken === 'query-error') {
            throw Object.assign(new Error('test query failure'), { code: 'ORA-00942' });
          }
          return {
            metaData: [{ name: 'TEST_IDENTITY' }],
            rows: [{ TEST_IDENTITY: executeContext.endUserToken }],
          };
        },
        async close() { releases++; },
        oracleServerVersionString: 'test',
      };
    },
    async close() { poolCloses++; },
  };
  const bridge = DeepSecModule.forRoot(options);
  bridge.providers = bridge.providers.map(provider => provider.provide === DEEPSEC_POOL
    ? { provide: DEEPSEC_POOL, useValue: pool } : provider);
  class TestModule {}
  Module({ imports: [bridge], controllers: [AppController], providers: [DatabaseService] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal((await fetch(`${base}/deepsec/auth/status`)).status, 404);
    for (const authorization of [undefined, 'Basic invalid', 'Bearer', 'Bearer one two']) {
      const response = await fetch(`${base}/api/query`, {
        headers: authorization ? { Authorization: authorization } : {},
      });
      assert.equal(response.status, 401);
    }
    assert.equal(executions, 0);
    const identities = await Promise.all(['user-a', 'user-b'].map(async token => {
      const response = await fetch(`${base}/api/query`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      return (await response.json()).rows[0].TEST_IDENTITY;
    }));
    assert.deepEqual(identities, ['user-a', 'user-b']);
    const failure = await fetch(`${base}/api/query`, {
      headers: { Authorization: 'Bearer query-error' },
    });
    assert.equal(failure.status, 503);
    assert.equal(releases, 3);
    assert.equal(contextProvider.getCurrentContext(), null);
  } finally {
    await app.close();
  }
  assert.equal(poolCloses, 1);
});
