import test from "node:test";
import assert from "node:assert/strict";

import {
  DISALLOWED_PAYLOAD_KEYS,
  MAX_REVIEW_PASSES,
  ROLES,
  advanceRoleProgram,
  assignRoleRoutes,
  assertNoDisallowedKeys,
  buildRoleDispatchPayload,
  counterpartRole,
  distinctPreferenceRole,
  modePreferencesFor,
  roleProgramForMode,
  selectExecutionMode,
  skillForRole,
} from "../../scripts/project-issue-roles.mjs";
import { VALID_MODES, determineEligibleModes } from "../../scripts/project-issue-modes.mjs";
import { buildWorkerPrompt } from "../../scripts/project-issue-runtime-adapters/shared.mjs";

const route = (agent, model) => ({
  agent,
  model,
  role: "worker",
  selector: `sel ${model}`,
  selectable: true,
  verifiable: true,
  timeoutMs: 60_000,
});

const program = (mode) => roleProgramForMode(mode);

test("small low-risk Issues get direct-review, larger ones get plan-implement-review", () => {
  assert.equal(selectExecutionMode({ size: "S", dependencies: [] }).mode, "direct-review");
  assert.equal(selectExecutionMode({ size: "M", dependencies: [] }).mode, "direct-review");
  assert.equal(selectExecutionMode({ size: "XL", dependencies: [] }).mode, "plan-implement-review");
  assert.equal(
    selectExecutionMode({ size: "S", riskCategory: "high", dependencies: [] }).mode,
    "plan-implement-review",
  );
});

test("every eligible mode set contains an implemented mode, so ranking never falls through", () => {
  const sizes = ["XS", "S", "M", "L", "XL"];
  const risks = ["low", "medium", "high", "critical"];
  for (const size of sizes)
    for (const riskCategory of risks)
      for (const dependencyDepth of [0, 1, 2, 3, 5]) {
        const eligible = determineEligibleModes({ size, riskCategory, dependencyDepth });
        assert.equal(
          eligible.includes("plan-implement-review"),
          true,
          `plan-implement-review missing for ${size}/${riskCategory}/${dependencyDepth}`,
        );
        const { mode } = selectExecutionMode({
          size,
          riskCategory,
          dependencies: Array.from({ length: dependencyDepth }, (_, index) => index),
        });
        assert.equal(VALID_MODES.includes(mode), true);
        assert.notEqual(mode, "parallel-analysis-implement-review");
      }
});

test("role programs run the reviewer last, after the implementer", () => {
  assert.deepEqual(program("direct-review"), ["implementer", "reviewer"]);
  assert.deepEqual(program("plan-implement-review"), ["planner", "implementer", "reviewer"]);
  assert.throws(
    () => program("parallel-analysis-implement-review"),
    /unsupported-execution-mode/,
  );
});

test("implementer and reviewer get distinct routes when the pool allows it", () => {
  const pool = [route("Claude", "sonnet"), route("Grok", "grok-4")];
  const { routes, degraded } = assignRoleRoutes(pool, program("plan-implement-review"));
  assert.equal(degraded, undefined);
  assert.notEqual(routes.implementer.agent, routes.reviewer.agent);
  // The planner takes the non-implementer route, so plan and implementation
  // come from different runtimes.
  assert.equal(routes.planner.agent, routes.reviewer.agent);
});

test("a single verified route degrades to a shared route with a recorded reason", () => {
  const pool = [route("Claude", "sonnet")];
  const { routes, degraded } = assignRoleRoutes(pool, program("direct-review"));
  assert.equal(degraded, "same-route-reviewer:single-verified-route");
  assert.equal(routes.implementer.agent, routes.reviewer.agent);
});

test("the first role creates the worktree and later roles reuse it", () => {
  assert.equal(skillForRole(ROLES.IMPLEMENTER, { hasWorktree: false }), "issue-implementation");
  assert.equal(skillForRole(ROLES.IMPLEMENTER, { hasWorktree: true }), "handoff-issue");
  assert.equal(skillForRole(ROLES.PLANNER, { hasWorktree: false }), "issue-implementation");
  // A reviewer runs no skill at all: both implementation skills commit, which
  // a read-only review must not do.
  assert.equal(skillForRole(ROLES.REVIEWER, { hasWorktree: true }), null);
  assert.equal(skillForRole(ROLES.REVIEWER, { hasWorktree: false }), null);
});

