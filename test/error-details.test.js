const { test } = require('node:test');
const assert = require('node:assert/strict');
const { errorDetails } = require('../dist/error-details');

test('nested provider diagnostics retain actionable messages and redact secret values', () => {
  process.env.TEST_DIAGNOSTIC_CLIENT_SECRET = 'fixture-environment-secret';
  try {
    const cause = Object.assign(new Error('AADSTS7000222: expired; client_secret=fixture-inline-secret Bearer fixture-bearer fixture-environment-secret'), { errorCodes: [7000222] });
    const error = Object.assign(new Error('NJS-198: provider failed'), { code: 'NJS-198', cause, response: { access_token: 'fixture-response-token' } });
    const details = errorDetails(error);
    assert.equal(details.code, 'NJS-198');
    assert.match(details.message, /AADSTS7000222: expired/);
    for (const secret of ['fixture-inline-secret', 'fixture-bearer', 'fixture-environment-secret', 'fixture-response-token']) assert.ok(!JSON.stringify(details).includes(secret));
    cause.cause = error;
    assert.equal(errorDetails(error).message, details.message, 'cycles terminate');
  } finally { delete process.env.TEST_DIAGNOSTIC_CLIENT_SECRET; }
});

test('diagnostics omit descriptors and JWTs and tolerate unknown errors', () => {
  assert.equal(errorDetails(null).message, 'Request failed');
  assert.ok(!errorDetails(new Error('eyJhbGciOiJIUzI1NiJ9.payload.signature')).message.includes('eyJ'));
  assert.ok(!errorDetails(new Error('failed (DESCRIPTION=(HOST=private-host))')).message.includes('private-host'));
});
