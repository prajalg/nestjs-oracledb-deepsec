const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { DeepSecModule } = require('nestjs-oracledb-deepsec');

test('missing identity mapper fails startup for direct and asynchronous module configuration', async () => {
  for (const mapIdentity of [undefined, null, 'invalid']) {
    for (const registration of [DeepSecModule.forRoot({ mapIdentity }),
      DeepSecModule.forRootAsync({ useFactory: async () => ({ mapIdentity }) })]) {
      class App {}
      Module({ imports: [registration] })(App);
      await assert.rejects(NestFactory.create(App, { logger: false, abortOnError: false }),
        /requires a mapIdentity function/);
    }
  }
});
