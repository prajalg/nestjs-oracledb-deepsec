# NestJS DeepSec adapter

A small portable bridge to node-oracledb's endUserSecurityProvider, with optional Azure user sign-in for apps that do not already obtain user tokens.

```ts
@Module({
  imports: [DeepSecModule.forRoot({
    azureLogin: {                    // optional: omit for existing bearer-token apps
      clientId: userLoginClientId,   // public client with device-code flow enabled
      authority: tenantAuthority,
      scopes: [middleTierUserScope],
      // networkClient,             // optional corporate-proxy MSAL client
      // secureCookie: false,       // local HTTP development only; defaults to true
    },
    poolOptions: {
      user, password, connectString,
      endUserSecParams: {
        spiType: 'azure', authFlow: 'onBehalfOf',
        clientId: middleTierClientId,
        clientSecret: middleTierClientSecret,
        authority: tenantAuthority,
        scopes: [databaseResourceScope],
      },
    },
  })],
  providers: [DatabaseService],
})
export class AppModule {}

@Injectable()
export class DatabaseService {
  constructor(@Inject(DEEPSEC_POOL) private readonly pool: oracledb.Pool) {}
  // Existing getConnection()/execute()/close() code stays unchanged.
}
```

## Identity sources

1. Existing app authentication: configure `mapIdentity` to read the identity established by your authentication guard (see below).
2. Direct bearer forwarding: omit `azureLogin` and send Authorization: Bearer <user-token>. This is not local HTTP authentication; Azure validates the token when OBO runs.
3. Plugin-owned authentication: configure azureLogin and use the endpoints below. The plugin stores the resulting user token in server memory, associates it with an opaque HttpOnly SameSite=Strict cookie, and resolves that identity for subsequent requests. The browser never receives an access token.

For all identity sources the interceptor calls the shared driver's runWithContext({ endUserToken }, ...). The driver plugin performs Azure OBO exchange to obtain the **database** token and constructs the Oracle security context. Sign-in does not replace that database-token exchange.

## Optional login endpoints

- POST /deepsec/auth/start: sets a pending session cookie and returns verificationUri, userCode, expiresIn. Show the link and code to the user.
- GET /deepsec/auth/status: returns signedOut, pending, authenticated, or failed, plus username after sign-in. Pending status includes the device code so a page reload can resume the flow.
- POST /deepsec/auth/logout: cancels pending sign-in or deletes the local authenticated session and clears its cookie. This is local logout, not a Microsoft-wide sign-out.

Use same-origin requests. Login/logout reject cross-origin requests. Auth responses use no-store. Other Nest HTTP routes require a mapped identity or a supplied bearer/session token unless explicitly marked @DeepSecPublic(); public handlers must not run protected database work. Static assets are served separately by Express. An explicit malformed Authorization header is rejected even if a valid session cookie exists.

## First implementation limits

This checkpoint supports one configured pool and HTTP/Azure OBO. Device code is the built-in sign-in flow; it does not require a callback URL. Sessions are process-local, bounded to 100 entries, expire no later than token expiry minus 30 seconds or one hour, and are cleared on restart/shutdown. Pending login expires within ten minutes. There is no automatic renewal yet: sign in again after expiry. Multiple app processes need a shared session-store implementation before this session feature can be used across replicas. Background jobs and other transports need their own explicit scopes.

NestJS, RxJS and oracledb are peers so the adapter shares the consumer's driver instance. @azure/msal-node is an optional peer for built-in login (the Azure driver extension also needs MSAL for OBO). No SQL, credentials, proxy URLs or app-specific Azure settings are hardcoded in this package. Token validity is determined by Azure and Oracle, not by bearer-header syntax checking.

## Existing authentication: map validated identity

For an app that already authenticates requests, configure `mapIdentity` once.
Your authentication guard must validate the request before the interceptor runs.
The adapter does not validate JWT signatures or replace your authentication guard.

```ts
DeepSecModule.forRoot({
  poolOptions, // configured with the driver's endUserSecParams, as above
  mapIdentity: request => {
    // Set by your app's authentication guard; these field names are app-specific.
    const user = request.user;
    if (!user) return null;
    return {
      endUserToken: user.accessToken,
      dataRoles: user.oracleRoles,
      attributes: user.oracleAttributes,
    };
  },
});
```

The mapper may be asynchronous and receives `(request, executionContext)`. It must
return a nonempty end-user access token and may return `dataRoles` (string array)
and `attributes` (JSON object). Map roles and attributes only from trusted policy,
never directly from unvalidated request fields. Passport does not automatically
retain the raw access token on `req.user`: configure your strategy or server-side
token store to make the Azure token available. A local app session token is not
necessarily a valid Azure OBO assertion.

When a mapper is configured it is the only identity source. Missing or malformed
mapped identity returns 401 before the handler; neither a bearer header nor a
built-in login session provides a fallback. `@DeepSecPublic()` bypasses mapping.
Only token, roles and attributes are forwarded, with copied role/attribute values
so mutation of the source user object cannot change an established scope.

Without a mapper, existing bearer forwarding and optional device login remain
compatible. Bearer forwarding checks syntax only; Azure validates the assertion
at OBO time. It must not be treated as application-level authentication.

The interceptor subscribes to Nest's handler inside the driver's context, and
returns the subscription for cancellation/error teardown. No additional CLS
store or driver API is needed. This does not automatically scope background jobs,
external callbacks or streams consumed after the handler subscription completes.
Those require explicit context/resource lifecycle integration.

This checkpoint still creates one pool and exports `DEEPSEC_POOL`. Existing-pool
integration and operation-resolution lifecycle tests are subsequent work. The demo
keeps connection resolution and borrows/releases within each query; never share a
borrowed connection concurrently across users.
