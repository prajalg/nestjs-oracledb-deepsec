# NestJS plugin for Oracle Deep Data Security

Map your app's authenticated identity once. A global Nest interceptor makes it
available to the shared node-oracledb security provider during existing queries.
The plugin owns no database pool, connection, login or session.

> **Important: module options and driver settings are separate.**
> `DeepSecModule.forRoot()` / `forRootAsync()` configure `mapIdentity`.
> The interceptor never receives pool or connection settings.
> Each resource passes its own `endUserSecParams` directly to node-oracledb
> when the app calls `createPool()` or standalone `getConnection()`.
> Configure a pool once; borrowing with `pool.getConnection()` needs no repeated settings.

## Install

From this package checkout, run `npm install` and `npm pack`. Then, in your app:

```sh
npm install /path/to/nestjs-oracledb-deepsec-0.2.0.tgz oracledb@26.0.0
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
  mapIdentity: context => {
    const user = context.switchToHttp().getRequest().user;
    return user ? { endUserToken: user.accessToken } : null;
  },
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

The callback receives Nest ExecutionContext and runs per handler execution, after guards. Read the current identity inside it,
not at startup. It may return a promise, trusted `dataRoles` and JSON-compatible
`attributes`. Return null when identity is absent to reject execution. To control the response,
throw your transport's exception in the mapper or authentication guard (for example,
UnauthorizedException for HTTP or WsException for WebSockets). The plugin throws
a plain Error for a null identity, which the app's exception handling formats. Login, token/role/attribute validation, expiry, renewal and permission checks stay
in the app. The plugin checks that a mapper exists and rejects a null or undefined identity. Supply an access token accepted by the driver exchange, not a username,
session ID, ID token or decoded claims.

Mark login and other routes that run without a database identity with
`@SkipDeepSec()` on their handler or controller. This does not bypass app guards.
See [example configurations](#example-configurations) at the end for other
authentication setups and transports, with the fields to replace.

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
installation/cleanup. The interceptor uses the same scope for each Nest handler
execution, regardless of transport. The app supplies the matching identity mapper
and interceptor registration. Detached jobs and streams consumed outside the
handler chain require their own integration. Do not share one connection concurrently
between users.

This token-based contract does not expose every database identity mechanism.
Automated tests verify the plugin boundary without live Azure/Oracle I/O. They
cannot establish database authorization or fix upstream driver behavior. Driver
26.0.0 has known cached-token refresh and initial provider-failure cleanup defects;
validate your intended driver version and policies before production use.

## Contributors

`npm test` builds, tests real Nest HTTP and TCP message pipelines and checks
the packed package as a consumer. Coverage includes existing pools, standalone
calls, concurrent users, missing identity, decorator precedence, scoped roles,
Observable errors and cancellation teardown. All public tests must pass; there
are no expected-failure or skipped tests. Tests are excluded from the npm archive.

## Example configurations

Keep your app's existing login, authentication guards and database queries.
Choose one configuration below and put it in your module's `imports`.
No extra example files or wrapper functions are needed.

### Start here: HTTP with an authenticated user

If your guard sets `request.user.accessToken`, add this to `app.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { DeepSecModule } from 'nestjs-oracledb-deepsec';

@Module({
  imports: [
    // Keep your existing auth and database modules.
    DeepSecModule.forRoot({
      mapIdentity: context => {
        const user = context.switchToHttp().getRequest().user;
        return user ? { endUserToken: user.accessToken } : null;
      },
    }),
  ],
  // Keep your existing controllers and providers.
})
export class AppModule {}
```

This works with Passport or a custom guard. The plugin does not require Passport.
`mapIdentity` runs after guards for each handler execution. It reads the identity
that your authentication layer has already verified.

**If your app uses different fields, replace these expressions:**

| In the example | Replace with your app's field, for example |
| --- | --- |
| `.getRequest().user` | `.getRequest().identity` or `.getRequest().auth?.principal` |
| `user.accessToken` | `user.token` |

Example: if your guard stores `request.identity.token`, replace the mapper with:

```ts
mapIdentity: context => {
  const user = context.switchToHttp().getRequest().identity;
  return user ? { endUserToken: user.token } : null;
}
```

For the setups below, **replace the existing DeepSec registration** with the one
shown. Register the plugin once; do not add all these examples together.

### HTTP with a server-side session

If your session holds the verified identity in `request.session.account`:

```ts
DeepSecModule.forRoot({
  mapIdentity: context => {
    const user = context.switchToHttp().getRequest().session?.account;
    return user ? { endUserToken: user.accessToken } : null;
  },
});
```

Replace `.session?.account` with your user location, such as `.session?.user`.
Keep your session middleware and guard's expiry checks. Pass the access token,
not the session ID.

### Existing CLS setup

Use `forRootAsync` when Nest must inject the app's existing context service:

```ts
import { ClsService } from 'nestjs-cls';
import { DeepSecModule } from 'nestjs-oracledb-deepsec';

// In your module's imports, alongside your existing global ClsModule setup:
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

Replace `'user'` with your CLS key and `.accessToken` with your token field.
Keep your app's typed `ClsService<YourStore>` if you already use one.
Read the user **inside `mapIdentity`**, not once in `useFactory` at startup.

