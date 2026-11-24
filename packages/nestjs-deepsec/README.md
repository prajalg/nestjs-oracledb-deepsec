# NestJS plugin for Oracle Deep Data Security

Connect your app's authenticated user to Oracle Deep Data Security (DeepSec).
Configure the plugin once. Your controllers and query methods do not need token
arguments or manual `runWithContext()` calls.

## What changes in your app?

1. Keep your existing login and authentication guards.
2. Register `DeepSecModule` with your database and DeepSec settings.
3. Provide one `mapIdentity` function to read the signed-in user's access token.
4. Use the configured pool for database work.

Passport and CLS are optional. The plugin reads the identity your app supplies;
your app remains responsible for login, token validation, expiry and renewal.

## 1. Install

This package is currently private. From the package source directory, build an
installable archive:

```sh
npm install
npm pack
```

Then, from your NestJS application:

```sh
npm install /path/to/nestjs-oracledb-deepsec-0.1.0.tgz oracledb@26.0.0
```

The package expects NestJS 11, RxJS 7 and reflect-metadata 0.2. Consumers install
compiled JavaScript and types; they do not need to build the plugin.
For the Azure driver provider, also install `@azure/msal-node`.

Your database must already have DeepSec and its identity provider configured.
The app must obtain an access token accepted by that provider.

## 2. Register the plugin once

A NestJS module registers the parts of your app. Add `DeepSecModule` to your
module's `imports`. Keep your existing authentication module and guards enabled.

This example uses Azure On-Behalf-Of (OBO) to obtain a database token for the user:

```ts
import { Module } from '@nestjs/common';
import { DeepSecModule } from 'nestjs-oracledb-deepsec';

@Module({
  imports: [
    DeepSecModule.forRoot({
      poolOptions: {
        user: process.env.NODE_ORACLEDB_USER,
        password: process.env.NODE_ORACLEDB_PASSWORD,
        connectString: process.env.NODE_ORACLEDB_CONNECTIONSTRING,
        walletLocation: process.env.NODE_ORACLEDB_WALLET_LOCATION,
        walletPassword: process.env.NODE_ORACLEDB_WALLET_PASSWORD,
        endUserSecParams: {
          spiType: 'azure',
          authFlow: 'onBehalfOf',
          contextResolution: 'operation',
          clientId: process.env.AZURE_DB_CLIENT_ID,
          clientSecret: process.env.AZURE_DB_CLIENT_CREDENTIAL,
          authority: process.env.AZURE_DB_AUTHORITY,
          scopes: (process.env.AZURE_DB_SCOPES ?? '')
            .split(/[\s,]+/).filter(Boolean),
        },
      },
      // Your authentication guard must establish this user first.
      mapIdentity: request => request.user
        ? { endUserToken: request.user.accessToken }
        : null,
    }),
  ],
  // Keep your existing controllers and providers here.
})
export class AppModule {}
```

Load and validate these environment settings before creating the module.
`endUserSecParams` is passed to the shared node-oracledb provider. These are
settings for the database token exchange, separate from your app's login settings.

`mapIdentity` runs once per protected HTTP request, after Nest guards. Return an
access token, with optional trusted roles and attributes:

```ts
return {
  endUserToken: user.accessToken,
  dataRoles: user.oracleRoles,       // Optional string array
  attributes: user.oracleAttributes, // Optional JSON-compatible object
};
```

A missing or malformed mapped identity returns 401 before the handler runs.
Supply an access token, not a username, session ID, ID token or decoded claims.
The plugin checks the identity's shape; it does not authenticate the user.

## 3. Use the pool in your service

When you supply `poolOptions`, the plugin creates the pool and exports it as
`DEEPSEC_POOL`. Inject it into a provider in the module that imports `DeepSecModule`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'oracledb';
import { DEEPSEC_POOL } from 'nestjs-oracledb-deepsec';

@Injectable()
export class EmployeesService {
  constructor(@Inject(DEEPSEC_POOL) private readonly pool: Pool) {}