test("medium risk buys a planner instead of ranking down to the cheapest mode", () => {
  // determineEligibleModes keeps direct-review eligible here, so an
  // unconditional preference would silently skip planning.
  const eligible = determineEligibleModes({ size: "M", riskCategory: "medium", dependencyDepth: 0 });
  assert.equal(eligible.includes("direct-review"), true);
  assert.equal(selectExecutionMode({ size: "M", riskCategory: "medium", dependencies: [] }).mode, "plan-implement-review");
  assert.deepEqual(modePreferencesFor("low"), ["direct-review", "plan-implement-review"]);
  assert.deepEqual(modePreferencesFor("critical"), ["plan-implement-review", "direct-review"]);
});

test("counterpart roles pair the implementer with the reviewer", () => {
  assert.equal(counterpartRole(ROLES.REVIEWER), ROLES.IMPLEMENTER);
  assert.equal(counterpartRole(ROLES.IMPLEMENTER), ROLES.REVIEWER);
  assert.equal(counterpartRole(ROLES.PLANNER), null);
});

function newRoleState(mode = "direct-review") {
  return {
    issue: 1,
    executionMode: mode,
    program: program(mode),
    index: 0,
    reviewPasses: 0,
    fixCycles: 0,
    routes: {},
    status: "active",
  };
}

test("a passing review ends the program and opens the milestone gate", () => {
  const afterImplement = advanceRoleProgram(newRoleState(), { role: "implementer" });
  assert.equal(afterImplement.index, 1);
  assert.equal(afterImplement.status, "active");
  const afterReview = advanceRoleProgram(afterImplement, { role: "reviewer", verdict: "PASS" });
  assert.equal(afterReview.status, "awaiting-milestone");
  assert.equal(afterReview.reviewPasses, 1);
});

test("NEEDS_REVISION buys one fix pass that is not re-reviewed (one review per Issue)", () => {
  assert.equal(MAX_REVIEW_PASSES, 1);
  let state = advanceRoleProgram(newRoleState(), { role: "implementer" });
  state = advanceRoleProgram(state, { role: "reviewer", verdict: "NEEDS_REVISION" });
  assert.equal(state.status, "active");
  assert.equal(state.program[state.index], "implementer");
  assert.equal(state.fixCycles, 1);
  assert.equal(state.reviewPasses, 1);

  state = advanceRoleProgram(state, { role: "implementer" });
  assert.equal(state.status, "awaiting-milestone");
  assert.equal(state.reviewPasses, 1, "the fix pass is not reviewed again");
  assert.throws(() => advanceRoleProgram(state, { role: "implementer" }), /role-mismatch/);
});

test("REJECTED blocks immediately without spending a fix pass", () => {
  let state = advanceRoleProgram(newRoleState(), { role: "implementer" });
  state = advanceRoleProgram(state, { role: "reviewer", verdict: "REJECTED" });
  assert.equal(state.status, "blocked");
  assert.equal(state.blockedReason, "review-rejected");
  assert.equal(state.fixCycles, 0);
});

test("role programs reject out-of-order roles and unknown verdicts", () => {
  assert.throws(() => advanceRoleProgram(newRoleState(), { role: "reviewer" }), /role-mismatch/);
  const afterImplement = advanceRoleProgram(newRoleState(), { role: "implementer" });
  assert.throws(
    () => advanceRoleProgram(afterImplement, { role: "reviewer", verdict: "LGTM" }),
    /invalid-review-verdict/,
  );
});

test("dispatch payloads carry only closed, non-sensitive fields", () => {
  const payload = buildRoleDispatchPayload({
    role: "reviewer",
    issueNumber: 482,
    executionMode: "direct-review",
    skill: "handoff-issue",
    releasePolicy: "pr-created",
    nextMilestone: "pr-created",
    reviewPass: 2,
  });
  assert.deepEqual(Object.keys(payload).sort(), [
    "executionMode",
    "issueNumber",
    "nextMilestone",
    "releasePolicy",
    "reviewPass",
    "role",
    "skill",
  ]);
  assert.throws(() => buildRoleDispatchPayload({ role: "auditor", issueNumber: 1 }), /invalid-role/);

  // A reviewer has no skill, so the key is omitted rather than sent as null.
  const reviewerPayload = buildRoleDispatchPayload({
    role: "reviewer",
    issueNumber: 482,
    executionMode: "direct-review",
    skill: skillForRole("reviewer", { hasWorktree: true }),
    releasePolicy: "pr-created",
    nextMilestone: "pr-created",
  });
  assert.equal(Object.hasOwn(reviewerPayload, "skill"), false);
});

