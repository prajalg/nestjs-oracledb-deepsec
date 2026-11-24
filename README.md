# NestJS Oracle employee demo

This demo reads all columns from `HR.EMPLOYEES`, ordered by employee ID and limited
to 100 rows. Its Azure sign-in is application code. The reusable DeepSec package
accepts a trusted identity callback and establishes the driver's security scope.

```text
App-owned Azure device login -> app session/Passport -> app authentication guard
-> app CLS user -> mapIdentity -> DeepSec adapter -> node-oracledb OBO/EUSC
-> unchanged database query -> employee table
```

## Run locally

```sh
npm install
npm run dev
```

Use the ignored `.env` for database/wallet, Azure and optional proxy settings;
`.env.example` lists names. No credentials or tokens should be committed or logged.
Open the URL printed by the app, sign in with Azure, and click **Load employees**.
The current local configuration uses HTTP and `secureCookie: false`; the login
service defaults to secure cookies for HTTPS. No deployment is performed.

`npm run build` builds plugin then app. `npm start` starts compiled code. After
server restart, the default in-memory sessions require sign-in again. Stop a
foreground server with Ctrl+C. The UI supports full-width tables, horizontal
scrolling, padding and confirmation before logout.

## Code ownership

| Location | Responsibility |
| --- | --- |
| `packages/nestjs-deepsec/src/index.ts` | Adapter registration, mapper validation, driver request scope and owned-pool shutdown |
| `packages/nestjs-deepsec/src/options.ts` | Authentication-library-independent mapping/pool contracts |
| `src/auth/azure-auth.module.ts` | App-owned login routes and session/Passport middleware registration |
| `src/auth/azure-login.ts` | App-owned MSAL device login, session store, expiry, polling handoff and logout |
| `src/azure-session.serializer.ts` | Save/restore the minimal server-side Passport identity |
| `src/azure-session.guard.ts` | App authentication policy and authenticated-user-to-CLS bridge/mapping |
| `src/app.module.ts` | Configures app auth separately, then passes its identity callback and pool settings to DeepSec |
| `src/azure-network.ts` | App-specific corporate proxy bridge |
| `src/error-details.ts` | App-owned diagnostic messages and best-effort redaction for the UI |
| `src/database.service.ts` | Ordinary getConnection/execute/close, with the fixed employee query |
| `public/` | Simple sign-in/employee UI; access tokens are never returned to it |
| `packages/nestjs-deepsec/examples/auth-configurations.ts` | Commented, type-checked examples for alternative auth setups |

## Use the adapter in another app

Keep the application's current authentication module/guard. Configure one
`mapIdentity` callback that reads its trusted request user, custom auth property,
server-side session or existing CLS service. The callback maps an access token,
optional trusted roles and attributes to driver metadata. The adapter does not
require Passport, CLS, Azure login, Express sessions or the demo's identity shape.

See `packages/nestjs-deepsec/README.md` and `packages/nestjs-deepsec/examples/auth-configurations.ts`.
The adapter is currently for Nest HTTP handlers; queues/other transports need
separate integration. An authenticated user ID alone is not enough for Azure OBO:
the application must retain an appropriate end-user access token.

## Validation and driver limits

```sh
npm test
```

This builds TypeScript, checks developer examples, runs offline auth/adapter/driver
component tests and validates the packed core without auth-library imports.
Published `oracledb@26.0.0` is installed; no local driver checkout is required.
The changed-cached-token EUSC regression remains an explicit TODO/expected failure.
The provider-failure cleanup defect is also reproduced in both resolution modes.
See the package README; a passing diagnostic test does not mean that defect is fixed.

The live employee flow must be checked separately with valid Azure credentials
and the intended database policies. Test tokens are fixtures, not live credentials.
A successful query alone does not verify row/column policy isolation across users.

The plugin is maintained in TypeScript and ships compiled JavaScript/declarations
via `npm pack`. Consumer applications need no plugin compilation step. Only core
adapter output, examples and documentation are included; app authentication stays in this repo.

`npm run test:plugin` runs only the package-owned tests and example checks.
Demo-only authentication, SQL-service and UI tests remain in root `test/`.
Package tests, examples and their READMEs live beside the plugin source; the npm
tarball includes `examples/` for consumers and excludes contributor `test/` files.
