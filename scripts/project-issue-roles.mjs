/**
 * Role programs for bounded multi-agent Issue execution.
 *
 * A single Issue is implemented by a *sequence* of workers, each running as
 * its own CLI process on its own verified route. Process isolation is the
 * context isolation: a reviewer started as a separate CLI cannot see the
 * implementer's conversation, chain-of-thought, or raw responses, because it
 * never shares an address space or a session with it.
 *
 * This module owns the deterministic part of that: which roles run, in which
 * order, on which routes, and what non-sensitive payload each one receives.
 * The bounded execution modes come from `project-issue-modes.mjs`.
 */

import {
  EXECUTION_MODES,
  assignRoutesForMode,
  determineEligibleModes,
  rankAndSelectMode,
} from "./project-issue-modes.mjs";

export const ROLES = Object.freeze({
  PLANNER: "planner",
  IMPLEMENTER: "implementer",
  REVIEWER: "reviewer",
});

export const VALID_ROLES = Object.freeze(Object.values(ROLES));

/**
 * Role sequence per execution mode. `parallel-analysis-implement-review`
 * (analysts + synthesizer) has no program yet and is therefore never ranked
 * into a run — see MODE_PREFERENCES.
 */
export const MODE_ROLE_PROGRAMS = Object.freeze({
  [EXECUTION_MODES.DIRECT_REVIEW]: Object.freeze([ROLES.IMPLEMENTER, ROLES.REVIEWER]),
  [EXECUTION_MODES.PLAN_IMPLEMENT_REVIEW]: Object.freeze([
    ROLES.PLANNER,
    ROLES.IMPLEMENTER,
    ROLES.REVIEWER,
  ]),
});

/**
 * Ranking preference over the deterministically eligible modes.
 *
 * `determineEligibleModes` leaves `direct-review` eligible alongside
 * `plan-implement-review` for medium-risk Issues, so an unconditional
 * preference would mean "always the cheapest eligible mode" and risk would
 * never buy a planner. Only genuinely low-risk work skips planning.
 *
 * Either order always matches, because `determineEligibleModes` always
 * includes `plan-implement-review`; the unimplemented parallel-analysis mode
 * is therefore never selected by accident.
 */
export function modePreferencesFor(riskCategory, dependencyDepth = 0) {
  const lowRisk = String(riskCategory ?? "low").toLowerCase() === "low";
  // `determineEligibleModes` also keeps `direct-review` eligible at
  // dependencyDepth exactly 2, so the depth has to be part of the preference
  // too — otherwise a depth-2 Issue would skip planning, contradicting the
  // documented "depth >= 2 selects plan-implement-review" rule.
  return lowRisk && Number(dependencyDepth) <= 1
    ? [EXECUTION_MODES.DIRECT_REVIEW, EXECUTION_MODES.PLAN_IMPLEMENT_REVIEW]
    : [EXECUTION_MODES.PLAN_IMPLEMENT_REVIEW, EXECUTION_MODES.DIRECT_REVIEW];
}

/** Reviewer verdicts returned in the `role-complete` event. */
export const REVIEW_VERDICTS = Object.freeze(["PASS", "NEEDS_REVISION", "REJECTED"]);

/**
 * One review per Issue. A
 * NEEDS_REVISION verdict buys one implementer fix pass that is not re-reviewed.
 */
export const MAX_REVIEW_PASSES = 1;

/**
 * An integration-gate rejection may send the program back to the implementer
 * once. This budget is separate from MAX_REVIEW_PASSES: a gate rejection is a
 * cross-Issue problem, not a code-review round, so it gets its own single
 * allowance (re-checked by the gate, not the reviewer) and a second rejection
 * stops the Issue instead of cycling.
 */
export const MAX_GATE_REOPENS = 1;

/**
 * Keys that must never appear in a dispatch payload.
 */
export const DISALLOWED_PAYLOAD_KEYS = Object.freeze([
  "chainOfThought",
  "chain_of_thought",
  "cot",
  "rawResponse",
  "raw_response",
  "rawModelResponse",
  "raw_model_response",
  "conversationHistory",
  "conversation_history",
  "fullConversation",
  "full_conversation",
  "toolHistory",
  "tool_history",
  "apiKey",
  "api_key",
  "credential",
  "credentials",
  "password",
  "secret",
  "prompt",
  "systemPrompt",
  "userPrompt",
]);

const DISALLOWED_PAYLOAD_KEY_SET = new Set(DISALLOWED_PAYLOAD_KEYS);

