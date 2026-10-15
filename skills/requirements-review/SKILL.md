---
name: requirements-review
description: Use when a diff adds, changes, or removes content in README.md — before committing it, while drafting it, or when asked to review requirement wording. Not for code diffs or other docs.
user-invocable: true
---

# Requirements Review

Review a diff to `README.md` against the five criteria below. The
criteria are owned by this skill; development links here without duplicating them.

## Scope

- **Review target: the diff to `README.md` only.** Judge unchanged
  text only as context (e.g. a contradiction between new and existing text).
- Do not review code diffs (`/code-review` owns that) and do not judge the
  correctness of sample code embedded in the documentation.

## Review criteria (priority order)

1. **Unambiguous** — each changed statement allows exactly one interpretation.
   Flag vague qualifiers ("appropriately", "as needed", "fast", "simple",
   "etc."), undefined new terms, and the same concept named two different ways.
2. **Verifiable** — an implementer could objectively check whether the
   requirement is met (by test, inspection, or measurement). Flag requirements
   with no observable pass/fail condition ("the UI should feel trustworthy").
3. **Consistent** — the change contradicts neither the rest of
   `README.md` nor the product principles stated in the repository's
   agent instructions (`AGENTS.md`). A diff that silently weakens a
   non-negotiable requirement is a `blocker`.
4. **Failure paths specified** — where the diff introduces behavior, the
   failure / exception / interruption side is stated too (errors, external
   blockers the system cannot resolve on its own, cancellation, partial
   completion). Flag happy-path-only requirements.
5. **Scope explicit** — what is *not* included is stated, and unstated
   assumptions (network availability, prior verification, existing data) are
   surfaced instead of implied.

Every criterion is judged: detailed findings go in the findings list (a few
strong ones over many shallow ones), and the closing `## Criterion coverage`
section states, for all five criteria, either which findings violate it or
that it is satisfied.

## Output format

Record the review in the Issue/PR using this format:

```
verdict: PASS | NEEDS_CHANGES | NIT_ONLY

## Findings

1. [<severity>] README.md:<line> — <one-sentence problem statement>
   <2-4 sentences of explanation, including a concrete suggested rewording>

## Criterion coverage

- **Unambiguous** — <"violated: findings N, M" or "satisfied">
- ... (all five criteria)
```

Severity (this list is controlling for requirements review): `blocker`
(contradicts a non-negotiable / makes the requirement unimplementable) ·
`major` (ambiguity or missing failure path likely to cause a wrong
implementation) · `minor` (clarity, small consistency issues) · `nit`
(wording, optional). Verdict mapping: any `blocker`/`major` →
`NEEDS_CHANGES`; only `minor`/`nit` → `NIT_ONLY`; no findings →
`verdict: PASS` with a one-line reason. Use post-image line numbers; if the
input has no usable hunk headers, cite the quoted text instead.

## Common mistakes

- Reviewing the whole document instead of the diff.
- Raising style opinions about prose as `major` — style is `nit`.
- Marking a requirement ambiguous because it delegates detail to
  `architecture.md` — a deliberate pointer to another owning doc is not a gap.
