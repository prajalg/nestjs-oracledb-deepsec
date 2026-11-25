# NestJS plugin for Oracle Deep Data Security

Map your app's authenticated identity once. A global Nest interceptor makes it
available to the shared node-oracledb security provider during existing queries.
The plugin owns no database pool, connection, login or session.

## Install

From this package checkout, run `npm install` and `npm pack`. Then, in your app:

```sh
npm install /path/to/nestjs-oracledb-deepsec-0.1.0.tgz oracledb@26.0.0
```

Requires NestJS 11, RxJS 7 and reflect-metadata 0.2. Compiled JavaScript and types
are included. Passport and CLS are optional; keep whichever authentication and
request-context system the app already uses. Azure database-token exchange also
needs `@azure/msal-node` and a configured Oracle identity provider.

## 1. Configure one identity mapper

Add to your module's imports. Keep the app's authentication guards enabled:

```ts
DeepSecModule.forRoot({
  // The app's guard has authenticated request.user before this callback runs.
  mapIdentity: request => request.user
    ? { endUserToken: request.user.accessToken }
    : null,
});
```

For an app already using CLS:

```ts
DeepSecModule.forRootAsync({
  inject: [ClsService],
  useFactory: (cls: ClsService) => ({
    mapIdentity: () => {
      const user = cls.get('user');
      return user ? { endUserToken: user.accessToken } : null;
    },
  }),
});
```

The callback runs per request, after guards. Read the current identity inside it,
not at startup. It may return a promise, trusted `dataRoles` and JSON-compatible
`attributes`. Return null when identity is absent; protected handlers then fail
with 401. Login, token/role/attribute validation, expiry, renewal and permission checks stay
in the app. The plugin checks that a mapper exists and rejects a null or undefined identity. Supply an access token accepted by the driver exchange, not a username,
session ID, ID token or decoded claims.

Mark login and other routes that run without a database identity with
`@SkipDeepSec()` on their handler or controller. This does not bypass app guards.
See [authentication examples](examples/README.md) for other identity sources.

## 2. Enable the shared driver on existing resources

Import the plugin before creating your resources. Add the driver's
`endUserSecParams` to their existing creation options:

```ts
const poolOptions = {
  ...existingPoolOptions,
  endUserSecParams: {
    spiType: 'azure', authFlow: 'onBehalfOf', contextResolution: 'operation',
    clientId, clientSecret, authority, scopes,
  },
};
const pool = await oracledb.createPool(poolOptions);

const connectionOptions = {
  ...existingConnectionOptions,
  endUserSecParams: anotherResourceSettings,
};
const connection = await oracledb.getConnection(connectionOptions);
```

Load secrets from app configuration. Settings apply when the resource is created;
an already-open pool/connection must be recreated by its owner. Each pool or
standalone connection may use different settings. Create fresh options for each
standalone call, since driver hooks can add temporary fields during creation.
The mapped token must be accepted by each provider used in the request.

Keep existing injection tokens, borrowing, query execution, release and shutdown:

```ts
const connection = await this.pool.getConnection();
try {
  return await connection.execute(sql);
} finally {
  await connection.close();
}
```

No identity arguments or manual `runWithContext()` calls in query methods.
The plugin never creates, replaces, patches or closes database resources.

## Optional handler/controller scope

No decorator means use the globally configured mapping. Use decorators only
where scope differs:

```ts
@Get('employees')
findEmployees() { return this.service.findEmployees(); }

@DeepSec()
@Get('restricted')
findRestricted() { return this.service.findRestricted(); }

@SkipDeepSec()
@Get('health')
health() { return { status: 'ok' }; }

@DeepSec({ dataRoles: ['SALARY_REPORT'] })
@Get('salary-report')
salaryReport() { return this.service.salaryReport(); }
```

Both decorators also work on controllers. Method metadata overrides the entire
controller setting. `@DeepSec()` restores mapped roles; `dataRoles` replaces
mapped roles for that scope, and an empty array clears them. Configured roles are
trusted app code, not request input. Oracle must authorize their use; the
decorator alone grants no privilege. Other requests and mapped identities keep
their original roles.

`@SkipDeepSec()` skips only this plugin's scope. It never disables a login guard
or makes a route public. Keep authentication policy independent.

## Execution and limits

```text
App authentication -> mapIdentity -> global interceptor
  -> runWithContext(identity, handler) -> existing pool/connection
  -> shared driver -> Oracle policies
```

The interceptor subscribes to Nest's lazy Observable inside the driver's async
scope and returns the subscription for normal error/cancellation teardown.
The shared driver owns token exchange, caching and database security-context
installation/cleanup. The plugin supports HTTP handlers and awaited work in
that chain. Detached jobs, queues, other transports and streams consumed outside
it require their own integration. Do not share one connection concurrently
between users.

This token-based contract does not expose every database identity mechanism.
Automated tests verify the plugin boundary without live Azure/Oracle I/O. They
cannot establish database authorization or fix upstream driver behavior. Driver
26.0.0 has known cached-token refresh and initial provider-failure cleanup defects;
validate your intended driver version and policies before production use.

## Contributors

`npm test` builds, type-checks examples, tests real Nest HTTP pipelines and checks
the packed package as a consumer. Coverage includes existing pools, standalone
calls, concurrent users, missing identity, decorator precedence, scoped roles,
Observable errors and cancellation teardown. All public tests must pass; there
are no expected-failure or skipped tests. Tests are excluded from the npm archive.
