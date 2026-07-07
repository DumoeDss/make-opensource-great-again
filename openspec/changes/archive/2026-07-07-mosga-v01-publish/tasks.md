# Tasks — mosga-v01-publish

Ordered, individually completable. Fixtures are ALWAYS hand-crafted fake data; canary secrets are obviously non-functional. No real HF upload, no live external PR. Capabilities: `dataset-export`, `publish-precheck`, `pr-submission`, `community-repo-template`. Consumes the shipped `@mosga/sanitizer` + `@mosga/contracts` + daemon export contract unchanged.

## 1. Publisher package scaffold

- [x] 1.1 Create `packages/publisher/` (`@mosga/publisher`): ESM `package.json` (`exports`/`bin`), `tsconfig.json` extending base, `tsup.config.ts` (ESM + d.ts), `src/index.ts`. Depend on `@mosga/sanitizer`, `@mosga/contracts` (workspace `*`) + `zod`.
- [x] 1.2 Add a smoke test so the root vitest runner picks up the package; confirm root `typecheck`/`build`/`test` pass with the package present.

## 2. Dataset export

- [x] 2.1 Implement the exporter: accept a `SanitizedSession`, validate it is stamped (`meta.sanitized:true` + non-null `sanitizationRulesetVersion`) and `SanitizedSessionSchema`-valid; refuse an un-stamped/gate-locked session.
- [x] 2.2 Serialize to one JSONL record per session (one line = the stamped envelope); keep the body isomorphic (no slicing).
- [x] 2.3 Compute the deterministic file path (`data/<schemaVersion>/<contributorAlias>/<sessionId>.jsonl`); make re-export idempotent to the same path.
- [x] 2.4 Build the provenance stamp `{ schemaVersion, sanitizationRulesetVersion, sanitizerPackageVersion, gitleaksVersion }`; read `sanitizerPackageVersion` from the resolved `@mosga/sanitizer` package.json and `gitleaksVersion` from its `GITLEAKS_VERSION`; assert the stamp's ruleset version equals the envelope's.
- [x] 2.5 Vitest: export→parse round-trip deep-equals + schema-valid; un-stamped session refused; stamp carries engine version and matches the envelope; re-export resolves the same path.

## 3. Mandatory local pre-check (highest-value gate)

- [x] 3.1 Implement the pre-check: parse the about-to-publish record back to a `SanitizedSession`, compile the ruleset (`compileRuleset({ customRules })`, custom rules from trusted local config — NEVER an artifact/request-embedded path), and run `scanSession`.
- [x] 3.2 Hard-refuse on ANY blocking finding (`secrets`, `custom`, `redos-guard`, `ruleset-compile-error`): write no file, prepare no PR, report the blocking findings. Proceed only on zero blocking findings. Do not refuse on non-blocking L3 findings.
- [x] 3.3 Surface the pre-check's engine + ruleset version (`sanitizerPackageVersion`, `rulesetVersion`, `gitleaksVersion`) for CI parity.
- [x] 3.4 Vitest (THE core test): a would-be-published artifact with a planted fake canary secret → pre-check REFUSES and emits no output; a fully-sanitized artifact → pre-check passes; a human-`allow`ed real secret still present → refused; an artifact with only L3/normalization findings → passes.

## 4. GitHub PR submission

- [x] 4.1 Implement contribution prep (only after a passing pre-check): resolve a working clone, create branch `contrib/<contributorAlias>/<sessionId>`, place the record at its deterministic path, stage a commit. No prep for a failed pre-check.
- [x] 4.2 Render the PR body from a template including the provenance stamp, record/session count, and a sanitization attestation.
- [x] 4.3 Detect the `gh` CLI: when present+authenticated, support pushing + opening the PR; when absent, emit the exact `git`/`gh` commands + staged file list + documented manual steps.
- [x] 4.4 Vitest: clean artifact stages branch/file/commit; failed pre-check stages nothing; PR body carries the version stamp; `gh`-absent path emits exact commands; the flow uses a local/dry-run target and never opens a live external PR.

## 5. Community data-repo template

- [x] 5.1 Create `templates/community-data-repo/`: data-repo `README` (contribution guide), data-`LICENSE` placeholder (CC-BY / ODC-BY 待定), and the `data/` layout matching the exporter's placement.
- [x] 5.2 Add `.github/workflows/scan.yml`: on PR, install the pinned `@mosga/sanitizer` version and re-run the shared-ruleset scan over each changed record file, failing on any blocking finding.
- [x] 5.3 Add `tests/canary/` obviously-fake canary records + the CI assertion that they ARE caught (gate self-test; a miss is a build failure).
- [x] 5.4 Add `scripts/hf-sync.*`: a documented HF batch-sync stub, clearly marked creds/upload out of scope, performing no live upload.
- [x] 5.5 Vitest/checks: template contains README + data-LICENSE + `data/` layout; the workflow references the pinned sanitizer + scans changed records; canary fixtures are non-functional fakes and are asserted-caught by the scan logic the workflow invokes.

## 6. Incident response + loop closure

- [x] 6.1 Write `INCIDENT-RESPONSE.md`: HF record removal + re-release; git history rewrite/rotation; contributor credential-rotation notice; public incident record; prevention follow-up (add a rule to the shared ruleset); named owners + timeline.
- [x] 6.2 Add an end-to-end closure test/doc note demonstrating the full v0.1 loop on a fake fixture: read → scan → gate (stamped envelope) → export → pre-check pass → PR-prep staged (dry-run), proving a session can traverse the whole pipeline.

## 7. Validation

- [x] 7.1 Run root `typecheck`, `build`, and `test` — all green; confirm no test performs a live upload/PR or reads real session data.
- [x] 7.2 Run `openspec validate --change mosga-v01-publish` (strict) and fix any errors until it passes.
