# NestJS + Oracle — DeepSec demo

A small NestJS app using a portable local DeepSec plugin. The original runQuery() method and SQL are unchanged. Changes are awaiting review; no Git commit has been made.

## Run

```sh
npm install
npm run build
npm start
```

Open http://127.0.0.1:7002, click **Sign in with Azure**, open Microsoft's link and enter the displayed device code. After signing in, click **Run query**. There is no token input. If port 7002 is busy, use `PORT=7003 npm start` and open port 7003.

The optional user-login feature belongs to the portable plugin. The app only configures it and renders the sign-in controls. Device login avoids needing a registered localhost callback URI. Its scope must target the middle-tier Azure app, which subsequently exchanges that user token for a database token through OBO.

```
Azure device login -> user token in plugin's server-side session
  -> browser sends opaque HttpOnly cookie -> plugin runWithContext({ endUserToken })
  -> unchanged runQuery() -> shared driver plugin exchanges token -> Oracle
```

The ignored .env contains Oracle settings, Azure middle-tier credentials, public-client login settings and the optional corporate proxy. .env.example lists the names without real credentials. The demo explicitly uses secureCookie: false for localhost HTTP; the plugin defaults to secure cookies for HTTPS.

## Read the code

- `packages/nestjs-deepsec/index.js`: loads the shared driver plugin, creates/exports DEEPSEC_POOL, installs the HTTP request-scope interceptor, and closes the pool on shutdown.
- `packages/nestjs-deepsec/azure-login.js`: optional Azure device login, bounded server-side sessions, cookie resolution, expiry, logout, and login endpoints. Access tokens are never returned by these endpoints.
- `src/app.module.ts`: configures optional azureLogin (public client/user scope) and poolOptions.endUserSecParams (middle-tier credentials/database scope).
- `src/database.service.ts`: receives DEEPSEC_POOL through injection. runQuery() still uses ordinary getConnection(), execute(), and close().
- `src/app.controller.ts`: GET /api/query is protected; GET /api/health is explicitly public and does not query Oracle.
- `src/azure-network.ts`: app-owned corporate proxy networking passed to both MSAL sign-in and the driver's Azure extension.
- `public/`: small sign-in button, verification link/code, query button and results table. No access tokens in browser storage or URLs.

Apps with existing authentication omit azureLogin and keep supplying Authorization: Bearer <user-token>. See the package README for usage and first-checkpoint limitations.

## Local driver and tests

The demo links `../drivers/node-oracledb`, because the previous published 6.10.0 package lacks the DeepSec APIs. The portable package itself uses peer dependencies. --preserve-symlinks keeps the app, adapter and driver on the same driver instance and allows the driver plugin to resolve app-installed MSAL. The earlier nestjs-deepsec project is not a runtime dependency.

```sh
npm test
```

Tests cover the original connection lifecycle, real driver-hook installation, bearer isolation across concurrent HTTP requests, optional-login behavior, cookie-session propagation into the real driver's async scope, expiry, logout, login failure, origin checking and shutdown. Database/Azure I/O is stubbed for these automated tests; they do not prove Oracle policy enforcement. Live verification results will be recorded separately.

The existing SELECT on DUAL returns DB_USER, DB_NAME and SERVER_TIME. Pool minimum is zero: startup and health do not prove a database connection. Query results use Cache-Control: no-store. Changing to individual user security does not change the SQL text. Stop a foreground server with Ctrl+C and rebuild after TypeScript changes.

Git is initialized on main with zero commits. .env, node_modules and dist are ignored. runQuery() was compared against the original basic-app snapshot and is byte-for-byte unchanged (SHA256 eb64fe71fd40296be22717c2ac6cc191d527b4ceff6f9366e35273db10fb5433, excluding surrounding blank lines).

## Verified checkpoint — 2026-11-23

Build and all nine tests passed. A real sign-in through the plugin's device-code endpoint completed successfully. Using only the returned opaque session cookie (no Authorization header), GET /api/query returned HTTP 200 in Thin mode against Oracle Database 26.1.0.24.0, with DB_USER=XS$NULL and DB_NAME=CDB1_PDB1. The entire original runQuery() method and SQL remained unchanged. Logout returned 201 and the same cookie subsequently received 401 on the query endpoint. Temporary test-session cookies were deleted after logout.

This verifies the optional login -> server-side user token -> driver OBO -> live query path. It does not constitute XS identity mapping or row-policy coverage. The updated demo was run on port 7003 because an existing process occupied 7002; that existing process was left alone. Changes are still awaiting approval and are uncommitted.