test("any disallowed key is rejected at any depth", () => {
  for (const key of DISALLOWED_PAYLOAD_KEYS)
    assert.throws(() => assertNoDisallowedKeys({ outer: [{ [key]: "x" }] }), /disallowed-payload-key/);
  assert.doesNotThrow(() => assertNoDisallowedKeys({ role: "reviewer", issueNumber: 1 }));
});

test("the reviewer prompt withholds the implementer's reasoning and forbids edits", () => {
  const prompt = buildWorkerPrompt({
    issueNumber: 482,
    agent: "Grok",
    model: "grok-4",
    releasePolicy: "pr-created",
    nextMilestone: "pr-created",
    role: "reviewer",
    skill: "handoff-issue",
    reviewPass: 1,
  });
  assert.match(prompt, /Role: reviewer/);
  assert.match(prompt, /Do not modify, commit, push, or merge/);
  assert.match(prompt, /no access to the implementer's reasoning/);
  assert.match(prompt, /verdict=<PASS\|NEEDS_REVISION\|REJECTED>/);
  // Acceptance criteria, diffs, and test results are read by the worker
  // itself; the prompt never carries them.
  assert.equal(prompt.includes("acceptance criteria\n"), false);
});

test("the single-worker prompt is unchanged when no role is assigned", () => {
  const prompt = buildWorkerPrompt({
    issueNumber: 482,
    agent: "Codex",
    model: "gpt-5",
    releasePolicy: "merged",
    nextMilestone: "pr-created",
  });
  assert.match(prompt, /^Implement exactly one GitHub Issue using the repository issue-implementation/);
  assert.equal(prompt.includes("Role:"), false);
});

test("dependency depth 2 selects plan-implement-review even at low risk", () => {
  // determineEligibleModes keeps direct-review eligible at depth exactly 2,
  // so the preference has to consider depth or the documented
  // "depth >= 2 -> plan-implement-review" rule would be contradicted.
  const eligible = determineEligibleModes({ size: "M", riskCategory: "low", dependencyDepth: 2 });
  assert.equal(eligible.includes("direct-review"), true);
  const depth = (n) => ({ size: "M", riskCategory: "low", dependencies: Array.from({ length: n }, (_, i) => i) });
  assert.equal(selectExecutionMode(depth(0)).mode, "direct-review");
  assert.equal(selectExecutionMode(depth(1)).mode, "direct-review");
  assert.equal(selectExecutionMode(depth(2)).mode, "plan-implement-review");
  assert.equal(selectExecutionMode(depth(3)).mode, "plan-implement-review");
  assert.deepEqual(modePreferencesFor("low", 2), ["plan-implement-review", "direct-review"]);
});

test("the planner prefers a route distinct from the implementer's", () => {
  // counterpartRole stays the hard implementer/reviewer rule; the planner
  // only carries a preference, used when picking a route.
  assert.equal(distinctPreferenceRole(ROLES.PLANNER), ROLES.IMPLEMENTER);
  assert.equal(distinctPreferenceRole(ROLES.REVIEWER), ROLES.IMPLEMENTER);
  assert.equal(distinctPreferenceRole(ROLES.IMPLEMENTER), ROLES.REVIEWER);
  assert.equal(counterpartRole(ROLES.PLANNER), null);
});

test("the planner records its handoff plan on the Issue without a repository artifact", () => {
  const prompt = buildWorkerPrompt({
    issueNumber: 601,
    agent: "Claude",
    model: "sonnet",
    releasePolicy: "pr-created",
    nextMilestone: "plan-posted",
    role: "planner",
    skill: "issue-implementation",
  });
  assert.match(prompt, /comment on Issue #601 using gh issue comment/);
  assert.match(prompt, /when the plan comment is posted/);
  assert.match(prompt, /Return its URL/);
  assert.match(prompt, /Do not implement, commit, push/);
  assert.doesNotMatch(prompt, /docs\/design|plan is committed/);
});

test("the reviewer prompt names the pull request comment as the findings destination", () => {
  const prompt = buildWorkerPrompt({
    issueNumber: 482,
    agent: "Grok",
    model: "grok-4",
    releasePolicy: "pr-created",
    nextMilestone: "pr-created",
    role: "reviewer",
    skill: skillForRole("reviewer", { hasWorktree: true }),
    reviewPass: 2,
  });
  assert.match(prompt, /gh pr comment/);
  assert.match(prompt, /role=reviewer pass=2 verdict=<PASS\|NEEDS_REVISION\|REJECTED>/);
  // GitHub's review feature cannot express the verdict: one account owns both
  // the PR and the review.
  assert.match(prompt, /do not use `gh pr review`/);
});

test("a fix-cycle implementer is told a PR exists and where the findings are", () => {
  const prompt = buildWorkerPrompt({
    issueNumber: 482,
    agent: "Claude",
    model: "sonnet",
    releasePolicy: "pr-created",
    nextMilestone: "pr-created",
    role: "implementer",
    skill: "handoff-issue",
    fixCycle: 1,
  });
  assert.match(prompt, /Do NOT create a pull request/);
  assert.match(prompt, /gh pr view --comments/);
  assert.match(prompt, /role=implementer fix-cycle=1/);
});

test("the first implementer pass still creates the pull request", () => {
  const prompt = buildWorkerPrompt({
    issueNumber: 482,
    agent: "Claude",
    model: "sonnet",
    releasePolicy: "pr-created",
    nextMilestone: "pr-created",
    role: "implementer",
    skill: "issue-implementation",
  });
  assert.match(prompt, /the pull request exists/);
  assert.equal(prompt.includes("Do NOT create a pull request"), false);
  assert.equal(prompt.includes("fix-cycle"), false);
});

test("fixCycle reaches the dispatch payload only for a fixing implementer", () => {
  const base = {
    issueNumber: 482,
    executionMode: "direct-review",
    skill: "handoff-issue",
    releasePolicy: "pr-created",
    nextMilestone: "pr-created",
  };
  assert.equal(buildRoleDispatchPayload({ ...base, role: "implementer", fixCycle: 2 }).fixCycle, 2);
  assert.equal(
    Object.hasOwn(buildRoleDispatchPayload({ ...base, role: "implementer", fixCycle: 0 }), "fixCycle"),
    false,
  );
  assert.equal(
    Object.hasOwn(buildRoleDispatchPayload({ ...base, role: "reviewer", fixCycle: 2 }), "fixCycle"),
    false,
  );
});

test("the integration gate gets its own single reopen, separate from review passes", async () => {
  const { reopenRoleProgramForFix, MAX_GATE_REOPENS } = await import(
    "../../scripts/project-issue-roles.mjs"
  );
  assert.equal(MAX_GATE_REOPENS, 1);

  let state = advanceRoleProgram(newRoleState(), { role: "implementer" });
  state = advanceRoleProgram(state, { role: "reviewer", verdict: "PASS" });
  assert.equal(state.status, "awaiting-milestone");
  assert.equal(state.reviewPasses, 1);

  const first = reopenRoleProgramForFix(state, "integration-gate-rejected");
  assert.equal(first.status, "active");
  assert.equal(first.program[first.index], "implementer");
  assert.equal(first.gateReopens, 1);
  assert.equal(first.fixCycles, 1);

  // The single review is already spent, so the gate (not the reviewer) re-checks the fix.
  const second = advanceRoleProgram(first, { role: "implementer" });
  assert.equal(second.status, "awaiting-milestone");
  assert.equal(second.reviewPasses, 1);

  // A second gate rejection stops the Issue with its own closed reason.
  const blocked = reopenRoleProgramForFix(second, "integration-gate-rejected");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blockedReason, "integration-gate-rejected-twice");
});

test("a review fix pass does not spend the gate reopen; the gate's fix is not re-reviewed either", async () => {
  const { reopenRoleProgramForFix } = await import("../../scripts/project-issue-roles.mjs");
  let state = advanceRoleProgram(newRoleState(), { role: "implementer" });
  state = advanceRoleProgram(state, { role: "reviewer", verdict: "NEEDS_REVISION" });
  state = advanceRoleProgram(state, { role: "implementer" });
  assert.equal(state.status, "awaiting-milestone");
  assert.equal(state.gateReopens ?? 0, 0, "the gate budget is untouched by review cycles");

  const reopened = reopenRoleProgramForFix(state, "integration-gate-rejected");
  assert.equal(reopened.status, "active");
  assert.equal(reopened.program[reopened.index], "implementer");
  const fixed = advanceRoleProgram(reopened, { role: "implementer" });
  assert.equal(fixed.status, "awaiting-milestone");
  assert.equal(fixed.reviewPasses, 1);
});
