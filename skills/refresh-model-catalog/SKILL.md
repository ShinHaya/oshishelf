---
name: refresh-model-catalog
description: Use when the operator asks to refresh, update or inspect the local model catalog (the models each enabled AI agent CLI currently offers), or after installing/upgrading an agent CLI. Reports what changed and proposes model-policy edits; never changes policy or runs costed probes without the operator's consent.
user-invocable: true
---

# Refresh Model Catalog

The orchestrator's model candidates come from the local model catalog
`state/model-catalog.json` (ignored by Git: availability depends on the machine
and account). Each enabled runtime's own CLI reports its models; listing never
executes a model. The orchestrator re-lists a runtime automatically when its
entry is missing, failed, older than `run.modelCatalog.maxAgeHours` (default
168 = one week), or its CLI path/`--version` changed. Use this skill to refresh
on demand and to review the result.

## Steps

1. Refresh every enabled runtime, or only named ones:

   ```bash
   node scripts/issue-model-catalog.mjs refresh            # all enabled runtimes
   node scripts/issue-model-catalog.mjs refresh --agent claude
   ```

   `--dry-run` lists without writing. `show` prints the stored catalog and
   which runtimes are stale without listing anything.

2. Report to the operator, per runtime, from the JSON output:
   - `status` and, for `failed`, the closed `reason` code
     (`cli-not-found`, `auth-unavailable`, `model-not-selectable`, `probe-failed`,
     `verification-timeout`).
   - `diff`: `added` (with each model's current `policy`), `removed`, `relabeled`.
   - The count of models per `policy`: `allowed`, `not-allowed` (outside
     `agents.models.<id>.allow`), `denied` (matches `agents.models.<id>.deny`).
3. If an added model is `not-allowed` or `allowed` contrary to an operator
   decision already recorded in the Issue/PR history (for example a cost
   restriction), propose the exact `.ai-template/config.json` change
   (`allow` is exact; `deny` takes case-insensitive `*` patterns and wins over
   `allow`). The policy file is committed: change it only through an Issue
   worktree after the operator approves.
4. Probing is separate and costs usage: each candidate runs one small headless
   task. Run `node scripts/issue-capabilities.mjs` only when the operator asks
   for verified routes. Otherwise the next orchestration run re-probes only the
   runtimes whose candidate list changed.

## Boundaries

- Never hand-edit `state/model-catalog.json`; never commit it.
- Never infer a model from a name: an alias such as `sonnet` becomes a route
  only after the probe reports its canonical model.
- Report only identifiers, labels, statuses and reason codes; the catalog
  holds nothing else.
