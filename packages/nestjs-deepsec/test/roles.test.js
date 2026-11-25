const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { Module, Controller, Get, ServiceUnavailableException } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { Observable, take } = require('rxjs');
const oracledb = require('oracledb');
const { DeepSecModule, DeepSec, SkipDeepSec } = require('nestjs-oracledb-deepsec');
const provider = oracledb.getSecurityContextProvider();
const decorate = (decorator, type, name) => decorator(type.prototype, name,
  Object.getOwnPropertyDescriptor(type.prototype, name));

test('scoped roles replace mapped roles only within that handler; method metadata overrides controller metadata', async () => {
  const original = { endUserToken: 'fixture', dataRoles: ['READER'], attributes: { tenant: 'a' } };
  const configured = ['SALARY_REPORT'];
  const salary = DeepSec({ dataRoles: configured });
  configured.push('MUTATED'); // Registration snapshots the trusted role configuration.
  class Reports {
    base() { return provider.getCurrentContext(); }
    salary() { return provider.getCurrentContext(); }
    mapped() { return provider.getCurrentContext(); }
    empty() { return provider.getCurrentContext(); }
    skipped() { return { scoped: provider.getCurrentContext() !== null }; }
    fail() {
      assert.deepEqual(provider.getCurrentContext().dataRoles, ['SALARY_REPORT']);
      throw new ServiceUnavailableException('Fixture report error');
    }
  }
  Controller('reports')(Reports);
  DeepSec({ dataRoles: ['CONTROLLER'] })(Reports);
  for (const name of ['base', 'salary', 'mapped', 'empty', 'skipped', 'fail']) decorate(Get(name), Reports, name);
  decorate(salary, Reports, 'salary');
  decorate(salary, Reports, 'fail');
  decorate(DeepSec(), Reports, 'mapped');
  decorate(DeepSec({ dataRoles: [] }), Reports, 'empty');
  decorate(SkipDeepSec(), Reports, 'skipped');
  class Disabled {
    report() { return provider.getCurrentContext(); }
  }
  Controller('disabled')(Disabled);
  SkipDeepSec()(Disabled);
  decorate(Get(), Disabled, 'report');
  decorate(salary, Disabled, 'report');
  class App {}
  Module({ imports: [DeepSecModule.forRoot({
    // Fixture-only authentication input; never treat raw headers this way in an app.
    async mapIdentity(request) {
      await delay(request.headers['x-fixture-user'] === 'alice' ? 3 : 1);
      return request.headers['x-fixture-user'] ? { ...original, endUserToken: request.headers['x-fixture-user'] } : null;
    },
  })], controllers: [Reports, Disabled] })(App);
  const app = await NestFactory.create(App, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    assert.equal((await fetch(`${base}/reports/salary`)).status, 401, 'a role override cannot replace missing identity');
    const requests = [
      ['reports/base', 'alice', ['CONTROLLER']],
      ['reports/salary', 'alice', ['SALARY_REPORT']],
      ['reports/mapped', 'bob', ['READER']],
      ['reports/empty', 'bob', []],
      ['disabled', 'bob', ['SALARY_REPORT']],
    ];
    await Promise.all(requests.map(async ([path, user, roles]) => {
      const response = await fetch(`${base}/${path}`, { headers: { 'x-fixture-user': user } });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { endUserToken: user, dataRoles: roles, attributes: { tenant: 'a' } });
    }));
    const failure = await fetch(`${base}/reports/fail`, { headers: { 'x-fixture-user': 'alice' } });
    assert.equal(failure.status, 503);
    const after = await fetch(`${base}/reports/mapped`, { headers: { 'x-fixture-user': 'alice' } });
    assert.deepEqual((await after.json()).dataRoles, ['READER']);
    assert.deepEqual(await (await fetch(`${base}/reports/skipped`)).json(), { scoped: false });
    assert.deepEqual(original.dataRoles, ['READER']);
    assert.equal(provider.getCurrentContext(), null);
  } finally { await app.close(); }
});

test('scoped-role Observable teardown stops work on completion, error and unsubscribe', async () => {
  let teardowns = 0;
  class Streams {
    stream() {
      return new Observable(subscriber => {
        assert.deepEqual(provider.getCurrentContext().dataRoles, ['SALARY_REPORT']);
        subscriber.next(provider.getCurrentContext());
        return () => { teardowns++; };
      }).pipe(take(1));
    }
    fail() {
      return new Observable(subscriber => {
        assert.deepEqual(provider.getCurrentContext().dataRoles, ['SALARY_REPORT']);
        subscriber.error(new ServiceUnavailableException('Fixture stream error'));
        return () => { teardowns++; };
      });
    }
  }
  Controller('streams')(Streams);
  DeepSec({ dataRoles: ['SALARY_REPORT'] })(Streams);
  for (const name of ['stream', 'fail']) decorate(Get(name), Streams, name);
  class App {}
  Module({ imports: [DeepSecModule.forRoot({ mapIdentity: () => ({ endUserToken: 'fixture', dataRoles: ['READER'] }) })],
    controllers: [Streams] })(App);
  const app = await NestFactory.create(App, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    assert.equal((await fetch(`${base}/streams/stream`)).status, 200);
    assert.equal((await fetch(`${base}/streams/fail`)).status, 503);
    assert.equal(teardowns, 2);
    assert.equal(provider.getCurrentContext(), null);
  } finally { await app.close(); }
});
