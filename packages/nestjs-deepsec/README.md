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

## Two ways to supply a user identity

1. Existing app authentication: omit azureLogin and send Authorization: Bearer <user-token>.
2. Plugin-owned authentication: configure azureLogin and use the endpoints below. The plugin stores the resulting user token in server memory, associates it with an opaque HttpOnly SameSite=Strict cookie, and resolves that identity for subsequent requests. The browser never receives an access token.

In both cases the interceptor calls the shared driver's runWithContext({ endUserToken }, ...). The driver plugin performs Azure OBO exchange to obtain the **database** token and constructs the Oracle security context. Sign-in does not replace that database-token exchange.

## Optional login endpoints

- POST /deepsec/auth/start: sets a pending session cookie and returns verificationUri, userCode, expiresIn. Show the link and code to the user.
- GET /deepsec/auth/status: returns signedOut, pending, authenticated, or failed, plus username after sign-in. Pending status includes the device code so a page reload can resume the flow.
- POST /deepsec/auth/logout: cancels pending sign-in or deletes the local authenticated session and clears its cookie. This is local logout, not a Microsoft-wide sign-out.

Use same-origin requests. Login/logout reject cross-origin requests. Auth responses use no-store. Other Nest HTTP routes require a valid bearer/session identity unless explicitly marked @DeepSecPublic(); public handlers must not run protected database work. Static assets are served separately by Express. An explicit malformed Authorization header is rejected even if a valid session cookie exists.

## First implementation limits

This checkpoint supports one configured pool and HTTP/Azure OBO. Device code is the built-in sign-in flow; it does not require a callback URL. Sessions are process-local, bounded to 100 entries, expire no later than token expiry minus 30 seconds or one hour, and are cleared on restart/shutdown. Pending login expires within ten minutes. There is no automatic renewal yet: sign in again after expiry. Multiple app processes need a shared session-store implementation before this session feature can be used across replicas. Background jobs and other transports need their own explicit scopes.

NestJS, RxJS and oracledb are peers so the adapter shares the consumer's driver instance. @azure/msal-node is an optional peer for built-in login (the Azure driver extension also needs MSAL for OBO). No SQL, credentials, proxy URLs or app-specific Azure settings are hardcoded in this package. Token validity is determined by Azure and Oracle, not by bearer-header syntax checking.
