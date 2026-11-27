# NestJS + Oracle Deep Data Security

An employee app using Azure device login, Passport sessions, CLS and an application-owned Oracle pool. The DeepSec integration passes the authenticated user's identity to node-oracledb without adding identity arguments to query code.

For integration into another app, see [the DeepSec guide](DEEPSEC.md).

## Run

```sh
npm install
# Fill in .env using .env.example; keep credentials out of Git.
npm run dev
```

Open the printed URL, sign in with Azure, then select **Load employees**. The query returns all employee columns, up to 100 rows. Oracle applies the configured end-user authorization policies. Stop the server with **Ctrl+C**.

This local app uses HTTP and in-memory sessions. Restarting signs everyone out. It is not a production deployment configuration.

## Code structure

```text
src/
├── main.ts                   # Start Nest and serve the UI
├── app.module.ts             # Configure auth, CLS, DeepSec and the Oracle pool
├── auth/                     # Azure login, Passport sessions and the auth guard
├── deepsec/
│   ├── deepsec.ts             # Configuration class and interceptor
│   └── deepsec.definitions.ts # Types and scope decorators
├── database/oracle-pool.ts   # App-owned pool and its endUserSecParams
├── employees/                # Employee controller and query service
├── health.controller.ts      # Health endpoint; no database call
└── shared/error-details.ts   # Redacted error messages
public/                       # Browser UI
test/                         # App tests and DeepSec integration tests
```

## Request flow

```text
Azure login → server-side session
  → Passport restores request.user
  → authentication guard stores user in CLS
  → DeepSec interceptor calls mapIdentity
  → handler runs inside the driver's identity scope
  → EmployeesService borrows from the pool and executes its query
  → shared driver provider performs Azure OBO and handles EUSC
  → Oracle returns the data authorized for that user
```

The employee controller explicitly attaches `DeepSecInterceptor`. Login and health have no interceptor attached and need no skip decorators. The pool's `endUserSecParams` goes directly to node-oracledb; the NestJS integration does not manage database resources.

## Tests

```sh
npm test
```

Tests cover authentication/session behavior, identity isolation, pool ownership, standalone integration, scope decorators, HTTP/TCP handlers, cleanup and UI errors. Standalone connection support is tested as an integration capability; the app itself only queries through its pool.

External Azure and Oracle calls are stubbed. Passing tests do not establish live connectivity or database policy correctness.
