# `data/` layout

One JSONL record **per session**, placed deterministically so parallel
contributions never collide on the same file and a re-export is idempotent:

```
data/<schemaVersion>/<contributorAlias>/<sessionId>.jsonl
```

- `<schemaVersion>` — the `SanitizedSession.schemaVersion` (e.g. `0.1.0`).
- `<contributorAlias>` — the session-scoped pseudonym (slugified to a
  filesystem-safe token).
- `<sessionId>` — the source session id (slugified).

Each `.jsonl` file contains exactly **one line**: a stamped `SanitizedSession`
conforming to `@mosga/contracts` `SanitizedSessionSchema`, structurally
isomorphic to the source Claude Code JSONL (so 出口② replay stays possible;
dataset slicing beyond one-record-per-session is deferred).

Alongside each record, `@mosga/publisher` also writes a machine-readable
provenance sidecar:

```
data/<schemaVersion>/<contributorAlias>/<sessionId>.provenance.json
```

carrying `{ schemaVersion, sanitizationRulesetVersion, sanitizerPackageVersion,
gitleaksVersion }` — the exact engine CI must pin to re-scan byte-identically.

This directory is intentionally kept in git (via `.gitkeep`) even when empty so
the layout is discoverable before the first contribution.
