#!/usr/bin/env node

/**
 * LangGraph StateGraph model of project-issue orchestration.
 *
 * The graph makes the long-running orchestration's state transitions,
 * parallel dispatch, checkpointing, recovery, and auditability explicit.
 * It does not replace the existing building blocks: config loading,
 * capability discovery, planning, milestone application, and dispatch all
 * call the same functions the classic `project-issue-orchestrator.mjs`
 * CLI uses. Runtime adapters, worktree lifecycle, and CLI process launch
 * stay outside the graph (they are injected side effects).
 *
 * Judgment points that belong to the orchestrating agent — dynamic route
 * assignment, the integration quality gate verdict, and worker lifecycle
 * events — surface as `interrupt()` pauses. Every resume payload is
 * validated against deterministic state (the verified worker-route pool,
 * the selected Issue set, closed event schemas), so an LLM caller can
 * only pick among verified routes and can never invent one; invalid
 * proposals fail the run closed.
 *
 * Graph state stores only non-sensitive orchestration data: Issue
 * numbers/titles/URLs/status, routing labels and selectors, milestones,
 * timestamps, process metadata, and exact usage. Issue bodies, prompts,
 * diffs, credentials, and personal data must never enter state (they
 * would otherwise be persisted by the checkpointer).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";

import {
  Annotation,
  Command,
  END,
  START,
  Send,
  StateGraph,
  interrupt,
  isInterrupted,
} from "@langchain/langgraph";

import { DEFAULT_CAPABILITIES_OUTPUT, loadOrRefreshCapabilities, refreshWorkerRoutes, verifyWorkerRoute } from "./project-issue-capabilities.mjs";
import {
  DEFAULT_CONFIG_PATH,
  loadOrchestratorConfig,
  mergeOrchestratorConfig,
} from "./project-issue-config.mjs";
import { fetchRepositoryIssues, repositoryIssueGraphql, fetchTriageRevision } from "./project-issue-github.mjs";
import {
  decideParentWorker,
  parseParentWorkerMode,
  readParentUsage,
  resolveParentWorkerFlags,
} from "./project-issue-parent-usage.mjs";
import { loadAssistedApproval, loadApprovedRouteEvidence } from "./project-issue-triage-approval.mjs";
import { createTriageRunner, createTriageState } from "./project-issue-triage-client.mjs";
import { TRIAGE_POLICY, normalizeTriageConfig, normalizeTriageInput, triageContext, fallbackResult, parseTriageResult, parseTriageDecision } from "./project-issue-triage-contract.mjs";
import {
  applyMilestone,
  buildRunPlan,
  buildUsageReport,
  parseProjectItems,
  selectProjectItems,
  selectWorkerRoutes,
  validateCapabilities,
} from "./project-issue-plan.mjs";
import { createModeTelemetryRecord, validateWorktreeConcurrency } from "./project-issue-modes.mjs";
import {
  ROLES,
  advanceRoleProgram,
  assignRoleRoutes,
  applyTriageDecision,
  buildRoleDispatchPayload,
  counterpartRole,
  distinctPreferenceRole,
  reopenRoleProgramForFix,
  roleProgramForMode,
  selectExecutionMode,
  skillForRole,
} from "./project-issue-roles.mjs";
import { FileCheckpointSaver, triageRunId } from "./project-issue-graph-checkpointer.mjs";
import { verifyRepositoryFreshness } from "./project-issue-runtime-adapters/shared.mjs";

const execFileAsync = promisify(execFile);

export const DEFAULT_CHECKPOINT_DIR = "state/project-issue-graph";

const RELEASE_POLICIES = new Set(["pr-created", "merged"]);
const MILESTONE_TYPES = new Set(["pr-created", "merged"]);
const EVENT_TYPES = new Set(["milestone", "role-complete", "worker-interrupted", "worker-started", "check"]);
export const FAILURE_TAXONOMY = Object.freeze({
  recoverable: new Set(["timeout", "session-limit", "provider-unavailable", "worker-crashed"]),
  unrecoverable: new Set(["auth-failed", "policy-blocked", "invalid-input"]),
});
export const FAILURE_TRANSITIONS = Object.freeze({
  running: new Set(["retrying", "handing_off", "failed"]),
  retrying: new Set(["running", "failed"]),
  handing_off: new Set(["running", "failed"]),
  failed: new Set(["manual_intervention"]),
});
export function classifyFailure(reason = "unknown") {
  const kind = String(reason).split(":", 1)[0];
  return { kind, recoverable: FAILURE_TAXONOMY.recoverable.has(kind) };
}
export function idempotencyKey(issue, action, attempt) {
  return `issue-${issue}:${action}:${attempt}`;
}
const GATE_CHECKS = Object.freeze([
  "conflicts-with-other-issues-in-run",
  "contract-consistency-with-dependencies-and-dependents",
  "acceptance-criteria-coverage",
]);

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const unionStrings = (left = [], right = []) => [...new Set([...left, ...(right ?? [])])];
const unionNumbers = (left = [], right = []) =>
  [...new Set([...left, ...(right ?? [])].map(Number))].sort((a, b) => a - b);

/** Append-only milestone log, deduplicated on (issue, type). */
const mergeMilestones = (left = [], right = []) => {
  const merged = [...left];
  for (const entry of right ?? []) {
    if (!merged.some(({ issue, type }) => issue === entry.issue && type === entry.type))
      merged.push({ issue: entry.issue, type: entry.type });
  }
  return merged;
};

/** Keyed merge: entries in `right` replace same-issue entries in `left`. */
const mergeByIssue =
  (key) =>
  (left = [], right) => {
    if (right === null) return [];
    const merged = [...left];
    for (const entry of right ?? []) {
      const index = merged.findIndex((existing) => existing[key] === entry[key]);
      if (entry.remove === true) {
        if (index !== -1) merged.splice(index, 1);
      } else if (index === -1) merged.push(entry);
      else merged[index] = entry;
    }
    return merged;
  };

const mergeAssignments = (left = [], right) => {
  if (right === null) return [];
  const merged = [...left];
  for (const entry of right ?? []) {
    const index = merged.findIndex(({ number }) => number === entry.number);
    if (entry.remove === true) {
      if (index !== -1) merged.splice(index, 1);
    } else if (index === -1) merged.push(entry);
    else merged[index] = entry;
  }
  return merged;
};

