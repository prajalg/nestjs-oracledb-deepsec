const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { Module, Controller, Get, UseGuards, UnauthorizedException } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const oracledb = require('oracledb');
const { DeepSecModule, DeepSec, SkipDeepSec } = require('nestjs-oracledb-deepsec');
const context = oracledb.getSecurityContextProvider();
const decorate = (decorator, type, name) => decorator(type.prototype, name,
  Object.getOwnPropertyDescriptor(type.prototype, name));

test('scope decorators override class defaults; bypass does not authenticate or open database resources', async () => {
  let maps = 0;
  class DisabledController {
    plain() { return { scoped: context.getCurrentContext() !== null }; }
    async enabled() {
      const identity = context.getCurrentContext();
      await delay(1);
      assert.equal(context.getCurrentContext(), identity);
      return identity;
    }
  }
  Controller('disabled')(DisabledController);
  SkipDeepSec()(DisabledController);
  decorate(Get(), DisabledController, 'plain');
  decorate(Get('enabled'), DisabledController, 'enabled');
  decorate(DeepSec(), DisabledController, 'enabled');
  class EnabledController {
    normal() { return { scoped: context.getCurrentContext() !== null }; }
    skipped() { return { scoped: context.getCurrentContext() !== null }; }
  }
  Controller('enabled')(EnabledController);
  DeepSec()(EnabledController);
  decorate(Get(), EnabledController, 'normal');
  decorate(Get('skipped'), EnabledController, 'skipped');
  decorate(SkipDeepSec(), EnabledController, 'skipped');
  class DefaultController {
    plain() { return { scoped: context.getCurrentContext() !== null }; }
  }
  Controller('default')(DefaultController);
  decorate(Get(), DefaultController, 'plain');
  class AuthenticationGuard {
    canActivate(context) {
      if (context.switchToHttp().getRequest().headers['x-fixture-auth'] === 'valid') return true;
      throw new UnauthorizedException();
    }
  }
  class GuardedController {
    skipped() { return { scoped: context.getCurrentContext() !== null }; }
  }
  Controller('guarded')(GuardedController);
  UseGuards(AuthenticationGuard)(GuardedController);
  SkipDeepSec()(GuardedController);
  decorate(Get(), GuardedController, 'skipped');
  class App {}
  Module({ imports: [DeepSecModule.forRoot({
    mapIdentity: request => {
      maps++;
      // Fixture-only identity; production guards establish the authenticated user.
      return request.headers['x-fixture-user'] ? { endUserToken: request.headers['x-fixture-user'] } : null;
    },
  })], controllers: [DisabledController, EnabledController, DefaultController, GuardedController] })(App);
  const app = await NestFactory.create(App, { logger: false });
  try {
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    for (const path of ['disabled', 'enabled/skipped']) {
      const response = await fetch(`${base}/${path}`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { scoped: false });
    }
    assert.equal((await fetch(`${base}/guarded`)).status, 401,
      'SkipDeepSec does not bypass an authentication guard');
    const guarded = await fetch(`${base}/guarded`, { headers: { 'x-fixture-auth': 'valid' } });
    assert.equal(guarded.status, 200);
    assert.deepEqual(await guarded.json(), { scoped: false });
    assert.equal(maps, 0);
    assert.equal((await fetch(`${base}/default`)).status, 401, 'undecorated handlers use the global mapping');
    assert.equal((await fetch(`${base}/disabled/enabled`)).status, 401);
    assert.equal((await fetch(`${base}/enabled`)).status, 401,
      'explicit enable requires a mapped identity');
    const results = await Promise.all(['alice', 'bob'].map(async user => {
      const response = await fetch(`${base}/disabled/enabled`, { headers: { 'x-fixture-user': user } });
      assert.equal(response.status, 200);
      return response.json();
    }));
    assert.deepEqual(results, [{ endUserToken: 'alice' }, { endUserToken: 'bob' }]);
    assert.equal(context.getCurrentContext(), null);
  } finally { await app.close(); }
});
