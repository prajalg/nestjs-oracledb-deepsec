const { test } = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const { Module, Injectable, Inject, Controller, Get, SetMetadata } = require('@nestjs/common');
const { NestFactory, Reflector, APP_GUARD } = require('@nestjs/core');
const { ClsModule, ClsService } = require('nestjs-cls');
const oracledb = require('oracledb');
const { DeepSecModule, DEEPSEC_POOL } = require('nestjs-oracledb-deepsec');
const contextProvider = oracledb.getSecurityContextProvider();
const ORACLE_POOL = Symbol('EXISTING_APP_ORACLE_POOL');
const APP_PUBLIC = 'existing-app:public';
const poolOptions = {
  user: 'test', password: 'test', connectString: 'localhost:1521/test', poolMin: 0,
  endUserSecParams: {
    spiType: 'azure', authFlow: 'onBehalfOf', clientId: 'test-client',
    clientSecret: 'test-secret', authority: 'https://login.microsoftonline.com/test',
    scopes: ['test/.default'],
  },
};

test('existing pool, business handlers, CLS and public-route metadata work without replacement', async () => {
  // Real configured pool, no DB connection. Only getConnection is stubbed below.
  const pool = await oracledb.createPool(poolOptions);
  const close = pool.close.bind(pool);
  let closes = 0;
  let releases = 0;
  let poolCreations = 0;
  let mappings = 0;
  let cls;
  pool.close = async (...args) => { closes++; await close(...args); };
  pool.getConnection = async () => ({
    async execute(sql) {
      assert.equal(sql, 'select * from employees');
      const metadata = contextProvider.getCurrentContext();
      assert.equal(metadata.endUserToken, cls.get('user').accessToken);
      assert.deepEqual(metadata.dataRoles, ['READER']);
      assert.deepEqual(metadata.attributes, { tenant: cls.get('user').tenant });
      await delay(metadata.endUserToken === 'test-a' ? 20 : 1);
      assert.equal(contextProvider.getCurrentContext(), metadata);
      assert.equal(metadata.endUserToken, cls.get('user').accessToken);
      return { rows: [{ employee: cls.get('user').tenant }] };
    },
    async close() { releases++; },
  });

  // These represent an existing app. Its service keeps its original injection
  // token and SQL lifecycle. The controller knows nothing about DeepSec.
  class ExistingEmployeeService {
    constructor(pool) { this.pool = pool; }
    async findAll() {
      const conn = await this.pool.getConnection();
      try { return (await conn.execute('select * from employees')).rows; }
      finally { await conn.close(); }
    }
  }
  Injectable()(ExistingEmployeeService);
  Inject(ORACLE_POOL)(ExistingEmployeeService, undefined, 0);
  class ExistingController {
    constructor(employees) { this.employees = employees; }
    health() { return { ok: true, scoped: Boolean(contextProvider.getCurrentContext()) }; }
    employeesList() { return this.employees.findAll(); }
  }
  Controller('existing')(ExistingController);
  Inject(ExistingEmployeeService)(ExistingController, undefined, 0);
  Get('health')(ExistingController.prototype, 'health',
    Object.getOwnPropertyDescriptor(ExistingController.prototype, 'health'));
  SetMetadata(APP_PUBLIC, true)(ExistingController.prototype, 'health',
    Object.getOwnPropertyDescriptor(ExistingController.prototype, 'health'));
  Get('employees')(ExistingController.prototype, 'employeesList',
    Object.getOwnPropertyDescriptor(ExistingController.prototype, 'employeesList'));

  // Test-only identities stand in for an existing authentication strategy.
  class ExistingAuthenticationGuard {
    constructor(cls) { this.cls = cls; }
    canActivate(context) {
      const user = context.switchToHttp().getRequest().headers['x-test-user'];
      if (['a', 'b'].includes(user)) this.cls.set('user', { accessToken: `test-${user}`, tenant: user });
      return true;
    }
  }
  Inject(ClsService)(ExistingAuthenticationGuard, undefined, 0);
  class ExistingDatabaseModule {}
  Module({ providers: [{ provide: ORACLE_POOL, useFactory: () => { poolCreations++; return pool; } }],
    exports: [ORACLE_POOL] })(ExistingDatabaseModule);

  const bridge = DeepSecModule.forRootAsync({
    imports: [ExistingDatabaseModule],
    inject: [ORACLE_POOL, ClsService, Reflector],
    useFactory: async (existingPool, cls, reflector) => ({
      pool: existingPool,
      isPublic: async context => reflector.getAllAndOverride(APP_PUBLIC,
        [context.getHandler(), context.getClass()]) === true,
      mapIdentity: () => {
        mappings++;
        const user = cls.get('user');
        return user ? { endUserToken: user.accessToken, dataRoles: ['READER'],
          attributes: { tenant: user.tenant } } : null;
      },
    }),
  });
  class ExistingAppModule {}
  Module({ imports: [ClsModule.forRoot({ global: true, middleware: { mount: true } }),
    ExistingDatabaseModule, bridge], controllers: [ExistingController],
  providers: [ExistingEmployeeService, { provide: APP_GUARD, useClass: ExistingAuthenticationGuard }] })(ExistingAppModule);
  let app;
  try {
    app = await NestFactory.create(ExistingAppModule, { logger: false, abortOnError: false });
    await app.listen(0, '127.0.0.1');
    cls = app.get(ClsService);
    const base = await app.getUrl();
    assert.equal(app.get(DEEPSEC_POOL), pool);
    assert.equal(app.get(ExistingEmployeeService).pool, pool);
    assert.equal(poolCreations, 1);
    assert.deepEqual(await (await fetch(`${base}/existing/health`)).json(), { ok: true, scoped: false });
    assert.equal(mappings, 0, 'existing public metadata bypasses mapping');
    const anonymous = await fetch(`${base}/existing/employees`, {
      headers: { Authorization: 'Bearer unvalidated-token' },
    });
    assert.equal(anonymous.status, 401);
    assert.equal(releases, 0);
    const results = await Promise.all(['a', 'b'].map(async user => {
      const response = await fetch(`${base}/existing/employees`, { headers: { 'x-test-user': user } });
      assert.equal(response.status, 200);
      return response.json();
    }));
    assert.deepEqual(results, [[{ employee: 'a' }], [{ employee: 'b' }]]);
    assert.equal(releases, 2);
    for (const [method, path] of [['GET', 'status'], ['POST', 'start'], ['POST', 'logout']]) {
      assert.equal((await fetch(`${base}/deepsec/auth/${path}`, { method })).status, 404);
    }
    assert.equal(cls.get('user'), undefined);
    assert.equal(contextProvider.getCurrentContext(), null);
    await app.close();
    app = undefined;
    assert.equal(closes, 0, 'adapter must not close an app-owned pool');
    assert.equal(pool.status, oracledb.POOL_STATUS_OPEN);
  } finally {
    if (app) await app.close();
    await pool.close(0);
  }
  assert.equal(closes, 1, 'only the application owner closes the pool');
});

test('ambiguous pool sources are rejected', () => {
  const pool = { getConnection() {}, close() {} };
  assert.throws(() => DeepSecModule.forRoot({ pool, poolOptions }), /exactly one/);
  assert.throws(() => DeepSecModule.forRoot({}), /exactly one/);
  assert.throws(() => DeepSecModule.forRoot({ pool: {} }), /existing configured Oracle pool/);
});