export const OrchestrationState = Annotation.Root({
  /** Sanitized run config (owner/name labels, maxParallel, releasePolicy, parent route, selectors). */
  config: Annotation(),
  /** Selected, sanitized project items (identity + ordering metadata + dependency closure). */
  items: Annotation(),
  /** Verified capability records from discovery (or explicit test input). */
  capabilities: Annotation(),
  /** Run-scoped verified worker-route pool after unavailable exclusions. */
  workerRoutes: Annotation(),
  /**
   * Latest closed snapshot of the parent's 5-hour usage window (status,
   * remainingPercent, windowDurationMins, resetsAt, fetchedAt, reason).
   * Re-read before new assignments and handoffs; never a raw response.
   */
  parentUsage: Annotation(),
  /** Closed, non-sensitive shadow results; no Issue body or provider response text. */
  triageByIssue: Annotation({ reducer: mergeByIssue("issue"), default: () => [] }),
  triageNotice: Annotation(),
  triageBudget: Annotation(),
  triagePreflightRetry: Annotation(),
  /** Optional caller-proposed assignments; always validated against the pool. */
  proposedAssignments: Annotation(),
  unavailableAgents: Annotation({ reducer: unionStrings, default: () => [] }),
  unavailableModels: Annotation({ reducer: unionStrings, default: () => [] }),
  completed: Annotation({ reducer: unionNumbers, default: () => [] }),
  milestones: Annotation({ reducer: mergeMilestones, default: () => [] }),
  usage: Annotation({ reducer: (left = {}, right = {}) => ({ ...left, ...right }), default: () => ({}) }),
  plan: Annotation(),
  /** Current route assignment per Issue: {number, agent, model, route, attempt, skill, role}. */
  assignments: Annotation({ reducer: mergeAssignments, default: () => [] }),
  /**
   * Role program per Issue: {issue, executionMode, program, index,
   * reviewPasses, fixCycles, routes, status}. Absent in single-worker mode.
   * Routes are capability records (agent/model/selector labels only).
   */
  roleStates: Annotation({ reducer: mergeByIssue("issue"), default: () => [] }),
  /** Append-only mode/role telemetry records (labels and counters only). */
  modeTelemetry: Annotation({
    reducer: (left = [], right = []) => [...left, ...(right ?? [])],
    default: () => [],
  }),
  /**
   * Worker execution metadata per Issue (latest attempt wins): issue,
   * attempt, uuid, pid/pgid when known, startedAt, worktreeId, agent,
   * model, expectedMilestone, status, dispatchCommand. PID alone never
   * decides recovery — probes must match uuid/start metadata too.
   */
  workerExecutions: Annotation({ reducer: mergeByIssue("issue"), default: () => [] }),
  gateResults: Annotation({
    reducer: (left = [], right = []) => [...left, ...(right ?? [])],
    default: () => [],
  }),
  /** Milestone event currently under integration-gate review, or null. */
  pendingGate: Annotation(),
  /** Issues needing handoff: {issue, reason, proposedRoute?, invalidateAgent?}; null clears. */
  pendingInterrupted: Annotation({ reducer: mergeByIssue("issue"), default: () => [] }),
  retryCounts: Annotation({
    reducer: (left = {}, right = {}) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  handoffCounts: Annotation({
    reducer: (left = {}, right = {}) => ({ ...left, ...right }),
    default: () => ({}),
  }),
  resumeFrom: Annotation({ reducer: (left, right) => right ?? left }),
  recoveryEvents: Annotation({
    reducer: (left = [], right = []) => [...left, ...(right ?? [])],
    default: () => [],
  }),
  lastEventError: Annotation(),
  /** "verified" | "unavailable" — set by discover_capabilities. */
  parentRouting: Annotation(),
  runStatus: Annotation(),
  failureReason: Annotation(),
  summary: Annotation(),
});

/* ------------------------------------------------------------------ */
/* Pure state helpers                                                  */
/* ------------------------------------------------------------------ */

function getDeps(config) {
  const deps = config?.configurable?.deps;
  if (!deps) throw new Error("graph-deps-required");
  return deps;
}

function executionsFor(state, issue) {
  return (state.workerExecutions ?? []).filter((execution) => execution.issue === issue);
}

function activeExecutions(state) {
  return (state.workerExecutions ?? []).filter((execution) => execution.status === "running");
}

/**
 * True when some worker actually started for this Issue and therefore created
 * (or entered) its worktree. A `dispatch-failed` execution never launched a
 * worker, so it is not evidence of a worktree.
 */
function worktreeExists(state, issue) {
  return executionsFor(state, issue).some((execution) => execution.status !== "dispatch-failed");
}

function attemptFor(state, issue) {
  return Math.max(0, ...executionsFor(state, issue).map(({ attempt }) => attempt)) + 1;
}

function pendingDispatches(state) {
  const executions = state.workerExecutions ?? [];
  return (state.assignments ?? []).filter(
    (assignment) =>
      !executions.some(
        (execution) => execution.issue === assignment.number && execution.attempt >= assignment.attempt,
      ),
  );
}

function skippedNumbers(state) {
  return (state.plan?.skipped ?? []).map(({ number }) => number);
}

function allComplete(state) {
  // Undefined items = the run never got past selection; an empty selection
  // (unreachable via selectProjectItems, which rejects empty matches) is
  // trivially complete rather than "blocked".
  if (!state.items) return false;
  const done = new Set([...(state.completed ?? []), ...skippedNumbers(state)]);
  return state.items.every(({ number }) => done.has(number));
}

function expectedMilestone(state, issue) {
  const hasPrCreated = (state.milestones ?? []).some(
    (milestone) => milestone.issue === issue && milestone.type === "pr-created",
  );
  return hasPrCreated ? "merged" : "pr-created";
}

/** Worker mode from config; legacy checkpoints carry `asWorker: true` instead. */
function parentWorkerMode(config) {
  const parent = config.parent;
  return parseParentWorkerMode(parent.workerMode ?? (parent.asWorker === true ? true : undefined));
}

function parentWorkerDecisionFor(state) {
  return decideParentWorker(parentWorkerMode(state.config), state.parentUsage);
}

/**
 * Parent route options for every worker-pool computation. In auto mode the
 * parent joins only while the last usage snapshot shows >= 50% of its 5-hour
 * window left; an absent or unknown snapshot keeps it out.
 */
function parentPoolOptions(state) {
  return { parentAgent: state.config.parent.agent, parentAsWorker: parentWorkerDecisionFor(state).eligible };
}

/** Fresh usage snapshot for auto mode; `{}` (keep state) for fixed modes. */
async function refreshParentUsage(state, config) {
  if (parentWorkerMode(state.config) !== "auto") return {};
  const read = getDeps(config).readParentUsage;
  const parentUsage = read
    ? await read(state.config.parent.agent).catch(() => ({ status: "unknown", reason: "parent-usage-fetch-failed" }))
    : { status: "unknown", reason: "parent-usage-unsupported-runtime" };
  return { parentUsage };
}

function currentPool(state) {
  return selectWorkerRoutes(state.capabilities ?? [], {
    ...parentPoolOptions(state),
    unavailableAgents: state.unavailableAgents,
    unavailableModels: state.unavailableModels,
  });
}

/** Resolve a proposed {agent, model} against the verified pool, or null. */
function resolveRoute(pool, proposal) {
  if (!proposal || typeof proposal !== "object") return null;
  return (
    pool.find(
      (route) =>
        route.agent === proposal.agent &&
        (route.requestedModel !== undefined
          ? route.requestedModel === proposal.model
          : route.model === proposal.model),
    ) ?? null
  );
}

function routeLabels(route) {
  return { agent: route.agent, model: route.requestedModel ?? route.model };
}

/**
 * Compare two capability records by *runtime identity*, never by object
 * identity: checkpoint round-trips deserialize state into fresh objects, so
 * `===` would silently stop matching after a resume.
 *
 * The selector is an invocation detail, not identity — two records sharing an
 * agent and model are the same runtime even with different selectors. This
 * matches `assignRoutesForMode`, which also decides distinctness on
 * agent/model; comparing selectors here would let two records for one runtime
 * pass as "distinct routes" and silently collapse independent review.
 */
function sameRoute(left, right) {
  if (!left || !right) return false;
  return (
    left.agent === right.agent &&
    (left.requestedModel ?? left.model) === (right.requestedModel ?? right.model)
  );
}

function roleStateFor(state, issue) {
  return (state.roleStates ?? []).find((entry) => entry.issue === issue) ?? null;
}

function currentRole(roleState) {
  return roleState.program[roleState.index] ?? null;
}

/**
 * Start (or return) the role program for one runnable Issue. The execution
 * mode and role sequence come from the deterministic plan; the routes come
 * from the run's verified pool, with implementer and reviewer distinct
 * whenever the pool holds more than one route.
 */
function ensureRoleState(state, item, pool) {
  const existing = roleStateFor(state, item.number);
  if (existing) return existing;
  const executionMode = item.executionMode ?? selectExecutionMode(item).mode;
  const program = item.roleProgram ?? roleProgramForMode(executionMode);
  const preferred = (state.triageByIssue ?? []).find((e) => e.issue === item.number)?.decision?.preferredRoute;
  const orderedPool = preferred ? [...pool.filter((r) => sameRoute(r, preferred)), ...pool.filter((r) => !sameRoute(r, preferred))] : pool;
  const { routes, degraded } = assignRoleRoutes(orderedPool, program);
  return {
    issue: item.number,
    executionMode,
    program: [...program],
    index: 0,
    reviewPasses: 0,
    fixCycles: 0,
    gateReopens: 0,
    routes,
    status: "active",
    ...(degraded ? { degraded } : {}),
  };
}

/**
 * Terminal telemetry for one role program. Emitted once, where the program
 * truly stops: either the Issue is released, or the program is blocked.
 * `degraded` keeps its own key so it cannot be mistaken for the reason the
 * mode was selected.
 */
function modeTelemetryFor(roleState, outcome) {
  return createModeTelemetryRecord({
    issueNumber: roleState.issue,
    mode: roleState.executionMode,
    selectionReason: "deterministic-policy",
    ...(roleState.degraded ? { degraded: roleState.degraded } : {}),
    routes: Object.fromEntries(
      Object.entries(roleState.routes).map(([role, route]) => [role, routeLabels(route)]),
    ),
    outcome,
    reviewPasses: roleState.reviewPasses,
    fixCycles: roleState.fixCycles,
  });
}

/**
 * Pick a route for `role`, preferring one distinct from its counterpart's
 * recorded route. Returns the fallback reason when no distinct route is left.
 */
function pickRoleRoute(pool, roleState, role) {
  const counterpart = roleState.routes[distinctPreferenceRole(role)];
  const distinct = pool.find((candidate) => !counterpart || !sameRoute(candidate, counterpart));
  // Name the role that had to share: pickRoleRoute also runs for the
  // implementer and the planner, so a fixed "reviewer" label would misreport.
  return distinct
    ? { route: distinct }
    : { route: pool[0], degraded: `same-route:${role}:no-distinct-route-left` };
}

/** True when `route` would collapse independent review onto one runtime. */
function violatesRoleDistinctness(pool, roleState, role, route) {
  if (pool.length <= 1) return false;
  const counterpart = roleState.routes[counterpartRole(role)];
  return sameRoute(route, counterpart);
}

/**
 * Issues whose role program finished but whose configured release milestone
 * has not landed yet (e.g. `--release-policy merged` after `pr-created`).
 * The run must stay waitable for them.
 */
function awaitingReleaseMilestone(state) {
  const completed = new Set(state.completed ?? []);
  return (state.roleStates ?? []).filter(
    (roleState) => roleState.status === "awaiting-milestone" && !completed.has(roleState.issue),
  );
}

/** Closed decision record: mode, verdict, reason code, exact remaining % and read time only. */
function parentWorkerSummary(state) {
  const mode = parentWorkerMode(state.config);
  const usage = state.parentUsage;
  return {
    mode,
    ...parentWorkerDecisionFor(state),
    ...(mode === "auto" && usage?.status === "ok"
      ? { remainingPercent: usage.remainingPercent, windowDurationMins: usage.windowDurationMins }
      : {}),
    ...(mode === "auto" && usage?.fetchedAt ? { fetchedAt: usage.fetchedAt } : {}),
  };
}

export function buildSummary(state, runStatus) {
  const issueNumbers = (state.items ?? []).map(({ number }) => number);
  return {
    routing: {
      parent: state.parentRouting ?? "verified",
      ...(state.config?.parent ? { parentWorker: parentWorkerSummary(state) } : {}),
    },
    runnable: (state.plan?.runnable ?? []).map(({ number }) => number),
    assignments: (state.assignments ?? []).map(({ number, agent, model }) => ({ number, agent, model })),
    blocked: state.plan?.blocked ?? [],
    skipped: state.plan?.skipped ?? [],
    milestones: state.milestones ?? [],
    completed: state.completed ?? [],
    roles: (state.roleStates ?? []).map(
      ({ issue, executionMode, program, index, status, reviewPasses, blockedReason }) => ({
        issue,
        executionMode,
        // The role currently running; null once the program stopped advancing.
        role: status === "active" ? (program[index] ?? null) : null,
        status,
        reviewPasses,
        // Why it stopped is exactly what an operator needs from a blocked run.
        ...(blockedReason ? { blockedReason } : {}),
      }),
    ),
    usage: buildUsageReport(state.usage ?? {}, issueNumbers),
    ...(triageMode(state) === "shadow" ? { shadowTriage: (state.triageByIssue ?? []).map(
      ({ issue, result, evaluatedAt, budget, firstRoute }) => ({
        issue, result, evaluatedAt, budget,
        legacyMode: (state.plan?.runnable ?? []).find(({ number }) => number === issue)?.executionMode ?? null,
        assignedRoute: firstRoute ?? ((assignment) => (assignment ? routeLabels(assignment) : null))(
          (state.assignments ?? []).find(({ number }) => number === issue)),
      }),
    ) } : {}),
    ...(state.triageNotice ? { triageNotice: state.triageNotice } : {}),
    ...(triageMode(state) === "assisted" ? { assistedTriage: (state.triageByIssue ?? []).map(({ issue, result, decision }) => ({ issue, result, decision })) } : {}),
    runStatus,
    ...(state.failureReason ? { failureReason: state.failureReason } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Nodes                                                               */
/* ------------------------------------------------------------------ */

async function loadConfigNode(state, runtimeConfig) {
  const config = state.config;
  try {
    if (!config || typeof config !== "object") throw new Error("config-required");
    if (!Number.isSafeInteger(config.maxParallel) || config.maxParallel <= 0)
      throw new Error("invalid-max-parallel");
    if (!RELEASE_POLICIES.has(config.releasePolicy)) throw new Error("invalid-release-policy");
    if (!config.parent?.agent || !config.parent?.model) throw new Error("parent-route-required");
    let triage = normalizeTriageConfig(config.triage);
    let triageNotice = null;
    if (triage.mode === "assisted" && config.singleWorker) {
      triage = { ...triage, mode: "shadow" };
      triageNotice = "triage-single-worker-shadow";
    } else if (triage.mode === "assisted" && !(await getDeps(runtimeConfig).assistedApproval?.(triage.model))) {
      throw new Error("triage-assisted-not-available");
    }
    const selectors = config.selectors ?? {};
    const hasSelector = ["issues", "priority", "iteration", "size"].some(
      (key) => Array.isArray(selectors[key]) && selectors[key].length,
    );
    if (!hasSelector) throw new Error("issue-filter-required");
    return {
      // Later nodes read model/maxRequests, so keep the normalized defaults.
      config: { ...config, triage },
      triageNotice,
      unavailableAgents: config.unavailableAgents ?? [],
      unavailableModels: config.unavailableModels ?? [],
    };
  } catch (error) {
    return { failureReason: error.message };
  }
}

async function discoverCapabilitiesNode(state, config) {
  let capabilities;
  try {
    capabilities = state.capabilities ?? (await getDeps(config).loadCapabilities(state.config));
  } catch (error) {
    // Discovery infrastructure failed; that says nothing about the parent
    // route itself.
    return { failureReason: error.message };
  }
  try {
    validateCapabilities(
      [{ agent: state.config.parent.agent, model: state.config.parent.model, role: "parent" }],
      capabilities,
    );
  } catch (error) {
    return { failureReason: error.message, parentRouting: "unavailable" };
  }
  try {
    const usage = await refreshParentUsage(state, config);
    const workerRoutes = selectWorkerRoutes(capabilities, {
      ...parentPoolOptions({ ...state, ...usage }),
      unavailableAgents: state.unavailableAgents,
      unavailableModels: state.unavailableModels,
    });
    return { capabilities, workerRoutes, ...usage, parentRouting: "verified" };
  } catch (error) {
    return { failureReason: error.message, parentRouting: "verified" };
  }
}

async function fetchProjectIssuesNode(state, config) {
  try {
    const rawItems = state.items ?? (await getDeps(config).fetchItems(state.config)).items;
    const selection = selectProjectItems(rawItems, state.config.selectors);
    return { items: selection.items, completed: selection.completed };
  } catch (error) {
    return { failureReason: error.message };
  }
}

function validateDependenciesNode(state) {
  try {
    return { items: parseProjectItems(state.items, { completed: state.completed }) };
  } catch (error) {
    return { failureReason: error.message };
  }
}

function buildRunnablePlanNode(state) {
  try {
    const existingWorktrees = new Set([
      ...(state.config.existingWorktrees ?? []).map(Number),
      ...(state.workerExecutions ?? []).map(({ issue }) => issue),
    ]);
    const plan = buildRunPlan(state.items, {
      completed: state.completed,
      existingWorktrees: [...existingWorktrees],
      maxParallel: state.config.maxParallel,
      releasePolicy: state.config.releasePolicy,
    });
    if (triageMode(state) === "assisted") {
      plan.runnable = plan.runnable.map((item) => applyTriageDecision(item,
        (state.triageByIssue ?? []).find((e) => e.issue === item.number)?.decision));
    }
    const workerRoutes = currentPool(state);
    // Fail closed before any worktree mutation when Issues are runnable
    // but no verified worker route remains.
    if (plan.runnable.length && !workerRoutes.length && triageMode(state) === "off")
      return { plan, workerRoutes, failureReason: "no-worker-route-available" };
    return { plan, workerRoutes };
  } catch (error) {
    return { failureReason: error.message };
  }
}

function triageMode(state) {
  return state.config?.triage?.mode ?? "off";
}

/** Issues in this selection batch that have not started a role program yet. */
function triageCandidates(state) {
  return dispatchCandidates(state)
    .slice(0, Math.max(0, state.config.maxParallel - activeExecutions(state).length))
    .filter(({ number }) => !roleStateFor(state, number));
}

async function refreshTriageRoutesNode(state, config) {
  // A later role, fix cycle, or re-dispatch needs no triage, so it keeps the
  // existing pool and cannot fail on a CLI refresh.
  if (triageMode(state) === "off" || !triageCandidates(state).length) return {};
  try {
    const refreshed = await getDeps(config).refreshTriageRoutes(state);
    const capabilities = refreshed.capabilities;
    const workerRoutes = selectWorkerRoutes(capabilities, {
      ...parentPoolOptions(state),
      unavailableAgents: state.unavailableAgents,
      unavailableModels: state.unavailableModels,
    });
    if (!workerRoutes.length) return { capabilities, workerRoutes, failureReason: "no-worker-route-available" };
    return { capabilities, workerRoutes };
  } catch {
    return { failureReason: "triage-route-refresh-failed" };
  }
}

/**
 * Builds the triage input exactly as the child normalizes it (sorted routes),
 * so routeSetHash/evidenceVersion match the child's result. Null when the
 * revision, the evidence provider, or the evidence shape is unusable.
 */
async function triageInputFor(deps, issue, revision, pool, model) {
  if (!revision) return null;
  try {
    const routes = pool.map(routeLabels);
    const input = normalizeTriageInput({
      issue, issueUpdatedAt: revision.updatedAt, routes,
      routeEvidence: await deps.triageEvidence(routes, model), policyVersion: TRIAGE_POLICY, model,
    });
    return { input, context: triageContext(input) };
  } catch {
    return null;
  }
}

async function prepareTriageNode(state, config) {
  if (triageMode(state) === "off") return {};
  const deps = getDeps(config);
  const pool = currentPool(state);
  const triageByIssue = [];
  for (const item of triageCandidates(state)) {
    const model = state.config.triage.model;
    const revision = await deps.fetchTriageRevision(item.number).catch(() => null);
    const previous = (state.triageByIssue ?? []).find(({ issue }) => issue === item.number);
    const { input, context } = (await triageInputFor(deps, item.number, revision, pool, model)) ?? {};
    if (previous && context && previous.result.issueUpdatedAt === revision.updatedAt &&
        previous.result.policyVersion === TRIAGE_POLICY && previous.inputModel === model &&
        previous.result.routeSetHash === context.routeSetHash &&
        previous.result.evidenceVersion === context.evidenceVersion) continue;
    if (previous && !revision && previous.result.issueUpdatedAt === null &&
        previous.result.reason === "fetch-failed") continue;
    if (triageMode(state) === "assisted" && previous?.decision && context &&
        previous.result.issueUpdatedAt === revision.updatedAt && previous.inputModel === model &&
        previous.result.policyVersion === TRIAGE_POLICY && previous.decision.action !== "fallback") {
      const identity = { routeSetHash: context.routeSetHash, evidenceVersion: context.evidenceVersion };
      const { preferredRoute: _discarded, ...decision } = previous.decision;
      triageByIssue.push({ ...previous, decision: { ...decision, ...identity },
        result: { ...previous.result, ...identity, ...(previous.result.status === "recommended" ? { routeMap: {},
          route: { choice: "abstain", probabilities: { abstain: 1 }, confidence: 0 } } : {}) },
        requiresManualAssignment: true });
      continue;
    }
    let result;
    if (!revision) {
      result = { issue: item.number, issueUpdatedAt: null, policyVersion: TRIAGE_POLICY,
        routeSetHash: null, evidenceVersion: "none", status: "fallback", reason: "fetch-failed" };
    } else if (!context) {
      result = { issue: item.number, issueUpdatedAt: revision.updatedAt, policyVersion: TRIAGE_POLICY,
        routeSetHash: null, evidenceVersion: "none", status: "fallback", reason: "provider-error" };
    } else {
      try {
        const budget = deps.triageBudget?.();
        if (budget?.providerUnavailable) result = fallbackResult(context, "provider-unavailable");
        else if (budget?.reserved >= state.config.triage.maxRequests)
          result = fallbackResult(context, "budget-exhausted");
        else {
          const claimed = await deps.claimTriageAttempt(input).catch(() => null);
          if (claimed === null) result = fallbackResult(context, "provider-unavailable");
          else if (!claimed) result = fallbackResult(context, "cancelled");
          else {
            const response = await deps.runTriage(input, { ...state.config.triage, mode: "shadow" });
            result = parseTriageResult(response.result, input, context);
          }
        }
      } catch {
        result = fallbackResult(context, "provider-error");
      }
    }
    triageByIssue.push({ ...(previous?.preflightAttempts ? { preflightAttempts: previous.preflightAttempts } : {}),
      issue: item.number, inputModel: model, result, evaluatedAt: deps.now(),
      requiresManualAssignment: result.status === "fallback",
      budget: deps.triageBudget?.() ?? state.triageBudget ?? null });
  }
  return { triageByIssue, triageBudget: deps.triageBudget?.() ?? state.triageBudget ?? null };
}

function resolveTriageNode(state) {
  if (triageMode(state) !== "assisted") return {};
  const entries = (state.triageByIssue ?? []).filter((e) =>
    triageCandidates(state).some((i) => i.number === e.issue) && !e.decision);
  if (!entries.length) return {};
  const resume = interrupt({ resolveTriage: {
    issues: entries.map(({ issue, result }) => ({ issue, recommendation: result })),
    actions: ["accept", "override", "fallback"],
  }, ...(state.lastEventError ? { lastEventError: state.lastEventError } : {}) });
  const raw = resume?.triageDecisions ?? [];
  if (!Array.isArray(raw) || new Set(raw.map((d) => d?.issue)).size !== raw.length ||
      raw.some((d) => !entries.some((e) => e.issue === d?.issue)))
    return { lastEventError: "triage-invalid-decision" };
  const updated = [];
  let plan = { ...state.plan, runnable: [...state.plan.runnable] };
  try {
    for (const entry of entries) {
      const context = { ...entry.result, model: entry.inputModel };
      const proposal = raw.find((d) => d.issue === entry.issue) ?? {
        issue: entry.issue, issueUpdatedAt: entry.result.issueUpdatedAt,
        policyVersion: entry.result.policyVersion, routeSetHash: entry.result.routeSetHash,
        evidenceVersion: entry.result.evidenceVersion, action: "fallback", reason: "legacy-fallback",
      };
      const decision = parseTriageDecision(proposal, context, entry.result);
      const index = plan.runnable.findIndex((i) => i.number === entry.issue);
      plan.runnable[index] = applyTriageDecision(plan.runnable[index], decision);
      updated.push({ ...entry, decision, requiresManualAssignment: decision.action === "fallback" });
    }
  } catch (error) {
    return { lastEventError: error.message === "triage-mode-conflict" ? error.message : "triage-invalid-decision" };
  }
  return { triageByIssue: updated, plan, lastEventError: null };
}

function dispatchCandidates(state) {
  const completed = new Set(state.completed ?? []);
  const interrupted = new Set((state.pendingInterrupted ?? []).map(({ issue }) => issue));
  const awaiting = new Set(pendingDispatches(state).map(({ number }) => number));
  // An Issue whose role program finished (waiting on a milestone) or ran out
  // of review budget has no further role to dispatch.
  const roleProgramDone = new Set(
    (state.roleStates ?? []).filter(({ status }) => status !== "active").map(({ issue }) => issue),
  );
  return (state.plan?.runnable ?? []).filter(
    ({ number }) =>
      !completed.has(number) &&
      !interrupted.has(number) &&
      !awaiting.has(number) &&
      !roleProgramDone.has(number) &&
      !executionsFor(state, number).some((execution) => execution.status === "running"),
  );
}

function assignRoutesNode(state) {
  if (state.failureReason) return {};
  const capacity = state.config.maxParallel - activeExecutions(state).length;
  const dispatchable = dispatchCandidates(state).slice(0, Math.max(0, capacity));
  const candidates = state.config.autoAssign && dispatchable.some(({ number }) =>
    !(state.triageByIssue ?? []).find(({ issue }) => issue === number)?.requiresManualAssignment)
    ? dispatchable.filter(({ number }) =>
        !(state.triageByIssue ?? []).find(({ issue }) => issue === number)?.requiresManualAssignment)
    : dispatchable;
  if (!candidates.length) return {};

  const pool = currentPool(state);
  if (!pool.length) return { failureReason: "no-worker-route-available" };

  const proposedByNumber = new Map(
    (state.proposedAssignments ?? []).map((proposal) => [Number(proposal.number), proposal]),
  );
  let proposals = proposedByNumber;
  // A rejected proposal from a resume re-prompts (the run stays alive,
  // matching the other interrupts); a rejected pre-supplied proposal fails
  // the run closed (there is no caller waiting to correct it).
  let fromResume = false;

  // Role programs are started before the interrupt so the orchestrating agent
  // sees which role it is choosing a route for.
  const singleWorker = state.config.singleWorker === true;
  const roleStates = new Map();
  if (!singleWorker) {
    try {
      // Guard the single-owner rule for a worktree: each Issue owns one, and
      // a role program dispatches into it one role at a time. Checking the
      // running executions alone can never collide (state keeps one execution
      // per Issue), so the candidates about to be dispatched go in too — that
      // is what would actually clash if the dispatchCandidates filter ever
      // stopped excluding an Issue whose worker is still running.
      validateWorktreeConcurrency([
        ...activeExecutions(state).map(({ worktreeId }) => ({ worktree: worktreeId })),
        ...candidates.map(({ number }) => ({ worktree: `issue-${number}` })),
      ]);
      for (const item of candidates) roleStates.set(item.number, ensureRoleState(state, item, pool));
    } catch (error) {
      return { failureReason: error.message };
    }
  }

  const manualFallback = candidates.some(({ number }) =>
    (state.triageByIssue ?? []).find(({ issue }) => issue === number)?.requiresManualAssignment);
  if ((!state.config.autoAssign || manualFallback) && !candidates.every(({ number }) => proposedByNumber.has(number))) {
    // Dynamic assignment is the orchestrating agent's judgment: pause and
    // present the deterministic candidate set plus the verified pool. The
    // resume payload can only reference pool entries (validated below).
    const resume = interrupt({
      assign: {
        issues: candidates.map(({ number, title, size, priority, executionMode }) => {
          const roleState = roleStates.get(number);
          const triage = (state.triageByIssue ?? []).find(({ issue }) => issue === number);
          return {
            number,
            title,
            size,
            priority,
            ...(triage ? { shadowTriage: triage.result,
              ...(triage.decision ? { triageDecision: triage.decision } : {}),
              legacyMode: executionMode,
              requiresManualAssignment: triage.requiresManualAssignment } : {}),
            ...(roleState
              ? {
                  executionMode: roleState.executionMode,
                  role: currentRole(roleState),
                  program: roleState.program,
                }
              : {}),
          };
        }),
        workerRoutes: pool.map(routeLabels),
      },
      ...(state.lastEventError ? { lastEventError: state.lastEventError } : {}),
    });
    fromResume = true;
    if (!Array.isArray(resume?.assignments)) return { lastEventError: "invalid-assignment:shape" };
    proposals = new Map(resume.assignments.map((proposal) => [Number(proposal.number), proposal]));
  }
  const rejectProposal = (reason) => (fromResume ? { lastEventError: reason } : { failureReason: reason });

  const assignments = [];
  const updatedRoleStates = [];
  const degradedByNumber = new Map();
  for (const [index, item] of candidates.entries()) {
    const roleState = roleStates.get(item.number);
    const role = roleState ? currentRole(roleState) : null;
    const proposal = proposals.get(item.number);
    const manualOnly = (state.triageByIssue ?? []).find(({ issue }) => issue === item.number)
      ?.requiresManualAssignment === true;
    let route;
    if (proposal === undefined && manualOnly) {
      // A triage fallback is never assigned implicitly, even with autoAssign
      // or a recorded role route.
      return rejectProposal(`invalid-assignment:${item.number}:missing`);
    } else if (proposal !== undefined) {
      route = resolveRoute(pool, proposal);
      if (!route)
        return rejectProposal(`invalid-assignment:${item.number}:${proposal.agent}:${proposal.model}`);
      // Independent review means a different runtime whenever one exists —
      // in both directions, since a fix cycle re-picks the implementer too.
      if (roleState && violatesRoleDistinctness(pool, roleState, role, route))
        return rejectProposal(`invalid-assignment:${item.number}:${role}-route-not-distinct`);
    } else if (roleState) {
      route = roleState.routes[role];
      // Re-pick when the recorded route left the pool (its agent was excluded
      // after an interruption) or would collapse onto its counterpart.
      if (
        !pool.some((candidate) => sameRoute(candidate, route)) ||
        violatesRoleDistinctness(pool, roleState, role, route)
      ) {
        const picked = pickRoleRoute(pool, roleState, role);
        route = picked.route;
        if (picked.degraded) degradedByNumber.set(item.number, picked.degraded);
      }
    } else if (state.config.autoAssign) {
      route = pool[index % pool.length];
    } else {
      return rejectProposal(`invalid-assignment:${item.number}:missing`);
    }

    if (roleState) {
      // Record the route actually used for this role, so a later role can be
      // checked against it.
      const degraded = degradedByNumber.get(item.number) ?? roleState.degraded;
      updatedRoleStates.push({
        ...roleState,
        routes: { ...roleState.routes, [role]: route },
        ...(degraded ? { degraded } : {}),
      });
    }

    assignments.push({
      number: item.number,
      ...routeLabels(route),
      route,
      attempt: attemptFor(state, item.number),
      // The plan is only rebuilt on milestones, so a later role in the same
      // program must read "does a worktree exist" from execution state, not
      // from the (now stale) planned skill. A dispatch-failed execution is not
      // evidence of a worktree: that attempt never started a worker.
      skill: roleState
        ? skillForRole(role, {
            hasWorktree: item.skill === "handoff-issue" || worktreeExists(state, item.number),
          })
        : item.skill,
      ...(roleState
        ? {
            role,
            executionMode: roleState.executionMode,
            ...(role === ROLES.REVIEWER ? { reviewPass: roleState.reviewPasses + 1 } : {}),
            ...(role === ROLES.IMPLEMENTER && roleState.fixCycles > 0
              ? { fixCycle: roleState.fixCycles }
              : {}),
          }
        : {}),
    });
  }
  return {
    assignments,
    workerRoutes: pool,
    lastEventError: null,
    triagePreflightRetry: false,
    ...(updatedRoleStates.length ? { roleStates: updatedRoleStates } : {}),
    ...(manualFallback ? { triageByIssue: (state.triageByIssue ?? [])
      .filter(({ issue, requiresManualAssignment }) => requiresManualAssignment && candidates.some(({ number }) => number === issue))
      .map((entry) => ({ ...entry, requiresManualAssignment: false })) } : {}),
  };
}

async function preflightAssistedDispatchNode(state, config) {
  const deps = getDeps(config);
  for (const assignment of pendingDispatches(state)) {
    const initial = !worktreeExists(state, assignment.number);
    if (initial && !(await deps.assistedApproval?.(state.config.triage.model)))
      return { failureReason: "triage-assisted-not-available" };
    const entry = (state.triageByIssue ?? []).find((e) => e.issue === assignment.number);
    const revision = initial ? await deps.fetchTriageRevision(assignment.number).catch(() => null) : null;
    let refreshed;
    try { refreshed = await deps.refreshTriageRoutes(state); } catch {
      return { failureReason: "triage-route-refresh-failed" };
    }
    let pool = selectWorkerRoutes(refreshed.capabilities, {
      ...parentPoolOptions(state), unavailableAgents: state.unavailableAgents,
      unavailableModels: state.unavailableModels,
    });
    if (!pool.length) return { failureReason: "no-worker-route-available" };
    let context = initial && revision ? await triageInputFor(deps, assignment.number, revision, pool,
      state.config.triage.model) : null;
    const adopted = entry?.decision && entry.decision.action !== "fallback";
    const staleIssue = initial && (entry?.result.status !== "fallback" || adopted) && (!context ||
      revision.updatedAt !== entry.result.issueUpdatedAt || entry.inputModel !== state.config.triage.model ||
      entry.result.policyVersion !== TRIAGE_POLICY);
    const changedRoutes = initial && context && (entry?.result.status === "recommended" || adopted) &&
      (context.context.routeSetHash !== entry.result.routeSetHash || context.context.evidenceVersion !== entry.result.evidenceVersion);
    const verified = !staleIssue && await deps.verifyTriageRoute(assignment.route, state).catch(() => ({ ok: false }));
    if (!staleIssue && !changedRoutes && verified?.ok) continue;
    const attempts = entry?.preflightAttempts ?? 0;
    const unavailableModels = !staleIssue && !verified?.ok ? [assignment.model] : [];
    if (unavailableModels.length) {
      try { refreshed = await deps.refreshTriageRoutes({ ...state,
        unavailableModels: [...state.unavailableModels, ...unavailableModels] }); } catch {
        return { failureReason: "triage-route-refresh-failed" };
      }
      pool = selectWorkerRoutes(refreshed.capabilities, {
        ...parentPoolOptions(state), unavailableAgents: state.unavailableAgents,
        unavailableModels: [...state.unavailableModels, ...unavailableModels],
      });
      if (!pool.length) return { failureReason: "no-worker-route-available" };
      if (initial && revision) context = await triageInputFor(deps, assignment.number, revision, pool, state.config.triage.model);
    }
    const reason = staleIssue ? "stale-input" : "route-unavailable";
    const identity = { issue: assignment.number, issueUpdatedAt: revision?.updatedAt ?? entry?.result.issueUpdatedAt ?? null,
      policyVersion: TRIAGE_POLICY, routeSetHash: context?.context.routeSetHash ?? entry?.result.routeSetHash ?? null,
      evidenceVersion: context?.context.evidenceVersion ?? entry?.result.evidenceVersion ?? "none" };
    const retained = !staleIssue && entry?.decision && entry.decision.action !== "fallback";
    const decision = retained ? { ...entry.decision, ...identity, preferredRoute: undefined } : {
      ...identity, action: "fallback", reason: "legacy-fallback",
    };
    const result = retained ? { ...entry.result, ...identity,
      ...(entry.result.status === "recommended" ? { route: { choice: "abstain",
        probabilities: { abstain: 1 }, confidence: 0 }, routeMap: {} } : {}) } : {
      ...identity, status: "fallback", reason,
    };
    const nextEntry = { ...entry, issue: assignment.number, inputModel: state.config.triage.model,
      result, decision, preflightAttempts: attempts + 1, requiresManualAssignment: true };
    let rawItem = state.items.find((i) => i.number === assignment.number);
    let refreshedItems;
    let completed = [];
    if (staleIssue) {
      try {
        const fetched = await deps.fetchItems({ ...state.config,
          selectors: { issues: [String(assignment.number)] } });
        const selected = selectProjectItems(fetched.items, { issues: [assignment.number] });
        const fresh = parseProjectItems(selected.items, { completed: selected.completed })
          .find((i) => i.number === assignment.number);
        if (!fresh || !["Ready", "Todo", "In Progress"].includes(fresh.status)) throw new Error();
        const risks = ["low", "medium", "high", "critical"];
        rawItem = { ...rawItem, ...fresh,
          riskCategory: risks[Math.max(risks.indexOf(rawItem.riskCategory ?? "low"),
            risks.indexOf(fresh.riskCategory ?? "low"))],
          size: rawItem.size ?? fresh.size,
          changeScopeCount: rawItem.changeScopeCount,
          modeOverride: rawItem.modeOverride,
        };
        refreshedItems = state.items.map((i) => i.number === assignment.number ? rawItem : i);
        completed = selected.completed;
      } catch { return { failureReason: "triage-metadata-refresh-failed" }; }
    }
    const plan = initial ? { ...state.plan, runnable: state.plan.runnable.map((i) => i.number === assignment.number
      ? applyTriageDecision({ ...i, ...rawItem, riskCategory: rawItem.riskCategory,
        size: rawItem.size, ...selectPlanFields(rawItem) }, decision) : i) } : state.plan;
    // One automatic re-evaluation only, before any role starts. Later failures
    // wait for explicit assignment; they cannot spend another API request.
    const reevaluate = initial && staleIssue && attempts < 1 && revision;
    return {
      plan, ...(refreshedItems ? { items: refreshedItems, completed } : {}),
      assignments: [{ number: assignment.number, remove: true }],
      proposedAssignments: (state.proposedAssignments ?? []).filter((p) => Number(p.number) !== assignment.number),
      capabilities: refreshed.capabilities, workerRoutes: pool,
      ...(unavailableModels.length ? { unavailableModels } : {}),
      ...(initial ? { roleStates: [{ issue: assignment.number, remove: true }] } : {}),
      triageByIssue: [{ ...nextEntry, ...(reevaluate ? { decision: undefined, result: {
        ...result, issueUpdatedAt: entry?.result.issueUpdatedAt ?? null,
      } } : {}) }],
      triagePreflightRetry: reevaluate ? "triage" : true,
      lastEventError: attempts >= 1 ? "triage-reselection-limit" : null,
    };
  }
  return { triagePreflightRetry: false, lastEventError: null };
}

function selectPlanFields(item) {
  const selected = selectExecutionMode(item);
  return { executionMode: selected.mode, eligibleModes: selected.eligibleModes,
    roleProgram: roleProgramForMode(selected.mode) };
}

async function preflightTriageDispatchNode(state, config) {
  if (triageMode(state) === "assisted") return preflightAssistedDispatchNode(state, config);
  if (triageMode(state) !== "shadow") return {};
  const deps = getDeps(config);
  const freshPool = async (unavailableModels) => {
    const refreshed = await deps.refreshTriageRoutes(state);
    return {
      capabilities: refreshed.capabilities,
      pool: selectWorkerRoutes(refreshed.capabilities, {
        ...parentPoolOptions(state),
        unavailableAgents: state.unavailableAgents,
        unavailableModels,
      }),
    };
  };
  const passed = [];
  for (const assignment of pendingDispatches(state)) {
    if (worktreeExists(state, assignment.number)) continue;
    const entry = (state.triageByIssue ?? []).find(({ issue }) => issue === assignment.number);
    const revision = await deps.fetchTriageRevision(assignment.number).catch(() => null);
    // A fallback was already presented for explicit manual assignment, so a
    // continuing metadata outage must not turn that approved route into a
    // repeated stale-input loop; exact CLI route verification still applies.
    let reason = null;
    if (!revision) reason = entry?.result.status === "fallback" ? null : "stale-input";
    else if (entry?.result.issueUpdatedAt && revision.updatedAt !== entry.result.issueUpdatedAt)
      reason = "stale-input";
    let refreshed;
    if (!reason) {
      try {
        refreshed = await freshPool(state.unavailableModels);
      } catch {
        return { failureReason: "triage-route-refresh-failed" };
      }
      if (!refreshed.pool.length) return { failureReason: "no-worker-route-available" };
      if (entry?.result.status === "recommended") {
        const current = await triageInputFor(deps, assignment.number, revision, refreshed.pool,
          state.config.triage.model);
        if (!current || current.context.routeSetHash !== entry.result.routeSetHash ||
            current.context.evidenceVersion !== entry.result.evidenceVersion) reason = "stale-input";
      }
    }
    if (!reason) {
      const verified = await deps.verifyTriageRoute(assignment.route, state).catch(() => ({ ok: false }));
      if (!verified?.ok) reason = "route-unavailable";
    }
    if (!reason) {
      // The summary compares the recommendation with this first route, not a
      // later reviewer, fix-cycle, or handoff assignment.
      if (entry && !entry.firstRoute)
        passed.push({ ...entry, firstRoute: { agent: assignment.agent, model: assignment.model } });
      continue;
    }
    // Stale input re-prompts once; repeated edits fail the run closed. A
    // failed route is excluded from the re-offered pool instead, which bounds
    // its retries by the pool size.
    const attempts = entry?.preflightAttempts ?? 0;
    if (reason === "stale-input" && attempts >= 1) return { failureReason: reason };
    const excludedModels = reason === "route-unavailable" ? [assignment.model] : [];
    if (!refreshed || excludedModels.length) {
      try {
        refreshed = await freshPool([...(state.unavailableModels ?? []), ...excludedModels]);
      } catch {
        return { failureReason: "triage-route-refresh-failed" };
      }
    }
    if (!refreshed.pool.length) return { failureReason: "no-worker-route-available" };
    const previous = entry?.result ?? {};
    return {
      assignments: [{ number: assignment.number, remove: true }],
      capabilities: refreshed.capabilities,
      workerRoutes: refreshed.pool,
      ...(excludedModels.length ? { unavailableModels: excludedModels } : {}),
      triagePreflightRetry: true,
      triageByIssue: [{ issue: assignment.number, inputModel: state.config.triage.model,
        evaluatedAt: deps.now(),
        budget: entry?.budget ?? state.triageBudget ?? null,
        preflightAttempts: reason === "stale-input" ? attempts + 1 : attempts,
        requiresManualAssignment: true,
        result: { issue: assignment.number, issueUpdatedAt: revision?.updatedAt ?? null,
          policyVersion: TRIAGE_POLICY, routeSetHash: previous.routeSetHash ?? null,
          evidenceVersion: previous.evidenceVersion ?? "none", status: "fallback", reason } }],
    };
  }
  return passed.length ? { triageByIssue: passed } : {};
}

async function dispatchWorkerNode(payload, config) {
  const deps = getDeps(config);
  const assignment = payload.assignment;
  const base = {
    issue: assignment.number,
    attempt: assignment.attempt,
    uuid: deps.uuid(),
    agent: assignment.agent,
    model: assignment.model,
    ...(assignment.skill === null || assignment.skill === undefined ? {} : { skill: assignment.skill }),
    ...(assignment.role === undefined ? {} : { role: assignment.role }),
    ...(assignment.executionMode === undefined ? {} : { executionMode: assignment.executionMode }),
    worktreeId: `issue-${assignment.number}`,
    expectedMilestone: payload.nextMilestone,
    startedAt: deps.now(),
    idempotencyKey: idempotencyKey(assignment.number, "dispatch", assignment.attempt),
  };
  // Role dispatches go through the closed-payload builder so the deny-list
  // guard runs here, on the live path. A violation is a programming error and
  // must fail the run rather than be retried as a route failure, so this sits
  // outside the try below.
  const rolePayload =
    assignment.role === undefined
      ? {
          issueNumber: assignment.number,
          releasePolicy: payload.releasePolicy,
          nextMilestone: payload.nextMilestone,
          skill: assignment.skill,
        }
      : buildRoleDispatchPayload({
          role: assignment.role,
          issueNumber: assignment.number,
          executionMode: assignment.executionMode,
          skill: assignment.skill,
          releasePolicy: payload.releasePolicy,
          nextMilestone: payload.nextMilestone,
          ...(assignment.reviewPass === undefined ? {} : { reviewPass: assignment.reviewPass }),
          ...(assignment.fixCycle === undefined ? {} : { fixCycle: assignment.fixCycle }),
        });
  try {
    const started = await deps.dispatch({
      ...rolePayload,
      route: assignment.route,
      uuid: base.uuid,
      idempotencyKey: base.idempotencyKey,
    });
    return {
      workerExecutions: [
        {
          ...base,
          status: "running",
          ...(started?.pid === undefined || started.pid === null ? {} : { pid: started.pid }),
          ...(started?.pgid === undefined ? {} : { pgid: started.pgid }),
          ...(started?.dispatchCommand === undefined ? {} : { dispatchCommand: started.dispatchCommand }),
        },
      ],
    };
  } catch (error) {
    // A route that fails at actual dispatch no longer reflects reality:
    // exclude that exact model for this run and hand the Issue off. The
    // fan-in wait node serializes targeted refreshes and replaces the live
    // capability pool before selecting any handoff route; doing that here
    // would make parallel Send children write the same LastValue channel.
    return {
      workerExecutions: [{ ...base, status: "dispatch-failed", reason: error.message }],
      pendingInterrupted: [
        {
          issue: assignment.number,
          reason: `dispatch-failed:${error.message}`,
          // The worker never started, so no worktree was created by it;
          // hand off with the skill this dispatch attempt was going to use.
          skill: assignment.skill,
          // Recorded rather than inferred: the handoff must not assume a
          // worktree exists just because an execution record does.
          worktreeCreated: false,
          // Sanitized agent label only. The wait node consumes this marker
          // after it has replaced state.capabilities from the targeted probe.
          invalidateAgent: assignment.agent,
        },
      ],
      unavailableModels: [assignment.model],
    };
  }
}

async function waitForEventsNode(state, config) {
  const invalidationAgents = [
    ...new Set(
      (state.pendingInterrupted ?? [])
        .map(({ invalidateAgent }) => invalidateAgent)
        .filter((agent) => typeof agent === "string" && agent.length > 0),
    ),
  ];
  if (invalidationAgents.length) {
    try {
      let capabilities = state.capabilities ?? [];
      for (const agent of invalidationAgents) {
        capabilities = await getDeps(config).invalidateCapabilities(agent);
        if (!Array.isArray(capabilities)) throw new Error("invalid-capability-refresh-result");
      }
      return {
        capabilities,
        pendingInterrupted: (state.pendingInterrupted ?? []).map(
          ({ invalidateAgent: _consumed, ...entry }) => entry,
        ),
      };
    } catch (error) {
      return { failureReason: `capability-invalidation-failed:${error.message}` };
    }
  }
  // Events already applied but not yet routed take precedence over waiting.
  if (state.pendingGate) return {};
  if ((state.pendingInterrupted ?? []).length) return {};
  // Nothing to wait for either when the next role of a role program can be
  // dispatched right now, or when nothing is running and nothing can advance
  // — the router sends those to assign_routes and summarize_run instead of
  // pausing for an event that would never come.
  const active = activeExecutions(state).length;
  if (state.config.maxParallel - active > 0 && dispatchCandidates(state).length) return {};
  // An Issue whose program finished but whose release milestone (e.g.
  // `merged`) has not landed keeps the run waiting even with no worker
  // running — the event comes from outside.
  if (!active && !awaitingReleaseMilestone(state).length && !allComplete(state)) return {};

  const event = interrupt({
    waiting: {
      active: activeExecutions(state).map(({ issue, agent, model, expectedMilestone: next }) => ({
        issue,
        agent,
        model,
        expectedMilestone: next,
      })),
      accepts: [...EVENT_TYPES],
    },
    ...(state.lastEventError ? { lastEventError: state.lastEventError } : {}),
  });

  if (!event || typeof event !== "object" || !EVENT_TYPES.has(event.type))
    return { lastEventError: "invalid-event:type" };

  if (event.type === "milestone") {
    const issue = Number(event.issue);
    if (!Number.isSafeInteger(issue) || !state.items.some(({ number }) => number === issue))
      return { lastEventError: `invalid-event:unknown-issue:${event.issue}` };
    if (!MILESTONE_TYPES.has(event.milestone))
      return { lastEventError: `invalid-event:milestone-type:${event.milestone}` };
    if ((state.milestones ?? []).some((m) => m.issue === issue && m.type === event.milestone))
      return { lastEventError: `duplicate-milestone:${issue}:${event.milestone}` };
    // With a role program running, the milestone is reached by finishing the
    // program (the reviewer's PASS opens the gate), never by reporting it
    // early — that would release dependents on unreviewed work.
    const roleState = roleStateFor(state, issue);
    if (roleState && roleState.status === "active")
      return { lastEventError: `role-program-active:${issue}:${currentRole(roleState)}` };
    return {
      pendingGate: {
        issue,
        type: event.milestone,
        ...(event.usage === undefined ? {} : { usage: event.usage }),
      },
      lastEventError: null,
    };
  }

  if (event.type === "role-complete") {
    const issue = Number(event.issue);
    const execution = executionsFor(state, issue).at(-1);
    if (!execution || execution.status !== "running")
      return { lastEventError: `invalid-event:no-running-worker:${event.issue}` };
    const roleState = roleStateFor(state, issue);
    if (!roleState || roleState.status !== "active")
      return { lastEventError: `invalid-event:no-role-program:${event.issue}` };
    if (event.role !== execution.role)
      return { lastEventError: `invalid-event:role-mismatch:${issue}:${event.role}` };
    let next;
    try {
      next = advanceRoleProgram(roleState, { role: event.role, verdict: event.verdict });
    } catch (error) {
      return { lastEventError: `invalid-event:${error.message}` };
    }
    const updates = {
      workerExecutions: [{ ...execution, status: "complete" }],
      roleStates: [next],
      lastEventError: null,
    };
    if (next.status === "awaiting-milestone") {
      // Every role has run and the reviewer passed (or its single fix pass is
      // done, which is not re-reviewed): the Issue may now enter
      // the integration gate for its milestone. Terminal telemetry waits for
      // the release, since the gate may still send the program back.
      updates.pendingGate = { issue, type: expectedMilestone(state, issue) };
    }
    if (next.status === "blocked") {
      updates.modeTelemetry = [modeTelemetryFor(next, next.blockedReason)];
      updates.recoveryEvents = [
        {
          issue,
          kind: "role-program-blocked",
          reason: next.blockedReason,
          at: getDeps(config).now(),
        },
      ];
    }
    return updates;
  }

  if (event.type === "worker-started") {
    const issue = Number(event.issue);
    const execution = executionsFor(state, issue).at(-1);
    if (!execution) return { lastEventError: `invalid-event:no-execution:${event.issue}` };
    return {
      workerExecutions: [
        {
          ...execution,
          ...(event.pid === undefined ? {} : { pid: Number(event.pid) }),
          ...(event.pgid === undefined ? {} : { pgid: Number(event.pgid) }),
          // Instruction-mode workers launch after the dispatch node ran, so
          // the liveness probe must compare against the moment the PID was
          // reported, not the (earlier) dispatch record time.
          pidReportedAt: getDeps(config).now(),
        },
      ],
      lastEventError: null,
    };
  }

  if (event.type === "worker-interrupted") {
    const issue = Number(event.issue);
    const execution = executionsFor(state, issue).at(-1);
    if (!execution || execution.status !== "running")
      return { lastEventError: `invalid-event:no-running-worker:${event.issue}` };
    return {
      workerExecutions: [{ ...execution, status: "interrupted", reason: event.reason ?? "interrupted" }],
      pendingInterrupted: [
        {
          issue,
          reason: event.reason ?? "interrupted",
          ...(event.proposedRoute === undefined ? {} : { proposedRoute: event.proposedRoute }),
        },
      ],
      unavailableAgents: [execution.agent],
      lastEventError: null,
    };
  }

  // "check": lost-notification fallback. Re-verify recorded executions via
  // the injected probe; a PID match alone is never sufficient (PID reuse).
  // Unlike a dispatch-time failure or an explicit interruption report, a
  // worker found dead by the probe says little about its agent CLI, so the
  // agent stays in the run's route pool (the handoff may pick it again).
  const deps = getDeps(config);
  const updates = { lastEventError: null };
  const interruptedNow = [];
  const executionUpdates = [];
  for (const execution of activeExecutions(state)) {
    const verdict = await deps.probeProcess(execution);
    if (verdict === "alive" || verdict === "unknown") continue;
    executionUpdates.push({ ...execution, status: "interrupted", reason: `probe:${verdict}` });
    interruptedNow.push({ issue: execution.issue, reason: `probe:${verdict}` });
  }
  if (executionUpdates.length) {
    updates.workerExecutions = executionUpdates;
    updates.pendingInterrupted = interruptedNow;
  }
  return updates;
}

function integrationGateNode(state) {
  const pending = state.pendingGate;
  const verdict = interrupt({
    gate: { issue: pending.issue, type: pending.type, checks: GATE_CHECKS },
    ...(state.lastEventError ? { lastEventError: state.lastEventError } : {}),
  });
  if (!verdict || typeof verdict !== "object" || typeof verdict.accepted !== "boolean")
    return { lastEventError: "invalid-gate-verdict" };
  return {
    gateResults: [
      {
        issue: pending.issue,
        type: pending.type,
        accepted: verdict.accepted,
        ...(verdict.reason === undefined ? {} : { reason: verdict.reason }),
      },
    ],
    lastEventError: null,
  };
}

function releaseDependentsNode(state) {
  const event = state.pendingGate;
  const next = applyMilestone(
    { completed: state.completed, milestones: state.milestones, usage: state.usage },
    { issue: event.issue, type: event.type, ...(event.usage === undefined ? {} : { usage: event.usage }) },
    {
      issueNumbers: state.items.map(({ number }) => number),
      releasePolicy: state.config.releasePolicy,
    },
  );
  const updates = {
    completed: next.completed,
    milestones: next.milestones,
    usage: next.usage,
    pendingGate: null,
  };
  const execution = executionsFor(state, event.issue).at(-1);
  if (execution && event.type === state.config.releasePolicy)
    updates.workerExecutions = [{ ...execution, status: "complete" }];
  else if (execution && execution.status === "running")
    updates.workerExecutions = [{ ...execution, expectedMilestone: "merged" }];
  // The release is where a role program truly ends, so terminal telemetry is
  // emitted once, here.
  const roleState = roleStateFor(state, event.issue);
  if (roleState && event.type === state.config.releasePolicy)
    updates.modeTelemetry = [modeTelemetryFor(roleState, "released")];
  return updates;
}

function returnToWorkerNode(state) {
  // Gate rejected: the Issue goes back to its worker (reason recorded in
  // gateResults); dependents are not released. Under a role program the
  // worker already exited after its role, so the program reopens at the
  // implementer for one more bounded fix cycle.
  const roleState = state.pendingGate ? roleStateFor(state, state.pendingGate.issue) : null;
  if (!roleState || roleState.status !== "awaiting-milestone") return { pendingGate: null };
  const reopened = reopenRoleProgramForFix(roleState, "integration-gate-rejected");
  return {
    pendingGate: null,
    roleStates: [reopened],
    ...(reopened.status === "blocked"
      ? { modeTelemetry: [modeTelemetryFor(reopened, reopened.blockedReason)] }
      : {}),
  };
}

function selectHandoffRouteNode(state) {
  const pool = currentPool(state);
  const assignments = [];
  const updatedRoleStates = [];
  for (const entry of state.pendingInterrupted ?? []) {
    if (!pool.length) return { failureReason: `no-worker-route-available:handoff:${entry.issue}` };
    const handoffRoleState = roleStateFor(state, entry.issue);
    const activeRole =
      handoffRoleState && handoffRoleState.status === "active" ? currentRole(handoffRoleState) : null;
    let route = null;
    let degraded = null;
    if (entry.proposedRoute !== undefined) {
      route = resolveRoute(pool, entry.proposedRoute);
      if (!route)
        return {
          failureReason: `invalid-assignment:${entry.issue}:${entry.proposedRoute?.agent}:${entry.proposedRoute?.model}`,
        };
      if (activeRole && violatesRoleDistinctness(pool, handoffRoleState, activeRole, route))
        return { failureReason: `invalid-assignment:${entry.issue}:${activeRole}-route-not-distinct` };
    } else if (activeRole) {
      // Keep the implementer/reviewer split across the handoff too.
      ({ route, degraded = null } = pickRoleRoute(pool, handoffRoleState, activeRole));
    } else {
      route = pool[0];
    }
    // Handoff continues in the same Issue worktree with the handoff-issue
    // skill, inherited WIP preserved (the worker was terminated, not the
    // tree). Exception: a dispatch-time failure never started the worker, so
    // the entry carries the skill that attempt was going to use.
    // The interrupted role resumes as the same role on the new route.
    if (activeRole) {
      // Record the route this role actually continues on, so the next role is
      // still checked against reality.
      const nextDegraded = degraded ?? handoffRoleState.degraded;
      updatedRoleStates.push({
        ...handoffRoleState,
        routes: { ...handoffRoleState.routes, [activeRole]: route },
        ...(nextDegraded ? { degraded: nextDegraded } : {}),
      });
    }
    assignments.push({
      number: entry.issue,
      ...routeLabels(route),
      route,
      attempt: attemptFor(state, entry.issue),
      // A dispatch-time failure never started a worker, so the worktree the
      // attempt was going to create does not exist: the replacement must run
      // the creating skill, not handoff-issue.
      skill: activeRole
        ? skillForRole(activeRole, { hasWorktree: entry.worktreeCreated !== false })
        : (entry.skill ?? "handoff-issue"),
      ...(activeRole
        ? {
            role: activeRole,
            executionMode: handoffRoleState.executionMode,
            ...(activeRole === ROLES.REVIEWER ? { reviewPass: handoffRoleState.reviewPasses + 1 } : {}),
            ...(activeRole === ROLES.IMPLEMENTER && handoffRoleState.fixCycles > 0
              ? { fixCycle: handoffRoleState.fixCycles }
              : {}),
          }
        : {}),
    });
  }
  return {
    assignments,
    workerRoutes: pool,
    pendingInterrupted: null,
    ...(updatedRoleStates.length ? { roleStates: updatedRoleStates } : {}),
  };
}

/**
 * Re-judge the parent's worker eligibility right before new assignments and
 * handoffs. Running workers keep their routes; only the next pick changes.
 */
async function refreshParentUsageNode(state, config) {
  if (state.failureReason) return {};
  return refreshParentUsage(state, config);
}

function failRunNode(state) {
  return { runStatus: "failed", summary: buildSummary(state, "failed") };
}

function summarizeRunNode(state) {
  let runStatus = "complete";
  if (state.failureReason) runStatus = "failed";
  else if (!allComplete(state)) runStatus = "blocked";
  return { runStatus, summary: buildSummary(state, runStatus) };
}

/* ------------------------------------------------------------------ */
/* Routers                                                             */
/* ------------------------------------------------------------------ */

const failOr = (next) => (state) => (state.failureReason ? "fail_run" : next);
const assignmentRouter = (state) => state.failureReason ? "fail_run" :
  String(state.lastEventError ?? "").startsWith("invalid-assignment") && dispatchCandidates(state).length
    ? "assign_routes" : "preflight_triage_dispatch";
const triagePreflightRouter = (state) => state.failureReason ? "fail_run" :
  state.triagePreflightRetry === "triage" ? "refresh_triage_routes" :
  state.triagePreflightRetry ? "assign_routes" : dispatchRouter(state);

function dispatchRouter(state) {
  if (state.failureReason) return "fail_run";
  // A rejected interactive assignment proposal re-prompts instead of
  // terminating: the candidates are still undispatched.
  if (String(state.lastEventError ?? "").startsWith("invalid-assignment") && dispatchCandidates(state).length)
    return "assign_routes";
  const dispatches = pendingDispatches(state);
  if (dispatches.length)
    return dispatches.map(
      (assignment) =>
        new Send("dispatch_worker", {
          assignment,
          releasePolicy: state.config.releasePolicy,
          nextMilestone: expectedMilestone(state, assignment.number),
        }),
    );
  if (allComplete(state)) return "summarize_run";
  if (
    activeExecutions(state).length ||
    (state.pendingInterrupted ?? []).length ||
    awaitingReleaseMilestone(state).length
  )
    return "wait_for_events";
  return "summarize_run";
}

function waitRouter(state) {
  if (state.failureReason) return "fail_run";
  if (state.pendingGate) return "integration_gate";
  // A handoff keeps the legacy pool: shadow triage only observes new
  // selections, so a refresh failure must not stop interrupted-work recovery.
  if ((state.pendingInterrupted ?? []).length) return "refresh_handoff_parent_usage";
  // A finished role leaves the next role of the same Issue undispatched.
  // Only go back with free capacity, otherwise the run would ping-pong
  // between assign_routes and wait_for_events without pausing.
  const capacity = state.config.maxParallel - activeExecutions(state).length;
  if (capacity > 0 && dispatchCandidates(state).length)
    return triageMode(state) === "shadow" ? "refresh_triage_routes" : "refresh_parent_usage";
  if (allComplete(state)) return "summarize_run";
  // Nothing is running and nothing can be dispatched (e.g. a role program
  // ran out of review budget): report the run as blocked instead of waiting
  // for an event that can never arrive. An Issue still owed its release
  // milestone is the exception — that event comes from outside.
  if (!activeExecutions(state).length && !awaitingReleaseMilestone(state).length) return "summarize_run";
  return "wait_for_events";
}

function gateRouter(state) {
  if (state.failureReason) return "fail_run";
  if (state.lastEventError) return "integration_gate";
  const verdict = (state.gateResults ?? []).at(-1);
  return verdict?.accepted ? "release_dependents" : "return_to_worker";
}

/* ------------------------------------------------------------------ */
/* Graph                                                               */
/* ------------------------------------------------------------------ */

export function buildOrchestrationGraph({ checkpointer } = {}) {
  const graph = new StateGraph(OrchestrationState)
    .addNode("load_config", loadConfigNode)
    .addNode("discover_capabilities", discoverCapabilitiesNode)
    .addNode("fetch_project_issues", fetchProjectIssuesNode)
    .addNode("validate_dependencies", validateDependenciesNode)
    .addNode("build_runnable_plan", buildRunnablePlanNode)
    .addNode("refresh_triage_routes", refreshTriageRoutesNode)
    .addNode("prepare_triage", prepareTriageNode)
    .addNode("resolve_triage", resolveTriageNode)
    .addNode("refresh_parent_usage", refreshParentUsageNode)
    .addNode("assign_routes", assignRoutesNode)
    .addNode("preflight_triage_dispatch", preflightTriageDispatchNode)
    .addNode("dispatch_worker", dispatchWorkerNode)
    .addNode("wait_for_events", waitForEventsNode)
    .addNode("integration_gate", integrationGateNode)
    .addNode("release_dependents", releaseDependentsNode)
    .addNode("return_to_worker", returnToWorkerNode)
    .addNode("refresh_handoff_parent_usage", refreshParentUsageNode)
    .addNode("select_handoff_route", selectHandoffRouteNode)
    .addNode("fail_run", failRunNode)
    .addNode("summarize_run", summarizeRunNode)
    .addEdge(START, "load_config")
    .addConditionalEdges("load_config", failOr("discover_capabilities"))
    .addConditionalEdges("discover_capabilities", failOr("fetch_project_issues"))
    .addConditionalEdges("fetch_project_issues", failOr("validate_dependencies"))
    .addConditionalEdges("validate_dependencies", failOr("build_runnable_plan"))
    .addConditionalEdges("build_runnable_plan", (state) =>
      failOr(triageMode(state) === "off" ? "refresh_parent_usage" : "refresh_triage_routes")(state))
    .addConditionalEdges("refresh_triage_routes", failOr("prepare_triage"))
    .addConditionalEdges("prepare_triage", failOr("resolve_triage"))
    .addConditionalEdges("resolve_triage", (state) => state.failureReason ? "fail_run" :
      state.lastEventError?.startsWith("triage-") ? "resolve_triage" : "refresh_parent_usage")
    .addConditionalEdges("refresh_parent_usage", failOr("assign_routes"))
    .addConditionalEdges("refresh_handoff_parent_usage", failOr("select_handoff_route"))
    .addConditionalEdges("assign_routes", assignmentRouter)
    .addConditionalEdges("preflight_triage_dispatch", triagePreflightRouter)
    .addEdge("dispatch_worker", "wait_for_events")
    .addConditionalEdges("wait_for_events", waitRouter)
    .addConditionalEdges("integration_gate", gateRouter)
    .addEdge("release_dependents", "build_runnable_plan")
    .addEdge("return_to_worker", "wait_for_events")
    .addConditionalEdges("select_handoff_route", dispatchRouter)
    .addEdge("fail_run", END)
    .addEdge("summarize_run", END);
  return graph.compile({ checkpointer });
}

/* ------------------------------------------------------------------ */
/* Default side-effect implementations (injected, never checkpointed)  */
/* ------------------------------------------------------------------ */

export function createDefaultDeps({ cwd, checkpointer, threadId }) {
  let triageRunner;
  const runId = triageRunId(threadId);
  const runner = () => {
    if (!checkpointer || !threadId) throw new Error("triage-persistence-required");
    triageRunner ??= createTriageRunner({
      runId,
      state: checkpointer.triageBudget(runId) ?? createTriageState(runId),
      persistState: (snapshot) => checkpointer.reserveTriageBudget(snapshot),
    });
    return triageRunner;
  };
  return {
    uuid: () => crypto.randomUUID(),
    readParentUsage: (agent) => readParentUsage(agent),
    now: () => new Date().toISOString(),
    triageBudget: () => checkpointer?.triageBudget(runId) ?? null,
    assistedApproval: async (model) => Boolean(await loadAssistedApproval(cwd, model)),
    triageEvidence: async (_routes, model) => loadApprovedRouteEvidence(cwd, model),
    claimTriageAttempt: async (input) => {
      const context = triageContext(input);
      const fingerprint = crypto.createHash("sha256")
        .update(JSON.stringify([context.issue, context.issueUpdatedAt, context.model,
          context.policyVersion, context.routeSetHash, context.evidenceVersion]))
        .digest("hex");
      return checkpointer.beginTriageAttempt(runId, fingerprint);
    },
    runTriage: (input, triage) => runner().run(input, triage),
    refreshTriageRoutes: (state) => refreshWorkerRoutes({
      cwd, ...parentPoolOptions(state),
      unavailableAgents: state.unavailableAgents,
      unavailableModels: state.unavailableModels,
    }),
    fetchTriageRevision: (issue) => fetchTriageRevision(issue, {
      graphql: repositoryIssueGraphql,
    }),
    verifyTriageRoute: (route, state) => verifyWorkerRoute(route, {
      cwd, ...parentPoolOptions(state),
      unavailableAgents: state.unavailableAgents,
      unavailableModels: state.unavailableModels,
    }),
    async loadCapabilities() {
      const discovered = await loadOrRefreshCapabilities({
        cachePath: path.resolve(cwd, DEFAULT_CAPABILITIES_OUTPUT),
        cwd,
      });
      return discovered.capabilities;
    },
    async invalidateCapabilities(agent) {
      const discovered = await loadOrRefreshCapabilities({
        cachePath: path.resolve(cwd, DEFAULT_CAPABILITIES_OUTPUT),
        cwd,
        invalidateAgents: [agent],
      });
      return discovered.capabilities;
    },
    fetchItems: (config) => fetchRepositoryIssues({ issues: config.selectors.issues }),
    /**
     * CLI process launch is intentionally outside the graph: emit the exact
     * dispatch command for the orchestrating agent to run (usually in a
     * backgrounded shell). The agent reports pid via a "worker-started"
     * event and milestones/interruptions as they happen.
     */
    async dispatch(job) {
      return {
        pid: null,
        dispatchCommand: [
          "node",
          "scripts/project-issue-dispatch.mjs",
          "--route-json",
          JSON.stringify(job.route),
          "--issue",
          String(job.issueNumber),
          "--release-policy",
          job.releasePolicy,
          "--next-milestone",
          job.nextMilestone,
          ...(job.role ? ["--role", job.role] : []),
          ...(job.skill ? ["--skill", job.skill] : []),
          ...(job.executionMode ? ["--execution-mode", job.executionMode] : []),
          ...(job.reviewPass ? ["--review-pass", String(job.reviewPass)] : []),
          ...(job.fixCycle ? ["--fix-cycle", String(job.fixCycle)] : []),
        ],
      };
    },
    /**
     * PID-reuse-safe liveness probe: "alive" only when the recorded PID is
     * running AND its start time is not later than the recorded dispatch
     * time (a PID started after our record is a different, reused process).
     * "unknown" when there is no PID to check (instruction-mode dispatch).
     */
    async probeProcess(execution) {
      if (!Number.isSafeInteger(execution.pid)) return "unknown";
      let stdout;
      try {
        // C locale pins lstart to the parseable "Tue Jul 22 17:43:07 2026"
        // format regardless of the user's LC_TIME.
        ({ stdout } = await execFileAsync("ps", ["-p", String(execution.pid), "-o", "lstart="], {
          env: { ...process.env, LC_ALL: "C" },
        }));
      } catch {
        return "dead";
      }
      const started = new Date(stdout.trim());
      if (Number.isNaN(started.getTime())) return "unknown";
      // Compare against when the PID was reported (instruction-mode workers
      // launch after the dispatch record was written), falling back to the
      // dispatch time for direct spawns.
      const recorded = new Date(execution.pidReportedAt ?? execution.startedAt);
      // Allow 5s skew between our ISO record and ps's second granularity.
      if (started.getTime() > recorded.getTime() + 5_000) return "mismatch";
      return "alive";
    },
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export function parseGraphCliArgs(argv) {
  const options = {};
  const valueFlags = new Map([
    ["--thread-id", "threadId"],
    ["--checkpoint-file", "checkpointFile"],
    ["--input", "inputPath"],
    ["--project-owner", "projectOwner"],
    ["--project-name", "projectName"],
    ["--owner-type", "ownerType"],
    ["--max-parallel", "maxParallel"],
    ["--release-policy", "releasePolicy"],
    ["--issues", "issues"],
    ["--priority", "priority"],
    ["--iteration", "iteration"],
    ["--size", "size"],
    ["--unavailable-model", "unavailableModels"],
    ["--unavailable-agent", "unavailableAgents"],
    ["--existing-worktree", "existingWorktrees"],
    ["--capabilities-file", "capabilitiesFile"],
    ["--parent-agent", "parentAgent"],
    ["--parent-model", "parentModel"],
    ["--parent-worker-mode", "parentWorkerMode"],
    ["--assignments-json", "assignmentsJson"],
    ["--resume-json", "resumeJson"],
    ["--resume-file", "resumeFile"],
    ["--config", "configPath"],
    ["--triage", "triage"],
  ]);
  const listKeys = new Set([
    "issues",
    "priority",
    "iteration",
    "size",
    "unavailableModels",
    "unavailableAgents",
    "existingWorktrees",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--auto-assign") {
      options.autoAssign = true;
      continue;
    }
    if (flag === "--single-worker") {
      options.singleWorker = true;
      continue;
    }
    if (flag === "--parent-as-worker") {
      options.parentAsWorker = "always";
      continue;
    }
    const key = valueFlags.get(flag);
    if (!key) throw new Error(`unknown-flag:${flag}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) throw new Error(`missing-flag-value:${flag}`);
    if (listKeys.has(key)) {
      options[key] ??= [];
      if (["issues", "priority", "iteration", "size"].includes(key))
        options[key].push(
          ...value
            .split(",")
            .map((item) => item.trim())
            .filter(Boolean),
        );
      else if (key === "existingWorktrees") {
        const issue = Number(value);
        if (!Number.isSafeInteger(issue) || issue <= 0)
          throw new Error(`invalid-flag-value:--existing-worktree:${value}`);
        options[key].push(issue);
      } else options[key].push(value);
    } else options[key] = key === "maxParallel" ? Number(value) : value;
  }
  if (!options.threadId) throw new Error("thread-id-required");
  if (options.triage && !["off", "shadow", "assisted"].includes(options.triage))
    throw new Error("triage-invalid-mode");
  if (options.resumeJson && options.resumeFile) throw new Error("resume-source-conflict");
  return resolveParentWorkerFlags(options);
}

async function buildStartInput(cli, repositoryRoot) {
  let yamlConfig = {};
  try {
    yamlConfig = await loadOrchestratorConfig(cli.configPath ?? DEFAULT_CONFIG_PATH, {
      cwd: repositoryRoot,
    });
  } catch (error) {
    if (error.message !== "config-file-not-found" || cli.configPath) throw error;
  }
  const merged = mergeOrchestratorConfig({
    yaml: yamlConfig,
    cli: Object.fromEntries(
      [
        ["projectOwner", cli.projectOwner],
        ["ownerType", cli.ownerType],
        ["projectName", cli.projectName],
        ["maxParallel", cli.maxParallel],
        ["releasePolicy", cli.releasePolicy],
        ["unavailableModels", cli.unavailableModels],
        ["unavailableAgents", cli.unavailableAgents],
        ["parentAsWorker", cli.parentAsWorker],
        ["triage", cli.triage],
      ].filter(([, value]) => value !== undefined),
    ),
  });
  if (!cli.parentAgent || !cli.parentModel) throw new Error("parent-agent-and-model-required");

  const input = {
    config: {
      projectOwner: merged.projectOwner,
      ownerType: merged.ownerType ?? "organization",
      projectName: merged.projectName,
      maxParallel: merged.maxParallel,
      releasePolicy: merged.releasePolicy,
      unavailableAgents: merged.unavailableAgents ?? [],
      unavailableModels: merged.unavailableModels ?? [],
      parent: { agent: cli.parentAgent, model: cli.parentModel, workerMode: merged.parentAsWorker },
      selectors: {
        issues: cli.issues,
        priority: cli.priority,
        iteration: cli.iteration,
        size: cli.size,
      },
      existingWorktrees: cli.existingWorktrees ?? [],
      autoAssign: Boolean(cli.autoAssign),
      // Escape hatch: one worker owns the whole Issue, as before role programs.
      singleWorker: Boolean(cli.singleWorker),
      triage: normalizeTriageConfig(merged.triage),
    },
  };
  if (cli.inputPath) {
    const fileInput = JSON.parse(await fs.readFile(cli.inputPath, "utf8"));
    input.items = fileInput.items;
    if (fileInput.capabilities) input.capabilities = fileInput.capabilities;
  }
  if (cli.capabilitiesFile) {
    const loaded = JSON.parse(await fs.readFile(cli.capabilitiesFile, "utf8"));
    input.capabilities = Array.isArray(loaded) ? loaded : loaded.capabilities;
  }
  if (cli.assignmentsJson) input.proposedAssignments = JSON.parse(cli.assignmentsJson);
  return input;
}

async function main() {
  const cli = parseGraphCliArgs(process.argv.slice(2));
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  await verifyRepositoryFreshness(repositoryRoot);
  const checkpointFile = path.resolve(
    repositoryRoot,
    cli.checkpointFile ?? path.join(DEFAULT_CHECKPOINT_DIR, `${cli.threadId}.json`),
  );
  const checkpointer = await FileCheckpointSaver.load(checkpointFile);
  const graph = buildOrchestrationGraph({ checkpointer });
  const config = {
    recursionLimit: 100,
    configurable: {
      thread_id: cli.threadId,
      deps: createDefaultDeps({ cwd: repositoryRoot, checkpointer, threadId: cli.threadId }),
    },
  };

  let result;
  if (cli.resumeJson || cli.resumeFile) {
    const event = JSON.parse(cli.resumeJson ?? (await fs.readFile(cli.resumeFile, "utf8")));
    result = await graph.invoke(new Command({ resume: event }), config);
  } else {
    result = await graph.invoke(await buildStartInput(cli, repositoryRoot), config);
  }

  if (isInterrupted(result)) {
    const snapshot = await graph.getState(config);
    process.stdout.write(
      `${JSON.stringify({
        status: "paused",
        interrupts: result.__interrupt__.map(({ value }) => value),
        pendingDispatches: pendingDispatches(snapshot.values).map(({ number, agent, model }) => ({
          number,
          agent,
          model,
        })),
        // Instruction-mode dispatches the orchestrating agent still has to
        // launch (no pid reported yet via a "worker-started" event).
        dispatchInstructions: (snapshot.values.workerExecutions ?? [])
          .filter((execution) => execution.status === "running" && execution.pid === undefined)
          .map(({ issue, agent, model, uuid, role, dispatchCommand }) => ({
            issue,
            agent,
            model,
            uuid,
            ...(role === undefined ? {} : { role }),
            ...(dispatchCommand === undefined ? {} : { dispatchCommand }),
          })),
        summary: buildSummary(snapshot.values, "in-progress"),
      })}\n`,
    );
    return;
  }
  process.stdout.write(
    `${JSON.stringify({ status: result.runStatus ?? "complete", summary: result.summary })}\n`,
  );
  if (result.runStatus === "failed") process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "error", reason: error.message })}\n`);
    process.exitCode = 1;
  });
