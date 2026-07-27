# @mosga/replay-submit

Cli-resume orchestration boundary: validates consent against a sealed bundle,
drives the locked `prepare → render terminal manifest → register proxy route →
execute → dispose` order, and converges the three-hash receipt.

## Public surface

- **`submitCliResume(params)`** — the sole orchestration entry point. Accepts
  injectable `ReplayRuntime` and `ReplayProxy` instances so tests never launch a
  real CLI, bind a real listener, or contact a real provider.
- **`renderTerminalManifest(input)`** — pure, deterministic terminal-manifest
  renderer. Produces byte-identical output for identical inputs (canonical JSON
  key order, LF endings). Never rereads raw session metadata.

## No-fallback guarantee (3 levels)

1. **Structural:** this package does NOT import `@mosga/direct-submit`. A
   package-surface test asserts no import path reaches the reconstructed-API
   builder.
2. **Runtime:** `submitCliResume` returns `{ ok: false }` on every failure
   condition and never retries via a different path.
3. **Daemon-handler:** the daemon's submit route branches on
   `consent.replayMode` before any side effect. A cli-resume failure returns a
   terminal HTTP error and never falls through to the reconstructed `submit()`.

## Three-hash receipt

The `CliResumeReceipt` converges hashes from three separate children:

| Hash | Origin |
|------|--------|
| `bundleContentHash` | `ReplayPreparationObservation` (replay-runtime) |
| `cliRequestHash` | `ReplayProxyReceipt` (replay-proxy) |
| `outboundRequestHash` | `ReplayProxyReceipt` (replay-proxy) |

The receipt NEVER includes the real API key, route token, full request/response
bodies, system prompts, tool schemas, the workspace path, or CLI-generated
content.

## Dependencies

- `@mosga/contracts` — consent/receipt/failure schemas
- `@mosga/replay-bundle` — `validateReplayBundle`
- `@mosga/replay-runtime` — `ReplayRuntime` types (type-only)
- `@mosga/replay-proxy` — `ReplayProxy` types (type-only)

Deliberately does NOT depend on `@mosga/direct-submit`.
