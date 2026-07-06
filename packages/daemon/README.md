# @mosga/daemon

Local loopback HTTP API that turns a scanned session into a review-and-unlock
workflow, and serves the `@mosga/ui` review interface same-origin. This is slice
3 of mosga v0.1; slice 4 (`@mosga/publisher`) consumes this daemon's export
endpoint output (the stamped `SanitizedSession`).

## What it does

- Wraps `@mosga/session-readers` (enumerate sources / projects / sessions) and
  `@mosga/sanitizer` (compile ruleset, scan, disposition, apply) behind a REST
  API.
- Holds a **stateful review** in memory keyed by `reviewId`: `{ session, report,
  mapper }`. The `PseudonymMapper` instance is retained so that at export
  `primaryContributorAlias()` and placeholder assignment stay consistent — the
  mapper's internal counters cannot round-trip through the browser.
- Enforces the confirmation **gate**: the export endpoint returns a stamped
  `SanitizedSession` (`meta.sanitized:true`) only when `gate.unlocked`, otherwise
  HTTP 409. There is no code path that emits a stamped session while locked.
- Serves the built UI at `/ui` from the same origin as the API (zero CORS).

## Running

```
mosga ui            # start the daemon and open the browser at /ui
mosga ui --port N   # use port N instead of 8899
MOSGA_PORT=N mosga ui
```

Default port is **8899** (deliberately different from omnicross's 8766).

## Threat model (v0.1) — READ THIS

**The daemon binds `127.0.0.1` only and never a non-loopback interface.** There
is **no authentication** in v0.1. The threat model is a **single local user** on
the machine: any process able to reach loopback (any local process, any local
user) can call the API and read the session currently under review. This is
acceptable for a local developer tool and is called out explicitly here rather
than hidden.

**DNS-rebinding guard.** Because the API has no auth, a website you visit could
point a hostname it controls at `127.0.0.1` and try to drive the API from the
browser. The daemon rejects any request whose `Host` header is not a loopback
name (`127.0.0.1` / `localhost` / `::1`) with HTTP 403, closing that vector.
Custom rules are loaded only from a trusted server-configured path at startup,
never from a request body — the API performs no client-directed file reads.

Out of scope for v0.1 (do not assume these protect you):

- Multi-user / shared machines. If other users share this host, they can reach
  the loopback API.
- Remote access. The daemon is never exposed off-host by design.
- An auth token / origin check is a v0.2 option, not present here.

Two further properties worth knowing:

- **In-memory review state is lost on daemon restart.** Dispositions are not
  persisted. A re-scan is deterministic (`Finding.id` is stable), so the review
  can be redone without corruption — but it must be redone.
- **The git-remote "recommended" flag is a heuristic, not a security control.**
  It biases the project picker toward projects whose `cwd` has a git remote on a
  recognized public host (github.com, gitlab.com, …). A private mirror hosted on
  a public host, or an unpushed repo, is misclassified. The real defenses are the
  scan and the human gate; "show all projects" is always available.
