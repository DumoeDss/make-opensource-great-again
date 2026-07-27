# @mosga/replay-proxy

Loopback-only one-shot replay route proxy with route-token credential isolation
and structural protocol conversion. Sits between `@mosga/replay-runtime` and the
later integration child in the portfolio DAG:

```
bundle -> runtime -> proxy -> integration
```

## What it does

`createReplayProxy()` exposes a `registerRoute(requirement, upstream, options?)`
registrar that consumes the runtime's non-secret `ReplayRouteRequirement` and a
separately resolved `ReplayUpstreamTarget` (real base URL, API format, and key),
and produces a typed `ReplayRouteBinding` for `PreparedReplay.execute`. Each
registration starts a dedicated loopback HTTP listener on an OS-assigned
ephemeral port that serves at most one inference request and is disposed after
the round-trip.

The four enforced guarantees:

1. **One-shot** — a first-wins latch per route; the first token-valid request is
   processed, any subsequent request gets HTTP 429 `route-already-used`, and the
   listener closes after relay.
2. **Route-token isolation** — a ≥32-byte cryptographically random route token is
   the only credential placed in the binding; the real upstream key lives only in
   a non-exported frozen route record and is sent only as the converter-selected
   authorization header on the single outbound request. Token and key never
   appear in the binding (beyond `routeToken`), receipt, error response, or log.
3. **No mutation** — converters perform structural protocol mapping only. No
   sanitizer import; content canaries survive conversion unchanged; unsupported
   fields fail closed (`converter-request-failed`) rather than dropped.
4. **No fallback** — on any failure a stable code is returned and the route
   closes. The package import graph never reaches `@mosga/direct-submit` or any
   reconstructed-API builder.

## v1 converter set

| Source protocol | Target format | Converter id |
| --- | --- | --- |
| `anthropic-messages` | `anthropic-messages` | `anthropic-passthrough-v1` |
| `openai-responses` | `openai-responses` | `openai-responses-passthrough-v1` |
| `anthropic-messages` | `openai-chat-completions` | `anthropic-to-openai-chat-v1` |
| `openai-responses` | `openai-chat-completions` | `openai-responses-to-openai-chat-v1` |

Any other `(sourceProtocol, targetFormat)` pair fails closed at registration with
`converter-unsupported`.

## Public surface

- `createReplayProxy(options?)` → `ReplayProxy` (`registerRoute`, `shutdown`).
- `ReplayRouteHandle` — `{ binding, receipt, dispose(signal?) }`.
- `ReplayProxyReceipt` — `cliRequestHash`, `outboundRequestHash`, converter
  id/version, request count, HTTP status, normalized usage, timing. Does NOT
  carry the bundle content hash (that converges at integration).

## Handoff for the integration child

The integration orchestrates: `prepare -> render terminal manifest ->
register proxy route -> execute -> dispose`. The proxy supplies the typed
loopback-only `ReplayRouteBinding`; the runtime injects only the ephemeral route
token into the child environment and never accepts a real upstream key. After
`execute` returns, the integration awaits `handle.receipt` and merges it with the
runtime's `ReplayPreparationObservation.bundleContentHash`.

## Dependencies

Type-only on `@mosga/contracts` (`SourceCli`, `SubmissionUsage`) and
`@mosga/replay-runtime` (`ReplayRouteRequirement`, `ReplayRouteBinding`).
Deliberately no dependency on `@mosga/direct-submit`, `@mosga/sanitizer`, or
`@mosga/replay-bundle`.