  async findAll() {
    const connection = await this.pool.getConnection();
    try {
      return await connection.execute('SELECT * FROM hr.employees');
    } finally {
      await connection.close();
    }
  }
}
```

Query methods still use ordinary `getConnection()`, `execute()` and `close()`.
Keep controllers calling these services as usual.

The plugin closes a pool it creates during application shutdown. Enable
`app.enableShutdownHooks()` in your bootstrap code for signal-triggered shutdown.

### Already have a pool?

Pass `pool` instead of `poolOptions`. Keep your existing pool injection, query
methods and shutdown code. The pool must have been created with DeepSec enabled;
the plugin cannot add that setting to an existing pool.

Use `forRootAsync({ imports, inject, useFactory })` when the pool or configuration
comes from another Nest provider. Import the module that exports that provider.
For services in another feature module, make the configured pool provider
available through Nest module imports and exports as usual.

## Other authentication setups

Change only the mapping to match your app's authenticated identity:

```ts
// A custom guard stores the authenticated user on request.auth:
mapIdentity: req => req.auth?.principal
  ? { endUserToken: req.auth.principal.accessToken }
  : null

// An authenticated server-side session stores the account:
mapIdentity: req => req.session?.account
  ? { endUserToken: req.session.account.accessToken }
  : null
```

For CLS or an identity service, inject that service through `forRootAsync` and
read the current user inside `mapIdentity`. The callback can also be asynchronous.
Read the user per request, rather than capturing one at startup.

See the [integration examples](examples/README.md) for request-user, custom-auth,
session, CLS and async identity mappings. Use the example that matches your app.

## How this simplifies your code

```text
App authenticates request
  -> plugin reads mapIdentity
  -> plugin opens the driver's runWithContext(identity, ...) scope
  -> existing controller and service run their queries
  -> shared driver resolves tokens and the end-user security context (EUSC)
  -> Oracle enforces its data-access policies
```

The plugin registers a global interceptor: NestJS code that wraps request
handlers. It starts the handler inside the driver's asynchronous identity scope,
so database calls can read that request's identity without extra function
arguments. Nest's Observable subscription and teardown are preserved.

The shared driver handles token exchange, caching and EUSC installation/cleanup.
The plugin connects that driver behavior to Nest requests.

## Public routes

Mark routes that do not need an end-user database context:

```ts
import { DeepSecPublic } from 'nestjs-oracledb-deepsec';

@DeepSecPublic()
@Get('health')
health() { return { status: 'ok' }; }
```

Make your authentication guard recognize the same public routes. You can also
configure `isPublic(executionContext)` to read your existing route metadata; it
must return a boolean. `@DeepSecPublic()` always skips the plugin's identity scope.
A public handler must not perform protected database work: skipping the scope
does not prevent ordinary database access through the pool account.

## Current support and limits

- Supports Nest HTTP handlers and database work within their asynchronous scope.
  Detached jobs, other transports and streams consumed outside that scope need
  separate integration. Keep work awaited and release connections after use.
- Requires an end-user token. Named local users and application-only identities
  are not exposed by this plugin. Authentication-library independence does not
  mean every identity provider or database authentication flow is supported.
- The installed shared provider supports Azure and OCI; OBO requires Azure.
  Azure OBO has automated coverage. OCI integration has not been verified here.
- Driver 26.0.0 has known token-cache and provider-failure cleanup defects. A
  changed cached token can reuse an older EUSC; initial token-exchange failure can
  prevent connection release with NJS-198. The plugin does not fix these defects.

## For contributors

Run `npm test` from the package directory to build, type-check examples and test
public plugin behavior and packed consumers. Tests need no live Azure or Oracle
credentials; database authorization policies require separate live checks.

Driver reproductions stay in the source checkout's `diagnostics/` directory.
`npm run test:driver-diagnostics` runs them separately and currently fails on the
known driver defects. Contributor tests and diagnostics are excluded from the
installable archive; integration examples are included.
