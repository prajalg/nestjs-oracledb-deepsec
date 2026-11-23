const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { DeepSecModule, mapBearerIdentity, mapSessionIdentity } = require('nestjs-oracledb-deepsec');

test('bearer mapper extracts only a syntactically valid bearer token without session fallback', () => {
  for (const authorization of [undefined, '', 'Basic abc', 'Bearer', 'Bearer one two', ['Bearer array']]) {
    assert.equal(mapBearerIdentity({ headers: { authorization },
      session: { identity: { token: 'session-token', expiresAt: Date.now() + 60000 } } }), null);
  }
  assert.equal(mapBearerIdentity({}), null);
  assert.deepEqual(mapBearerIdentity({ headers: { authorization: 'bEaReR fixture-token' } }),
    { endUserToken: 'fixture-token' });
});

test('session mapper accepts only unexpired server-side identity and never falls back to bearer/user', () => {
  for (const identity of [undefined, null, {}, { token: '', expiresAt: Date.now() + 60000 },
    { token: 'expired', expiresAt: Date.now() - 1 }, { token: 'invalid', expiresAt: NaN },
    { token: 'invalid', expiresAt: Infinity }, { token: 'invalid', expiresAt: String(Date.now() + 60000) }]) {
    assert.equal(mapSessionIdentity({ session: { identity },
      headers: { authorization: 'Bearer ignored' }, user: { accessToken: 'ignored' } }), null);
  }
  assert.equal(mapSessionIdentity({}), null);
  assert.deepEqual(mapSessionIdentity({ session: { identity: {
    token: 'session-token', expiresAt: Date.now() + 60000, username: 'ignored' } },
    headers: { authorization: 'Bearer ignored' } }), { endUserToken: 'session-token' });
});

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
