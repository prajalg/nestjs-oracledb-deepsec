const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { DeepSecModule } = require('nestjs-oracledb-deepsec');

test('missing identity mapper fails at startup for synchronous and asynchronous configuration', async () => {
  const pool = { getConnection() { throw new Error('must not borrow'); }, close() {} };
  for (const mapIdentity of [undefined, null, 'invalid']) {
    assert.throws(() => DeepSecModule.forRoot({ pool, mapIdentity }), /requires a mapIdentity function/);
  }
  class MissingMapperModule {}
  Module({ imports: [DeepSecModule.forRootAsync({ useFactory: async () => ({ pool }) })] })(MissingMapperModule);
  await assert.rejects(NestFactory.create(MissingMapperModule, { logger: false, abortOnError: false }),
    /requires a mapIdentity function/);
});
