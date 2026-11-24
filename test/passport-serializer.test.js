const { test } = require('node:test');
const assert = require('node:assert/strict');
const { AzureSessionSerializer } = require('../dist/auth/azure-session.serializer');

test('Passport serializer persists only the minimal server-side identity', () => {
  const serializer = new AzureSessionSerializer();
  const user = { accessToken: 'fixture-user-token', expiresAt: Date.now() + 60000,
    username: 'fixture-user', password: 'must-not-persist', unrelated: 'omit' };
  let stored;
  serializer.serializeUser(user, (error, value) => { assert.equal(error, null); stored = value; });
  assert.deepEqual(stored, { accessToken: user.accessToken, expiresAt: user.expiresAt,
    username: user.username });
});

test('Passport deserializer rejects malformed and expired identities', () => {
  const serializer = new AzureSessionSerializer();
  for (const user of [null, {}, { accessToken: '', expiresAt: Date.now() + 60000 },
    { accessToken: 'fixture', expiresAt: Date.now() - 1 },
    { accessToken: 'fixture', expiresAt: NaN }]) {
    serializer.deserializeUser(user, (error, value) => {
      assert.equal(error, null); assert.equal(value, false);
    });
  }
  const user = { accessToken: 'fixture', expiresAt: Date.now() + 60000 };
  serializer.deserializeUser(user, (error, value) => { assert.equal(error, null); assert.equal(value, user); });
});
