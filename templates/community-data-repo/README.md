# mosga community dataset (scaffold)

> This is the **template** the initiator instantiates as the real community data
> repository. It ships the CI verification defense, the canary self-test, and an
> HuggingFace sync stub — not a live dataset.

This repo collects **sanitized** AI coding-session records contributed by the
community. Every record was produced locally by [`@mosga/publisher`](../../packages/publisher),
which runs a **mandatory local pre-check** — re-scanning the exact bytes with the
shared `@mosga/sanitizer` ruleset and hard-refusing on any surviving secret —
before a PR is ever opened. This repo's CI then **re-scans with a byte-identical,
pinned engine** as an independent verification layer.

## How a record gets here

```
your Claude Code session
  → read (@mosga/session-readers)
  → scan (@mosga/sanitizer, three layers)
  → human review + gate (mosga daemon UI)
  → export + MANDATORY local pre-check (@mosga/publisher)   ← refuses on any leak
  → PR to this repo
  → CI re-scan with the PINNED engine + canary self-test    ← this repo
  → merge → periodic HF sync (operator)
```

## Contributing

1. Review one of your own sessions to a stamped, gate-passed `SanitizedSession`.
2. Run the publisher; it exports the record, runs the pre-check, and prepares a PR:
   ```
   mosga-publish prepare ./my-session.json --repo /path/to/this/clone
   ```
   If `gh` is installed it can open the PR; otherwise it prints the exact
   `git`/`gh` commands to run manually.
3. Open the PR. CI re-scans your record. A blocking finding fails the check and
   the record cannot merge — replace/delete the value or get the rule allowlisted
   upstream (which strengthens the shared ruleset for everyone). There is **no
   "allow through" escape hatch** at publication: the published bytes must pass
   the shared ruleset cleanly.

Only contribute **your own** data. A PR is public the instant it is created and
its git history is permanent — that is exactly why the pre-check and CI re-scan
exist.

## The pinned-engine invariant (why versions are exact)

`package.json` pins `@mosga/sanitizer` and `@mosga/publisher` to an **exact**
version (no `^`/`~`). That version must equal the `sanitizerPackageVersion` in
contributors' provenance stamps. A `rulesetVersion` alone is insufficient: a
regex can compile differently across engine/runtime versions, so CI pins the
whole **engine**, guaranteeing its re-scan is byte-identical to the contributor's
local pre-check. A mismatch is a visible CI failure, never a silent divergence.

Community-wide Layer-2 custom rules may be committed as `sanitizer.custom-rules.json`
(additive — they only ever catch more). Contributor-private custom rules stay on
the contributor's machine.

## Layout

- `data/<schemaVersion>/<contributorAlias>/<sessionId>.jsonl` — one JSONL record
  per session (see `data/README.md`).
- `.github/workflows/scan.yml` — the PR re-scan + canary self-test.
- `tests/canary/` — obviously-fake canary records the CI **must** catch.
- `scripts/` — `scan-changed.mjs`, `scan-canary.mjs`, `hf-sync.mjs` (stub).
- `LICENSE-DATA` — dataset license (placeholder; see the file).
- [`INCIDENT-RESPONSE.md`](../../INCIDENT-RESPONSE.md) — the post-publication leak playbook.

## Data license

See `LICENSE-DATA`. The dataset license is a pre-launch decision (Open Question 2:
CC-BY-4.0 / ODC-BY / Apache-data 待定) and is **separate** from this scaffold's
MIT code license.
