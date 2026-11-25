const { test } = require('node:test');
const assert = require('node:assert/strict');
const oracledb = require('oracledb');
const { StandaloneService, STANDALONE_QUERY } = require('../dist/database/standalone.service');

Object.assign(process.env, {
  NODE_ORACLEDB_USER: 'fixture-user', NODE_ORACLEDB_PASSWORD: 'fixture-password',
  NODE_ORACLEDB_CONNECTIONSTRING: 'localhost:1521/fixture',

});

for (const failure of [null, 'query', 'connect']) {
  test(`standalone query uses ordinary Oracle options and releases resources (${failure ?? 'success'})`, async t => {
    let closed = 0;
    const connection = {
      async execute(sql, binds, options) {
        assert.equal(sql, STANDALONE_QUERY);
        assert.deepEqual(binds, []);
        assert.equal(options.outFormat, oracledb.OUT_FORMAT_OBJECT);
        if (failure === 'query') throw Object.assign(new Error('Fixture SQL error'), { code: 'ORA-00942' });
        return { metaData: [{ name: 'DATABASE_TIME' }, { name: 'SESSION_USER' }],
          rows: [{ DATABASE_TIME: 'fixture-time', SESSION_USER: 'FIXTURE_USER' }] };
      },
      async close() { closed++; },
    };
    const connects = t.mock.method(oracledb, 'getConnection', async options => {
      assert.equal(options.user, 'fixture-user');
      assert.deepEqual(Object.keys(options).sort(),
        ['user', 'password', 'connectString', 'walletLocation', 'walletPassword', 'connectTimeout'].sort());
      if (failure === 'connect') throw new Error('Fixture connection failure');
      return connection;
    });
    const service = new StandaloneService();
    if (failure) {
      await assert.rejects(service.runQuery(), error => {
        assert.equal(error.getStatus(), 503);
        if (failure === 'query') assert.equal(error.getResponse().code, 'ORA-00942');
        return true;
      });
    } else {
      const result = await service.runQuery();
      assert.equal(result.sql, STANDALONE_QUERY);
      assert.deepEqual(result.columns, ['DATABASE_TIME', 'SESSION_USER']);
      assert.deepEqual(result.rows, [{ DATABASE_TIME: 'fixture-time', SESSION_USER: 'FIXTURE_USER' }]);
      assert.equal(connection.callTimeout, 15000);
    }
    assert.equal(connects.mock.callCount(), 1);
    assert.equal(closed, failure === 'connect' ? 0 : 1);
  });
}


test('simultaneous standalone requests receive separate creation options', async t => {
  const seen = [];
  const temporary = Symbol('fixture-hook-state');
  t.mock.method(oracledb, 'getConnection', async options => {
    seen.push(options);
    const id = seen.length;
    // A configuration hook may write temporary creation state on its input.
    options[temporary] = id;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(options[temporary], id);
    return { async execute() { return { metaData: [], rows: [] }; }, async close() {} };
  });
  const service = new StandaloneService();
  await Promise.all([service.runQuery(), service.runQuery()]);
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
});
