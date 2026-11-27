# Integrating DeepSec into a NestJS application
###### Build secure, multi-user REST APIs with Oracle AI Database, Microsoft Entra ID, and request-scoped security contexts

_Integrating DeepSec requires only a few configuration changes. Existing query methods and SQL remain unchanged._

Copy [deepsec.interceptor.ts](src/deepsec/deepsec.interceptor.ts) and [deepsec.definitions.ts](src/deepsec/deepsec.definitions.ts) into `src/deepsec/`. Your app compiles both files with its existing TypeScript build. Keep your existing authentication, database resources and query methods.

>Tested with NestJS 11, RxJS 7, reflect-metadata 0.2 and node-oracledb 26.0.0.

## 1. Import in app.module.ts

In **`src/app.module.ts`**, the application's root module:

```ts
import { DeepSecConfiguration } from './deepsec/deepsec.interceptor';
```

## 2. Configure identity mapping

**If your app already uses `ClsService` (the preferred setup),** add this to the existing **`@Module({ imports: [...] })`**:

```ts
// Configure how DeepSec reads the current authenticated user's identity.
DeepSecConfiguration.forRootAsync({
  inject: [ClsService],
  useFactory: (cls: ClsService) => ({
    mapIdentity: () => {
      const user = cls.get('user');
      return user ? { endUserToken: user.accessToken } : null;
    },
  }),
}),
```

Replace `'user'` and `.accessToken` with your app's fields.

**If CLS is not set up yet**, install it:

```sh
npm install nestjs-cls
```

Initialize it for HTTP requests in `src/app.module.ts`:

```ts
import { ClsModule } from 'nestjs-cls';

// Add to @Module({ imports: [...] }):
ClsModule.forRoot({ global: true, middleware: { mount: true } }),
```

In your existing authentication guard, inject `ClsService` and store the verified user after authentication succeeds:

```ts
// Add to the guard's existing constructor:
constructor(private readonly cls: ClsService) {}

// After authentication succeeds:
this.cls.set('user', authenticatedUser);
```

`mapIdentity` runs once per intercepted handler execution, after guards, unless skipped. It may return a Promise; null/undefined rejects execution before the handler runs. Login, token validation and renewal remain app-owned.

