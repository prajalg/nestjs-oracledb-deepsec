const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { Module, Controller, Get, Inject, UnauthorizedException, ServiceUnavailableException } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const oracledb = require('oracledb');
const { DeepSecModule } = require('nestjs-oracledb-deepsec');
const context = oracledb.getSecurityContextProvider();
const decorate = (decorator, type, name) => decorator(type.prototype, name,
  Object.getOwnPropertyDescriptor(type.prototype, name));
const databaseOptions = id => ({
  user: 'fixture', password: 'fixture', connectString: 'localhost:1521/unused', poolMin: 0,
  endUserSecParams: {
    spiType: 'azure', authFlow: 'onBehalfOf', contextResolution: 'operation',
    clientId: `fixture-${id}`, clientSecret: 'fixture-secret',
    authority: 'https://login.microsoftonline.com/fixture', scopes: [`fixture-${id}/.default`],
  },
});
const plugin = () => DeepSecModule.forRoot({
  // Fixture identities only. A real app reads the output of its authentication guard.
  mapIdentity: execution => {
    const request = execution.switchToHttp().getRequest();
    if (!request.headers['x-fixture-user']) throw new UnauthorizedException();
    return { endUserToken: request.headers['x-fixture-user'] };
  },
});

async function start(controller, providers = []) {
  Controller('resources')(controller);
  decorate(Get(), controller, 'query');
  class App {}
  Module({ imports: [plugin()], controllers: [controller], providers })(App);
  const app = await NestFactory.create(App, { logger: false, abortOnError: false });
  try { await app.listen(0, '127.0.0.1'); }
  catch (error) { await app.close(); throw error; }
  return app;
}

// Real pools/context propagation; network operations are replaced at public
// driver methods. These checks do not exercise token exchange or database policy.
test('one identity mapping serves multiple app-owned pools without replacing or closing them', async t => {
  const pools = await Promise.all(['first', 'second'].map(id => oracledb.createPool(databaseOptions(id))));
  const tokens = [Symbol('FIRST_APP_POOL'), Symbol('SECOND_APP_POOL')];
  const releases = [0, 0];
  const closes = pools.map(pool => t.mock.method(pool, 'close', pool.close.bind(pool)));
  pools.forEach((pool, index) => t.mock.method(pool, 'getConnection', async () => {
    const identity = context.getCurrentContext();
    return {
      async execute() {
        await delay(identity.endUserToken === 'alice' ? 10 : 1);
        assert.equal(context.getCurrentContext(), identity);
        return { rows: [[index, identity.endUserToken]] };
      },
      async close() { releases[index]++; },
    };
  }));
  const creates = t.mock.method(oracledb, 'createPool', () => { throw new Error('unexpected pool creation'); });
  const standalone = t.mock.method(oracledb, 'getConnection', () => { throw new Error('unexpected standalone connection'); });
  class ExistingController {
    constructor(first, second) { this.pools = [first, second]; }
    async query() {
      const results = [];
      for (const pool of this.pools) {
        const connection = await pool.getConnection();
        try { results.push((await connection.execute('select * from employees')).rows); }
        finally { await connection.close(); }
      }
      return results;
    }
  }
  tokens.forEach((token, index) => Inject(token)(ExistingController, undefined, index));
  let app;
  try {
    app = await start(ExistingController, tokens.map((provide, index) => ({ provide, useValue: pools[index] })));
    const base = await app.getUrl();
    assert.equal((await fetch(`${base}/resources`)).status, 401);
    const results = await Promise.all(['alice', 'bob'].map(async user => {
      const response = await fetch(`${base}/resources`, { headers: { 'x-fixture-user': user } });
      assert.equal(response.status, 200);
      return response.json();
    }));
    assert.deepEqual(results, [[[[0, 'alice']], [[1, 'alice']]], [[[0, 'bob']], [[1, 'bob']]]]);
    assert.deepEqual(releases, [2, 2]);
    tokens.forEach((token, index) => assert.equal(app.get(token), pools[index]));
    await app.close(); app = undefined;
    assert.equal(creates.mock.callCount(), 0);
    assert.equal(standalone.mock.callCount(), 0);
    closes.forEach(close => assert.equal(close.mock.callCount(), 0));
    pools.forEach(pool => assert.equal(pool.status, oracledb.POOL_STATUS_OPEN));
    assert.equal(context.getCurrentContext(), null);
  } finally {
    if (app) await app.close();
    await Promise.all(pools.map(pool => pool.close(0)));
  }
  closes.forEach(close => assert.equal(close.mock.callCount(), 1, 'only application cleanup closes the pool'));
});

test('standalone connection options and cleanup stay with the app on success and query failure', async t => {
  const options = databaseOptions('standalone');
  const originalOptions = structuredClone(options);
  let releases = 0;
  const connects = t.mock.method(oracledb, 'getConnection', async passed => {
    assert.equal(passed, options);
    const identity = context.getCurrentContext();
    return {
      async execute() {
        await delay(identity.endUserToken === 'alice' ? 10 : 1);
        assert.equal(context.getCurrentContext(), identity);
        if (identity.endUserToken === 'failure') throw new ServiceUnavailableException('Fixture SQL failure');
        return { rows: [[identity.endUserToken]] };
      },
      async close() { releases++; },
    };
  });
  const creates = t.mock.method(oracledb, 'createPool', () => { throw new Error('no pool should be created'); });
  class ExistingController {
    async query() {
      const connection = await oracledb.getConnection(options);
      try { return (await connection.execute('select * from employees')).rows; }
      finally { await connection.close(); }
    }
  }
  const app = await start(ExistingController);
  try {
    const base = await app.getUrl();
    assert.equal(connects.mock.callCount(), 0, 'registration opens no connections');
    assert.equal((await fetch(`${base}/resources`)).status, 401);
    assert.equal(connects.mock.callCount(), 0, 'missing identity does not reach connection code');
    const results = await Promise.all(['alice', 'bob', 'failure'].map(async user => {
      const response = await fetch(`${base}/resources`, { headers: { 'x-fixture-user': user } });
      return { status: response.status, body: await response.json() };
    }));
    assert.deepEqual(results.slice(0, 2), [
      { status: 200, body: [['alice']] }, { status: 200, body: [['bob']] },
    ]);
    assert.equal(results[2].status, 503);
    assert.equal(releases, 3);
    assert.deepEqual(options, originalOptions, 'connection settings remain unchanged');
  } finally { await app.close(); }
  assert.equal(connects.mock.callCount(), 3, 'only handlers open connections');
  assert.equal(creates.mock.callCount(), 0);
  assert.equal(releases, 3, 'shutdown does not repeat application cleanup');
  assert.equal(context.getCurrentContext(), null);
});
