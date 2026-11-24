# Integrating the NestJS DeepSec plugin

The plugin connects an application's authenticated user to node-oracledb's DeepSec
provider. Configure the integration once; controllers and query methods do not
need token parameters or manual security-context calls.

## What the application configures

Keep the application's authentication. Its guard must authenticate protected
requests before the plugin reads the identity. A NestJS guard decides whether a
request may continue.

Import `DeepSecModule` in the application's NestJS module. A module groups and
registers the components Nest needs to run the application.

```ts
import { DeepSecModule } from 'nestjs-oracledb-deepsec';

// Add this to your module's imports. databaseConfig and deepsecConfig
// are your application's Oracle connection and driver-provider settings.
DeepSecModule.forRoot({
  poolOptions: {
    ...databaseConfig,
    endUserSecParams: deepsecConfig,
  },
  mapIdentity: request => request.user
    ? { endUserToken: request.user.accessToken }
    : null,
});
```

`mapIdentity` is a function the plugin calls for each protected request. It maps
an already authenticated user to an access token accepted by the configured
provider, plus optional trusted roles and attributes. Adapt it to the app's user
shape or identity service; Passport and CLS are optional. A missing or malformed
mapped identity is rejected before the handler runs.

Use the plugin-provided `DEEPSEC_POOL` when the plugin creates the pool. If the app
already owns a pool, supply `pool` instead of `poolOptions` and keep its existing
injection and shutdown code. That pool must already have DeepSec configured.
Align the app's authentication policy with the plugin's public-route policy;
handlers marked public must not perform protected database work.

## What happens automatically

```text
App authenticates the request
  -> plugin calls mapIdentity
  -> plugin establishes runWithContext(identity, handler)
  -> existing controller and query service execute
  -> shared driver resolves tokens and EUSC
  -> Oracle enforces database policies
```

The plugin registers a global interceptor: a NestJS component that wraps handler
execution. It calls the driver's `runWithContext()` to make the mapped identity
available along that request's asynchronous execution chain.

Nest represents handler execution using an RxJS Observable: work that starts when
subscribed to and can produce results, errors and completion. The interceptor
subscribes inside `runWithContext()` so handler execution starts in the correct
identity scope and subscription teardown is preserved.

The shared driver owns token exchange, caching and EUSC handling. The NestJS
plugin supplies the identity scope; it does not perform user login.

## What stays simple

Query methods continue to borrow a connection, execute SQL and release it:

```ts
const connection = await this.pool.getConnection();
try {
  return await connection.execute(sql);
} finally {
  await connection.close();
}
```

No per-handler mapping, token arguments or manual `runWithContext()` calls are
needed. This integration covers Nest HTTP handlers and their scoped asynchronous
work; detached jobs and other transports need separate integration. Supported
identity flows also depend on the configured driver provider and database.
