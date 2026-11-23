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
      spiType: 'azure', authFlow: 'onBehalfOf', contextResolution: 'operation',
      clientId: 'test-client', clientSecret: 'test-secret',
      authority: 'https://login.microsoftonline.com/test-tenant',
      scopes: ['test-resource/.default'],
    },
  },
};

test('pool creation installs the real shared driver provider without opening a connection', async () => {
  const dynamicModule = DeepSecModule.forRoot(options);
  const poolProvider = dynamicModule.providers.find(provider => provider.provide === DEEPSEC_POOL);
  const pool = await poolProvider.useFactory(options);
  try {
    // This assertion deliberately checks the driver hook's installation only.
    // It does not prove Azure exchange or database enforcement.
    assert.equal(typeof pool._securityContextProvider, 'function');
    assert.equal(pool._securityContextProvider._contextResolution, 'operation');
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

// These identities are test fixtures established by a guard, not real authentication.
test('guard identities map into isolated driver scopes with no raw-header fallback', async () => {
  const users = {
    alice: { accessToken: 'alice-token', roles: ['READER'], attributes: { tenant: { id: 'a' } } },
    bob: { accessToken: 'bob-token', roles: ['WRITER'], attributes: { tenant: { id: 'b' } } },
    invalid: { accessToken: ' ', roles: [] },
    badRoles: { accessToken: 'token', roles: 'ADMIN' },
    badAttributes: { accessToken: 'token', attributes: [] },
  };
  let calls = 0;
  const seen = [];
  class FixtureGuard {
    canActivate(context) {
      const req = context.switchToHttp().getRequest();
      req.user = users[req.headers['x-test-user']];
      req.guardRan = true;
      return true;
    }
  }
  const bridge = DeepSecModule.forRoot({ ...options,
    async mapIdentity(request) {
      calls++;
      assert.equal(request.guardRan, true);
      await delay(1);
      if (!request.user) return null;
      return { endUserToken: request.user.accessToken, dataRoles: request.user.roles,
        attributes: request.user.attributes, clientSecret: 'must-not-propagate' };
    },
  });
  const pool = {
    async getConnection() {
      const metadata = contextProvider.getCurrentContext();
      seen.push(metadata);
      assert.equal(metadata.clientSecret, undefined);
      const original = metadata.endUserToken === 'alice-token' ? users.alice : users.bob;
      assert.notEqual(metadata.dataRoles, original.roles);
      assert.notEqual(metadata.attributes.tenant, original.attributes.tenant);
      await delay(metadata.endUserToken === 'alice-token' ? 20 : 1);
      assert.equal(contextProvider.getCurrentContext(), metadata);
      return { async execute() {
        return { metaData: [], rows: [{ identity: metadata }] };
      }, async close() {} };
    },
    async close() {},
  };
  bridge.providers = bridge.providers.map(provider => provider.provide === DEEPSEC_POOL
    ? { provide: DEEPSEC_POOL, useValue: pool } : provider);
  const { APP_GUARD } = require('@nestjs/core');
  class TestModule {}
  Module({ imports: [bridge], controllers: [AppController], providers: [DatabaseService,
    { provide: APP_GUARD, useClass: FixtureGuard }] })(TestModule);
  const app = await NestFactory.create(TestModule, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    assert.equal(calls, 0, 'public routes bypass mapping');
    for (const user of ['', 'invalid', 'badRoles', 'badAttributes']) {
      const r = await fetch(`${base}/api/query`, {
        headers: { 'x-test-user': user, Authorization: 'Bearer spoofed-token' },
      });
      assert.equal(r.status, 401);
    }
    assert.equal(seen.length, 0, 'rejected identity never reaches SQL');
    const results = await Promise.all(['alice', 'bob'].map(async user => {
      const response = await fetch(`${base}/api/query`, {
        headers: { 'x-test-user': user, Authorization: 'Bearer spoofed-token' },
      });
      assert.equal(response.status, 200);
      return (await response.json()).rows[0].identity;
    }));
    assert.deepEqual(results, [
      { endUserToken: 'alice-token', dataRoles: ['READER'], attributes: { tenant: { id: 'a' } } },
      { endUserToken: 'bob-token', dataRoles: ['WRITER'], attributes: { tenant: { id: 'b' } } },
    ]);
    assert.equal(contextProvider.getCurrentContext(), null);
  } finally { await app.close(); }
});

test('mapped Observable subscriptions preserve context, errors and cancellation teardown', async () => {
  const { APP_INTERCEPTOR, Reflector } = require('@nestjs/core');
  const { Observable } = require('rxjs');
  const bridge = DeepSecModule.forRoot(options);
  const Interceptor = bridge.providers.find(p => p.provide === APP_INTERCEPTOR).useClass;
  const identity = { endUserToken: 'test-token', dataRoles: ['READER'],
    attributes: { tenant: { id: 'original' } } };
  const interceptor = new Interceptor(new Reflector(), {
    tokenForRequest() { throw new Error('session must not be consulted'); },
  }, () => identity);
  const context = { getType: () => 'http', getHandler: () => function handler() {},
    getClass: () => class Controller {}, switchToHttp: () => ({ getRequest: () => ({ headers: {} }) }) };
  let teardown = 0;
  const stream = await interceptor.intercept(context, { handle: () => new Observable(subscriber => {
    assert.equal(contextProvider.getCurrentContext().endUserToken, 'test-token');
    subscriber.next(contextProvider.getCurrentContext());
    return () => { teardown++; };
  }) });
  identity.dataRoles.push('CHANGED');
  identity.attributes.tenant.id = 'changed';
  let captured;
  const sub = stream.subscribe(value => { captured = value; });
  assert.deepEqual(captured.dataRoles, ['READER']);
  assert.equal(captured.attributes.tenant.id, 'original');
  sub.unsubscribe();
  assert.equal(teardown, 1);
  assert.equal(contextProvider.getCurrentContext(), null);
  const expected = new Error('handler failed');
  const failing = await interceptor.intercept(context, { handle: () => new Observable(subscriber => {
    subscriber.error(expected);
    return () => { teardown++; };
  }) });
  let actual;
  failing.subscribe({ error: error => { actual = error; } });
  assert.equal(actual, expected);
  assert.equal(teardown, 2);
  assert.equal(contextProvider.getCurrentContext(), null);
});
