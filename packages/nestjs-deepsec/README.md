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
handler. When a mapper is configured, bearer headers and built-in login sessions
cannot provide a fallback.

Without a mapper, direct bearer forwarding and optional built-in session lookup
remain compatible. Bearer forwarding checks header syntax only; Azure validates
the assertion during OBO. This is not application-level HTTP authentication.

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

Sessions are bounded to 100 process-local entries, expire before token expiry
minus 30 seconds or after an hour, and clear on restart. Pending login expires
within ten minutes. No automatic renewal/shared store is implemented.

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
resolution. Offline tests cover both modes, including token changes, SQL-error
cleanup, and sequential identity isolation.

An independent shared-driver cleanup defect remains: initial OBO failure can
cause both execute and close to return NJS-198 before the underlying release
runs. Both modes are affected. Diagnostic tests reproduce this known failure;
they do not certify correct provider-failure cleanup. The driver is unchanged.
Background jobs, non-HTTP transports and streams consumed after the handler
subscription need explicit scope/resource integration.

NestJS, RxJS and oracledb are peers so the app and adapter share the driver instance.
No SQL, app credentials or corporate proxy addresses are hardcoded in the package.
