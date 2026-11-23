const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dirname, join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const oracledb = require('oracledb');
require('oracledb/plugins/token/endUserSecurityProvider');
const azure = require('oracledb/plugins/token/extensionAzure');
const ThinConnectionImpl = require(join(dirname(require.resolve('oracledb')), 'lib/thin/connection.js'));
const contextProvider = oracledb.getSecurityContextProvider();

// Component integration with the linked driver: real Connection.execute()/close()
// wrappers, serialization lock, provider, EUSC construction and Thin set/clear.
// Only the Azure exchange and database/protocol I/O are stubbed. Test-only access
// to driver internals does not establish real TLS negotiation or DB enforcement.
async function fixture(t, { mode = 'operation', exchange } = {}) {
  const exchanges = [];
  t.mock.method(azure, 'getOnBehalfOfToken', async request => {
    exchanges.push(request);
    return exchange ? exchange(request, exchanges.length) : {
      accessToken: `fixture-db-token:${request.endUserToken}`, isNewToken: false,
    };
  });
  const pool = await oracledb.createPool({
    user: 'test', password: 'test', connectString: 'localhost:1521/test', poolMin: 0,
    endUserSecParams: {
      spiType: 'azure', authFlow: 'onBehalfOf', contextResolution: mode,
      clientId: 'fixture-client', clientSecret: 'fixture-secret',
      authority: 'https://login.microsoftonline.com/fixture', scopes: ['fixture/.default'],
    },
  });
  const impl = new ThinConnectionImpl();
  impl.serverVersion = 2326040000;
  impl.serverVersionString = '23.26.4.0.0';
  impl._protocol = { caps: { supportsEndUserSecurityContext: true } };
  impl._securityContextProvider = pool._securityContextProvider;
  impl.clearEndUserSecurityContext();
  const installed = [];
  const executed = [];
  let releases = 0;
  const setContext = impl.setEndUserSecurityContext.bind(impl);
  t.mock.method(impl, 'setEndUserSecurityContext', context => {
    assert.ok(context instanceof oracledb.EndUserSecurityContext);
    installed.push(context);
    setContext(context);
  });
  impl.close = async () => { releases++; impl.clearEndUserSecurityContext(); };
  function borrow() {
    const connection = new oracledb.Connection();
    connection._impl = impl;
    connection._execute = async sql => {
      const metadata = contextProvider.getCurrentContext();
      if (metadata) assert.ok(impl.securityContext instanceof oracledb.EndUserSecurityContext);
      else assert.equal(impl.securityContext, null);
      await delay(1);
      assert.equal(contextProvider.getCurrentContext(), metadata);
      executed.push({ sql, metadata });
      if (sql === 'fixture SQL error') {
        throw Object.assign(new Error('fixture SQL failure'), { code: 'ORA-00942' });
      }
      return { rows: [{ tag: metadata?.attributes?.tag ?? null }] };
    };
    return connection;
  }
  t.after(async () => {
    // No network connection was opened. Clean up the zero-connection pool;
    // failed-close fixtures deliberately retain an unclosed logical connection.
    impl.clearEndUserSecurityContext();
    await pool.close(0);
  });
  return { pool, impl, installed, executed, exchanges, borrow, get releases() { return releases; } };
}

test('operation mode resolves each execute and clears EUSC before returning to the caller', async t => {
  const f = await fixture(t);
  const connection = f.borrow();
  await contextProvider.runWithContext({ endUserToken: 'user-a' }, async () => {
    await connection.execute('select 1 from dual');
    assert.equal(f.impl.securityContext, null);
    await connection.execute('select 2 from dual');
    assert.equal(f.impl.securityContext, null);
    assert.equal(f.exchanges.length, 2, 'token extension is consulted per operation');
    assert.equal(f.installed.length, 2);
    assert.equal(f.installed[0], f.installed[1], 'same cached DB token reuses EUSC within this scope');
    await connection.close();
  });
  assert.equal(f.releases, 1);
  assert.equal(f.impl.securityContext, null);
  assert.equal(f.impl._inProgress, false);
  assert.equal(contextProvider.getCurrentContext(), null);
});

