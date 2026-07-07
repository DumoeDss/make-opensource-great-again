## Why

Slices 1–3 take a session from raw discovery through scan and the human confirmation gate to a stamped `SanitizedSession` (the daemon's export output). What is still missing is the last mile: turning that stamped envelope into a published community-dataset contribution — safely. This slice builds `@mosga/publisher` plus the community data-repo template and the leak incident playbook. It **closes the v0.1 loop end to end**: a session flows read (`session-readers`) → scan (`sanitizer`) → human gate (`review-ui` daemon) → **export** (dataset serialization) → **mandatory local pre-check** (the same shared ruleset re-scanned on the exact bytes about to ship) → **PR-ready** contribution, with CI re-running the identical engine as a verification defense. Because a PR is public the instant it is created and GitHub keeps history forever, the pre-check is the project's most important safety property: never emit a publishable file that still fails the shared ruleset.

## What Changes

- Add `@mosga/publisher` (`packages/publisher`), consuming a stamped `SanitizedSession` (from the daemon's export route or a file) and:
  1. **Dataset export** — serialize the stamped envelope to the on-disk dataset format: JSONL, one record per session, each record a `SanitizedSession` conforming to `@mosga/contracts` + `SCHEMA.md` (dataset slicing beyond one-record-per-session is deferred; `SCHEMA.md` defers it here). Emit a provenance/version stamp alongside it.
  2. **Mandatory local pre-check** — re-run the SAME `@mosga/sanitizer` scan on the artifact about to be published (the "本地预检 = CI 同一份规则集" invariant). If ANY blocking finding survives (secret, custom, `redos-guard`, or `ruleset-compile-error`), **hard-refuse**: produce no PR, no output file. This is defense-in-depth over the human gate — it re-verifies the actual bytes, not the human's decisions.
  3. **GitHub PR submission** — given a target data-repo and a pre-check-passing artifact, prepare the contribution (branch, deterministic file placement, PR body from a template carrying the version stamps). Use the `gh` CLI when available; otherwise emit the exact `git`/`gh` commands + staged files and document the manual path. Never open a PR against a real external repo in tests.
- Add a **community data-repo template** (`templates/` scaffold): a GitHub repo skeleton with (a) a CI workflow that re-runs the SAME shared ruleset scan (pinned `@mosga/sanitizer` version) on every incoming PR, (b) obviously-fake canary-key fixtures the CI MUST catch to prove the gate is alive, and (c) an HuggingFace sync script stub (documented; HF creds out of scope).
- Add **INCIDENT-RESPONSE.md** — the post-publication leak playbook (design doc Next Steps 8): HF record removal + re-release, repo history rewrite/rotation, contributor credential-rotation notice, and a public incident record.
- **Resolve sanitizer review's m3**: the pre-check emits the exact `@mosga/sanitizer` package version (plus `rulesetVersion` and gitleaks pin) into the provenance stamp, and the CI template pins that version — so local pre-check and CI run a byte-identical matching engine, not merely the same rule text.

## Capabilities

### New Capabilities

- `dataset-export`: serialize a stamped `SanitizedSession` to the on-disk JSONL dataset format (one record per session) conforming to `@mosga/contracts` + `SCHEMA.md`, with a provenance/version stamp.
- `publish-precheck`: the mandatory local pre-check — re-run the shared `@mosga/sanitizer` ruleset on the exact artifact bytes and hard-refuse on any surviving blocking finding. The project's core safety gate.
- `pr-submission`: prepare a GitHub PR contribution (branch / file placement / templated PR body) via `gh` when available, else emit exact commands + staged files for the manual path.
- `community-repo-template`: the community data-repo scaffold (shared-ruleset CI workflow + canary fixtures + HF sync stub) and the INCIDENT-RESPONSE.md leak playbook.

### Modified Capabilities

<!-- None. `openspec/specs/` is empty (prior slices not yet archived); this slice adds new capabilities and consumes the shipped @mosga/sanitizer + @mosga/contracts + daemon export contract without modifying them. -->

## Impact

- **New package**: `packages/publisher/` (`@mosga/publisher`), with a CLI entry for export + pre-check + PR-prep.
- **New top-level artifacts**: a `templates/community-data-repo/` scaffold (CI workflow, canary fixtures, HF sync stub, data-repo README + data-license placeholder) and `INCIDENT-RESPONSE.md`.
- **New dependencies**: `zod` (validate the stamped envelope on the way in); no HF SDK, no live GitHub API client required at runtime beyond the `gh` CLI when present. No network in tests.
- **Consumes (unchanged)**: `@mosga/sanitizer` (`compileRuleset`, `scanSession`, `computeGate`, the report/finding model, `GITLEAKS_VERSION`), `@mosga/contracts` (`SanitizedSession`, `SanitizedSessionSchema`, `SCHEMA.md`), and the daemon export contract (stamped `SanitizedSession` in, 409 when locked).
- **Closes the v0.1 loop**: with this slice, the initiator can take one of their own Claude Code sessions through read → scan → gate → export → pre-check → PR-ready, and the community repo's CI re-scans it with the pinned engine — the design doc's Success Criteria path.
- **Out of scope**: real HuggingFace upload, opening a PR against a live external repo, Tauri, authentication, and the API-replay 出口② (v0.2). The HF sync and PR steps are wired to fake/dry-run paths in tests.
