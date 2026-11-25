# NestJS + Oracle

A small NestJS app with Azure device-code login, Passport sessions and CLS.
Azure authenticates the app user. Its access token stays in the server-side
session and request-local CLS; database creation and queries never receive it.
Oracle connects using the normal database username/password and optional wallet.

## Run

```sh
npm install
# Fill in .env using .env.example; keep credentials out of git.
npm run dev
```

Open the printed URL. Sign in, then load employees or database time. Stop with
Ctrl+C. Azure login uses `/auth/start`, `/auth/status` and `/auth/logout`.
The local app uses HTTP and in-memory sessions; restarting signs everyone out.

## Code

- `src/auth/`: Azure login, Passport session restoration and authentication guard.
- `src/app.module.ts`: register auth, CLS and the app-owned Oracle pool.
- `src/database/oracle-options.ts`: ordinary Oracle credentials and wallet settings.
- `src/database/oracle-pool.ts`: create the pool; AppModule closes it on shutdown.
- `src/employees/`: authenticated route, borrow a connection, query all employee columns, release.
- `src/database/standalone.*`: authenticated route, open a standalone connection, query database time, close.
- `src/health.controller.ts`: public health endpoint, no database call.
- `public/`: simple UI with a wide results table and logout confirmation.

The guard stores the authenticated user in CLS. Asynchronous work in that request
can read it without passing the user through every function. Database services
need only ordinary node-oracledb calls and know nothing about user access tokens.

## Tests

```sh
npm test
```

Offline tests cover login/session lifecycle, concurrent CLS users, unauthenticated
requests, query errors, connection release and UI diagnostics. External Azure and
Oracle I/O is stubbed. Live database permissions are those of the database user.
