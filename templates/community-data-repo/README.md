# mosga community dataset (scaffold)

This template is the canonical public GitHub repository that receives reviewed
mosga contributions. It includes the compatibility manifest, pinned CI
verification, canary self-test, and a Hugging Face sync stub; it is not a live
dataset.

Every record is compiled locally from a reviewed, gate-unlocked session. The
publisher scans the exact record and provenance bytes before the daemon may
write them. This repository then validates the target contract and re-scans the
same committed bytes with pinned engine versions before merge.

## Canonical contribution flow

1. The operator configures this public repository in mosga as its canonical
   GitHub `owner/repo` publication target.
2. Mosga resolves the repository, exact default-branch commit, compatibility
   manifest, authenticated actor, and direct-or-fork push route.
3. The operator previews one or more reviewed sessions. Preview is read-only
   and reports whether confirmed submit will create a fork.
4. Explicit confirmed submit writes only the sealed bytes in a daemon-managed
   private workspace, pushes the contribution branch, and opens a pull request
   against this canonical upstream.
5. CI validates `.mosga-dataset.json`, proves the canary gate is alive, checks
   engine parity from provenance, and scans every changed record.

The contribution branch may live in the upstream repository or in the
authenticated actor's verified fork, but the pull request always targets this
canonical upstream and its sealed base branch.

Only contribute your own data. A pull request is public when created and Git
history is durable, which is why preview confirmation, the final exact-byte
pre-check, and independent CI verification are mandatory.

## Compatibility manifest

`.mosga-dataset.json` declares:

- `kind: "mosga-community-data"`
- publication `contractVersion: 1`
- the accepted record schema versions
- the concrete dataset license (`CC-BY-4.0` in this template)

Run the standalone compatibility checks with:

```bash
npm run check:compat
```

CI runs the same validation whenever the manifest, scripts, tests, records, or
package pins change. Missing, malformed, unsupported, duplicate-schema, empty,
and placeholder-license manifests fail without contacting GitHub.

## Pinned-engine invariant

This development template vendors exact `@mosga/*@0.1.0` package tarballs and
its own `package-lock.json`. A generated repository can therefore run `npm ci`
and the complete scan workflow without a parent monorepo or unpublished npm
packages. The four tarballs and lockfile are one coordinated engine release
unit and must match contribution provenance. Ruleset identity alone is
insufficient because runtime/engine differences can change scan behavior.
Version drift is a visible CI failure. Compatibility checks also decompress
every archive and reject every bounded drive-rooted `X:\Users\` occurrence,
every NUL-bearing entry, and known private workspace roots. Documentation
examples must use environment-variable forms such as `%USERPROFILE%` instead
of a concrete profile path.

Community-wide additive rules may be committed as
`sanitizer.custom-rules.json`. Contributor-private rules stay on the
contributor's machine.

## Layout

- `vendor/` — exact installable development snapshots for the pinned engine.
- `package-lock.json` — standalone reproducible CI dependency graph.

- `.mosga-dataset.json` — strict publication compatibility contract.
- `data/<schemaVersion>/<contributorAlias>/<sessionId>.jsonl` — records.
- `data/.../*.provenance.json` — exact engine and contribution provenance.
- `.github/workflows/scan.yml` — manifest, canary, parity, and record checks.
- `tests/canary/` — obviously fake values the CI gate must catch.
- `scripts/` — manifest validation, record scans, canaries, and HF sync stub.
- `LICENSE-DATA` — concrete CC-BY-4.0 dataset declaration.

For a post-publication issue, follow the repository incident-response process.
