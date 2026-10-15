---
name: design-doc-review
description: Use when a detailed design in a GitHub Issue or PR is created or changed, before implementing it, or when asked to review that design. Do not create per-Issue repository files.
user-invocable: true
---

# Design Doc Review

Review one GitHub Issue/PR design against the five criteria below. Keep the
review in that Issue/PR; do not generate repository design or review files.
This skill owns the criteria; development links here without duplication.

## Scope

- **Review target: one Issue/PR design** — the whole doc when newly created, the
  diff when an existing doc changed.
- Design substance expressed in code blocks (interface signatures, state
  machines, failure paths) **is** design — judge it under the criteria below.
  What is out of scope is implementation-level bugs inside pseudocode
  (off-by-one, missing null check, algorithmic correctness). Flag embedded code
  only when it contradicts the prose, references
  a nonexistent or renamed API / file, or would mislead the implementer.
- Gather traceability inputs before judging: the Issue containing the design (`gh issue view <n> --comments`), the requirements sections the doc
  cites, and — when the doc names existing files or APIs — the current code,
  to catch drift against what is already implemented.

## Review criteria (priority order)

1. **Traceability** — every design element maps back to a requirement, Issue
   goal, or acceptance criterion, and every in-scope requirement is covered.
   Flag orphan design elements (scope creep) and uncovered requirements.
2. **Contracts and responsibilities** — component responsibilities, API /
   interface / IPC contracts, and the data model are explicit enough to
   implement against without guessing. Flag interfaces named but not typed,
   and responsibilities split across components with no stated owner.
3. **Failure handling and state transitions** — error paths, walls
   (CAPTCHA / MFA hand-off), interruption / cancellation / resume, and state
   transitions are designed, not just the happy path. Flag states with no
   exit, and operations whose failure leaves data inconsistent.
4. **Alternatives considered** — rejected options are recorded with the
   rationale for the chosen approach. Flag load-bearing decisions (new
   dependency, schema shape, process boundary) presented with no alternative.
5. **Test strategy** — the doc says how its behavior will be verified (which
   layers, which cases, what is manual-only). Flag designs whose acceptance
   criteria have no corresponding test approach.

Every criterion is judged: detailed findings go in the findings list (a few
strong ones over many shallow ones), and the closing `## Criterion coverage`
section states, for all five criteria, either which findings violate it or
that it is satisfied.

## Output format

Record the review in the Issue/PR using this format:

```
verdict: PASS | NEEDS_CHANGES | NIT_ONLY

## Findings

1. [<severity>] <Issue/PR URL>#<section-or-quoted-text> — <one-sentence problem statement>
   <2-4 sentences of explanation, including a concrete suggested fix>

## Criterion coverage

- **Traceability** — <"violated: findings N, M" or "satisfied">
- ... (all five criteria)
```

Severity (this list is controlling for design doc review): `blocker`
(design contradicts a non-negotiable requirement or cannot satisfy an
acceptance criterion) · `major` (an implementer following the doc would
build the wrong or an untestable thing) · `minor` (clarity, small gaps a
competent implementer would resolve correctly) · `nit` (wording, optional).
Verdict mapping: any `blocker`/`major` → `NEEDS_CHANGES`; only
`minor`/`nit` → `NIT_ONLY`; no findings → `verdict: PASS` with a one-line
reason. Cite the comment URL and exact section or quoted text.

## Common mistakes

- Reviewing pseudocode as production code.
- Demanding concerns from a different system shape (for example horizontal
  scaling or HA from a single-user local app) — judge against this project's
  actual context.
- Flagging detail deliberately deferred to implementation as a gap when the
  doc says so explicitly and the deferral is safe.
- Re-litigating requirements — requirements review owns that; here
  they are inputs.
