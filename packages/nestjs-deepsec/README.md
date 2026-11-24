# NestJS DeepSec adapter

A small HTTP adapter around the shared node-oracledb DeepSec provider. It reads
identity established by the application's authentication guard and wraps handler
execution in the driver's `runWithContext()` scope. Controllers and query methods
continue using node-oracledb normally.

The package owns no authentication, Azure login, Passport setup, CLS store,
session middleware, cookie, token-renewal flow or login endpoints. These belong to
the application. Passport, custom guards, sessions and CLS are supported through
one callback, not separate authentication branches inside the adapter.

## Existing authenticated app

```ts
DeepSecModule.forRoot({
  poolOptions: {
    ...yourOraclePoolOptions,
    // Passed unchanged to the SHARED DRIVER; the driver owns OBO/token caching/EUSC.
    endUserSecParams: {
      spiType: 'azure', authFlow: 'onBehalfOf', contextResolution: 'operation',
      clientId, clientSecret, authority, scopes,
    },
  },
  // Runs per protected request, AFTER your auth guard. request.user is YOUR
  // convention, not a requirement of the adapter or evidence of Passport use.
  mapIdentity: request => request.user ? {
    endUserToken: request.user.accessToken,
    dataRoles: request.user.oracleRoles,
    attributes: request.user.oracleAttributes,
  } : null,
});
```

Your guard must authenticate/authorize the request before mapping. The callback
must provide an ACCESS token suitable for the configured exchange. A username,
session ID, ID token or JWT claims object alone is insufficient. Do not treat JWT
decoding as signature/issuer/audience validation. Only use trusted app policy for
roles/attributes. The adapter validates shape and takes a snapshot; it does not
validate authentication cryptographically or grant database permissions.

## Other authentication setups

There is no required property name or storage library. Choose one integration:

```ts
// Passport or a custom guard that sets request.user:
mapIdentity: req => req.user ? { endUserToken: req.user.accessToken } : null

// Your own authentication guard uses a different request property:
mapIdentity: req => req.auth?.principal
  ? { endUserToken: req.auth.principal.accessToken } : null

// App-owned server-side session, already authenticated and checked for expiry:
mapIdentity: req => req.session?.account
  ? { endUserToken: req.session.account.accessToken } : null
```

For an existing CLS setup, inject its service once and read identity inside the
per-request callback. Do not capture a user in the startup factory:

```ts
DeepSecModule.forRootAsync({
  imports: [ExistingDatabaseModule],
  inject: [EXISTING_POOL, ClsService],
  useFactory: (pool, cls) => ({
    pool,
    mapIdentity: () => {
      const user = cls.get('user'); // Your guard placed a trusted user here.
      return user ? { endUserToken: user.accessToken,
        dataRoles: user.oracleRoles, attributes: user.oracleAttributes } : null;
    },
  }),
});
```

The package does not import `nestjs-cls`; this is an application dependency only
when the app chooses it. The package's `examples/auth-configurations.ts`
contains commented, type-checked request-user, custom-auth, server-session, CLS
and async-resolver examples. Existing auth guards remain in place; no changes to
every controller/service are required to pass identity arguments.

## Configuration and pool ownership

`mapIdentity(request, executionContext)` is required, may be sync/async, and is
called once per protected HTTP request. Return `{ endUserToken, dataRoles?,
attributes? }` or null/undefined to reject. Missing/malformed identity returns 401
before the handler, without trying headers or another session as a fallback.

Supply exactly one of `poolOptions` and `pool`. With `poolOptions`, the adapter
creates the pool and drains/closes it on app shutdown. With `pool`, the app retains
its existing pool injection and lifecycle. An existing pool must be created with
DeepSec configured; this adapter cannot retrofit that setting. A supplied pool is
not inspected through private driver properties. The app must enable Nest shutdown
hooks if it wants signal-triggered pool shutdown.

`endUserSecParams` is forwarded unchanged and checked by the driver. The adapter
does not restrict provider configuration to Azure, although its current identity
contract requires an end-user token and does not expose named-user/key contexts.
Provider/token compatibility is separate from supporting an application's
authentication library. The Azure OBO configuration above is one provider example;
applications must obtain tokens accepted by their configured provider.

