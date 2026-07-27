# @mosga/daemon

Local loopback HTTP API for session review, sanitization, direct model submit,
and canonical GitHub dataset publication. It also serves `@mosga/ui` from the
same origin.

## Running

```bash
mosga ui
mosga ui --port 8899
MOSGA_PORT=8899 mosga ui
```

The daemon derives publication storage beneath the local user application
directory. No CLI flag or HTTP field accepts a clone, workspace, remote, branch,
URL, command, or credential for GitHub publication.

GitHub publication v1 supports public repositories on `github.com` and uses the
locally installed GitHub CLI authentication. Sign in before publishing:

```bash
gh auth login
```

## Canonical GitHub publication

Configure exactly one canonical upstream through the settings UI or:

```http
PUT /api/publish/target
Content-Type: application/json

{"repository":"owner/repo"}
```

The target repository must be public and contain a compatible
`.mosga-dataset.json` at its current default-branch commit. `GET /api/publish`
returns one typed state:

- `unconfigured`
- `login_required`
- `fork_confirmation_required`
- `ready`
- `blocked`

Readiness is resolved from GitHub repository identity, visibility, manifest,
default branch/head, actor permission, and verified fork relation. It never
reports local paths, credentials, commands, or raw external output.

Publication is a two-step confirmation flow:

1. `POST /api/publish/preview` accepts `{ "reviewIds": [...] }` for both one
   review and a batch. It rechecks review gates, compiles one deterministic
   contribution bundle, binds it to an exact target/base snapshot, and returns
   file path/byte/hash summaries. Preview is memory-only and performs no
   filesystem, Git, fork, push, or pull-request write.
2. `POST /api/publish/submit` accepts only the preview reference, target
   revision, content digest, and literal `confirmPublic: true`. It revalidates
   current reviews, target, manifest, engine pins, bundle commitments, and exact
   bytes before the first write.

Confirmed submit uses a daemon-owned managed workspace. It writes the sealed
bytes, commits from the sealed base, pushes through an explicit upstream or
verified fork route, and creates/adopts the exact upstream pull request. A
durable monotonic journal and immutable receipt make retry/recovery converge on
the same branch and PR. The receipt contains public audit facts only.

`DELETE /api/publish/target` clears the active target and invalidates
unsubmitted previews. Target revisions never reset or get reused.

If GitHub publication is unavailable, the review export endpoint remains the
fallback for obtaining the sanitized, gate-unlocked file only. The daemon does
not emit shell commands or expose its managed workspace for manual takeover.

## Review and mutation security

The daemon binds `127.0.0.1` only and has no authentication in v0.x. It is
designed for one local user and must not be exposed remotely.

Every request must use a loopback `Host`. Every `POST`, `PUT`, `PATCH`, and
`DELETE` request additionally requires:

- `Content-Type: application/json` (an optional charset is accepted),
- no `Sec-Fetch-Site: cross-site`, and
- when `Origin` is present, exact equality with the current loopback daemon
  origin.

The server sends no CORS allow headers. Known failures use stable curated error
codes/messages. Unexpected exceptions, Git/GitHub output, commands, tokens, and
local absolute paths are never serialized into HTTP responses.

Reviews and unconfirmed previews are in memory and are lost on daemon restart.
Once confirmed submit begins, the private journal/receipt state supports crash
recovery without persisting credentials.
