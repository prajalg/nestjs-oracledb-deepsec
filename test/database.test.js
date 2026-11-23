const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseService, DEMO_QUERY } = require('../dist/database.service');

test('executes the fixed query and releases the borrowed connection', async () => {
  let closed = 0;
  const service = new DatabaseService();
  service.pool = { getConnection: async () => ({
    execute: async (sql, binds) => {
      assert.equal(sql, DEMO_QUERY);
      assert.deepEqual(binds, []);
      return { metaData: [{ name: 'DB_USER' }], rows: [{ DB_USER: 'SCOTT' }] };
    },
    close: async () => { closed++; },
    oracleServerVersionString: '26.1.0.0.0',
  }) };
  const result = await service.runQuery();
  assert.equal(result.connected, true);
  assert.deepEqual(result.rows, [{ DB_USER: 'SCOTT' }]);
  assert.equal(closed, 1);
});

test('releases on SQL failure and returns a diagnostic without sensitive details', async () => {
  let closed = 0;
  const service = new DatabaseService();
  service.pool = { getConnection: async () => ({
    execute: async () => { throw Object.assign(new Error('secret connection details'), { code: 'ORA-01017' }); },
    close: async () => { closed++; },
  }) };
  await assert.rejects(service.runQuery(), error => {
    assert.equal(error.getStatus(), 503);
    assert.equal(error.getResponse().code, 'ORA-01017');
    assert.ok(!JSON.stringify(error.getResponse()).includes('secret'));
    return true;
  });
  assert.equal(closed, 1);
});

test('reports connection failure without attempting to close an unborrowed connection', async () => {
  const service = new DatabaseService();
  service.pool = { getConnection: async () => { throw new Error('unreachable'); } };
  await assert.rejects(service.runQuery(), error => error.getStatus() === 503);
});
