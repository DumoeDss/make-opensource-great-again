## Context

Slices 1–3 shipped `@mosga/contracts`, `@mosga/session-readers`, `@mosga/sanitizer`, `@mosga/daemon`, and `@mosga/ui`. The daemon's export route (`packages/daemon/src/app.ts`) returns a stamped `SanitizedSession` (`meta.sanitized:true`, `sanitizationRulesetVersion` set, `contributorAlias` filled) when the gate is unlocked, else HTTP 409 with the gate. That stamped envelope — or an equivalent file — is this slice's input.

Real surfaces this slice binds to (read from shipped code, not memory):
- `compileRuleset({ customRules, generatedAt }) → CompiledRuleset` is deterministic; `CompiledRuleset.rulesetVersion` is the composite id (`gitleaks@<tag>+mosga-l3@<ver>+custom@<hash>`). `scanSession(session, ruleset) → ScanResult { report, mapper, rulesetWarnings }`. `computeGate(findings, nonTextItems)` yields `{ blockingTotal, blockingPending, nonTextPending, unlocked }`. Blocking findings include `secrets`, `custom`, and the engine kinds `redos-guard` and `ruleset-compile-error`.
- `SanitizedSession` on-disk shape is defined by `@mosga/contracts` `SanitizedSessionSchema` + `packages/contracts/SCHEMA.md`, which explicitly states dataset slicing is deferred to **this** (export) layer and the body stays isomorphic to the source JSONL for 出口② replay.
- **Contract update honored**: `customRulesPath` was removed from the daemon's create-review request body; custom rules load once from a trusted server-side config (`AppOptions.customRulesPath`). This slice mirrors that — custom rules come from trusted local config, never a request/artifact-embedded path.

Constraints carried in (design doc + planning-context): a PR is public the instant it is created and GitHub keeps history forever, so a leaked secret is catastrophic and irreversible; the local pre-check must run the SAME ruleset as CI ("验证防线"); canary keys must be caught 100%; the whitelist + human gate are upstream defenses, the pre-check is the last independent one.

## Goals / Non-Goals

**Goals:**

- Serialize a stamped `SanitizedSession` to a stable on-disk JSONL dataset record (one per session) conforming to `@mosga/contracts` + `SCHEMA.md`, with a provenance/version stamp.
- A mandatory local pre-check that re-scans the exact artifact bytes with the shared ruleset and hard-refuses on any surviving blocking finding.
- A GitHub PR preparation flow (branch/file/PR body) via `gh` when present, else exact commands + staged files.
- A community data-repo template whose CI re-runs the identical pinned engine + the canary self-test, an HF sync stub, and the INCIDENT-RESPONSE.md playbook.
- Realize the shared-ruleset local/CI invariant concretely (the m3 resolution).

**Non-Goals:**

