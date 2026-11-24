const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Module, Controller, Get, Post, Req, UseGuards, UnauthorizedException } = require('@nestjs/common');
const { NestFactory } = require('@nestjs/core');
const { PassportModule, AuthGuard } = require('@nestjs/passport');
const passport = require('passport');
const session = require('express-session');
const { setTimeout: delay } = require('node:timers/promises');
const oracledb = require('oracledb');
const { DeepSecModule, DeepSecPublic } = require('nestjs-oracledb-deepsec');
const provider = oracledb.getSecurityContextProvider();
const users = {
  a: { accessToken: 'fixture-a', oracleRoles: ['READER'], tenant: 'a' },
  b: { accessToken: 'fixture-b', oracleRoles: ['WRITER'], tenant: 'b' },
};
const decorate = (decorator, type, name) => decorator(type.prototype, name,
  Object.getOwnPropertyDescriptor(type.prototype, name));

for (const setup of ['passport-bearer', 'custom-session']) {
  test(`same adapter supports ${setup} without CLS or handler changes`, async () => {
    const strategyName = 'deepsec-fixture-bearer';
    if (setup === 'passport-bearer') {
      // A real Passport strategy with fixture-only credentials, not production JWT validation.
      class FixtureBearerStrategy extends passport.Strategy {
        authenticate(request) {
          const token = request.headers.authorization;
          const user = Object.values(users).find(user => token === `Bearer ${user.accessToken}`);
          if (user) this.success(user); else this.fail(401);
        }
      }
      passport.use(strategyName, new FixtureBearerStrategy());
    }
    class SessionGuard {
      canActivate(context) {
        if (!context.switchToHttp().getRequest().session?.account) throw new UnauthorizedException();
        return true;
      }
    }
    const Guard = setup === 'passport-bearer' ? AuthGuard(strategyName) : SessionGuard;
    let mappings = 0, executions = 0, poolCloses = 0;
    const pool = { getConnection() {}, async close() { poolCloses++; } };
    class ExistingController {
      login(request) {
        // Fixture-only login route seeds a real express-session store.
        // Applications must authenticate the user before creating a session.
        const user = users[request.body.user];
        if (!user) throw new UnauthorizedException();
        request.session.account = user;
        return { signedIn: true };
      }
      health() { return { scoped: Boolean(provider.getCurrentContext()) }; }
      async employees() {
        const metadata = provider.getCurrentContext();
        assert.ok(metadata);
        await delay(metadata.attributes.tenant === 'a' ? 10 : 1);
        assert.equal(provider.getCurrentContext(), metadata);
        executions++;
        return { token: metadata.endUserToken, roles: metadata.dataRoles, tenant: metadata.attributes.tenant };
      }
    }
    Controller('existing')(ExistingController);
    decorate(Get('employees'), ExistingController, 'employees');
    decorate(UseGuards(Guard), ExistingController, 'employees');
    decorate(Get('health'), ExistingController, 'health');
    decorate(DeepSecPublic(), ExistingController, 'health');
    decorate(Post('login'), ExistingController, 'login');
    decorate(DeepSecPublic(), ExistingController, 'login');
    Req()(ExistingController.prototype, 'login', 0);
    class ExistingApp {}
    Module({
      imports: [
        ...(setup === 'passport-bearer' ? [PassportModule.register({ session: false })] : []),
        DeepSecModule.forRoot({ pool,
          async mapIdentity(request) {
            mappings++;
            // App chooses its identity source. Plugin has no auth-library branches.
            const user = setup === 'passport-bearer' ? request.user : request.session?.account;
            if (!user) return null;
            return { endUserToken: user.accessToken, dataRoles: user.oracleRoles,
              attributes: { tenant: user.tenant } };
          },
        }),
      ], controllers: [ExistingController],
    })(ExistingApp);
    const app = await NestFactory.create(ExistingApp, { logger: false });
    if (setup === 'passport-bearer') app.use(passport.initialize());
    else app.use(session({ secret: 'fixture-only-session-signing-secret', resave: false, saveUninitialized: false }));
    try {
      await app.listen(0, '127.0.0.1');
      const base = await app.getUrl();
      assert.deepEqual(await (await fetch(`${base}/existing/health`)).json(), { scoped: false });
      assert.equal(mappings, 0, 'public route bypasses identity mapping');
      assert.equal((await fetch(`${base}/existing/employees`)).status, 401);
      assert.equal((await fetch(`${base}/existing/employees`, {
        headers: { Authorization: 'Bearer untrusted' },
      })).status, 401);
      assert.equal(executions, 0);
      const headers = [];
      for (const id of ['a', 'b']) {
        if (setup === 'passport-bearer') headers.push({ Authorization: `Bearer ${users[id].accessToken}` });
        else {
          const login = await fetch(`${base}/existing/login`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: id }) });
          assert.equal(login.status, 201);
          headers.push({ Cookie: login.headers.get('set-cookie').split(';')[0] });
        }
      }
      const responses = await Promise.all(headers.map(async headers => {
        const response = await fetch(`${base}/existing/employees`, { headers });
        assert.equal(response.status, 200);
        return response.json();
      }));
      assert.deepEqual(responses, [
        { token: 'fixture-a', roles: ['READER'], tenant: 'a' },
        { token: 'fixture-b', roles: ['WRITER'], tenant: 'b' },
      ]);
      assert.equal(Boolean(provider.getCurrentContext()), false);
      assert.equal((await fetch(`${base}/deepsec/auth/start`, { method: 'POST' })).status, 404,
        'the adapter registers no login endpoints');
    } finally {
      await app.close();
      if (setup === 'passport-bearer') passport.unuse(strategyName);
    }
    assert.equal(poolCloses, 0, 'app retains ownership of its pool');
  });
}
