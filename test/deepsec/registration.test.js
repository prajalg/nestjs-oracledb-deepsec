const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module, Controller, Get, UseInterceptors } = require('@nestjs/common');
const { NestFactory, APP_INTERCEPTOR } = require('@nestjs/core');
const { DeepSecConfiguration, DeepSecInterceptor, RunWithDataRoles } = require('../../dist/deepsec/deepsec');
const driver = require('oracledb').getSecurityContextProvider();
const decorate = (decorator, type, name) => decorator(type.prototype, name,
  Object.getOwnPropertyDescriptor(type.prototype, name));

for (const mode of ['none', 'controller', 'handler', 'global']) {
  test(`interceptor registration: ${mode} applies only to the selected handlers`, async () => {
    let mappings = 0;
    class Queries {
      scoped() { return { identity: driver.getCurrentContext() }; }
      plain() { return { identity: driver.getCurrentContext() }; }
    }
    Controller('query')(Queries);
    decorate(Get('scoped'), Queries, 'scoped');
    decorate(Get('plain'), Queries, 'plain');
    // Metadata alone must not install an interceptor.
    decorate(RunWithDataRoles(['REPORT']), Queries, 'scoped');
    if (mode === 'controller') UseInterceptors(DeepSecInterceptor)(Queries);
    if (mode === 'handler') decorate(UseInterceptors(DeepSecInterceptor), Queries, 'scoped');
    class Other {
      plain() { return { identity: driver.getCurrentContext() }; }
    }
    Controller('other')(Other);
    decorate(Get(), Other, 'plain');
    class App {}
    Module({
      imports: [DeepSecConfiguration.forRoot({ mapIdentity: () => {
        mappings++; return { endUserToken: 'fixture' };
      } })],
      controllers: [Queries, Other],
      providers: mode === 'global' ? [{ provide: APP_INTERCEPTOR, useExisting: DeepSecInterceptor }] : [],
    })(App);
    const app = await NestFactory.create(App, { logger: false, abortOnError: false });
    try {
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      const expected = [mode !== 'none', ['controller', 'global'].includes(mode), mode === 'global'];
      for (const [index, route] of ['/query/scoped', '/query/plain', '/other'].entries()) {
        const response = await fetch(base + route);
        assert.equal(response.status, 200);
        const { identity } = await response.json();
        assert.equal(identity !== null, expected[index]);
        if (expected[index]) {
          assert.equal(identity.endUserToken, 'fixture');
          if (index === 0) assert.deepEqual(identity.dataRoles, ['REPORT']);
        }
      }
      assert.equal(mappings, expected.filter(Boolean).length, 'map once per intercepted request');
      assert.equal(driver.getCurrentContext(), null);
    } finally { await app.close(); }
  });
}
