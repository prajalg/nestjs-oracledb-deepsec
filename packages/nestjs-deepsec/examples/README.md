# Authentication integration examples

Start with `auth-configurations.ts`. These examples configure the DeepSec plugin;
they do not implement login or replace an authentication guard.

| Your app | Example factory |
| --- | --- |
| Passport or another guard populates `request.user` | `withRequestUser()` |
| Custom guard populates `request.auth.principal` | `withCustomAuth()` |
| App-owned server session stores `session.account` | `withSession()` |
| Existing `nestjs-cls` context contains authenticated `user` | `withCls()` |
| App service resolves identity asynchronously | `withAsyncResolver(auth)` |

Choose one pattern, adapt field names and keep your existing auth guards enabled.
Do not register all examples together. Each callback runs per protected request,
after guards; no changes to business handlers or SQL methods are required.

The plugin receives no pool or connection. Keep the app's creation, configuration,
injection and cleanup code. Add `endUserSecParams` when creating each pool or
standalone connection that should use DeepSec. Multiple pools can keep different
provider settings; the mapper is configured once per app.

Supply an access token accepted by the configured driver exchange, plus optional
roles/attributes from trusted policy. A session ID or decoded claims object is
not a token. A null mapped identity rejects the request; the plugin never falls
back to an unrelated header or session.

The Passport/request-user examples do not require CLS. The custom/session
examples do not require Passport. Only the CLS example imports `nestjs-cls`.
If your app uses another context service, inject it through `forRootAsync` and
read it inside `mapIdentity` in the same way.

These examples are shipped as TypeScript reference code, not imported by the
plugin at runtime. Contributors run `npm run typecheck:examples` from the package
checkout after installing development dependencies. Consumers can copy the
chosen example into their own app and use their normal TypeScript build.

The application owns login, token acquisition, session expiry and renewal. The
configured driver provider owns downstream token exchange and database security
contexts. These examples only connect an authenticated identity to that provider.

## Resource settings

Add `endUserSecParams` directly where the app already creates each pool or
standalone connection. Different resources may have different provider settings.
Keep all resource ownership and cleanup in the app; the plugin receives only
the mapped request identity. See the package README for configuration and optional
handler/controller decorators, including scoped data roles.
