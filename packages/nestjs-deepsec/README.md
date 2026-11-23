# NestJS DeepSec adapter

A small bridge from an application's authenticated identity to node-oracledb's
shared `endUserSecurityProvider`. Configure one mapper; controllers, services and
SQL keep using normal `getConnection()`, `execute()` and `close()` calls.

## Existing application: keep authentication, CLS and pool injection

If your app already has authentication and `nestjs-cls`, keep them. Add the
adapter import to the module that can access your existing pool provider:

```ts
DeepSecModule.forRootAsync({
  imports: [DatabaseModule], // exports your existing ORACLE_POOL provider
  inject: [ORACLE_POOL, ClsService, Reflector],
  useFactory: (pool, cls, reflector) => ({
    pool,
    // Reuse the same metadata key as your existing authentication guard.
    isPublic: context => reflector.getAllAndOverride(IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()]) === true,
    mapIdentity: () => {
      const user = cls.get('user'); // established by your authentication integration
      return user ? {
        endUserToken: user.accessToken,
        dataRoles: user.oracleRoles,
        attributes: user.oracleAttributes,
      } : null;
    },
  }),
});
```

`DatabaseModule`, `ORACLE_POOL`, `IS_PUBLIC_KEY` and user field names are app-specific.
Import `DeepSecModule` from `nestjs-oracledb-deepsec`, `ClsService` from `nestjs-cls`
and `Reflector` from `@nestjs/core`. Initialize CLS once in the app; do not repeat
`ClsModule.forRoot()` if it is already configured.

Your existing pool provider and service injection token stay unchanged. The adapter
returns that same pool through its optional `DEEPSEC_POOL` alias and never closes
an application-owned pool. Keep its existing shutdown owner.

**The existing pool must already be configured for DeepSec.** Register
`oracledb/plugins/token/endUserSecurityProvider` before creating it and add
`endUserSecParams` to its creation options. This adapter does not retrofit an
already-created ordinary pool or inspect/patch its private provider fields.
Mapping metadata into async context alone does not enable database enforcement.
Restart/recreate the pool after changing its creation configuration.

For the Azure OBO demo, `endUserSecParams` contains:

```ts
{
  spiType: 'azure',
  authFlow: 'onBehalfOf',
  contextResolution: 'operation',
  clientId: middleTierClientId,
  clientSecret: middleTierClientSecret,
  authority: tenantAuthority,
  scopes: [databaseResourceScope],
}
```

No demo authentication guard, Azure device login, UI or new route decorators are
required for an app that already establishes the identity. If existing auth sets
only `request.user`, omit CLS and read that object in `mapIdentity(request)`.
Passport does not automatically retain the Azure access token; your auth/token
store must make a suitable middle-tier access token available. An app's own session
JWT is not necessarily an Azure OBO assertion.

## Pool creation managed by the adapter

Apps without a pool provider can supply `poolOptions` instead of `pool`:

```ts
DeepSecModule.forRoot({
  poolOptions: {
    user, password, connectString,
    endUserSecParams: { /* driver configuration as above */ },
  },
  mapIdentity: request => request.user ? {
    endUserToken: request.user.accessToken,
  } : null,
});
```

Inject `DEEPSEC_POOL` in this mode. The adapter creates the pool and closes it on
application shutdown. Exactly one of `pool` or `poolOptions` is required. Both
`forRoot` and `forRootAsync` support either source. Only one configured pool per
module integration is currently supported.

## Identity mapping and route policy

The HTTP interceptor runs after authentication guards. It invokes
`mapIdentity(request, executionContext)` once per protected request; the callback
may be asynchronous and can read injected CLS or other request-local services.
With `forRootAsync`, the configuration factory runs once at startup, so return a
callback that reads identity later; do not capture a current user at startup.
`imports`, `inject` and a sync/async `useFactory` are supported.

