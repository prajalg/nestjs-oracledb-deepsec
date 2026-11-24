const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { Module, Controller, Get, Req, ServiceUnavailableException } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { Observable, take } = require('rxjs');
const oracledb = require('oracledb');
const { DeepSecModule, DeepSecPublic, DEEPSEC_POOL } = require('nestjs-oracledb-deepsec');
const provider = oracledb.getSecurityContextProvider();
const externalPool = () => ({ getConnection() {}, close() {} });
const decorate = (decorator, type, name) => decorator(type.prototype, name,
  Object.getOwnPropertyDescriptor(type.prototype, name));

// Real Nest request pipeline, public package exports and driver context API.
// No private interceptor construction, DI-provider array edits or driver fields.
async function createApp(options, handler = () => provider.getCurrentContext()) {
  class BusinessController {
    health() { return { scoped: Boolean(provider.getCurrentContext()) }; }
    query(request) { return handler(request); }
  }
  Controller('contract')(BusinessController);
  decorate(Get('health'), BusinessController, 'health');
  decorate(DeepSecPublic(), BusinessController, 'health');
  decorate(Get('query'), BusinessController, 'query');
  Req()(BusinessController.prototype, 'query', 0);
  class App {}
  Module({ imports: [DeepSecModule.forRoot(options)], controllers: [BusinessController] })(App);
  const app = await NestFactory.create(App, { logger: false, abortOnError: false });
  try { await app.listen(0, '127.0.0.1'); }
  catch (error) { await app.close(); throw error; }
  return { app, base: await app.getUrl() };
}

test('missing or malformed mapped identity rejects before business code, without bearer fallback', async () => {
  const cyclic = {}; cyclic.self = cyclic;
  const identities = [null, undefined, {}, { endUserToken: '' }, { endUserToken: ' ' },
    { endUserToken: 123 }, { endUserToken: 'fixture', dataRoles: 'ADMIN' },
    { endUserToken: 'fixture', dataRoles: [''] }, { endUserToken: 'fixture', attributes: [] },
    { endUserToken: 'fixture', attributes: cyclic }];
  let index = 0, handled = 0;
  const { app, base } = await createApp({ pool: externalPool(), mapIdentity: () => identities[index++] },
    () => { handled++; return {}; });
  try {
    for (const ignored of identities) {
      const response = await fetch(`${base}/contract/query`, { headers: { Authorization: 'Bearer ignored-fixture' } });
      assert.equal(response.status, 401);
    }
    assert.equal(handled, 0);
    assert.equal(Boolean(provider.getCurrentContext()), false);
  } finally { await app.close(); }
});

test('async mapping runs once and snapshots supported metadata before invoking the handler', async () => {
  const identity = { endUserToken: 'fixture', dataRoles: ['READER'],
    attributes: { tenant: { id: 'original' } }, unrelated: 'must-not-forward' };
  let calls = 0;
  const { app, base } = await createApp({ pool: externalPool(), async mapIdentity() {
    calls++; await delay(1); return identity;
  } }, async () => {
    identity.dataRoles.push('MUTATED');
    identity.attributes.tenant.id = 'changed';
    const context = provider.getCurrentContext();
    await delay(1);
    assert.equal(provider.getCurrentContext(), context);
    return context;
  });
  try {
    const response = await fetch(`${base}/contract/query`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { endUserToken: 'fixture', dataRoles: ['READER'],
      attributes: { tenant: { id: 'original' } } });
    assert.equal(calls, 1);
    assert.equal(Boolean(provider.getCurrentContext()), false);
  } finally { await app.close(); }
});

test('mapper rejection propagates without executing business code', async () => {
  let handled = false;
  const { app, base } = await createApp({ pool: externalPool(), async mapIdentity() {
    throw new ServiceUnavailableException('Identity service unavailable');
  } }, () => { handled = true; });
  try {
    const response = await fetch(`${base}/contract/query`);
    assert.equal(response.status, 503);
    assert.equal((await response.json()).message, 'Identity service unavailable');
    assert.equal(handled, false);
    assert.equal(Boolean(provider.getCurrentContext()), false);
  } finally { await app.close(); }
});

