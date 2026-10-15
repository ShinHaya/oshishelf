import test from "node:test";
import assert from "node:assert/strict";

import {
  EXECUTION_MODES,
  RISK_CATEGORIES,
  determineEligibleModes,
  rankAndSelectMode,
  assignRoutesForMode,
  validateWorktreeConcurrency,
  createModeTelemetryRecord,
} from "../../scripts/project-issue-modes.mjs";

test("determineEligibleModes returns direct-review for simple low-risk issues", () => {
  const modes = determineEligibleModes({
    riskCategory: RISK_CATEGORIES.LOW,
    size: "S",
    dependencyDepth: 0,
    changeScopeCount: 2,
  });
  assert.ok(modes.includes(EXECUTION_MODES.DIRECT_REVIEW));
  assert.ok(modes.includes(EXECUTION_MODES.PLAN_IMPLEMENT_REVIEW));
  assert.equal(modes.includes(EXECUTION_MODES.PARALLEL_ANALYSIS_IMPLEMENT_REVIEW), false);
});

test("determineEligibleModes requires planning or parallel analysis for high risk", () => {
  const modes = determineEligibleModes({
    riskCategory: RISK_CATEGORIES.HIGH,
    size: "S",
    dependencyDepth: 0,
  });
  assert.equal(modes.includes(EXECUTION_MODES.DIRECT_REVIEW), false);
  assert.ok(modes.includes(EXECUTION_MODES.PLAN_IMPLEMENT_REVIEW));
  assert.ok(modes.includes(EXECUTION_MODES.PARALLEL_ANALYSIS_IMPLEMENT_REVIEW));
});

test("rankAndSelectMode enforces bounded selection within candidate set", () => {
  const eligible = [EXECUTION_MODES.DIRECT_REVIEW, EXECUTION_MODES.PLAN_IMPLEMENT_REVIEW];
  const selected = rankAndSelectMode(eligible, [
    EXECUTION_MODES.PARALLEL_ANALYSIS_IMPLEMENT_REVIEW,
    EXECUTION_MODES.PLAN_IMPLEMENT_REVIEW,
  ]);
  assert.equal(selected, EXECUTION_MODES.PLAN_IMPLEMENT_REVIEW);
});

test("rankAndSelectMode throws error if no candidate matches preference or candidate set is invalid", () => {
  assert.throws(() => rankAndSelectMode([], ["direct-review"]), /eligible-modes-empty/);
  assert.throws(
    () => rankAndSelectMode(["invalid-mode"], ["direct-review"]),
    /invalid-candidate-mode/,
  );
});

test("assignRoutesForMode selects distinct routes for implementer and reviewer", () => {
  const routes = [
    { agent: "Codex", model: "gpt-5", role: "worker" },
    { agent: "Claude", model: "sonnet", role: "worker" },
  ];
  const { implementer, reviewer } = assignRoutesForMode(routes);
  assert.equal(implementer.agent, "Codex");
  assert.equal(reviewer.agent, "Claude");
});

test("assignRoutesForMode throws error when distinct reviewer route is unavailable and not allowed", () => {
  const routes = [{ agent: "Codex", model: "gpt-5", role: "worker" }];
  assert.throws(() => assignRoutesForMode(routes), /distinct-reviewer-route-unavailable/);

  const fallback = assignRoutesForMode(routes, { allowSameRoute: true });
  assert.equal(fallback.implementer, fallback.reviewer);
});

test("validateWorktreeConcurrency prevents parallel edits to the same worktree", () => {
  assert.equal(
    validateWorktreeConcurrency([
      { worktree: "wt-1", implementer: "agent-1" },
      { worktree: "wt-2", implementer: "agent-2" },
    ]),
    true,
  );

  assert.throws(
    () =>
      validateWorktreeConcurrency([
        { worktree: "wt-1", implementer: "agent-1" },
        { worktree: "wt-1", implementer: "agent-2" },
      ]),
    /concurrent-editing-prohibited:wt-1/,
  );
});

test("createModeTelemetryRecord constructs valid frozen telemetry object", () => {
  const record = createModeTelemetryRecord({
    issueNumber: 440,
    mode: EXECUTION_MODES.DIRECT_REVIEW,
    selectionReason: "simple-issue",
    routes: {
      implementer: { agent: "Codex", model: "gpt-5" },
      reviewer: { agent: "Claude", model: "sonnet" },
    },
    usage: { inputTokens: 1000, outputTokens: 500 },
    outcome: "success",
    reviewPasses: 1,
    fixCycles: 0,
  });

  assert.equal(record.issueNumber, 440);
  assert.equal(record.mode, "direct-review");
  assert.equal(record.outcome, "success");
  assert.ok(Object.isFrozen(record));
});
