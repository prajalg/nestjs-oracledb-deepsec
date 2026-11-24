const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EmployeesService, DEMO_QUERY } = require('../dist/employees/employees.service');

test('returns employee rows and releases the borrowed connection', async () => {
  let closed = 0;
  const service = new EmployeesService();
  service.pool = { getConnection: async () => ({
    execute: async (sql, binds) => {
      assert.equal(sql, DEMO_QUERY);
      assert.deepEqual(binds, []);
      return { metaData: [{ name: 'EMPLOYEE_ID' }, { name: 'FIRST_NAME' }, { name: 'LAST_NAME' }],
        rows: [{ EMPLOYEE_ID: 100, FIRST_NAME: 'Fixture', LAST_NAME: 'Employee' }] };
    },
    close: async () => { closed++; },
    oracleServerVersionString: '26.1.0.0.0',
  }) };
  const result = await service.runQuery();
  assert.equal(result.connected, true);
  assert.deepEqual(result.rows, [{ EMPLOYEE_ID: 100, FIRST_NAME: 'Fixture', LAST_NAME: 'Employee' }]);
  assert.deepEqual(result.columns, ['EMPLOYEE_ID', 'FIRST_NAME', 'LAST_NAME']);
  assert.equal(closed, 1);
});

test('releases on SQL failure and returns a diagnostic without sensitive details', async () => {
  let closed = 0;
  const service = new EmployeesService();
  service.pool = { getConnection: async () => ({
    execute: async () => { throw Object.assign(new Error('ORA-01017: invalid username/password; logon denied'), { code: 'ORA-01017' }); },
    close: async () => { closed++; },
  }) };
  await assert.rejects(service.runQuery(), error => {
    assert.equal(error.getStatus(), 503);
    assert.equal(error.getResponse().code, 'ORA-01017');
    assert.equal(error.getResponse().message, 'ORA-01017: invalid username/password; logon denied');
    return true;
  });
  assert.equal(closed, 1);
});

test('reports connection failure without attempting to close an unborrowed connection', async () => {
  const service = new EmployeesService();
  service.pool = { getConnection: async () => { throw new Error('unreachable'); } };
  await assert.rejects(service.runQuery(), error => error.getStatus() === 503);
});
