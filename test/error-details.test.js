const { test } = require('node:test');
const assert = require('node:assert/strict');
const { errorDetails } = require('../dist/shared/error-details');

test('nested Azure sign-in diagnostics retain actionable messages and redact secret values', () => {
  process.env.TEST_DIAGNOSTIC_CLIENT_SECRET = 'fixture-environment-secret';
  try {
    const cause = Object.assign(new Error('AADSTS65001: consent required; client_secret=fixture-inline-secret Bearer fixture-bearer fixture-environment-secret'), { errorCodes: [65001] });
    const error = Object.assign(new Error('Azure sign-in failed'), { code: 'consent_required', cause, response: { access_token: 'fixture-response-token' } });
    const details = errorDetails(error);
    assert.equal(details.code, 'consent_required');
    assert.match(details.message, /AADSTS65001: consent required/);
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