/**
 * Pick the execution mode for one Issue from the deterministic eligible set.
 * Returns the mode plus the closed reason describing why it was chosen.
 */
export function selectExecutionMode(item = {}) {
  const riskCategory = item.riskCategory ?? "low";
  const dependencyDepth = Array.isArray(item.dependencies) ? item.dependencies.length : 0;
  const eligibleModes = determineEligibleModes({
    riskCategory,
    size: item.size ?? "M",
    dependencyDepth,
    ...(item.changeScopeCount === undefined ? {} : { changeScopeCount: item.changeScopeCount }),
  });
  const mode = rankAndSelectMode(eligibleModes, modePreferencesFor(riskCategory, dependencyDepth));
  return { mode, eligibleModes, selectionReason: "deterministic-policy" };
}

export function roleProgramForMode(mode) {
  const program = MODE_ROLE_PROGRAMS[mode];
  if (!program) throw new Error(`unsupported-execution-mode:${mode}`);
  return [...program];
}

/**
 * Bind each role in the program to a verified route.
 *
 * `implementer` and `reviewer` get distinct routes whenever the pool holds
 * more than one. With a single verified route the run continues on the same
 * route rather than failing closed — a one-provider setup must stay usable —
 * and the degradation is recorded as a closed reason.
 *
 * `planner` takes the reviewer's route when one is distinct, so the plan and
 * the implementation come from different runtimes.
 */
export function assignRoleRoutes(workerRoutes, program) {
  const allowSameRoute = (workerRoutes ?? []).length === 1;
  const { implementer, reviewer } = assignRoutesForMode(workerRoutes, { allowSameRoute });
  const routes = {};
  for (const role of program) {
    if (role === ROLES.IMPLEMENTER) routes[role] = implementer;
    else routes[role] = reviewer;
  }
  return {
    routes,
    ...(allowSameRoute ? { degraded: "same-route-reviewer:single-verified-route" } : {}),
  };
}

/**
 * Which skill the worker for `role` must use. The first role to enter the
 * Issue creates the worktree; every later role resumes the existing one.
 *
 * A reviewer gets **no** skill: both `issue-implementation` and
 * `handoff-issue` drive implementation and commit, which contradicts a
 * read-only review. It enters the existing worktree directly instead.
 */
export function skillForRole(role, { hasWorktree }) {
  if (role === ROLES.REVIEWER) return null;
  return hasWorktree ? "handoff-issue" : "issue-implementation";
}

/**
 * The role whose route this role must differ from. Independent review means
 * the implementer and the reviewer never share a runtime; this pair is the
 * only *hard* rule, so a proposal violating it is rejected.
 */
export function counterpartRole(role) {
  if (role === ROLES.REVIEWER) return ROLES.IMPLEMENTER;
  if (role === ROLES.IMPLEMENTER) return ROLES.REVIEWER;
  return null;
}

/**
 * The role whose route this role should *prefer* to differ from when picking
 * one. Adds the planner, which `assignRoleRoutes` already keeps off the
 * implementer's route so plan and implementation come from different
 * runtimes — without that preference a planner handoff would fall back to the
 * implementer's route even with other verified routes left.
 */
export function distinctPreferenceRole(role) {
  if (role === ROLES.PLANNER) return ROLES.IMPLEMENTER;
  return counterpartRole(role);
}

/** Advance a role program. Returns the next state, never mutating the input. */
export function advanceRoleProgram(roleState, { role, verdict } = {}) {
  const program = roleState.program;
  const current = program[roleState.index];
  if (current !== role) throw new Error(`role-mismatch:${roleState.issue}:${role}`);

  if (role !== ROLES.REVIEWER) {
    // A fix pass after the review budget is spent (review findings or a gate
    // reopen) is not re-reviewed: it goes straight back to the milestone gate.
    if (role === ROLES.IMPLEMENTER && roleState.fixCycles > 0 && roleState.reviewPasses >= MAX_REVIEW_PASSES) {
      return { ...roleState, index: program.indexOf(ROLES.REVIEWER), status: "awaiting-milestone" };
    }
    return { ...roleState, index: roleState.index + 1, status: "active" };
  }

  if (!REVIEW_VERDICTS.includes(verdict)) throw new Error(`invalid-review-verdict:${verdict}`);
  const reviewPasses = roleState.reviewPasses + 1;
  if (verdict === "PASS") {
    return { ...roleState, reviewPasses, status: "awaiting-milestone" };
  }
  if (verdict === "REJECTED" || reviewPasses > MAX_REVIEW_PASSES) {
    return {
      ...roleState,
      reviewPasses,
      status: "blocked",
      blockedReason: verdict === "REJECTED" ? "review-rejected" : "review-passes-exhausted",
    };
  }
  // NEEDS_REVISION: one fix pass by the implementer, which is not re-reviewed.
  return {
    ...roleState,
    reviewPasses,
    fixCycles: roleState.fixCycles + 1,
    index: program.indexOf(ROLES.IMPLEMENTER),
    status: "active",
  };
}

