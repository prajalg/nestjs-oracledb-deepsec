# Upstream driver diagnostics (explicit opt-in)

```sh
npm run test:driver-diagnostics
```

These reproductions belong to investigation of node-oracledb behavior, not the
Nest adapter's default public API suite. They instantiate private Thin driver
objects and stub Azure/protocol I/O. There is no live login or database connection.
Do not use private driver properties in applications or in the adapter itself.

Unlike the previous TODO test, these tests assert desired behavior normally.
The command exits nonzero until the installed driver satisfies those assertions.
They have not been deleted, skipped or changed to declare a defect successful.

With pinned published oracledb 26.0.0, these defects are reproduced:

- A changed database token returned as a cache hit can reuse an old encoded EUSC
  within one asynchronous scope. Correct behavior must replace the EUSC.
- After initial OBO provider failure, close can reacquire the failing provider and
  return NJS-198 before releasing the connection. Correct behavior must release it.
  The reproduction covers both operation and connection resolution.

A clean adapter test suite verifies mapping, scoping, app integration, lifecycle
wiring and packaging. It does NOT certify that these upstream behaviors are fixed
or that database policies are enforced correctly. Keep these limitations visible
in release notes and perform live acceptance checks with the intended driver,
identity provider, Oracle version and policies before production use.

The shared driver is unchanged. When a compatible fixed release becomes available,
run this command, verify the desired behavior, and update the documented driver
compatibility. Do not patch driver internals from the Nest adapter.
