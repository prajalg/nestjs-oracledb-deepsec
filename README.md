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
  -> Passport session middleware -> req.user
  -> AzureSessionGuard sets cls.user -> mapDemoIdentity(cls)
  -> plugin runWithContext({ endUserToken, dataRoles, attributes })
  -> unchanged runQuery() -> shared driver plugin exchanges token -> Oracle
```

The ignored .env contains Oracle settings, Azure middle-tier credentials, public-client login settings and the optional corporate proxy. .env.example lists the names without real credentials. The demo explicitly uses secureCookie: false for localhost HTTP; the plugin defaults to secure cookies for HTTPS.

## Read the code

- `packages/nestjs-deepsec/src/index.ts`: loads the shared driver plugin, creates/exports DEEPSEC_POOL, installs the HTTP request-scope interceptor, and closes the pool on shutdown.
- `packages/nestjs-deepsec/src/azure-login.ts`: optional Azure device login, bounded server-side sessions, cookie resolution, expiry, logout, and login endpoints. Access tokens are never returned by these endpoints.
- `src/azure-session.serializer.ts`: Passport stores/restores the minimal server-side user and rejects expired credentials.
- `src/azure-session.guard.ts`: the real NestJS session guard authenticates protected requests, stores the authenticated user in request-local CLS, and maps it to driver identity metadata.
- `src/app.module.ts`: initializes CLS middleware, registers the guard and injected identity mapper, configures optional azureLogin (public client/user scope) and poolOptions.endUserSecParams (middle-tier credentials/database scope).
- `src/database.service.ts`: receives DEEPSEC_POOL through injection. runQuery() still uses ordinary getConnection(), execute(), and close().
- `src/app.controller.ts`: GET /api/query is protected; GET /api/health is explicitly public and does not query Oracle.
- `src/azure-network.ts`: app-owned corporate proxy networking passed to both MSAL sign-in and the driver's Azure extension.
- `public/`: small sign-in button, verification link/code, query button and results table. No access tokens in browser storage or URLs.

Apps with existing authentication can omit azureLogin, retain their own guard (for example Passport), and configure mapIdentity for that guard's user shape. See the package README. This demo uses standard Passport session restoration behind the NestJS cookie-session guard. It rejects Authorization headers on protected routes; use its Azure login session instead.

The guard permits @DeepSecPublic() health/login routes, requires Passport's restored, nonexpired authenticated user, and sets `cls.set('user', identity)` server-side. The adapter's mapper then forwards the token. No Oracle roles or attributes are invented: the optional fields remain unset until trusted app policy supplies them. No authentication endpoint returns the CLS identity or its token.

## Local driver and tests

The demo installs the published `oracledb@26.0.0` release, verified as latest in the configured npm registry when this change was made. It includes the DeepSec provider and operation-level context APIs. The adapter accepts `oracledb` as a peer dependency (`^26.0.0`), so app and adapter share the installed driver. No local driver checkout or `--preserve-symlinks` flag is required. The earlier nestjs-deepsec project is not a runtime dependency.

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


## Checkpoint 1: Passport integration

The first Passport checkpoint (`82385f4`) used a custom strategy. It has now been
replaced by standard Passport sessions, described below. Existing apps retain
their own authentication and serializer; the shared adapter does not require
Passport unless optional login explicitly enables that integration.

## Following checkpoints

1. Passport integration is committed as `82385f4`.
2. The demo now configures operation resolution explicitly, following the review.
   Offline component tests cover both modes and document the known cleanup defect.
3. Define and test streaming cancellation/resource lifetime and background-job
   scope boundaries, including rejection when identity is missing.
4. Review authentication trust, token/session lifecycle, pool enforcement and
   expiry/revocation behavior. CLS itself is not authentication, and an existing
   pool must have the driver plugin configured before creation.

These are separate review checkpoints; this change does not claim they are complete.


## Checkpoint 2: operation resolution, following the review

The demo explicitly configures `contextResolution: 'operation'` in
`poolOptions.endUserSecParams`. The existing shared driver resolves identity
before each supported database operation, installs EUSC for that operation and
clears it afterward. This does not require a new driver API, wrapper, interceptor
or query-method change. The Nest adapter still establishes one request scope.

The driver consults its token extension for each operation; cached tokens can be
reused, so resolution does not imply an Azure network request for every query.
The configured mode does not make concurrent connection sharing between users
safe. Continue borrowing/releasing within the request and awaiting its DB work.
For existing pools, configure operation resolution when creating the pool;
the adapter does not retrofit its configuration.

Offline component tests exercise the linked driver's execute/close wrappers,
provider, EUSC construction, serialization lock and Thin context set/clear.
Azure exchange and SQL/protocol I/O are stubbed; no database sockets are opened.
Coverage includes repeated operations, cached/refreshed token results, SQL-error
cleanup, sequential borrower isolation and connection-mode compatibility.

Two diagnostic tests reproduce the independent, unfixed shared-driver defect:
initial OBO failure causes execute and then close to return NJS-198 before the
underlying release runs. Both resolution modes are affected. Passing diagnostics
record this bug; they do not certify correct cleanup after provider failure.
The driver is unchanged per the user's request. Live Azure/Oracle verification
remains pending valid credentials; streaming/background work is the next checkpoint.


## Library replacement: session middleware

`express-session` now generates/signs session IDs, parses cookies and loads/saves
server-side sessions. Optional Azure login mounts this middleware automatically.
The local default uses `memorystore` with at most 100 sessions and expiry pruning.
A bounded `lru-cache` holds only nonserializable, in-flight MSAL device-login jobs.
There is no custom cookie parser, ID generator or session Map/sweep loop.

After Microsoft sign-in completes, the UI's existing status poll transfers the
completed result into the server-side session. Protected requests authenticate
only after that handoff. Expiry never exceeds token expiry minus 30 seconds or
one hour. Logout destroys the session and cancels pending work; late MSAL results
cannot restore a removed pending login. Session cookies are signed, HttpOnly and
SameSite=Strict; secure cookies remain the default (local demo explicitly uses HTTP).

`azureLogin.sessionStore` accepts an external express-session store;
`sessionSecret` supplies a persistent signing secret. The local default generates
a secret per process, so restart requires sign-in. A shared store needs the same
signing secret across processes, and in-flight device jobs still require process
affinity. This local configuration is not a complete production deployment.


## Library replacement: standard Passport sessions

The demo uses `PassportModule.register({ session: true })` and
`azureLogin.passportSession: true`. Optional-login middleware installs
express-session first, followed by Passport initialization/session restoration.
When the status poll sees completed MSAL login, `req.logIn()` invokes the app's
serializer and regenerates the session ID. Logout uses `req.logOut()` and destroys
the session. The old custom strategy and `passport-custom` dependency are removed.

`AzureSessionSerializer` persists a minimal token-bearing user **in the server-side
session store**, not the browser cookie. Deserialization rejects malformed/expired
users. The guard uses Passport's `isAuthenticated()` and bridges `req.user` to CLS.
Tests verify session-ID regeneration, old-cookie rejection and user isolation.
An existing app with its own Passport session setup does not install this demo's
middleware or serializer; it only configures the DeepSec mapper.


## Library replacement results

- Nest's `ConfigurableModuleBuilder` owns configuration-provider generation and
  async DI/import wiring; adapter-specific validation and mapping remain ours.
- `express-session` owns session IDs, signed-cookie parsing and session lifecycle;
  `memorystore` supplies bounded local storage. `lru-cache` holds pending MSAL jobs.
- Standard Passport session middleware and an application serializer replace the
  custom session lookup strategy. `passport-custom` is no longer a dependency.
- The proxy bridge is retained for driver compatibility. Installed MSAL accepts
  `system.proxyUrl`, but the shared driver's Azure extension accepts only a network
  client implementing `sendGetRequestAsync` and `sendPostRequestAsync`. Its HTTP
  implementation is not exported as a public MSAL API. Switching just login would
  leave the OBO bridge and add a second configuration path without removing code.
  No driver changes or private MSAL imports were introduced for this replacement.

All replacements are covered by offline tests. Live Azure/OBO/Oracle verification
still requires valid credentials. The known provider-failure cleanup defect in
the shared driver remains documented and unchanged.

The plugin is maintained in TypeScript. Root `npm run build` compiles it before
the demo; `npm pack` inside its directory builds a tarball containing JavaScript
and generated declarations. Consumers of the tarball need no plugin build step.

Published driver verification: the offline suite exercises `oracledb@26.0.0`.
The changed-cached-token EUSC regression is an explicit TODO/expected failure;
the provider-failure cleanup defect also remains reproducible in both modes.
See the package README for these limits. No shared-driver files are modified.