test('operation mode replaces EUSC if the token extension returns a refreshed cached DB token', async t => {
  const f = await fixture(t, { exchange: (_request, count) => ({
    accessToken: count === 1 ? 'fixture-old-db-token' : 'fixture-refreshed-db-token',
    isNewToken: false,
  }) });
  const connection = f.borrow();
  await contextProvider.runWithContext({ endUserToken: 'user-a' }, async () => {
    await connection.execute('first');
    await connection.execute('second');
    await connection.execute('third');
    assert.notEqual(f.installed[0], f.installed[1]);
    assert.equal(f.installed[1], f.installed[2]);
    assert.equal(f.impl.securityContext, null);
    await connection.close();
  });
});

test('SQL errors clear operation EUSC and release the driver lock before subsequent work', async t => {
  const f = await fixture(t);
  const connection = f.borrow();
  await contextProvider.runWithContext({ endUserToken: 'user-a' }, async () => {
    await assert.rejects(connection.execute('fixture SQL error'), { code: 'ORA-00942' });
    assert.equal(f.impl.securityContext, null);
    assert.equal(f.impl._inProgress, false);
    await connection.execute('next operation');
    assert.equal(f.impl.securityContext, null);
    await connection.close();
  });
  assert.equal(f.releases, 1);
});

test('sequential borrowers get separate operation contexts and unscoped work inherits no prior EUSC', async t => {
  const f = await fixture(t);
  for (const tag of ['a', 'b']) {
    await contextProvider.runWithContext({ endUserToken: `user-${tag}`, attributes: { tag } }, async () => {
      const connection = f.borrow();
      assert.deepEqual((await connection.execute('select tag')).rows, [{ tag }]);
      await connection.close();
    });
    assert.equal(f.impl.securityContext, null);
  }
  // Driver policy intentionally permits ordinary DB login outside a scope.
  // The Nest authentication/mapper must prevent protected requests doing this.
  const unscoped = f.borrow();
  assert.deepEqual((await unscoped.execute('ordinary DB login')).rows, [{ tag: null }]);
  await unscoped.close();
  assert.notEqual(f.installed[0], f.installed[2]);
  assert.equal(f.releases, 3);
  assert.equal(contextProvider.getCurrentContext(), null);
});

for (const mode of ['connection', 'operation']) {
  test(`known driver defect (${mode}): initial OBO failure prevents close/release`, async t => {
    const f = await fixture(t, { mode, exchange: () => {
      throw Object.assign(new Error('fixture: expired client credential'), { errorCode: 'invalid_client' });
    } });
    const connection = f.borrow();
    await contextProvider.runWithContext({ endUserToken: 'user-a' }, async () => {
      await assert.rejects(connection.execute('must not execute'), { code: 'NJS-198' });
      await assert.rejects(connection.close(), { code: 'NJS-198' });
    });
    // Diagnostic assertions record the unfixed bug, not desired lifecycle behavior.
    // Once the shared driver is fixed, replace these with successful-close assertions.
    assert.equal(f.exchanges.length, 2);
    assert.equal(f.executed.length, 0);
    assert.equal(f.releases, 0, 'known defect: the close body was never reached');
    assert.equal(f.impl.securityContext, null);
    assert.equal(f.impl._inProgress, false);
    assert.equal(contextProvider.getCurrentContext(), null);
  });
}


test('connection mode resolves once per borrow and isolates sequential request borrowers', async t => {
  const f = await fixture(t, { mode: 'connection' });
  for (const [index, tag] of ['a', 'b'].entries()) {
    await contextProvider.runWithContext({ endUserToken: `user-${tag}`, attributes: { tag } }, async () => {
      const connection = f.borrow();
      assert.deepEqual((await connection.execute('first query')).rows, [{ tag }]);
      const context = f.impl.securityContext;
      assert.ok(context instanceof oracledb.EndUserSecurityContext);
      assert.deepEqual((await connection.execute('second query')).rows, [{ tag }]);
      assert.equal(f.impl.securityContext, context);
      assert.equal(f.exchanges.length, index + 1, 'one resolution for this borrowed connection');
      await connection.close();
    });
    assert.equal(f.impl.securityContext, null, 'successful release clears the previous user');
    assert.equal(f.impl._securityContextInitialized, false);
    assert.equal(contextProvider.getCurrentContext(), null);
  }
  assert.equal(f.installed.length, 2);
  assert.notEqual(f.installed[0], f.installed[1]);
  assert.deepEqual(f.exchanges.map(request => request.endUserToken), ['user-a', 'user-b']);
  assert.equal(f.releases, 2);
});