The callback can ignore `ExecutionContext`. It can stay the same across transports
if the app creates an isolated CLS context and stores its authenticated user for
each execution. HTTP CLS middleware alone does not initialize WebSocket or RPC
message contexts. CLS is optional; the other examples do not require it.

### Socket.IO WebSocket gateway

If your message guard establishes `client.data.user`:

```ts
DeepSecModule.forRoot({
  mapIdentity: context => {
    const user = context.switchToWs().getClient().data.user;
    return user ? { endUserToken: user.accessToken } : null;
  },
});
```

Replace `.data.user` with your authenticated socket user location. Other WebSocket
libraries may store it elsewhere. Also register the interceptor once on the gateway:

```ts
import { UseInterceptors } from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';
import { DeepSecInterceptor } from 'nestjs-oracledb-deepsec';

@WebSocketGateway()
@UseInterceptors(DeepSecInterceptor)
export class EmployeesGateway { /* keep existing handlers and guards */ }
```

Make the configured DeepSec module visible to the gateway's module. Nest gateways
do not inherit the HTTP global interceptor. The app still authenticates messages
and handles expiry/logout. Scope applies per handler, not for the socket's lifetime.

### RPC/microservices

Example: your RPC guard attaches a verified user to the transport context:

```ts
DeepSecModule.forRoot({
  mapIdentity: context => {
    const user = context.switchToRpc().getContext().user;
    return user ? { endUserToken: user.accessToken } : null;
  },
});
```

Replace `.getContext().user` with the verified identity location your guard uses.
Nest does not create `.user`. TCP, Kafka, RMQ and other transports have different
context objects. `.getData()` reads the message payload; it does not authenticate
caller-supplied identity or roles.

Standalone microservices use the global interceptor. A hybrid HTTP/microservice
app must enable interception for its microservice server too, for example with
`inheritAppConfig: true` when calling `connectMicroservice`.

### Several transports in one app

Use one mapper with a branch for each transport your app actually handles:

```ts
DeepSecModule.forRoot({
  mapIdentity: context => {
    let user;
    switch (context.getType()) {
      case 'http': user = context.switchToHttp().getRequest().user; break;
      case 'ws': user = context.switchToWs().getClient().data.user; break;
      case 'rpc': user = context.switchToRpc().getContext().user; break;
      default: throw new Error('Configure identity mapping for this execution type');
    }
    return user ? { endUserToken: user.accessToken } : null;
  },
});
```

Replace the user paths as above. Keep guards and interceptor registration for
each server/gateway. If your app already supplies CLS for every execution, use
the CLS mapper instead of transport branches.

### Async lookup using your auth service

If an existing Nest service resolves the current identity, inject it:

```ts
import { DeepSecModule } from 'nestjs-oracledb-deepsec';
import { AuthModule } from './auth/auth.module';
import { AuthService } from './auth/auth.service';

// In your module's imports:
DeepSecModule.forRootAsync({
  imports: [AuthModule],
  inject: [AuthService],
  useFactory: (auth: AuthService) => ({
    mapIdentity: async context => {
      const request = context.switchToHttp().getRequest();
      const user = await auth.currentUser(request);
      return user ? { endUserToken: user.accessToken } : null;
    },
  }),
});
```

Replace `AuthModule`, `AuthService` and `currentUser` with your existing module,
service and method. The auth module must export the service. Replace
`.accessToken` with your token field.

### GraphQL

Use the app's existing `@nestjs/graphql` dependency:

```ts
import { GqlExecutionContext } from '@nestjs/graphql';
import { DeepSecModule } from 'nestjs-oracledb-deepsec';

DeepSecModule.forRoot({
  mapIdentity: context => {
    const user = GqlExecutionContext.create(context).getContext().req?.user;
    return user ? { endUserToken: user.accessToken } : null;
  },
});
```

Replace `.req?.user` with your authenticated GraphQL context field, such as
`.user`. Configure resolver enhancers and subscription authentication as needed.
For a mixed app, use `context.getType<string>()` to add a `graphql` branch to its
mapper. GraphQL is an illustrative pattern, not an integration-tested setup.

### Optional roles and attributes

In any mapper, replace its returned identity with this if your app supplies
trusted policy metadata:

```ts
return user ? {
  endUserToken: user.accessToken,
  dataRoles: user.oracleRoles,
  attributes: user.oracleAttributes,
} : null;
```

Replace `oracleRoles` and `oracleAttributes` with your app's policy fields.
Leave out fields you do not need. Use JSON-compatible attributes. Do not trust
roles or attributes supplied directly by a caller; Oracle must authorize roles.

### What stays the app's responsibility

- Keep authentication, token validation, expiry and renewal in the app.
- Supply an access token accepted by the configured driver provider, not a
  session ID, ID token or decoded claims object.
- Returning null rejects execution with a plain Error. For a specific response,
  throw your transport's exception from the guard or mapper, such as
  `UnauthorizedException`, `WsException` or `RpcException`.
- Keep `endUserSecParams` on each existing pool/standalone connection. The
  interceptor never receives those settings. Query code stays unchanged.
- Use `@SkipDeepSec()` for handlers such as login that need no mapped identity;
  this does not bypass app authentication guards.

See [resource settings](#2-enable-the-shared-driver-on-existing-resources) and
[scope decorators](#optional-handlercontroller-scope) above.
