# Authentication integration examples

Start with `auth-configurations.ts`. These examples configure the DeepSec adapter;
they do not implement login or replace an authentication guard.

| Your app | Example factory |
| --- | --- |
| Passport or another guard populates `request.user` | `withRequestUser(pool)` |
| Custom guard populates `request.auth.principal` | `withCustomAuth(pool)` |
| App-owned server session stores `session.account` | `withSession(pool)` |
| Existing `nestjs-cls` context contains authenticated `user` | `withCls(pool)` |
| App service resolves identity asynchronously | `withAsyncResolver(pool, auth)` |

Choose one pattern, adapt field names and keep your existing auth guards enabled.
Do not register all examples together. Each callback runs per protected request,
after guards; no changes to business handlers or SQL methods are required.

The supplied pool must already have `endUserSecParams` configured at creation.
The app owns that pool's shutdown. To let the adapter create/close a pool, replace
`pool` with `poolOptions` containing the driver's security configuration.

Supply an access token accepted by the configured driver exchange, plus optional
roles/attributes from trusted policy. A session ID or decoded claims object is
not a token. A null mapped identity rejects the request; the adapter never falls
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