/**
 * Send a finished program back to the implementer for one more fix cycle —
 * used when the integration gate rejects work. MAX_GATE_REOPENS bounds this,
 * so a rejected Issue cannot cycle forever; the gate re-checks the fix.
 */
export function reopenRoleProgramForFix(roleState, reason) {
  // The gate gets one reopen of its own. A second rejection means the fix did
  // not resolve the cross-Issue problem, so stop rather than cycle.
  const gateReopens = roleState.gateReopens ?? 0;
  if (gateReopens >= MAX_GATE_REOPENS) {
    return { ...roleState, status: "blocked", blockedReason: `${reason}-twice` };
  }
  return {
    ...roleState,
    index: roleState.program.indexOf(ROLES.IMPLEMENTER),
    status: "active",
    fixCycles: roleState.fixCycles + 1,
    gateReopens: gateReopens + 1,
  };
}

/** Reject any payload carrying a disallowed key, at any depth. */
export function assertNoDisallowedKeys(value, path = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoDisallowedKeys(item, `${path}[${index}]`));
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.keys(value)) {
    if (DISALLOWED_PAYLOAD_KEY_SET.has(key))
      throw new Error(`disallowed-payload-key:${key}:${path || "root"}`);
    assertNoDisallowedKeys(value[key], path ? `${path}.${key}` : key);
  }
}

/**
 * The complete set of facts the parent hands a worker. Deliberately tiny:
 * the worker fetches the Issue body, the diff, and test results itself, so
 * nothing sensitive has to travel through orchestrator state or the prompt.
 */
export function buildRoleDispatchPayload({
  role,
  issueNumber,
  executionMode,
  skill,
  releasePolicy,
  nextMilestone,
  reviewPass,
  fixCycle,
}) {
  if (!VALID_ROLES.includes(role)) throw new Error(`invalid-role:${role}`);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error("issue-number-required");
  const payload = {
    role,
    issueNumber,
    executionMode,
    // A reviewer runs no skill, so the field is omitted rather than null.
    ...(skill === null || skill === undefined ? {} : { skill }),
    releasePolicy,
    nextMilestone,
    ...(role === ROLES.REVIEWER ? { reviewPass: reviewPass ?? 1 } : {}),
    // A fix cycle tells the implementer that a pull request already exists and
    // that the reviewer's findings are waiting on it.
    ...(role === ROLES.IMPLEMENTER && Number(fixCycle) > 0 ? { fixCycle: Number(fixCycle) } : {}),
  };
  assertNoDisallowedKeys(payload);
  return payload;
}


/** Recompute provisional plan fields after explicit triage adoption. */
export function applyTriageDecision(item, decision) {
  if (!decision || decision.action === "fallback") return { ...item };
  const risks = ["low", "medium", "high", "critical"];
  const sizes = ["XS", "S", "M", "L", "XL"];
  if (!risks.includes(decision.riskCategory) || !sizes.includes(decision.size))
    throw new Error("triage-invalid-decision");
  const riskCategory = risks[Math.max(risks.indexOf(item.riskCategory ?? "low"), risks.indexOf(decision.riskCategory))];
  const size = sizes[Math.max(sizes.indexOf(item.size), sizes.indexOf(decision.size))];
  const effective = { ...item, riskCategory, size };
  const selected = selectExecutionMode(effective);
  let executionMode = selected.mode;
  let roleProgram = roleProgramForMode(executionMode);
  if (item.modeOverride) {
    const proposed = item.modeOverride;
    let program;
    try { program = roleProgramForMode(proposed.executionMode); } catch { throw new Error("triage-mode-conflict"); }
    if (!selected.eligibleModes.includes(proposed.executionMode) ||
        JSON.stringify(proposed.roleProgram) !== JSON.stringify(program))
      throw new Error("triage-mode-conflict");
    executionMode = proposed.executionMode;
    roleProgram = program;
  }
  return { ...effective, eligibleModes: selected.eligibleModes, executionMode, roleProgram };
}