A mapped identity requires a nonempty `endUserToken`; optional `dataRoles` is a
string array and `attributes` is a JSON object. Use only authenticated identity
and trusted application policy. The adapter checks shape and copies roles and
attributes into the request scope. It does not validate JWT signatures or replace
your authentication guard. Missing/malformed identity returns 401 before the
handler. `mapIdentity` is required for both synchronous and asynchronous registration.
There is no implicit bearer/session fallback, even when optional login is enabled.

For existing Passport/CLS apps, keep your current authenticated-user mapper.
For explicit token extraction, the package exports two small helpers:

```ts
import { mapBearerIdentity, mapSessionIdentity } from 'nestjs-oracledb-deepsec';

// The app's guard must authenticate/authorize requests before mapping.
DeepSecModule.forRoot({ poolOptions, mapIdentity: mapBearerIdentity });

// Built-in Azure login with passportSession disabled: read its server-side session.
DeepSecModule.forRoot({ poolOptions, azureLogin, mapIdentity: mapSessionIdentity });
```

The bearer helper checks syntax only; it does not verify signatures, audience,
issuer or HTTP authorization. The session helper reads only `request.session.identity`,
checks expiry, and ignores bearer headers. With `passportSession: true`, map the
user restored by Passport instead, as in the demo. Neither helper selects another
identity source when its expected identity is absent.

Migration: configurations that previously relied on automatic bearer/session
lookup must now set the corresponding helper explicitly. Existing custom mapper
configurations and business handlers need no changes.

`isPublic(executionContext)` reuses your app's existing public-route policy. It
must return an explicit boolean (sync or async). Without it, all HTTP handlers
require identity unless marked `@DeepSecPublic()`. That marker remains an explicit
bypass even with a custom policy; `DEEPSEC_PUBLIC_ROUTE` exports its metadata key.
Keep the app's auth guard and adapter policies consistent. Public handlers must
not execute protected database work: skipping DeepSec does not itself prohibit
ordinary database access outside a scope. Route policies are application-controlled,
not derived from an unvalidated user header or missing identity.

## Optional Azure device login

Existing authenticated apps do not configure this. For the included demo, add
`azureLogin` options; async configuration must also opt in to registering routes:

```ts
DeepSecModule.forRootAsync({
  enableAzureLogin: true,
  inject: [ClsService],
  useFactory: cls => ({
    poolOptions,
    azureLogin: {
      clientId: userLoginClientId,
      passportSession: true, // app supplies a Passport serializer and auth-to-CLS guard
      authority: tenantAuthority,
      scopes: [middleTierUserScope],
      // networkClient,       // optional corporate-proxy MSAL client
      // secureCookie: false, // local HTTP development only; default is true
    },
    mapIdentity: () => mapDemoIdentity(cls),
  }),
});
```

For synchronous `forRoot`, supplying `azureLogin` is the opt-in. Without opt-in,
none of `/deepsec/auth/start`, `/status` or `/logout` is registered. A mismatch
between async opt-in and resolved login configuration fails at startup.

When enabled, endpoints are:

- `POST /deepsec/auth/start`: starts device login, returning Microsoft's verification
  URL/user code and setting an opaque HttpOnly SameSite=Strict cookie.
- `GET /deepsec/auth/status`: reports signedOut, pending, authenticated or failed;
  pending status includes the device code, authenticated status includes username.
- `POST /deepsec/auth/logout`: cancels login/deletes the local session and clears
  its cookie; this is not Microsoft-wide sign-out.

