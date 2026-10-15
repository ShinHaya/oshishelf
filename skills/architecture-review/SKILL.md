---
name: architecture-review
description: Use when README.md (or another architecture / technology-selection document) is created or changed, or when asked to review an architecture decision. Not for requirements, per-Issue design docs, or code diffs.
user-invocable: true
---

# Architecture Review

Review `README.md` (or a diff to it) against the five criteria
below. This skill owns the criteria; development links here without duplication.

Judge everything against **this project's actual context** — its deployment
shape, user count, and operating environment as stated in
`README.md` and `AGENTS.md`. Do not import expectations
from a different shape of system (for example demanding horizontal scaling,
HA clusters, or fleet observability from a single-user desktop app, or
ignoring multi-tenant isolation in a hosted service). Where a classic concern
genuinely does not apply, say "not applicable" explicitly under Criterion
coverage rather than inventing a finding. The project's non-negotiable
requirements (`AGENTS.md`) are fixed inputs — review whether the
architecture *satisfies* them, never whether they are right.

When the document names repository files, APIs, or implemented behavior,
verify those claims against the current code before judging — a confirmed
gap outranks a speculative one — and cite the code where it changes a
finding.

## Review criteria (priority order)

1. **Requirements and constraint fit** — every architectural choice satisfies
   the project's non-negotiable requirements (`AGENTS.md`) and
   the quality attributes the requirements actually prioritize. Make trade-off
   points explicit: which quality was sacrificed for which, and is that
   consistent with the requirements' priorities?
2. **System boundaries and data flow** — process / trust boundaries are drawn,
   and it is decidable where sensitive data may exist in what form (encrypted
   at rest / in memory / in transit) and what every egress point is. Flag any
   component whose access to sensitive data is broader than its job.
3. **Dependencies** — each significant dependency is justified against
   alternatives, maintained, license-compatible with OSS distribution, and
   its security surface is understood; the stack stays within the doc's own
   decisions (no undocumented framework / tool / service).
4. **Failure modes and data integrity** — crash, abrupt termination,
   out-of-space, and interrupted-write behavior for the system's source of
   truth is designed: atomic writes, versioned schema with a migration story,
   and detectable-not-silent corruption. Includes diagnosability: how an
   operator or agent investigates a failure with the observability the project
   actually permits.
5. **Decision records** — each significant decision is captured so it can be
   revisited: context, considered alternatives, rationale, and what would
   trigger reconsideration (ADR-style, whether or not in ADR files).

Every criterion is judged: detailed findings go in the findings list (a few
strong ones over many shallow ones), and the closing `## Criterion coverage`
section states, for all five criteria, which findings violate it, or that it
is satisfied (optionally "satisfied except finding N (minor)" when only
minor/nit findings touch it), or that it is not applicable and why.

## Output format

Record the review in the Issue/PR using this format. When reviewing the whole
document rather than a diff, citing repository code that confirms a finding is
in scope.

```
verdict: PASS | NEEDS_CHANGES | NIT_ONLY

## Findings

1. [<severity>] README.md:<line> — <one-sentence problem statement>
   <2-4 sentences of explanation, including a concrete suggested fix>

## Criterion coverage

- **Requirements and constraint fit** — <"violated: findings N, M" / "satisfied" / "satisfied except finding N (minor)" / "not applicable: reason">
- ... (all five criteria)
```

Severity (this list is controlling for architecture review): `blocker`
(the document's chosen design violates a non-negotiable or would lose or
expose the user's data) · `major` (a real risk left undesigned, or an
unrecorded load-bearing decision, likely to force rework — an *omission* is
at most `major`; `blocker` is reserved for what the document affirmatively
chooses) · `minor` (clarity, small gaps) · `nit` (wording, optional). Verdict mapping: any
`blocker`/`major` → `NEEDS_CHANGES`; only `minor`/`nit` → `NIT_ONLY`; no
findings → `verdict: PASS` with a one-line reason. Cite doc line numbers (or
post-image diff lines when reviewing a diff). Do not review embedded sample
code as shipped code.

## Common mistakes

- Applying defaults from a different system shape: demanding scalability,
  uptime targets, or cloud cost analysis from a single-user desktop app, or
  the reverse. The analogues that do apply belong under criteria 1 and 4 when
  the requirements make them matter.
- Re-litigating the non-negotiables (e.g. proposing a hosted service for
  convenience) — they are inputs, not review targets.
- Treating "not applicable" as a failure — an explicit, reasoned
  non-applicability is a passing answer.
- Flagging a missing formal ADR directory when the decision, alternatives,
  and rationale are recorded in the doc itself — criterion 5 is about the
  content, not the file format.
