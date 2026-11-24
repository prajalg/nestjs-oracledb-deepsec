# Public adapter tests

From the package checkout:

```sh
npm install
npm test
```

This is the release-facing suite: build the package, type-check its examples, and
exercise its documented exports through real Nest HTTP applications and isolated
packed consumers. All tests must pass. No TODO, expected-failure or skipped tests
are used to make this command succeed. Any unexpected assertion fails the command.
`prepublishOnly` runs the same checks before an npm publish attempt.

| File | Public behavior covered |
| --- | --- |
| `configuration.test.js` | Missing/invalid identity mapper rejects direct and async startup |
| `contract.test.js` | Metadata validation/snapshot, async mapper errors, public policy, Observable scope/teardown, pool creation/export/shutdown and startup errors |
| `existing-app.test.js` | Existing pool injection/ownership, app public metadata, CLS and concurrent identity isolation |
| `auth-setups.test.js` | Actual Passport strategy execution without CLS; custom server sessions without Passport/CLS |
| `package.test.js` | Packed CommonJS/ESM imports, declarations under Node/Node16 resolution, examples, unavailable auth dependencies and excluded contributor files |

The tests use the package's exports, Nest's HTTP/DI interfaces and the driver's
public context/pool interfaces. Driver calls at the application boundary can be
stubbed for deterministic offline checks; tests do not inspect private driver
fields, locate private interceptor classes or edit private provider structures.
No real Azure sign-in, Oracle connection or policy-enforcement check takes place.

Upstream driver reproductions are intentionally separate in `../diagnostics/`.
Run `npm run test:driver-diagnostics` explicitly to investigate those. That command
asserts desired driver behavior and genuinely fails while known upstream defects
remain; it does not mark broken behavior as a passing contract or an expected TODO.
See `../diagnostics/README.md` for the compatibility implications.

Passport, CLS, sessions and MSAL are development-only test dependencies. Consumers
of the core adapter need none of those unless their own chosen setup needs them.
Tests and diagnostics stay in source control and are excluded from the npm tarball.