- No real HuggingFace upload (stub + docs; creds out of scope), no PR against a live external repo in tests (dry-run / `gh` detection only).
- No dataset slicing beyond one-record-per-session (multi-trajectory splitting is a later refinement; `SCHEMA.md` defers it here but v0.1 does the simplest correct thing).
- No Tauri, no auth, no 出口② API replay (v0.2).
- No changes to the shipped packages; this slice only consumes them.
- No accepting a client/artifact-supplied custom-rules path (mirrors the daemon's removal — arbitrary file read).

## Decisions

### D1 — On-disk dataset format: one JSONL record per session

The export writes one JSONL file per session, each file containing a single line: the stamped `SanitizedSession` (validated against `SanitizedSessionSchema`). Rationale: one-file-per-session avoids PR merge conflicts (parallel contributions never touch the same file), keeps the body isomorphic to the source JSONL (per `SCHEMA.md`, 出口② replay), and is the simplest thing that conforms. File placement is deterministic: `data/<schemaVersion>/<contributorAlias>/<sessionId>.jsonl` (or a content-hash leaf), so re-exporting the same session is idempotent. *Alternative:* append to one big dataset file — rejected (guaranteed PR conflicts, and a bad line poisons the whole file). *Alternative:* split each session into multiple trajectory records now — deferred (needs the initiator's dataset schema, Open Question 1; `SCHEMA.md` is still banner-marked pending calibration).

### D2 — Mandatory local pre-check re-scans the ARTIFACT bytes and hard-refuses

The pre-check loads the compiled ruleset (`compileRuleset({ customRules })`, same vendored gitleaks + trusted local custom rules the daemon uses) and runs `scanSession` on the about-to-publish record parsed back as a `SanitizedSession`. If the scan yields ANY blocking finding — `secrets`, `custom`, `redos-guard`, or `ruleset-compile-error` — the publisher **refuses**: no file is written, no PR is prepared, and it reports which findings blocked. Only a clean pass (zero blocking findings) proceeds. This is deliberately independent of the human gate: it verifies the final bytes, so a real secret the human mistakenly `allow`ed, or one in a field the gate under-covered, is still caught. *Consequence (documented):* a genuine false positive that still matches a secret rule cannot be `allow`ed through publication — the contributor must either replace/delete it or get the rule allowlisted upstream (which improves the shared ruleset for everyone). This is the correct posture: the published bytes must pass the shared ruleset cleanly, exactly as CI will require. *Alternative:* trust the gate and skip re-scanning — rejected; the gate records human decisions, the pre-check verifies bytes, and "PR 一旦创建即公开" leaves no room to trust the former alone.

### D3 — Shared-ruleset local/CI invariant + m3 resolution

The invariant "本地预检与 CI 共用同一份规则集" is realized by three concrete mechanisms:
1. **Vendored, pinned gitleaks rules live inside `@mosga/sanitizer`** — the same package version ships byte-identical rules to both the local tool and CI (no fetch, no drift).
2. **`compileRuleset` is deterministic** — given the same package version and the same custom rules it produces an identical `CompiledRuleset` (same `rulesetVersion`).
3. **The provenance stamp pins the engine, not just the rules (m3)** — sanitizer review's m3 finding was that a `rulesetVersion` alone is insufficient, because a `regexSource` can compile differently across engine/runtime versions (surfacing as `ruleset-compile-error`). So the publisher records in the provenance stamp: `sanitizerPackageVersion` (the installed `@mosga/sanitizer` version, read from its resolved `package.json`), `rulesetVersion`, and `gitleaksVersion`. The community CI template **pins `@mosga/sanitizer@<sanitizerPackageVersion>`** so its re-scan uses the byte-identical matching engine. Baseline = vendored gitleaks + mosga L3, shared via the pinned package; community CI additionally applies the community's own committed custom rules, while contributor-private custom rules stay local (additive — they only ever catch more). This closes m3: CI runs the same engine that produced the local pre-check verdict.

### D4 — GitHub PR flow: gh-when-present, documented manual path otherwise

Given `{ targetRepo, artifactPath }` and a passing pre-check, the flow: resolve/prepare a working clone, create a branch (`contrib/<contributorAlias>/<sessionId>`), place the JSONL at the deterministic path, commit, and — when the `gh` CLI is detected and authenticated — push the branch and open a PR with a body rendered from a template (carrying the provenance stamp + record count + a sanitization attestation). When `gh` is absent, the publisher instead emits the exact `git`/`gh` command sequence and the staged file list, and documents the manual steps. Tests exercise the prep + command emission and the `gh`-absent path; they never push to or open a PR against a real repo. *Alternative:* a bundled Octokit GitHub API client — rejected for v0.1 (extra dep + token handling; `gh` already solves auth on developer machines, the PR channel's target audience).

### D5 — Community data-repo template as a scaffold under `templates/`

`templates/community-data-repo/` holds: (a) `.github/workflows/scan.yml` — on every PR, install the pinned `@mosga/sanitizer` and run the shared-ruleset scan over each changed record file, failing the check on any blocking finding; (b) `tests/canary/` — obviously-fake records with planted fake secrets that the workflow MUST flag (a living proof the gate works; a green CI on these fixtures would mean the gate is broken, so the workflow asserts they are caught); (c) `scripts/hf-sync.*` — a documented stub that batch-syncs merged records to a HuggingFace dataset (creds/upload out of scope); (d) a data-repo `README` (contribution guide) and a data-`LICENSE` placeholder (Open Question 2, CC-BY / ODC-BY 待定). The template is scaffolding the initiator instantiates as the real community repo; this slice ships and tests the scaffold, not a live repo.

### D6 — INCIDENT-RESPONSE.md (design doc Next Steps 8)

A repo-root (or `docs/`) playbook for a post-publication leak: (1) immediately remove the offending record from the HF dataset and re-release a new version; (2) rewrite the data-repo git history to purge the secret from permanent history (or, in the extreme, rotate/replace the repo); (3) notify the affected contributor to revoke/rotate the leaked credential immediately; (4) publish a public incident record in the repo; plus a prevention follow-up step — add a rule for the missed pattern so the shared ruleset (and thus every future local pre-check + CI run) catches it next time. The doc names owners/roles and expected timeline so it is actionable, not aspirational.

## Risks / Trade-offs

- **A leaked secret reaches a public PR** (irreversible) → the mandatory pre-check re-scans the exact bytes and hard-refuses on any blocking finding (D2); CI re-runs the identical pinned engine (D3); canary fixtures prove the gate is alive (D5); INCIDENT-RESPONSE.md handles the residual case (D6). Layered, with the byte-level pre-check as the last independent line.
- **Local pre-check and CI silently diverge** → the provenance stamp pins the exact `@mosga/sanitizer` version and CI installs that version (D3); a `rulesetVersion`/`sanitizerPackageVersion` mismatch is a visible CI failure, not a silent gap.
- **A genuine false positive blocks a legitimate contribution** → documented path: replace/delete the value or upstream an allowlist entry (which strengthens the shared ruleset); the pre-check does not offer an "allow through" escape hatch by design.
- **`gh` unavailable / unauthenticated on the contributor's machine** → the flow degrades to emitting exact commands + staged files + a documented manual path, so a non-`gh` user is not blocked.
- **HF sync stub mistaken for a finished uploader** → it is clearly marked a stub (creds/upload out of scope), documented as the operator's step, and not invoked in tests.
- **One-record-per-session diverges from the initiator's eventual dataset schema** → the record is the versioned `SanitizedSession` (`schemaVersion`), `SCHEMA.md` is banner-marked pending calibration, and slicing is isolated to this export layer so a future schema is a localized, versioned change.

## Migration Plan

Additive; no migration. Sequencing: (1) dataset export (serialize + validate + provenance stamp) with round-trip tests; (2) the mandatory pre-check (shared-ruleset re-scan + hard-refuse) with the canary-refusal test — the highest-value test in the project; (3) PR-submission flow (branch/file/PR-body + `gh`-present and `gh`-absent paths) with dry-run tests; (4) community-repo template (CI workflow + canary fixtures + HF stub + data README/LICENSE) and INCIDENT-RESPONSE.md; (5) `openspec validate`. Rollback = delete the package + templates + doc; no external state touched. No real publish/upload in this slice.

## Review round 1 resolutions (security review — NEEDS-FIX → addressed)

- **B1 (Blocker) — pre-check covered only a subset of the published bytes.** `scanSession`'s structure-aware traversal never visits `meta.*`, `schemaVersion`, or `session.{sessionId,sourceId,projectKey,updatedAt}`, so a secret planted there survived export AND CI (both call the same `precheckRecord`). Fixed in the publisher (no sanitizer source change) by adding a **structure-agnostic raw-bytes backstop**: after serializing the exact bytes, `precheckRecord` runs the same compiled ruleset over the serialized string (wrapped as a synthetic scan field, in overlapping windows to avoid truncation), and merges any blocking hit with the structured pass. Now any blocking finding ANYWHERE in the published bytes refuses. Regression tests plant canaries in `meta.contributorAlias`/`meta.toolVersion`/`session.projectKey`/`schemaVersion`/`session.sourceId`; the community canary set gains a `meta`/`projectKey` fixture so `scan-canary.mjs` proves it in CI too. (The identical blind spot in the shipped sanitizer scan + human gate is out of this slice's scope — tracked as a separate sanitizer-coverage follow-up; the backstop closes the publish path.)
- **M1 (Major) — `session.projectKey` leaked the raw OS username.** Readers set `projectKey = encodeProjectPath(cwd)` (the raw path), copied verbatim and never normalized, while `cwd` itself gets pseudonymized. The exporter now **re-derives `projectKey` from the sanitized `cwd`** (same non-alphanumeric→`-` encoding), so it carries no more PII than `cwd`; null `cwd` → a fixed placeholder. Consequence: the exported record's `projectKey` is no longer byte-identical to the input, so the round-trip requirement is restated as *lossless serialization + isomorphic message body* (metadata may be normalized).
- **M2 / m1 (Major/Minor) — CI version parity was pinned but never verified.** `scan-changed.mjs` now reads each record's `*.provenance.json` sidecar and calls the new exported `checkEngineParity(provenance, engine)`, FAILING the job on a `sanitizerPackageVersion`/`rulesetVersion`/`gitleaksVersion` mismatch — making a local/CI engine divergence a visible failure (the m3 guarantee) and bringing the sidecar inside the verification boundary (closing m1).

## Open Questions

- **Dataset license** (Open Question 2): CC-BY-4.0 / ODC-BY / Apache-data — placeholder in the template's data-LICENSE until the initiator decides.
- **HF organization + dataset repo names** (design doc Open Question 6) — placeholders in the HF sync stub.
- **Deterministic file-leaf choice** (`sessionId` vs content hash) — leaning `sessionId` for human-readable idempotence; a content hash better dedupes re-exports with edits. Confirm with the community-repo layout.
- **ToS handling of assistant content** (design doc Open Question 3) — orthogonal to the mechanics here, but the PR-body template SHOULD carry the contributor's knowing-consent attestation; the exact wording is a pre-launch decision.
- **Whether the provenance stamp is a sidecar file or embedded in the PR body only** — leaning both (a machine-readable sidecar for CI parity checks + a human-readable PR-body summary).
