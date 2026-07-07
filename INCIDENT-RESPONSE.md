# INCIDENT-RESPONSE — post-publication secret leak

> The mandatory local pre-check (`@mosga/publisher`) and the community repo's
> pinned-engine CI re-scan exist so this playbook is (almost) never needed. But a
> PR is public the instant it is created and **git history is permanent**, so if a
> secret ever reaches a merged record we must act as if it is already compromised.
> This document is the response. It names owners and timelines so it is
> actionable, not aspirational.

## Prime directive

**Assume any leaked credential is already compromised.** Removal from our
dataset and repo REDUCES exposure but does not undo it. Rotation by the
credential owner is the only real remediation — do it first and in parallel with
everything else.

## Roles (fill in real handles before launch)

| Role | Handle | Responsibility |
| --- | --- | --- |
| Incident Lead (IL) | `@TBD` | Owns the incident end-to-end; declares start/close. |
| Data Maintainer (DM) | `@TBD` | HF dataset + community repo write access; performs removal/rewrite. |
| Ruleset Owner (RO) | `@TBD` | Owns `@mosga/sanitizer`; ships the prevention rule. |
| Comms (CO) | `@TBD` | Contributor notice + public incident record. |

Any community member who spots a leak: **open a private report to the IL
immediately — do NOT open a public issue quoting the secret** (that amplifies it).

## Severity & clock

`T0` = the moment the leak is confirmed. The IL declares the incident at `T0`.

| Step | Target |
| --- | --- |
| 1. Contain (contributor rotation notice sent) | `T0 + 1h` |
| 2. Remove from HF + re-release | `T0 + 4h` |
| 3. Purge repo history (or rotate repo) | `T0 + 24h` |
| 4. Public incident record | `T0 + 72h` |
| 5. Prevention rule merged to the shared ruleset | `T0 + 7d` |

---

## Step 1 — Notify the contributor to rotate the credential (IL + CO, by T0+1h)

- Identify the contributor from the record's `contributorAlias` + PR author.
- Send a **private** notice: which credential leaked (by type/location, **never**
  re-paste the secret in a durable channel), and that they must **revoke/rotate
  it now** at the issuing provider. Rotation is the only true fix.
- Record acknowledgement. If the contributor is unreachable, proceed with
  removal regardless; exposure reduction does not wait on them.

## Step 2 — Remove from the HuggingFace dataset + re-release (DM, by T0+4h)

- Delete the offending record from the HF dataset revision.
- Cut a **new dataset revision** with the record removed and publish it; mark the
  affected prior revision(s) as yanked/deprecated in the dataset card.
- Note: HF revision history may retain the old revision — treat the credential as
  compromised regardless (see Prime directive). Removal limits *further*
  distribution; it is not erasure.
- See `templates/community-data-repo/scripts/hf-sync.mjs` for the (operator-run)
  sync path; the re-release is the reverse: drop the record, bump the revision.

## Step 3 — Purge the secret from git history (DM + IL, by T0+24h)

The record file is in the community repo's permanent history. Removing it in a new
commit is **not enough** — the blob stays reachable.

1. Rewrite history to excise the blob across all refs, using `git filter-repo`
   (preferred) or the BFG:
   ```
   git filter-repo --path data/<schemaVersion>/<alias>/<sessionId>.jsonl --invert-paths
   git filter-repo --path data/<schemaVersion>/<alias>/<sessionId>.provenance.json --invert-paths
   ```
2. Force-push the rewritten history; ask GitHub Support to expire cached views and
   any open forks/PRs that still reference the old objects.
3. **If history rewrite is infeasible or incomplete** (heavy forking, the object
   is widely mirrored): **rotate the repository** — create a fresh repo from the
   cleaned tree, archive the old one private/deleted, and re-point CI + HF sync.
4. Every collaborator re-clones; stale local clones still hold the secret and must
   be discarded.

## Step 4 — Publish a public incident record (CO, by T0+72h)

- Add a dated entry to a public `SECURITY-INCIDENTS.md` (or GitHub Security
  Advisory) in the community repo: what leaked (type only), timeline, actions
  taken, and confirmation the credential owner was notified to rotate.
- Be transparent about the residual risk (history/mirrors) without re-disclosing
  the secret value. Transparency is a trust obligation to the community whose data
  we steward.

## Step 5 — Prevention: strengthen the shared ruleset (RO, by T0+7d)

A leak that reached publication means the shared ruleset **missed a pattern**.
Close the gap so every future local pre-check AND CI run catches it:

1. Add/adjust a rule in `@mosga/sanitizer` (a gitleaks rule, a custom Layer-2
   rule, or an entropy/keyword tweak) with a fixture reproducing the missed
   pattern using an **obviously-fake** value.
2. Bump the ruleset/engine version; cut a new `@mosga/sanitizer` release.
3. Update the community repo's pinned `@mosga/sanitizer`/`@mosga/publisher`
   versions (the m3 pin) so CI re-scans with the improved engine.
4. Add a regression test so the pattern can never silently regress.

This is the flywheel: every incident makes the gate stronger for everyone.

---

## After-action

The IL closes the incident once Steps 1–5 are done, and files a short blameless
retro: how the pattern slipped every prior layer (whitelist → human gate → local
pre-check → CI), and which layer is the cheapest place to have caught it. Feed
that back into the ruleset and the reviewer guidance.