Tokens remain server-side. Auth responses use no-store; start/logout reject
cross-origin requests. The app can inject exported `AzureLoginService` and call
`tokenForRequest(request)` in its guard. It returns a token only for a nonexpired,
authenticated session. Never return or log it. The demo's guard stores that identity
in CLS; another app can keep its own guard. MSAL is an optional peer for this login
feature (the driver's Azure extension also needs MSAL for OBO).

Optional login uses `express-session` for signed cookies and session storage,
with a bounded `memorystore` (100 entries) for local development. A bounded TTL
`lru-cache` holds only in-flight, nonserializable MSAL jobs. The UI status poll
hands the completed login into the session before protected queries can run.
No tokens are included in the browser cookie or returned by login endpoints.

Supply `azureLogin.sessionStore` to use an external express-session store and
`sessionSecret` for a stable signing secret. By default the secret is generated
per process and sessions require sign-in after restart. Share the signing secret
when sharing a store. Pending device jobs remain process-local and expire within
ten minutes; replicas need affinity or further job coordination. Authenticated
sessions expire no later than token expiry minus 30 seconds or one hour. No
automatic token renewal is implemented. The adapter stops/clears only its owned
local store on shutdown and leaves a supplied store's lifecycle to the app.
The extra session/cache packages are optional peers used only by built-in login.

## Context propagation and limits

The interceptor subscribes to Nest's handler inside the driver's `runWithContext`
scope and returns the subscription for error/cancellation teardown. The driver
handles OBO and EUSC construction/installation. CLS holds application identity;
the adapter does not create a second app CLS store or require CLS as a dependency.

The demo explicitly configures `contextResolution: 'operation'`, following the
review's recommended default for multi-user integration. The shared driver
resolves identity before each supported operation, installs EUSC and clears it
afterward. Its token extension can reuse cached tokens; each resolution does not
necessarily contact Azure. The adapter does not override an explicitly selected
mode or retrofit an existing pool. Configure the existing pool at creation time.

Connection resolution remains available for apps with strictly request-scoped
borrowing. Neither mode permits concurrent connection sharing between users.
Keep borrowing/releasing within the request and awaiting its database work.
No changes to query methods or the shared driver are needed to select operation
resolution. The demo pins published `oracledb@26.0.0`; the adapter's driver peer
range is `^26.0.0`. No local driver checkout is required. Offline tests cover both
modes, SQL-error cleanup, identity isolation and token replacement when the token
helper reports `isNewToken: true`.

Published 26.0.0 has a separate cache limitation: within one async scope, if a DB
token changes but the token helper reports `isNewToken: false` (a cache hit), the
provider reuses the previous encoded EUSC. The desired-behavior regression test
still runs as an explicit TODO/expected failure. This is not a passing guarantee
of cached-token refresh correctness. Keep request scopes short; applications
requiring that scenario need a driver release that fixes it. The adapter does not
patch driver internals or silently change the configured resolution mode.

An independent shared-driver cleanup defect remains: initial OBO failure can
cause both execute and close to return NJS-198 before the underlying release
runs. Both modes are affected. Diagnostic tests reproduce this known failure;
they do not certify correct provider-failure cleanup. The driver is unchanged.
Background jobs, non-HTTP transports and streams consumed after the handler
subscription need explicit scope/resource integration.

NestJS, RxJS and oracledb are peers so the app and adapter share the driver instance.
No SQL, app credentials or corporate proxy addresses are hardcoded in the package.


### Standard Passport session integration

The included demo sets `azureLogin.passportSession: true` and registers its
`AzureSessionSerializer` with `PassportModule.register({ session: true })`.
Built-in login then mounts session middleware, Passport initialization and
Passport session restoration in that order. The status endpoint calls `req.logIn`
when MSAL completes; Passport regenerates the ID and serializes the user into the
server-side session store. Logout calls `req.logOut` before destroying the session.
The app's serializer controls the persisted fields and token-expiry checks.
No access token is included in the browser cookie. Existing authenticated apps
should retain their own session middleware and serializer and omit built-in login.


## Building and packaging

The maintained implementation is TypeScript in `src/`. `npm run build` in this
package generates JavaScript and declarations together in `dist/`; do not edit
generated files. The demo's root `npm run build` builds the plugin before the app.

Run `npm pack` in this package to build and create a tarball. Only compiled output,
package metadata and documentation are packaged. Applications install that tarball
(or a future published version) and use JavaScript directly; they do not need
TypeScript or a plugin build step. There is no consumer install/prepare hook.
Existing root and named subpath imports are preserved through package exports.

`npm test` from the demo runs the offline integration suite and checks the packed
artifact from JavaScript and TypeScript consumers. The consumer check validates
generated declarations with library checking enabled and verifies invalid identity
configuration is rejected by the type checker.