`forRootAsync` supports `imports`, `inject` and factory-based `useFactory`. The
factory runs at startup; the returned identity callback runs per request.

## Public routes

`@DeepSecPublic()` skips the adapter's identity scope. Or provide
`isPublic(executionContext)` to read your app's existing public-route metadata.
That callback must return an explicit boolean and can be asynchronous. The
explicit decorator remains a bypass even with a custom callback.

Keep authentication-guard and adapter route policies consistent. Skipped handlers
must not execute protected SQL: skipping DeepSec does not prohibit ordinary DB
login outside a scope. Mark routes public only when they do not require an
end-user database context.

## Context propagation and limits

The interceptor subscribes inside the driver's async scope and returns the RxJS
subscription for error/cancellation teardown. This covers ordinary awaited work
and tested Observable lifecycles. It is an HTTP adapter: WebSockets, microservices,
queues and streams consumed outside the subscription need their own scope and
resource integration. Do not claim universal transport support or share one
connection concurrently between different users.

With `contextResolution: 'operation'` as configured above, the driver resolves
identity before supported operations and can reuse cached tokens. Connection
resolution remains configurable for strictly request-scoped borrowing. Keep
database work awaited and release borrowed connections.

Published 26.0.0 has a cache limitation: within one async scope, when the DB token
changes but the token helper reports `isNewToken: false`, the provider can reuse
the old encoded EUSC. An opt-in upstream diagnostic asserts the desired replacement behavior and fails
on this driver. It is outside the adapter release suite; the limitation remains
part of driver compatibility, not a fixed or passing guarantee.

A separate provider-failure cleanup defect can cause both execute and close to
return NJS-198 before underlying release. Both resolution modes are affected.
Opt-in diagnostics assert correct cleanup and fail while this defect remains. No shared driver
files are modified and the adapter does not patch driver internals.

## Build and package

Maintainers edit TypeScript in `src/`. `npm run build` cleans `dist/` and generates
JavaScript/declarations. Cleaning prevents stale output from entering a tarball.
`npm pack` builds before packing. Consumers install compiled output; they need no TypeScript/plugin build step or install/prepare hook.

Nest, RxJS and node-oracledb are peers so the app and adapter share instances.
The runtime package has no Passport, CLS, MSAL, Express or session dependency. The shared
driver may separately require MSAL when its Azure provider is selected by the app.

## Package-local examples and tests

`examples/auth-configurations.ts` is included in the npm tarball so application
developers can inspect/copy the integration pattern that matches their setup.
See `examples/README.md`; examples never become runtime dependencies of the core.

From this directory, contributors run `npm install` then `npm test`. The package
builds itself, type-checks examples and runs its own `test/` suite. Test-only
Passport, CLS, session and MSAL packages are dev dependencies; they are not runtime dependencies or required peers. The example
that uses CLS requires CLS in the consuming app only if that example is chosen.

`test/README.md` describes the public contract suite: `npm test` exercises normal
assertions, and the suite contains no TODOs/skips. `prepublishOnly` runs that same suite.
Coverage includes real Passport strategies, custom sessions, optional CLS, pool
ownership, identity isolation and Observable teardown through Nest HTTP apps.
Packed-consumer checks verify CommonJS/ESM imports and TypeScript declarations
without optional authentication libraries. These checks require no live Azure or
Oracle credentials and do not verify database authorization policies.

Driver-internal regressions live in `diagnostics/`, outside default test discovery.
Run `npm run test:driver-diagnostics` explicitly; it asserts desired driver behavior
and currently fails on the documented upstream defects. This separation does not
remove or fix those compatibility limits. Both `test/` and `diagnostics/` stay in
source control and are excluded from the npm tarball. See their READMEs.

The package remains marked `private: true` to prevent accidental publication.
`npm pack` produces the installable artifact; actual npm publication requires
intentional publication metadata/ownership decisions as well as passing checks.
