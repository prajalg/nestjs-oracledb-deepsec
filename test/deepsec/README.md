# Public plugin tests

Run `npm test` from the application root. This builds the application and tests
the copyable integration. No Azure sign-in or Oracle network
connection is required. All assertions must pass; no TODO or expected failures.

| File | Coverage |
| --- | --- |
| registration.test.js | Explicit controller/handler registration, no implicit scope and app-owned global registration |
| configuration.test.js | Mapper configuration fails closed at startup |
| contract.test.js | Identity snapshots, missing identity, errors, scope decorators, Observable teardown and no resource management |
| connections.test.js | Multiple existing app pools, standalone calls and app-owned cleanup |
| existing-app.test.js | Existing CLS, injection, app-owned pools and concurrent identities |
| auth-setups.test.js | Actual Passport strategy without CLS and custom sessions without Passport |
| decorators.test.js | Controller/handler bypass, roles cannot re-enable skipped scope and guard independence |
| roles.test.js | Scoped roles, controller overrides, missing identity, concurrent isolation, errors and unsubscribe |
| transports.test.js | Actual TCP microservice messages, concurrent scopes, roles, bypass, errors and streamed completion |
| copied-file.test.js | Copy and compile deepsec.ts and deepsec.definitions.ts in a separate app without optional auth dependencies |

Tests use exported integration APIs and Nest/driver interfaces. Database operations
are stubbed where needed. Driver token exchange, real database policy enforcement
and external provider compatibility need separate live checks. The plugin's
subscription cleanup does not replace the app's connection-release lifecycle or
the shared driver's database security-context cleanup.

Consumers copy src/deepsec/deepsec.ts and src/deepsec/deepsec.definitions.ts; test files stay in this repository.
