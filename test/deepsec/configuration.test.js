const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { DeepSecConfiguration } = require('../../dist/deepsec/deepsec.interceptor');

test('missing identity mapper fails startup for direct and asynchronous module configuration', async () => {
  for (const mapIdentity of [undefined, null, 'invalid']) {
    for (const registration of [DeepSecConfiguration.forRoot({ mapIdentity }),
      DeepSecConfiguration.forRootAsync({ useFactory: async () => ({ mapIdentity }) })]) {
      class App {}
      Module({ imports: [registration] })(App);
      await assert.rejects(NestFactory.create(App, { logger: false, abortOnError: false }),
        /requires a mapIdentity function/);
    }
  }
});
