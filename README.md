# NestJS + Oracle — DeepSec demo

A small NestJS app using a portable local DeepSec plugin. The original runQuery() method and SQL are unchanged.

## Run

```sh
npm install
npm run build
npm start
```

Open the localhost URL printed at startup (the port comes from `.env`, default 7002), click **Sign in with Azure**, open Microsoft's link and enter the displayed device code. After signing in, click **Run query**. There is no token input. If port 7002 is busy, use `PORT=7003 npm start` and open port 7003.

The optional user-login feature belongs to the portable plugin. The app configures it, renders the sign-in controls, and uses an application-owned authentication guard to resolve its server-side session into CLS. Device login avoids needing a registered localhost callback URI. Its scope must target the middle-tier Azure app, which subsequently exchanges that user token for a database token through OBO.

```
Azure device login -> user token in plugin's server-side session
  -> browser sends opaque HttpOnly cookie
  -> Passport AzureSessionStrategy -> req.user
  -> AzureSessionGuard sets cls.user -> mapDemoIdentity(cls)
  -> plugin runWithContext({ endUserToken, dataRoles, attributes })
  -> unchanged runQuery() -> shared driver plugin exchanges token -> Oracle
```

The ignored .env contains Oracle settings, Azure middle-tier credentials, public-client login settings and the optional corporate proxy. .env.example lists the names without real credentials. The demo explicitly uses secureCookie: false for localhost HTTP; the plugin defaults to secure cookies for HTTPS.

## Read the code

- `packages/nestjs-deepsec/index.js`: loads the shared driver plugin, creates/exports DEEPSEC_POOL, installs the HTTP request-scope interceptor, and closes the pool on shutdown.
- `packages/nestjs-deepsec/azure-login.js`: optional Azure device login, bounded server-side sessions, cookie resolution, expiry, logout, and login endpoints. Access tokens are never returned by these endpoints.
- `src/azure-session.strategy.ts`: Passport validates the existing opaque Azure session and returns its server-side identity.
- `src/azure-session.guard.ts`: the real NestJS session guard authenticates protected requests, stores the authenticated user in request-local CLS, and maps it to driver identity metadata.
- `src/app.module.ts`: initializes CLS middleware, registers the guard and injected identity mapper, configures optional azureLogin (public client/user scope) and poolOptions.endUserSecParams (middle-tier credentials/database scope).
- `src/database.service.ts`: receives DEEPSEC_POOL through injection. runQuery() still uses ordinary getConnection(), execute(), and close().
- `src/app.controller.ts`: GET /api/query is protected; GET /api/health is explicitly public and does not query Oracle.
- `src/azure-network.ts`: app-owned corporate proxy networking passed to both MSAL sign-in and the driver's Azure extension.
- `public/`: small sign-in button, verification link/code, query button and results table. No access tokens in browser storage or URLs.

Apps with existing authentication can omit azureLogin, retain their own guard (for example Passport), and configure mapIdentity for that guard's user shape. See the package README. This demo uses a real Passport custom strategy behind the NestJS cookie-session guard. It rejects Authorization headers on protected routes; use its Azure login session instead.

The guard permits @DeepSecPublic() health/login routes, reads only nonexpired authenticated sessions through the exported AzureLoginService.tokenForRequest(), and sets `cls.set('user', identity)` server-side. The adapter's mapper then forwards the token. No Oracle roles or attributes are invented: the optional fields remain unset until trusted app policy supplies them. No authentication endpoint returns the CLS identity or its token.

## Local driver and tests

The demo links `../drivers/node-oracledb`, because the previous published 6.10.0 package lacks the DeepSec APIs. The portable package itself uses peer dependencies. --preserve-symlinks keeps the app, adapter and driver on the same driver instance and allows the driver plugin to resolve app-installed MSAL. The earlier nestjs-deepsec project is not a runtime dependency.

```sh
npm test
```

Tests cover the original connection lifecycle, real driver-hook installation, bearer isolation across concurrent HTTP requests, optional-login behavior, cookie-session propagation into the real driver's async scope, expiry, logout, login failure, origin checking and shutdown. Database/Azure I/O is stubbed for these automated tests; they do not prove Oracle policy enforcement. Live verification results will be recorded separately.

The existing SELECT on DUAL returns DB_USER, DB_NAME and SERVER_TIME. Pool minimum is zero: startup and health do not prove a database connection. Query results use Cache-Control: no-store. Changing to individual user security does not change the SQL text. Stop a foreground server with Ctrl+C and rebuild after TypeScript changes.

Changes are developed in feature branches and reviewed before commits. .env, node_modules and dist are ignored. runQuery() was compared against the original basic-app snapshot and is byte-for-byte unchanged (SHA256 eb64fe71fd40296be22717c2ac6cc191d527b4ceff6f9366e35273db10fb5433, excluding surrounding blank lines).

## Verified checkpoint — 2026-11-23

