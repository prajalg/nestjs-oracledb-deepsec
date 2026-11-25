# NestJS + Oracle

A small NestJS app with Azure device-code login, Passport sessions and CLS.
Azure signs the user into the app. One CLS mapper supplies that identity to the
DeepSec plugin. The existing pool and standalone query methods stay unchanged.

## Run

```sh
npm install
# Fill in .env using .env.example; keep credentials out of git.
npm run dev
```

Open the printed URL. Sign in, then load employees or database time. Stop with
Ctrl+C. Azure login uses `/auth/start`, `/auth/status` and `/auth/logout`.
The local app uses HTTP and in-memory sessions; restarting signs everyone out.

## Code

- `src/auth/`: Azure login, Passport session restoration and authentication guard.
- `src/app.module.ts`: register auth, CLS and the app-owned Oracle pool.
- `src/database/oracle-pool.ts`: configure and create the pool; AppModule closes it on shutdown.
- `src/employees/`: authenticated route, borrow a connection, query all employee columns, release.
- `src/database/standalone.*`: authenticated route, open a standalone connection, query database time, close.
- `src/health.controller.ts`: public health endpoint, no database call.
- `public/`: simple UI with a wide results table and logout confirmation.

The guard stores the authenticated user in CLS. Asynchronous work in that request
can read it without passing the user through every function. Database services
need only ordinary node-oracledb calls and know nothing about user access tokens.

## Tests

```sh
npm test
```

Offline tests cover login/session lifecycle, concurrent CLS users, unauthenticated
requests, query errors, connection release and UI diagnostics. External Azure and
Oracle I/O is stubbed. Live database permissions are those of the database user.

## DeepSec integration compared with the plain baseline

The baseline is `feat/plain-azure-cls-app`. This branch adds only the plugin,
its app configuration, scope decorators and tests. Shared Azure networking is
already part of the baseline.

```ts
DeepSecModule.forRootAsync({
  inject: [ClsService],
  useFactory: (cls: ClsService<DemoAuthStore>) => ({
    mapIdentity: () => {
      const user = cls.get('user');
      return user ? { endUserToken: user.accessToken } : null;
    },
  }),
});
```

The inline mapper reads the current authenticated user from CLS after the app guard.
The app supplies an inline `endUserSecParams` object in `createOraclePool()`.
It reads the `AZURE_DB_*` settings listed in `.env.example`; user login remains
configured separately with `AZURE_USER_*`. Each resource supplies its own Oracle connection options directly. The standalone
connection stays ordinary; add its own `endUserSecParams` to enable DeepSec there.

- Employees uses global identity mapping with no decorator.
- Standalone explicitly uses `@DeepSec()` for identity scope; its connection needs
  its own `endUserSecParams` to use DeepSec at the database.
- Health and the app's Azure login controller use `@SkipDeepSec()`.
- Rare scoped roles use `@DeepSec({ dataRoles: ['SALARY_REPORT'] })`.
  These replace mapped roles for that scope only; Oracle authorizes their use.

The plugin never manages database resources or changes authentication. Query execution, guards, session handling and UI remain as in the baseline;
the existing pool factory adds its own driver settings. App guards still control access on skipped routes.

```sh
git diff feat/plain-azure-cls-app -- src
npm test
```

The offline suites exercise real Nest request pipelines and the driver context
API. Azure token exchange and database I/O are stubbed. A live database-policy
check still requires valid provider credentials. See the
[plugin README](packages/nestjs-deepsec/README.md) for integration in other apps.
