const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { Module, Controller, Get, Req, ServiceUnavailableException, UseInterceptors } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { Observable, take } = require('rxjs');
const oracledb = require('oracledb');
const { DeepSecInterceptor, DeepSecConfiguration, SkipDeepSec } = require('../../dist/deepsec/deepsec');
const provider = oracledb.getSecurityContextProvider();
const decorate = (decorator, type, name) => decorator(type.prototype, name,
  Object.getOwnPropertyDescriptor(type.prototype, name));

// Real Nest request pipeline, exported integration APIs and driver context API.
// No private interceptor construction, DI-provider array edits or driver fields.
async function createApp(options, handler = () => provider.getCurrentContext()) {
  class BusinessController {
    health() { return { scoped: Boolean(provider.getCurrentContext()) }; }
    query(request) { return handler(request); }
  }
  Controller('contract')(BusinessController);
  UseInterceptors(DeepSecInterceptor)(BusinessController);
  decorate(Get('health'), BusinessController, 'health');
  decorate(SkipDeepSec(), BusinessController, 'health');
  decorate(Get('query'), BusinessController, 'query');
  Req()(BusinessController.prototype, 'query', 0);
  class App {}
  Module({ imports: [DeepSecConfiguration.forRoot(options)], controllers: [BusinessController] })(App);
  const app = await NestFactory.create(App, { logger: false, abortOnError: false });
  try { await app.listen(0, '127.0.0.1'); }
  catch (error) { await app.close(); throw error; }
  return { app, base: await app.getUrl() };
}

test('null or undefined mapped identity rejects before business code, without bearer fallback', async () => {
  const identities = [null, undefined];
  let index = 0, handled = 0;
  const { app, base } = await createApp({ mapIdentity: () => identities[index++] },
    () => { handled++; return {}; });
  try {
    for (const ignored of identities) {
      const response = await fetch(`${base}/contract/query`, { headers: { Authorization: 'Bearer ignored-fixture' } });
      assert.equal(response.status, 500);
    }
    assert.equal(handled, 0);
    assert.equal(Boolean(provider.getCurrentContext()), false);
  } finally { await app.close(); }
});

test('async mapping runs once and snapshots supported metadata before invoking the handler', async () => {
  const identity = { endUserToken: 'fixture', dataRoles: ['READER'],
    attributes: { tenant: { id: 'original' } }, unrelated: 'must-not-forward' };
  let calls = 0;
  const { app, base } = await createApp({ async mapIdentity() {
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
  const { app, base } = await createApp({ async mapIdentity() {
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

test('SkipDeepSec skips mapping on a handler without installing a context', async () => {
  let mappings = 0;
  const { app, base } = await createApp({
    mapIdentity() { mappings++; return { endUserToken: 'fixture' }; },
  }, () => ({ scoped: Boolean(provider.getCurrentContext()) }));
  try {
    assert.deepEqual(await (await fetch(`${base}/contract/health`)).json(), { scoped: false });
    assert.equal(mappings, 0);
    assert.deepEqual(await (await fetch(`${base}/contract/query`)).json(), { scoped: true });
    assert.equal(mappings, 1);
  } finally { await app.close(); }
});

test('handler Observable executes inside the scope and tears down on completion, error and unsubscribe', async () => {
  let teardowns = 0, emissions = 0;
  const { app, base } = await createApp({
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

test('identity-only startup and shutdown do not open pools or standalone connections', async t => {
  const createPool = t.mock.method(oracledb, 'createPool', () => {
    throw new Error('plugin must not create pools');
  });
  const getConnection = t.mock.method(oracledb, 'getConnection', () => {
    throw new Error('plugin must not open standalone connections');
  });
  const { app, base } = await createApp({ mapIdentity: () => ({ endUserToken: 'fixture' }) });
  try {
    assert.equal((await fetch(`${base}/contract/query`)).status, 200);
  } finally { await app.close(); }
  assert.equal(createPool.mock.callCount(), 0);
  assert.equal(getConnection.mock.callCount(), 0);
});


test('absent optional metadata preserves resource defaults while explicit empty values remain overrides', async () => {
  const cases = [
    { identity: { endUserToken: 'fixture' }, keys: ['endUserToken'] },
    { identity: { endUserToken: 'fixture', dataRoles: undefined, attributes: undefined }, keys: ['endUserToken'] },
    { identity: { endUserToken: 'fixture', dataRoles: ['READER'] }, keys: ['dataRoles', 'endUserToken'] },
    { identity: { endUserToken: 'fixture', attributes: { tenant: 'a' } }, keys: ['attributes', 'endUserToken'] },
    { identity: { endUserToken: 'fixture', dataRoles: [], attributes: {} }, keys: ['attributes', 'dataRoles', 'endUserToken'] },
  ];
  let identity;
  const { app, base } = await createApp({ mapIdentity: () => identity }, () => {
    const metadata = provider.getCurrentContext();
    // Inspect key presence before JSON serialization, which hides undefined values.
    return { keys: Object.keys(metadata).sort(), metadata };
  });
  try {
    for (const scenario of cases) {
      identity = scenario.identity;
      const response = await fetch(`${base}/contract/query`);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(result.keys, scenario.keys, 'absent values must not become overrides in driver metadata');
      assert.deepEqual(result.metadata, JSON.parse(JSON.stringify(identity)));
    }
  } finally { await app.close(); }
});