**CLS is preferred** for consistent identity access throughout asynchronous work. Though it **remains optional:** see the [mapper examples](#5-example-configurations-mapidentity). For other transports, the app must initialize CLS for each execution; HTTP middleware alone does not initialize WebSocket/RPC message contexts.

## 3. Enable, skip or customize DeepSec

- **Explicit interception (default):** place `@UseInterceptors(DeepSecInterceptor)` on a controller or an individual handler.
  For example, In `src/employees/employees.controller.ts`:

  ```ts
  import { Controller, UseInterceptors } from '@nestjs/common';
  import { DeepSecInterceptor } from '../deepsec/deepsec.interceptor';

  // Apply DeepSec identity mapping to all handlers in this controller.
  @UseInterceptors(DeepSecInterceptor)
  @Controller('employees')
  export class EmployeesController { /* existing handlers and guards */ }
  ```
####
- **Global interception (optional):** in `src/app.module.ts`, keep the mapping
  above and add these imports and provider:

  ```ts
  import { APP_INTERCEPTOR } from '@nestjs/core';
  import { DeepSecInterceptor } from './deepsec/deepsec.interceptor';

  // Add inside @Module({ providers: [...] }):
  { provide: APP_INTERCEPTOR, useExisting: DeepSecInterceptor },
  ```
  WebSocket gateways still need explicit registration.
####
- **Skip DeepSec:** can be used for explicitly skipping DeepSec on a particular controller/handler where an interceptor already applies, under global interception:

  ```ts
  import { SkipDeepSec } from '../deepsec/deepsec.interceptor'; // From src/employees/.

  @SkipDeepSec()
  @Get('health')
  health() { return { status: 'ok' }; }
  ```
  Unintercepted handlers need no skip decorator.
####
- **Customize roles:** override roles for an intercepted handler or controller:

  ```ts
  import { RunWithDataRoles } from '../deepsec/deepsec.interceptor'; // From src/employees/.

  @RunWithDataRoles(['SALARY_REPORT'])
  @Get('salary-report')
  salaryReport() { return this.service.salaryReport(); }
  ```

  Replaces roles rather than adding to them. Handler roles override controller roles; `[]` clears roles. Does not activate interception or override a skip. Choose roles from trusted app policy; Oracle must authorize them.

## 4. Add endUserSecParams to each database resource

**Required:** pass `endUserSecParams` directly to node-oracledb when creating each pool/standalone connection that should use DeepSec. `DeepSecConfiguration` only receives identity-mapping options; the interceptor never receives these settings.

Import the plugin **before a pool or connection is created**.

**Existing pool:**

```ts
const poolOptions = {
  ...existingPoolOptions,
  endUserSecParams: {
    spiType: 'azure', authFlow: 'onBehalfOf', contextResolution: 'operation',
    clientId, clientSecret, authority, scopes,
  },
};
const pool = await oracledb.createPool(poolOptions);
```

Configure once; borrow and query normally:

```ts
const connection = await pool.getConnection();
try {
  return await connection.execute(sql);
} finally {
  await connection.close();
}
```

**Standalone connection:**

```ts
const connectionOptions = {
  ...existingConnectionOptions,
  endUserSecParams: {
    spiType: 'azure', authFlow: 'onBehalfOf', contextResolution: 'operation',
    clientId, clientSecret, authority, scopes,
  },
};
const connection = await oracledb.getConnection(connectionOptions);
```

Each resource can have different settings; the mapped token must be accepted by its configured provider. Recreate existing resources to apply new settings. Use fresh options for each standalone call. The app owns resource creation, release and shutdown. Query methods need no identity arguments or `runWithContext()` calls.

The driver handles token exchange, caching and EUSC. The integration preserves subscription cleanup; it does not forcibly cancel Oracle I/O.

---
## Example configurations: mapIdentity

Replace the registration in step 2 with one matching configuration below. Keep authentication guards and interceptor registration. Examples assume imports from a file directly inside `src/`:

```ts
import { DeepSecConfiguration } from './deepsec/deepsec.interceptor';
```

### HTTP: Passport or custom guard

```ts
DeepSecConfiguration.forRoot({
  mapIdentity: context => {
    const user = context.switchToHttp().getRequest().user;
    return user ? { endUserToken: user.accessToken } : null;
  },
}),
```

Replace `.user` with your verified identity field, such as `.auth?.principal`, and `.accessToken` with your token field. Passport is optional.

### HTTP: server-side session

```ts
DeepSecConfiguration.forRoot({
  mapIdentity: context => {
    const user = context.switchToHttp().getRequest().session?.account;
    return user ? { endUserToken: user.accessToken } : null;
  },
}),
```

Replace `.session?.account` with your session's verified user location. The app must validate the session and its expiry; do not pass a session ID as a token.

### Socket.IO WebSocket gateway

```ts
DeepSecConfiguration.forRoot({
  mapIdentity: context => {
    const user = context.switchToWs().getClient().data.user;
    return user ? { endUserToken: user.accessToken } : null;
  },
}),
```

Replace `.data.user` with the identity established by your message guard. Attach the interceptor once to the gateway:

```ts
import { UseInterceptors } from '@nestjs/common';
import { WebSocketGateway } from '@nestjs/websockets';
import { DeepSecInterceptor } from './deepsec/deepsec.interceptor';

@WebSocketGateway()
@UseInterceptors(DeepSecInterceptor)
export class EmployeesGateway { /* existing handlers and guards */ }
```

The gateway's module must import the configured `DeepSecConfiguration`, directly or through a re-export. The app handles authentication, expiry and logout. Scope is per handler execution, not the socket's lifetime. CLS mapping can stay unchanged if the app initializes authenticated CLS for every message.

### RPC/microservices

```ts
DeepSecConfiguration.forRoot({
  mapIdentity: context => {
    const user = context.switchToRpc().getContext().user;
    return user ? { endUserToken: user.accessToken } : null;
  },
}),
```

`.user` is an app convention, not a Nest field. Replace it with your guard's verified identity location. TCP/Kafka/RMQ contexts differ. Message data from `.getData()` is not proof of identity. For hybrid apps using global interception, configure the server or pass `inheritAppConfig: true` to `connectMicroservice`.

### Multiple transports

```ts
DeepSecConfiguration.forRoot({
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
}),
```

Adapt each identity path. If CLS already supplies the authenticated user for every execution, use the mapper in step 2 instead of transport branches.

### Async lookup through an app service

```ts
import { AuthModule } from './auth/auth.module';
import { AuthService } from './auth/auth.service';

DeepSecConfiguration.forRootAsync({
  imports: [AuthModule],
  inject: [AuthService],
  useFactory: (auth: AuthService) => ({
    mapIdentity: async context => {
      const user = await auth.currentUser(context.switchToHttp().getRequest());
      return user ? { endUserToken: user.accessToken } : null;
    },
  }),
}),
```

Replace the module, service, method and token field. `AuthModule` must export the service.

### GraphQL

```ts
import { GqlExecutionContext } from '@nestjs/graphql';

DeepSecConfiguration.forRoot({
  mapIdentity: context => {
    const user = GqlExecutionContext.create(context).getContext().req?.user;
    return user ? { endUserToken: user.accessToken } : null;
  },
}),
```

Use the app's `@nestjs/graphql` dependency and replace `.req?.user` with your verified context field. Configure resolver enhancers and subscription auth as needed. In a mixed mapper, use `context.getType<string>()` for a `graphql` branch. This pattern is illustrative and has not been integration-tested.
