# Adapter contributor tests

From the package directory:

```sh
npm install
npm test
```

The command builds the adapter, checks `examples/` and runs these offline tests:

| File | Coverage |
| --- | --- |
| `configuration.test.js` | Required mapper validation for direct/async registration |
| `existing-app.test.js` | Existing pool ownership, app public metadata, CLS mapping and concurrent identities |
| `auth-setups.test.js` | Real Passport strategy execution without CLS; custom server sessions without Passport/CLS |
| `operation-resolution.test.js` | Published driver components, operation/connection modes, token refresh and cleanup diagnostics |
| `package.test.js` | Isolated tarball import without auth libraries, declarations, shipped examples and excluded contributor tests |

No demo source files or app build are required by these tests. Fixtures simulate
Azure exchanges and database/protocol I/O. Driver component tests intentionally
inspect private implementation fields for diagnostics; the adapter itself does not.
No real Azure sign-in, Oracle connection or policy-enforcement check takes place.

Published oracledb 26.0.0 has one explicitly expected failure: changed cached DB
tokens can leave an old EUSC in the same async scope. Separate diagnostic tests
also reproduce provider-failure close/release defects in both resolution modes.
A passing diagnostic does not mean that cleanup defect is fixed.

Passport, CLS, session and MSAL dependencies are development-only fixtures/tools.
They are not requirements for consumers of the portable adapter. These tests stay
in the source repository and are excluded from the distributed npm tarball.

The demo's app-owned Azure login, Passport serializer, database service and UI
checks remain in the repository-root `test/` directory. Root `npm test` runs both
sets; root `npm run test:plugin` runs only this package.
