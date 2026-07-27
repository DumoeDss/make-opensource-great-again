# `@mosga/replay-runtime`

This package owns the isolated source-CLI replay boundary. Its public lifecycle
is deliberately two phase:

```text
prepare sealed bundle
  -> render terminal input elsewhere
  -> register the one-shot proxy route elsewhere
  -> execute once
  -> dispose
```

Call `createReplayRuntime().prepare({ bundle, skillRoots, signal })` with the
sealed bundle as `unknown`. Preparation validates the bundle itself, probes one
trusted source executable, selects one complete tested compatibility profile,
and stages only canonical validated session bytes, the sealed instruction
snapshot, and explicitly selected detached skill snapshots. A successful
result contains an opaque `PreparedReplay`; its observation is safe to pass to
the later integration and proxy layers.

The integration layer renders the terminal manifest after reading the observed
replay CLI version. The proxy layer separately creates a loopback-only
`ReplayRouteBinding` matching `prepared.observation.routeRequirement`.
`prepared.execute({ terminalInput, route, signal, timeoutMs })` sends the exact
terminal string once through stdin and the opaque route token only through the
profile environment. `execute` is one-use. `dispose` is idempotent and should
still be called by orchestration in `finally`.

The package does not render terminal metadata, serve a proxy, accept upstream
provider credentials, discover project instructions, resanitize content,
forward network requests, or invoke reconstructed direct-submit behavior.
Unknown, newer, incomplete, or ambiguous CLI evidence fails closed; execution
never tries an alternate command or fallback submission.

Public failures contain only the stable code, stage, source CLI, observed CLI
version, and cleanup state. Process output and raw causes are always discarded.
Observations/results never expose workspace/source paths, argv, environment,
terminal input, route tokens, session/instruction/skill bodies, or provider
responses.