Build and all nine tests passed. A real sign-in through the plugin's device-code endpoint completed successfully. Using only the returned opaque session cookie (no Authorization header), GET /api/query returned HTTP 200 in Thin mode against Oracle Database 26.1.0.24.0, with DB_USER=XS$NULL and DB_NAME=CDB1_PDB1. The entire original runQuery() method and SQL remained unchanged. Logout returned 201 and the same cookie subsequently received 401 on the query endpoint. Temporary test-session cookies were deleted after logout.

This verifies the optional login -> server-side user token -> driver OBO -> live query path. It does not constitute XS identity mapping or row-policy coverage. The updated demo was run on port 7003 because an existing process occupied 7002; that existing process was left alone.


## Guard and mapper integration checkpoint

The demo now exercises the authentication-guard -> CLS user -> mapIdentity ->
driver context path. Automated HTTP tests use the actual AzureSessionGuard and
mapDemoIdentity with stubbed Azure responses/database I/O. They cover public routes,
pending/forged/expired/logged-out sessions, rejected bearer headers, isolated users,
and keeping tokens out of HTTP responses. This checkpoint does not repeat the
historical live Azure/Oracle test above. The Passport checkpoint below extends this path.
The SQL and runQuery() are unchanged.


## CLS-based identity mapping

The app now uses `nestjs-cls` 7.0.2. Middleware creates an isolated CLS store before
its authentication guard runs. The guard resolves the authenticated session and
writes the user once. The configured mapper reads the current user's token, roles
and attributes from injected `ClsService`, without needing the HTTP request.

```ts
ClsModule.forRoot({ global: true, middleware: { mount: true } }),
DeepSecModule.forRootAsync({
  enableAzureLogin: true,
  inject: [ClsService],
  useFactory: cls => ({
    azureLogin, poolOptions,
    mapIdentity: () => mapDemoIdentity(cls),
  }),
}),
```

Other injected services can read `cls.get('user')` during the same asynchronous
request chain, without passing identity through service arguments. Treat the
stored identity as immutable and never return or log its access token. CLS does
not authenticate a request; the guard establishes that identity from MSAL's
server-side session. Public routes do not acquire a user identity.

The adapter remains independent of `nestjs-cls`; it invokes the configured
callback and establishes the driver's existing `runWithContext` scope. CLS holds
application identity metadata, while the driver constructs the Oracle EUSC.
Jobs and callbacks outside the originating request chain need explicit scopes.
Automated tests verify concurrent users across both CLS and driver contexts.
This checkpoint does not retest live Azure login or Oracle access.


## Minimal adoption in an existing app

Keep your authentication guard, existing CLS setup and pool provider. Configure
`DeepSecModule.forRootAsync` to inject that provider and return `pool`, one
`mapIdentity` callback and, if needed, an `isPublic` callback that reads the app's
existing route metadata. Controllers, services and their pool injection stay
unchanged. The adapter does not close externally supplied pools. Configure the
shared driver plugin and `endUserSecParams` when that pool is created; passing an
ordinary pool does not retrofit DeepSec.

For apps with existing authentication, omit built-in Azure login entirely. Async
configuration now registers its login routes only with `enableAzureLogin: true`,
which this demo explicitly sets. The package README contains the minimal example.
Automated tests exercise an unchanged service using its original pool token,
existing route metadata, concurrent CLS identities, absent optional login routes,
and pool ownership. They stub SQL and token acquisition and do not prove live
Azure/Oracle enforcement.


## Checkpoint 1: real Passport integration

`AzureSessionStrategy` extends Nest's `PassportStrategy` using `passport-custom`.
It authenticates the existing opaque session cookie through the server-side
`AzureLoginService`, rejecting missing/pending/expired/logged-out sessions and raw
Authorization headers. The user token originates from MSAL device login; no new
password grant, session store, or unsigned/decode-only JWT authentication is added.

`AzureSessionGuard` now extends `AuthGuard('azure-session')`. Passport authenticates
and sets `request.user`; only then does the guard copy it into the request-local
CLS store. The configured mapper and SQL stay unchanged. Public login/health
routes bypass authentication as before. `PassportModule.register({ session: false })`
turns off Passport/Express session serialization; it does not disable the existing
Azure session store used by this custom strategy.

Automated HTTP tests use the real Passport module/strategy/guard with stubbed Azure
responses and DB execution. They assert Passport's authenticated state and
`request.user` -> CLS identity, concurrent user isolation through awaited SQL,
rejected invalid sessions, logout and expiry, public routes, and no access-token
leak through query/login responses. They do not retest live Azure/Oracle access or
claim coverage of a separate Passport JWT/OIDC strategy.

The shared adapter has no Passport dependency. An existing app can keep its own
strategy and use its identity mapping; the strategy added here belongs to the demo.

## Following checkpoints

1. Review Passport integration before committing this checkpoint.
2. Exercise operation-level driver resolution and context cleanup, then consider
   changing the demo default. Do not share borrowed connections concurrently.
3. Define and test streaming cancellation/resource lifetime and background-job
   scope boundaries, including rejection when identity is missing.
4. Review authentication trust, token/session lifecycle, pool enforcement and
   expiry/revocation behavior. CLS itself is not authentication, and an existing
   pool must have the driver plugin configured before creation.

These are separate review checkpoints; this change does not claim they are complete.