test('public decorator and application route policy bypass mapping without installing a context', async () => {
  let mappings = 0, policies = 0;
  const { app, base } = await createApp({ pool: externalPool(),
    mapIdentity() { mappings++; throw new Error('must not map public requests'); },
    async isPublic(context) { policies++; assert.equal(context.getType(), 'http'); return true; },
  }, () => ({ scoped: Boolean(provider.getCurrentContext()) }));
  try {
    for (const path of ['health', 'query']) {
      const response = await fetch(`${base}/contract/${path}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { scoped: false });
    }
    assert.equal(mappings, 0);
    assert.equal(policies, 1, 'explicit public decorator takes precedence over callback');
  } finally { await app.close(); }
});

test('a nonboolean public-route decision cannot bypass identity or execute the handler', async () => {
  let mapped = false, handled = false;
  const { app, base } = await createApp({ pool: externalPool(),
    mapIdentity() { mapped = true; return { endUserToken: 'fixture' }; },
    isPublic: async () => 'true',
  }, () => { handled = true; });
  try {
    assert.equal((await fetch(`${base}/contract/query`)).status, 500);
    assert.equal(mapped, false);
    assert.equal(handled, false);
  } finally { await app.close(); }
});

test('handler Observable executes inside the scope and tears down on completion, error and unsubscribe', async () => {
  let teardowns = 0, emissions = 0;
  const { app, base } = await createApp({ pool: externalPool(),
    mapIdentity: () => ({ endUserToken: 'fixture-observable' }),
  }, request => {
    const source = new Observable(subscriber => {
      assert.equal(provider.getCurrentContext().endUserToken, 'fixture-observable');
      const timer = setInterval(() => {
        try {
          assert.equal(provider.getCurrentContext().endUserToken, 'fixture-observable');
          if (request.headers['x-fixture-mode'] === 'error')
            subscriber.error(new ServiceUnavailableException('Fixture handler failure'));
          else {
            emissions++;
            subscriber.next({ ok: true });
            if (request.headers['x-fixture-mode'] !== 'unsubscribe') subscriber.complete();
          }
        } catch (error) { subscriber.error(error); }
      }, 2);
      return () => { clearInterval(timer); teardowns++; };
    });
    return request.headers['x-fixture-mode'] === 'unsubscribe' ? source.pipe(take(1)) : source;
  });
  try {
    for (const mode of ['complete', 'error', 'unsubscribe']) {
      const response = await fetch(`${base}/contract/query`, { headers: { 'x-fixture-mode': mode } });
      assert.equal(response.status, mode === 'error' ? 503 : 200);
      assert.equal(Boolean(provider.getCurrentContext()), false);
    }
    await delay(10);
    assert.equal(teardowns, 3);
    assert.equal(emissions, 2, 'unsubscribed source must stop emitting');
  } finally { await app.close(); }
});

test('adapter-created pool receives unchanged driver options, is exported, and closes on shutdown', async t => {
  const pool = externalPool();
  const closes = [];
  pool.close = async (...args) => { closes.push(args); };
  const options = { user: 'fixture', password: 'fixture', connectString: 'unused',
    endUserSecParams: { spiType: 'azure', authFlow: 'onBehalfOf', contextResolution: 'operation' } };
  let creations = 0;
  t.mock.method(oracledb, 'createPool', async passed => {
    creations++; assert.equal(passed, options); return pool;
  });
  const { app } = await createApp({ poolOptions: options, mapIdentity: () => null });
  try { assert.equal(app.get(DEEPSEC_POOL), pool); assert.equal(creations, 1); }
  finally { await app.close(); }
  assert.deepEqual(closes, [[10]]);
});

test('pool creation failure fails application startup rather than installing an unusable provider', async t => {
  t.mock.method(oracledb, 'createPool', async () => { throw new Error('Fixture pool startup failure'); });
  await assert.rejects(createApp({ poolOptions: { endUserSecParams: {} }, mapIdentity: () => null }),
    /Fixture pool startup failure/);
});
