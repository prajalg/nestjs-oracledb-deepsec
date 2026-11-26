# Public plugin tests

Run `npm test` from the package checkout. This builds the package and tests
the installable archive. No Azure sign-in or Oracle network
connection is required. All assertions must pass; no TODO or expected failures.

| File | Coverage |
| --- | --- |
| configuration.test.js | Mapper configuration fails closed at startup |
| contract.test.js | Identity snapshots, missing identity, errors, scope decorators, Observable teardown and no resource management |
| connections.test.js | Multiple existing app pools, standalone calls and app-owned cleanup |
| existing-app.test.js | Existing CLS, injection, app-owned pools and concurrent identities |
| auth-setups.test.js | Actual Passport strategy without CLS and custom sessions without Passport |
| decorators.test.js | Controller/method precedence, global defaults, explicit enable/bypass and guard independence |
| roles.test.js | Scoped roles, controller overrides, missing identity, concurrent isolation, errors and unsubscribe |
| transports.test.js | Actual TCP microservice messages, concurrent scopes, roles, bypass, errors and streamed completion |
| package.test.js | Packed JS imports and TypeScript declarations without optional auth dependencies |

Tests use public package exports and Nest/driver interfaces. Database operations
are stubbed where needed. Driver token exchange, real database policy enforcement
and external provider compatibility need separate live checks. The plugin's
subscription cleanup does not replace the app's connection-release lifecycle or
the shared driver's database security-context cleanup.

Tests remain in source control and are excluded from the installable package.
