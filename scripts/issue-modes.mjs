export const EXECUTION_MODES = Object.freeze({
  DIRECT_REVIEW: "direct-review",
  PLAN_IMPLEMENT_REVIEW: "plan-implement-review",
  PARALLEL_ANALYSIS_IMPLEMENT_REVIEW: "parallel-analysis-implement-review",
});

export const VALID_MODES = Object.freeze(Object.values(EXECUTION_MODES));

export const DEFAULT_MODE_CONFIGS = Object.freeze({
  [EXECUTION_MODES.DIRECT_REVIEW]: Object.freeze({
    agentCount: 2,
    maxTokenBudget: 50_000,
    timeoutMs: 300_000,
  }),
  [EXECUTION_MODES.PLAN_IMPLEMENT_REVIEW]: Object.freeze({
    agentCount: 3,
    maxTokenBudget: 100_000,
    timeoutMs: 600_000,
  }),
  [EXECUTION_MODES.PARALLEL_ANALYSIS_IMPLEMENT_REVIEW]: Object.freeze({
    agentCount: 5,
    maxTokenBudget: 200_000,
    timeoutMs: 900_000,
  }),
});

export const RISK_CATEGORIES = Object.freeze({
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical",
});

const SIZE_RANK = { XS: 1, S: 2, M: 3, L: 4, XL: 5 };

/**
 * Deterministically evaluate eligible execution modes for an Issue context.
 *
 * Rules:
 * - Simple issues (low risk, small size XS/S, shallow dependency depth <= 1, narrow change scope):
 *   direct-review is eligible.
 * - Medium risk or larger size (M/L) or depth >= 2: plan-implement-review is eligible.
 * - High/Critical risk or size XL or complex scope (depth >= 3, many files): parallel-analysis-implement-review is eligible.
 *
 * Note: Lower modes may remain eligible alongside higher modes unless hard constraints require planning/parallel analysis.
 */
export function determineEligibleModes(context = {}) {
  const risk = (context.riskCategory ?? RISK_CATEGORIES.LOW).toLowerCase();
  const size = (context.size ?? "M").toUpperCase();
  const depth = Number(context.dependencyDepth ?? 0);
  const changeScopeCount = Number(context.changeScopeCount ?? 1);

  const isHighRisk = risk === RISK_CATEGORIES.HIGH || risk === RISK_CATEGORIES.CRITICAL;
  const isMediumRisk = risk === RISK_CATEGORIES.MEDIUM;
  const sizeValue = SIZE_RANK[size] ?? 3;

  const eligible = new Set();

  if (isHighRisk) {
    // High risk demands planning or parallel analysis
    eligible.add(EXECUTION_MODES.PARALLEL_ANALYSIS_IMPLEMENT_REVIEW);
    eligible.add(EXECUTION_MODES.PLAN_IMPLEMENT_REVIEW);
  } else if (isMediumRisk || sizeValue >= SIZE_RANK.L || depth >= 2 || changeScopeCount > 5) {
    eligible.add(EXECUTION_MODES.PLAN_IMPLEMENT_REVIEW);
    if (sizeValue <= SIZE_RANK.M && depth <= 2 && changeScopeCount <= 5) {
      eligible.add(EXECUTION_MODES.DIRECT_REVIEW);
    }
    if (sizeValue >= SIZE_RANK.L || depth >= 3 || changeScopeCount > 10) {
      eligible.add(EXECUTION_MODES.PARALLEL_ANALYSIS_IMPLEMENT_REVIEW);
    }
  } else {
    // Low risk, small/medium size
    eligible.add(EXECUTION_MODES.DIRECT_REVIEW);
    eligible.add(EXECUTION_MODES.PLAN_IMPLEMENT_REVIEW);
  }

  return VALID_MODES.filter((mode) => eligible.has(mode));
}

/**
 * Rank eligible modes using candidate list / LLM preference.
 * Ensures selected mode belongs strictly to the eligible candidates set.
 */
export function rankAndSelectMode(eligibleModes, preferences = []) {
  if (!Array.isArray(eligibleModes) || eligibleModes.length === 0) {
    throw new Error("eligible-modes-empty");
  }
  const invalid = eligibleModes.filter((m) => !VALID_MODES.includes(m));
  if (invalid.length > 0) {
    throw new Error(`invalid-candidate-mode:${invalid.join(",")}`);
  }

  for (const pref of preferences) {
    if (eligibleModes.includes(pref)) {
      return pref;
    }
  }
  return eligibleModes[0];
}

/**
 * Select distinct verified routes for implementer and reviewer.
 */
export function assignRoutesForMode(workerRoutes, options = {}) {
  if (!Array.isArray(workerRoutes) || workerRoutes.length === 0) {
    throw new Error("no-worker-routes-available");
  }

  const implementer = workerRoutes[0];
  let reviewer = workerRoutes.find(
    (r) => r.agent !== implementer.agent || r.model !== implementer.model,
  );

  // If no distinct agent/model route exists, fallback to another selectable route if available,
  // or allow same route if forced by options.allowSameRoute.
  if (!reviewer) {
    if (workerRoutes.length > 1) {
      reviewer = workerRoutes[1];
    } else if (options.allowSameRoute) {
      reviewer = implementer;
    } else {
      throw new Error("distinct-reviewer-route-unavailable");
    }
  }

  return { implementer, reviewer };
}

/**
 * Validate concurrency rules across worktrees.
 */
export function validateWorktreeConcurrency(activeEdits = []) {
  const worktreeCounts = new Map();
  for (const edit of activeEdits) {
    const worktree = edit.worktree;
    if (!worktree) continue;
    const current = worktreeCounts.get(worktree) ?? 0;
    if (current >= 1) {
      throw new Error(`concurrent-editing-prohibited:${worktree}`);
    }
    worktreeCounts.set(worktree, current + 1);
  }
  return true;
}

/**
 * Create telemetry log entry for mode selection and execution outcome.
 */
export function createModeTelemetryRecord(data) {
  const mode = data.mode;
  if (!VALID_MODES.includes(mode)) {
    throw new Error(`invalid-mode-telemetry:${mode}`);
  }

  return Object.freeze({
    issueNumber: Number(data.issueNumber),
    mode: data.mode,
    selectionReason: String(data.selectionReason ?? "deterministic-policy"),
    // How the run had to degrade (e.g. a shared implementer/reviewer route),
    // kept separate from why the mode itself was selected.
    ...(data.degraded === undefined ? {} : { degraded: String(data.degraded) }),
    routes: Object.freeze({
      implementer: data.routes?.implementer ?? null,
      reviewer: data.routes?.reviewer ?? null,
      planner: data.routes?.planner ?? null,
      analysts: Object.freeze(data.routes?.analysts ?? []),
    }),
    config: Object.freeze(data.config ?? DEFAULT_MODE_CONFIGS[mode]),
    usage: Object.freeze(data.usage ?? {}),
    outcome: String(data.outcome ?? "pending"),
    reviewPasses: Number(data.reviewPasses ?? 0),
    fixCycles: Number(data.fixCycles ?? 0),
    timestamp: new Date().toISOString(),
  });
}
