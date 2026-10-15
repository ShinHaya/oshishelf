import test from "node:test";
import { freshCheckoutEnv } from "../helpers/fresh-checkout.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Command, MemorySaver, isInterrupted } from "@langchain/langgraph";

import {
  buildOrchestrationGraph,
  buildSummary,
  createDefaultDeps,
  parseGraphCliArgs,
} from "../../scripts/project-issue-graph.mjs";
import { FileCheckpointSaver, triageRunId } from "../../scripts/project-issue-graph-checkpointer.mjs";
import {
  fallbackResult,
  normalizeTriageInput,
  parseTriageResponse,
  triageContext,
} from "../../scripts/project-issue-triage-contract.mjs";

const execFileAsync = promisify(execFile);

const parentRecord = {
  agent: "Codex",
  model: "gpt-5",
  role: "parent",
  selector: "sel",
  selectable: true,
  verifiable: true,
  timeoutMs: 60_000,
};
const workerRoute = (agent, model) => ({
  agent,
  model,
  role: "worker",
  selector: `sel ${model}`,
  selectable: true,
  verifiable: true,
  timeoutMs: 60_000,
});
const defaultCapabilities = [
  parentRecord,
  workerRoute("Codex", "gpt-5"),
  workerRoute("Claude", "sonnet"),
  workerRoute("Grok", "grok-4"),
];

const item = (number, dependencies = [], overrides = {}) => ({
  number,
  title: `Issue ${number}`,
  url: `https://example.com/${number}`,
  status: "Ready",
  priority: "P1",
  dependencies,
  ...overrides,
});

const usageSample = {
  inputTokens: 10,
  cachedInputTokens: 1,
  outputTokens: 2,
  toolCalls: 3,
  waitCalls: 4,
  wallClockMs: 500,
  fetchedBytes: 600,
};

function makeDeps(overrides = {}) {
  const dispatched = [];
  return {
    dispatched,
    uuid: () => `uuid-${dispatched.length + 1}`,
    now: () => "2026-07-22T00:00:00.000Z",
    loadCapabilities: async () => {
      throw new Error("unexpected-discovery");
    },
    claimTriageAttempt: async () => true,
    invalidateCapabilities: async () => defaultCapabilities,
    fetchItems: async () => {
      throw new Error("unexpected-fetch");
    },
    dispatch: async (job) => {
      dispatched.push(job);
      return { pid: 9000 + dispatched.length };
    },
    probeProcess: async () => "alive",
    ...overrides,
  };
}

function makeInput({ items, capabilities = defaultCapabilities, config = {} }) {
  return {
    config: {
      maxParallel: 1,
      releasePolicy: "pr-created",
      parent: { agent: "Codex", model: "gpt-5" },
      selectors: { issues: items.map(({ number }) => String(number)) },
      autoAssign: true,
      // Most cases here cover orchestration invariants that predate role
      // programs; they double as regression coverage for the single-worker
      // escape hatch. Role-program cases pass singleWorker: false.
      singleWorker: true,
      ...config,
    },
    items,
    capabilities,
  };
}

function makeRun({ deps = makeDeps(), checkpointer = new MemorySaver(), threadId = "t" } = {}) {
  const graph = buildOrchestrationGraph({ checkpointer });
  const config = { recursionLimit: 100, configurable: { thread_id: threadId, deps } };
  return {
    deps,
    graph,
    config,
    invoke: (input) => graph.invoke(input, config),
    resume: (value) => graph.invoke(new Command({ resume: value }), config),
    state: async () => (await graph.getState(config)).values,
  };
}

const shadowConfig = { mode: "shadow", model: "jev-1.13.0", maxRequests: 20 };
const revision = { updatedAt: "2026-07-21T00:00:00.000Z" };
function shadowRecommendation(input) {
  const choice = (selected, options) => ({
    type: "choice", choice: selected, confidence: 0.9,
    probabilities: Object.fromEntries(options.map((option) => [option, option === selected ? 1 : 0])),
  });
  return parseTriageResponse({ model: input.model, answers: {
    risk: choice("high", ["low", "medium", "high", "critical"]),
    size: choice("XL", ["XS", "S", "M", "L", "XL"]),
  } }, input, triageContext(input));
}

test("shadow triage displays a closed recommendation without changing mode or route", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-shadow-"));
  try {
  let requests = 0;
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    triageBudget: () => ({ runId: "t", reserved: requests, providerUnavailable: false }),
    runTriage: async (input) => { requests += 1; return { result: { ...shadowRecommendation(input), secret: "DO_NOT_STORE" } }; },
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const checkpointFile = path.join(directory, "run.json");
  const run = makeRun({ deps, checkpointer: await FileCheckpointSaver.load(checkpointFile) });
  const paused = await run.invoke(makeInput({ items: [item(1)], config: {
    triage: shadowConfig, autoAssign: false, singleWorker: false,
  } }));
  assert.equal(isInterrupted(paused), true);
  assert.equal(requests, 1);
  const issue = paused.__interrupt__[0].value.assign.issues[0];
  assert.equal(issue.shadowTriage.risk.choice, "high");
  assert.equal(issue.legacyMode, "direct-review");
  assert.equal(issue.executionMode, "direct-review");
  const state = await run.state();
  assert.equal(JSON.stringify(state).includes("DO_NOT_STORE"), false);
  assert.equal((await readFile(checkpointFile, "utf8")).includes("DO_NOT_STORE"), false);
  await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  assert.equal(requests, 1);
  assert.equal(deps.dispatched[0].route.agent, "Claude");
  assert.equal(JSON.stringify(deps.dispatched[0]).includes("DO_NOT_STORE"), false);
  assert.deepEqual((await run.state()).roleStates[0].program, ["implementer", "reviewer"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("shadow fallback pauses auto assignment and never contacts Jev after revision failure", async () => {
  let requests = 0;
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => null,
    triageEvidence: async () => [],
    runTriage: async () => { requests += 1; throw new Error("unexpected-request"); },
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  const paused = await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  assert.equal(isInterrupted(paused), true);
  assert.equal(requests, 0);
  assert.equal(deps.dispatched.length, 0);
  assert.equal(paused.__interrupt__[0].value.assign.issues[0].shadowTriage.reason, "fetch-failed");
  await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  assert.equal(deps.dispatched.length, 1);
});

test("auto assignment still exposes the shadow comparison in the run summary", async () => {
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: async (input) => ({ result: shadowRecommendation(input) }),
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  const comparison = buildSummary(await run.state(), "in-progress").shadowTriage[0];
  assert.equal(comparison.result.risk.choice, "high");
  assert.equal(comparison.legacyMode, "direct-review");
  assert.deepEqual(comparison.assignedRoute, { agent: "Claude", model: "sonnet" });
});

test("provider fallback requires manual assignment even with autoAssign", async () => {
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: async (input) => ({ result: fallbackResult(triageContext(input), "provider-error") }),
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  const paused = await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  assert.equal(isInterrupted(paused), true);
  assert.equal(deps.dispatched.length, 0);
  assert.equal(paused.__interrupt__[0].value.assign.issues[0].shadowTriage.reason, "provider-error");
});

test("exhausted durable triage budget skips the child and waits for manual assignment", async () => {
  let claims = 0;
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    triageBudget: () => ({ runId: "t", reserved: 20, providerUnavailable: false }),
    claimTriageAttempt: async () => { claims += 1; return true; },
    runTriage: async () => { throw new Error("unexpected-request"); },
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  const paused = await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  assert.equal(isInterrupted(paused), true);
  assert.equal(paused.__interrupt__[0].value.assign.issues[0].shadowTriage.reason, "budget-exhausted");
  assert.equal(claims, 0);
});

test("resuming shadow assignment from a file checkpoint does not send Jev again", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-shadow-resume-"));
  try {
    let requests = 0;
    const deps = makeDeps({
      refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
      fetchTriageRevision: async () => revision,
      triageEvidence: async () => [],
      runTriage: async (input) => { requests += 1; return { result: shadowRecommendation(input) }; },
      verifyTriageRoute: async () => ({ ok: true }),
    });
    const file = path.join(directory, "run.json");
    const first = makeRun({ deps, checkpointer: await FileCheckpointSaver.load(file) });
    await first.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig, autoAssign: false } }));
    const restarted = makeRun({ deps, checkpointer: await FileCheckpointSaver.load(file) });
    await restarted.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
    assert.equal(requests, 1);
    assert.equal(deps.dispatched.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an Issue edit before first dispatch invalidates shadow and requires manual assignment", async () => {
  let reads = 0;
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => (++reads === 1 ? revision : { updatedAt: "2026-07-22T00:00:00.000Z" }),
    triageEvidence: async () => [],
    runTriage: async (input) => ({ result: shadowRecommendation(input) }),
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  const paused = await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  assert.equal(isInterrupted(paused), true);
  assert.equal(deps.dispatched.length, 0);
  assert.equal(paused.__interrupt__[0].value.assign.issues[0].shadowTriage.reason, "stale-input");
  await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  assert.equal(deps.dispatched.length, 1);
});

test("a changed verified pool invalidates the route recommendation before dispatch", async () => {
  let refreshes = 0;
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: ++refreshes === 1
      ? defaultCapabilities : [parentRecord, workerRoute("Grok", "grok-4")] }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: async (input) => ({ result: shadowRecommendation(input) }),
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  const paused = await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  assert.equal(isInterrupted(paused), true);
  assert.equal(deps.dispatched.length, 0);
  assert.equal(paused.__interrupt__[0].value.assign.issues[0].shadowTriage.reason, "stale-input");
  assert.deepEqual(paused.__interrupt__[0].value.assign.workerRoutes, [{ agent: "Grok", model: "grok-4" }]);
});

test("shadow triage does not invent a worker when fresh CLI discovery has none", async () => {
  let requests = 0;
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: [parentRecord] }),
    runTriage: async () => { requests += 1; throw new Error("unexpected-request"); },
  });
  const run = makeRun({ deps });
  const result = await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  assert.equal(result.runStatus, "failed");
  assert.equal(result.failureReason, "no-worker-route-available");
  assert.equal(requests, 0);
  assert.equal(deps.dispatched.length, 0);
});

test("assisted triage is explicitly unavailable before adoption", async () => {
  const run = makeRun();
  const result = await run.invoke(makeInput({ items: [item(1)], config: {
    triage: { ...shadowConfig, mode: "assisted" }, singleWorker: false,
  } }));
  assert.equal(result.runStatus, "failed");
  assert.equal(result.failureReason, "triage-assisted-not-available");
  assert.equal(run.deps.dispatched.length, 0);
});

test("a later dispatch batch refreshes and triages its newly available Issue", async () => {
  const called = [];
  let refreshes = 0;
  const deps = makeDeps({
    refreshTriageRoutes: async () => { refreshes += 1; return { capabilities: defaultCapabilities }; },
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: async (input) => { called.push(input.issue); return { result: shadowRecommendation(input) }; },
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1), item(2)], config: { triage: shadowConfig } }));
  assert.deepEqual(called, [1]);
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  await run.resume({ accepted: true });
  assert.deepEqual(called, [1, 2]);
  assert.ok(refreshes >= 3);
  assert.deepEqual(deps.dispatched.map(({ issueNumber }) => issueNumber), [1, 2]);
});

test("a successful Issue dispatches while another Issue awaits fallback assignment", async () => {
  const called = [];
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: async (input) => {
      called.push(input.issue);
      return { result: input.issue === 1
        ? fallbackResult(triageContext(input), "provider-error") : shadowRecommendation(input) };
    },
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  const paused = await run.invoke(makeInput({ items: [item(1), item(2)], config: {
    triage: shadowConfig, maxParallel: 2,
  } }));
  assert.equal(isInterrupted(paused), true);
  assert.deepEqual(deps.dispatched.map(({ issueNumber }) => issueNumber), [2]);
  assert.deepEqual(called, [1, 2]);
  assert.deepEqual(paused.__interrupt__[0].value.assign.issues.map(({ number }) => number), [1]);
});

test("one stale Issue keeps another Issue's pending assignment intact", async () => {
  let issueOneReads = 0;
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async (issue) => issue === 1 && ++issueOneReads > 1
      ? { updatedAt: "2026-07-22T00:00:00.000Z" } : revision,
    triageEvidence: async () => [],
    runTriage: async (input) => ({ result: shadowRecommendation(input) }),
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  const paused = await run.invoke(makeInput({ items: [item(1), item(2)], config: {
    triage: shadowConfig, maxParallel: 2,
  } }));
  assert.equal(isInterrupted(paused), true);
  assert.deepEqual((await run.state()).assignments.map(({ number }) => number), [2]);
  await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  assert.deepEqual(deps.dispatched.map(({ issueNumber }) => issueNumber).sort(), [1, 2]);
});

test("a changed route evaluation before first dispatch invalidates shadow and requires manual assignment", async () => {
  let evidenceReads = 0;
  const evaluatedAt = new Date().toISOString();
  // Valid under the real evidence contract, so only the evaluation change can invalidate it.
  const evaluation = (agent, model) => ({
    agent, model, evaluatedAt, profileVersion: "fake-profile-1", benchmarkVersion: "fake-bench-1",
    tasks: [{ kind: "local-code", samples: 10, passed: 8, medianDurationMs: 1000 }],
  });
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => (++evidenceReads === 1
      ? [] : [evaluation("Claude", "sonnet"), evaluation("Grok", "grok-4")]),
    runTriage: async (input) => ({ result: shadowRecommendation(input) }),
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  const paused = await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  assert.equal(isInterrupted(paused), true);
  assert.equal(deps.dispatched.length, 0);
  assert.equal(paused.__interrupt__[0].value.assign.issues[0].shadowTriage.reason, "stale-input");
  await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  assert.equal(deps.dispatched.length, 1);
});

const providerErrorTriage = async (input) => ({
  result: fallbackResult(triageContext(normalizeTriageInput(input)), "provider-error"),
});

test("shadow recommendations survive a worker pool that is not in sorted order", async () => {
  // Discovery order puts Grok before Claude; the real runner sorts before hashing.
  const capabilities = [parentRecord, workerRoute("Grok", "grok-4"), workerRoute("Claude", "sonnet")];
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: async (input) => ({ result: shadowRecommendation(normalizeTriageInput(input)) }),
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1)], capabilities, config: { triage: shadowConfig } }));
  const state = await run.state();
  assert.equal(state.triageByIssue[0].result.status, "recommended");
  assert.equal(state.triageByIssue[0].requiresManualAssignment, false);
  assert.equal(deps.dispatched.length, 1);
});

test("a triage fallback is never assigned implicitly when the resume omits it", async () => {
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: providerErrorTriage,
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  const again = await run.resume({ assignments: [] });
  assert.equal(isInterrupted(again), true);
  assert.equal(deps.dispatched.length, 0);
  assert.equal(again.__interrupt__[0].value.lastEventError, "invalid-assignment:1:missing");
});

test("a manually assigned provider fallback dispatches through a continuing metadata outage", async () => {
  let revisions = 0;
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => (++revisions === 1 ? revision : null),
    triageEvidence: async () => [],
    runTriage: providerErrorTriage,
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  const paused = await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  assert.equal(paused.__interrupt__[0].value.assign.issues[0].shadowTriage.reason, "provider-error");
  await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  assert.equal(deps.dispatched.length, 1);
  assert.equal((await run.state()).failureReason, undefined);
});

test("a route that fails exact verification is not offered again", async () => {
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: async (input) => ({ result: shadowRecommendation(normalizeTriageInput(input)) }),
    verifyTriageRoute: async (route) => ({ ok: route.model !== "sonnet" }),
  });
  const run = makeRun({ deps });
  // autoAssign picks Claude first; its preflight verification fails.
  const retry = await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  assert.equal(isInterrupted(retry), true);
  assert.equal(deps.dispatched.length, 0);
  const prompt = retry.__interrupt__[0].value.assign;
  assert.equal(prompt.issues[0].shadowTriage.reason, "route-unavailable");
  assert.deepEqual(prompt.workerRoutes, [{ agent: "Grok", model: "grok-4" }]);
  await run.resume({ assignments: [{ number: 1, agent: "Grok", model: "grok-4" }] });
  assert.equal(deps.dispatched.length, 1);
  assert.equal(deps.dispatched[0].route.agent, "Grok");
});

test("exhausting every verified route in preflight fails closed without inventing one", async () => {
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: async (input) => ({ result: shadowRecommendation(normalizeTriageInput(input)) }),
    verifyTriageRoute: async () => ({ ok: false }),
  });
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  await run.resume({ assignments: [{ number: 1, agent: "Grok", model: "grok-4" }] });
  const state = await run.state();
  assert.equal(deps.dispatched.length, 0);
  assert.equal(state.failureReason, "no-worker-route-available");
});

test("a failing route-evidence provider becomes a closed fallback, not a graph error", async () => {
  let requests = 0;
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => {
      throw new Error("evidence-unavailable");
    },
    runTriage: async () => {
      requests += 1;
      throw new Error("unexpected-request");
    },
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  const paused = await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  assert.equal(isInterrupted(paused), true);
  assert.equal(requests, 0);
  assert.equal(paused.__interrupt__[0].value.assign.issues[0].shadowTriage.reason, "provider-error");
});

test("shadow handoff of an interrupted worker does not depend on a fresh route refresh", async () => {
  let refreshes = 0;
  const deps = makeDeps({
    // Selection and preflight refresh succeed; any later refresh would fail.
    refreshTriageRoutes: async () => {
      if (++refreshes > 2) throw new Error("cli-unavailable");
      return { capabilities: defaultCapabilities };
    },
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: async (input) => ({ result: shadowRecommendation(normalizeTriageInput(input)) }),
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  assert.equal(deps.dispatched[0].route.agent, "Claude");
  await run.resume({ type: "worker-interrupted", issue: 1, reason: "timeout" });
  const state = await run.state();
  assert.equal(state.failureReason, undefined);
  assert.equal(deps.dispatched.at(-1).route.agent, "Grok");
  assert.equal(deps.dispatched.at(-1).skill, "handoff-issue");
});

test("Jev receives only freshly verified worker routes, never the parent runtime or unavailable models", async () => {
  const sent = [];
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: [
      parentRecord, workerRoute("Codex", "gpt-5-codex"),
      workerRoute("Claude", "sonnet"), workerRoute("Grok", "grok-4"),
    ] }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: async (input) => { sent.push(input.routes); return { result: shadowRecommendation(input) }; },
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1)], config: {
    triage: shadowConfig, unavailableModels: ["grok-4"],
  } }));
  assert.deepEqual(sent, [[{ agent: "Claude", model: "sonnet" }]]);
  assert.deepEqual(deps.dispatched.map(({ route }) => route.model), ["sonnet"]);
});

test("triage exception text never reaches state, checkpoint, interrupt, or summary", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-shadow-error-"));
  try {
    const markers = ["fake-key-DO_NOT_STORE", "FAKE_ISSUE_BODY_DO_NOT_STORE"];
    const deps = makeDeps({
      refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
      fetchTriageRevision: async () => revision,
      triageEvidence: async () => [],
      runTriage: async () => { throw new Error(`TYPESAFE_API_KEY=${markers[0]} body=${markers[1]}`); },
      verifyTriageRoute: async () => ({ ok: true }),
    });
    const checkpointFile = path.join(directory, "run.json");
    const run = makeRun({ deps, checkpointer: await FileCheckpointSaver.load(checkpointFile) });
    const paused = await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
    assert.equal(paused.__interrupt__[0].value.assign.issues[0].shadowTriage.reason, "provider-error");
    const state = await run.state();
    const outputs = [
      JSON.stringify(paused.__interrupt__), JSON.stringify(state),
      JSON.stringify(buildSummary(state, "in-progress")), await readFile(checkpointFile, "utf8"),
    ];
    for (const output of outputs)
      for (const marker of markers) assert.equal(output.includes(marker), false, `leaks ${marker}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a checkpoint written before shadow triage resumes as triage off without contacting Jev", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-legacy-checkpoint-"));
  try {
    const unexpected = async () => { throw new Error("unexpected-triage-call"); };
    const deps = makeDeps({
      refreshTriageRoutes: unexpected, fetchTriageRevision: unexpected,
      runTriage: unexpected, verifyTriageRoute: unexpected,
    });
    const file = path.join(directory, "run.json");
    const first = makeRun({ deps, checkpointer: await FileCheckpointSaver.load(file) });
    const input = makeInput({ items: [item(1)] });
    delete input.config.triage;
    await first.invoke(input);
    // Drop the triage sections to mimic a checkpoint file written before #536.
    const { triageBudgets, triageAttempts, ...legacy } = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual([triageBudgets, triageAttempts], [{}, {}]);
    await writeFile(file, JSON.stringify(legacy));
    const saver = await FileCheckpointSaver.load(file);
    assert.equal(saver.triageBudget(triageRunId("t")), null);
    const restarted = makeRun({ deps, checkpointer: saver });
    await restarted.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
    const done = await restarted.resume({ accepted: true });
    assert.equal(done.runStatus, "complete");
    assert.equal(Object.hasOwn(done.summary, "shadowTriage"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed on a dependency cycle", async () => {
  const run = makeRun();
  const result = await run.invoke(makeInput({ items: [item(1, [2]), item(2, [1])] }));
  assert.equal(result.runStatus, "failed");
  assert.match(result.failureReason, /^dependency-cycle:/);
  assert.equal(run.deps.dispatched.length, 0);
});

test("fails closed on an open blocked-by dependency", async () => {
  const items = [item(1, [9], { blockedBy: [{ number: 9, state: "OPEN" }] })];
  const run = makeRun();
  const result = await run.invoke(makeInput({ items }));
  assert.equal(result.runStatus, "failed");
  assert.equal(result.failureReason, "dependency-open:1:9");
  assert.equal(run.deps.dispatched.length, 0);
});

test("stops before any dispatch when zero verified worker routes exist", async () => {
  const run = makeRun();
  const result = await run.invoke(makeInput({ items: [item(1)], capabilities: [parentRecord] }));
  assert.equal(result.runStatus, "failed");
  assert.equal(result.failureReason, "no-worker-route-available");
  assert.equal(run.deps.dispatched.length, 0);
});

test("fails closed when the parent route is unverifiable", async () => {
  const run = makeRun();
  const result = await run.invoke(
    makeInput({
      items: [item(1)],
      capabilities: [{ ...parentRecord, verifiable: false }, workerRoute("Codex", "gpt-5")],
    }),
  );
  assert.equal(result.runStatus, "failed");
  assert.match(result.failureReason, /^routing-unavailable:parent/);
  assert.equal(result.summary.routing.parent, "unavailable");
});

test("an unavailable agent is excluded from assignment", async () => {
  const run = makeRun();
  const result = await run.invoke(makeInput({ items: [item(1)], config: { unavailableAgents: ["Codex"] } }));
  assert.equal(isInterrupted(result), true);
  assert.deepEqual(
    run.deps.dispatched.map(({ route }) => route.agent),
    ["Claude"],
  );
});

test("a proposed assignment outside the verified pool fails closed", async () => {
  const run = makeRun();
  const result = await run.invoke({
    ...makeInput({ items: [item(1)], config: { autoAssign: false } }),
    proposedAssignments: [{ number: 1, agent: "Codex", model: "gpt-6-imagined" }],
  });
  assert.equal(result.runStatus, "failed");
  assert.equal(result.failureReason, "invalid-assignment:1:Codex:gpt-6-imagined");
  assert.equal(run.deps.dispatched.length, 0);
});

test("interactive assignment pauses with the verified pool and accepts only pool routes", async () => {
  const run = makeRun();
  const paused = await run.invoke(makeInput({ items: [item(1)], config: { autoAssign: false } }));
  assert.equal(isInterrupted(paused), true);
  const payload = paused.__interrupt__[0].value;
  assert.deepEqual(payload.assign.workerRoutes, [
    { agent: "Claude", model: "sonnet" },
    { agent: "Grok", model: "grok-4" },
  ]);
  const result = await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  assert.equal(isInterrupted(result), true);
  assert.deepEqual(
    run.deps.dispatched.map(({ route }) => route.agent),
    ["Claude"],
  );
});

test("an invalid interactive assignment re-prompts instead of killing the run", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)], config: { autoAssign: false } }));
  const rejected = await run.resume({
    assignments: [{ number: 1, agent: "Codex", model: "gpt-6-imagined" }],
  });
  assert.equal(isInterrupted(rejected), true);
  const payload = rejected.__interrupt__[0].value;
  assert.equal(payload.lastEventError, "invalid-assignment:1:Codex:gpt-6-imagined");
  assert.ok(payload.assign, "re-presents the candidate set and verified pool");
  assert.equal(run.deps.dispatched.length, 0);
  // A corrected proposal then proceeds normally.
  const accepted = await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  assert.equal(isInterrupted(accepted), true);
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1],
  );
});

test("schedules dependent Issues only after the release milestone passes the gate", async () => {
  const run = makeRun();
  let result = await run.invoke(makeInput({ items: [item(1), item(2, [1])] }));
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1],
  );

  result = await run.resume({ type: "milestone", issue: 1, milestone: "pr-created", usage: usageSample });
  assert.deepEqual(result.__interrupt__[0].value.gate, {
    issue: 1,
    type: "pr-created",
    checks: [
      "conflicts-with-other-issues-in-run",
      "contract-consistency-with-dependencies-and-dependents",
      "acceptance-criteria-coverage",
    ],
  });

  result = await run.resume({ accepted: true });
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1, 2],
  );

  result = await run.resume({ type: "milestone", issue: 2, milestone: "pr-created" });
  result = await run.resume({ accepted: true });
  assert.equal(result.runStatus, "complete");
  assert.deepEqual(result.summary.completed, [1, 2]);
  assert.deepEqual(result.summary.usage.total.availableIssues, [1]);
  assert.deepEqual(result.summary.usage.total.usage.inputTokens, 10);
});

test("gate rejection does not release dependents", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1), item(2, [1])] }));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const result = await run.resume({ accepted: false, reason: "conflicts with issue 2 contract" });
  assert.equal(isInterrupted(result), true);
  // Still waiting on Issue 1; Issue 2 was never dispatched or completed.
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1],
  );
  const state = await run.state();
  assert.deepEqual(state.completed, []);
  assert.deepEqual(state.milestones, []);
  assert.deepEqual(state.gateResults, [
    { issue: 1, type: "pr-created", accepted: false, reason: "conflicts with issue 2 contract" },
  ]);
  // The worker may resubmit the same milestone after rework; acceptance
  // then releases and dispatches the dependent Issue.
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const accepted = await run.resume({ accepted: true });
  assert.equal(isInterrupted(accepted), true);
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1, 2],
  );
  assert.deepEqual((await run.state()).completed, [1]);
});

test("merged release policy completes only on merged", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1), item(2, [1])], config: { releasePolicy: "merged" } }));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  let result = await run.resume({ accepted: true });
  // pr-created accepted but policy is merged: dependent not released.
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1],
  );
  const midState = await run.state();
  assert.deepEqual(midState.completed, []);
  assert.equal(midState.workerExecutions[0].expectedMilestone, "merged");

  await run.resume({ type: "milestone", issue: 1, milestone: "merged" });
  result = await run.resume({ accepted: true });
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1, 2],
  );
  await run.resume({ type: "milestone", issue: 2, milestone: "merged" });
  result = await run.resume({ accepted: true });
  assert.equal(result.runStatus, "complete");
});

test("duplicate milestone events are ignored without a second gate", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const result = await run.resume({ accepted: true });
  assert.equal(result.runStatus, "complete");
  assert.deepEqual(result.summary.milestones, [{ issue: 1, type: "pr-created" }]);
});

test("a duplicate milestone while waiting reports an event error and keeps waiting", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1), item(2, [1])], config: { maxParallel: 2 } }));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  await run.resume({ accepted: true });
  const result = await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  assert.equal(isInterrupted(result), true);
  assert.equal(result.__interrupt__[0].value.lastEventError, "duplicate-milestone:1:pr-created");
  const state = await run.state();
  assert.deepEqual(state.milestones, [{ issue: 1, type: "pr-created" }]);
});

test("worker interruption hands off to another verified route in the same worktree", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  const before = await run.state();
  assert.equal(before.workerExecutions[0].agent, "Claude");
  assert.equal(before.workerExecutions[0].worktreeId, "issue-1");

  const result = await run.resume({ type: "worker-interrupted", issue: 1, reason: "timeout" });
  assert.equal(isInterrupted(result), true);
  const state = await run.state();
  assert.deepEqual(state.unavailableAgents, ["Claude"]);
  const execution = state.workerExecutions[0];
  assert.equal(execution.agent, "Grok");
  assert.equal(execution.skill, "handoff-issue");
  assert.equal(execution.attempt, 2);
  assert.equal(execution.worktreeId, "issue-1");
  assert.equal(run.deps.dispatched.at(-1).skill, "handoff-issue");
});

test("an interruption can carry a proposed handoff route, validated against the pool", async () => {
  const capabilities = [...defaultCapabilities, workerRoute("Grok", "grok-4")];
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)], capabilities }));
  await run.resume({
    type: "worker-interrupted",
    issue: 1,
    reason: "session-limit",
    proposedRoute: { agent: "Grok", model: "grok-4" },
  });
  const state = await run.state();
  assert.equal(state.workerExecutions[0].agent, "Grok");
});

test("fails closed when every handoff candidate is unavailable", async () => {
  const run = makeRun();
  const result = await run
    .invoke(makeInput({ items: [item(1)], capabilities: [parentRecord, workerRoute("Claude", "sonnet")] }))
    .then(() => run.resume({ type: "worker-interrupted", issue: 1, reason: "timeout" }));
  assert.equal(result.runStatus, "failed");
  assert.equal(result.failureReason, "no-worker-route-available:handoff:1");
  // The interrupted worktree is untouched: no further dispatch happened.
  assert.equal(run.deps.dispatched.length, 1);
});

test("a route failing at dispatch time is excluded and the Issue handed off", async () => {
  const invalidated = [];
  const deps = makeDeps({
    invalidateCapabilities: async (agent) => {
      invalidated.push(agent);
      return defaultCapabilities;
    },
    dispatch: async (job) => {
      if (job.route.agent === "Claude") throw new Error("model-mismatch");
      deps.dispatched.push(job);
      return { pid: 9100 };
    },
  });
  const run = makeRun({ deps });
  const result = await run.invoke(makeInput({ items: [item(1)] }));
  assert.equal(isInterrupted(result), true);
  const state = await run.state();
  assert.deepEqual(state.unavailableModels, ["sonnet"]);
  assert.deepEqual(state.unavailableAgents, []);
  assert.deepEqual(invalidated, ["Claude"]);
  assert.equal(state.workerExecutions[0].agent, "Grok");
  // The failed dispatch never started a worker, so no worktree exists yet:
  // the retry keeps the mode that attempt was going to use.
  assert.equal(state.workerExecutions[0].skill, "issue-implementation");
});

test("an interrupted worker with a pre-existing worktree hands off in handoff-issue mode", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  await run.resume({ type: "worker-interrupted", issue: 1, reason: "session-limit" });
  const state = await run.state();
  assert.equal(state.workerExecutions[0].skill, "handoff-issue");
});

test("lost-notification check probes executions and hands off dead workers", async () => {
  const deps = makeDeps({ probeProcess: async () => "dead" });
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1)] }));
  const result = await run.resume({ type: "check" });
  assert.equal(isInterrupted(result), true);
  const state = await run.state();
  // A probe-detected death is not evidence against the agent CLI itself:
  // the agent stays in the pool (and is picked again here), unlike an
  // explicit interruption or dispatch failure.
  assert.deepEqual(state.unavailableAgents, []);
  assert.equal(state.workerExecutions[0].agent, "Claude");
  assert.equal(state.workerExecutions[0].skill, "handoff-issue");
  assert.equal(state.workerExecutions[0].attempt, 2);
});

test("a check with live workers keeps waiting without changes", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  const result = await run.resume({ type: "check" });
  assert.equal(isInterrupted(result), true);
  const state = await run.state();
  assert.equal(state.workerExecutions[0].agent, "Claude");
  assert.equal(state.workerExecutions[0].status, "running");
});

test("worker-started events attach process metadata to the execution", async () => {
  const deps = makeDeps({ dispatch: async () => ({ pid: null, dispatchCommand: ["node", "x"] }) });
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1)] }));
  await run.resume({ type: "worker-started", issue: 1, pid: 4242, pgid: 4242 });
  const state = await run.state();
  assert.equal(state.workerExecutions[0].pid, 4242);
  assert.equal(state.workerExecutions[0].pgid, 4242);
  // The probe compares against the PID report time, not the earlier
  // dispatch record, so late-launched instruction-mode workers stay alive.
  assert.equal(state.workerExecutions[0].pidReportedAt, "2026-07-22T00:00:00.000Z");
});

test("the default probe accepts a live worker whose PID was reported after launch", async (t) => {
  const { spawn } = await import("node:child_process");
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve) => child.once("spawn", resolve));
  const { probeProcess } = createDefaultDeps({ cwd: process.cwd() });

  // Instruction-mode flow: dispatch was recorded long before the agent
  // actually launched the worker; the PID report time is what must match.
  const dispatchRecordedAt = new Date(Date.now() - 3_600_000).toISOString();
  assert.equal(
    await probeProcess({
      pid: child.pid,
      startedAt: dispatchRecordedAt,
      pidReportedAt: new Date().toISOString(),
    }),
    "alive",
  );
  // A PID recorded long ago but whose process started now is a reused PID.
  assert.equal(await probeProcess({ pid: child.pid, startedAt: dispatchRecordedAt }), "mismatch");
  assert.equal(await probeProcess({ startedAt: dispatchRecordedAt }), "unknown");

  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  assert.equal(await probeProcess({ pid: child.pid, pidReportedAt: new Date().toISOString() }), "dead");
});

test("dispatches independent Issues in parallel and tolerates reversed completion order", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1), item(2)], config: { maxParallel: 2 } }));
  assert.deepEqual(run.deps.dispatched.map(({ issueNumber }) => issueNumber).sort(), [1, 2]);

  await run.resume({ type: "milestone", issue: 2, milestone: "pr-created" });
  await run.resume({ accepted: true });
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const result = await run.resume({ accepted: true });
  assert.equal(result.runStatus, "complete");
  assert.deepEqual(result.summary.completed, [1, 2]);
});

test("maxParallel counts active workers before dispatching more", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1), item(2)], config: { maxParallel: 1 } }));
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1],
  );
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  await run.resume({ accepted: true });
  assert.deepEqual(
    run.deps.dispatched.map(({ issueNumber }) => issueNumber),
    [1, 2],
  );
});

test("an invalid gate verdict re-prompts the gate", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const result = await run.resume({ accepted: "yes" });
  assert.equal(isInterrupted(result), true);
  const payload = result.__interrupt__[0].value;
  assert.equal(payload.gate.issue, 1);
  assert.equal(payload.lastEventError, "invalid-gate-verdict");
  const accepted = await run.resume({ accepted: true });
  assert.equal(accepted.runStatus, "complete");
});

test("summary keeps the established report fields", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const result = await run.resume({ accepted: true });
  assert.deepEqual(
    Object.keys(result.summary).sort(),
    [
      "assignments",
      "blocked",
      "completed",
      "milestones",
      "roles",
      "routing",
      "runnable",
      "skipped",
      "usage",
      "runStatus",
    ].sort(),
  );
  assert.deepEqual(result.summary.assignments, [{ number: 1, agent: "Claude", model: "sonnet" }]);
  assert.deepEqual(result.summary.usage.issues, [{ number: 1, usage: "unavailable" }]);
});

test("buildSummary reports the parent routing status recorded by discovery", () => {
  assert.equal(buildSummary({ parentRouting: "unavailable" }, "failed").routing.parent, "unavailable");
  assert.equal(buildSummary({}, "failed").routing.parent, "verified");
});

test("resumes after a process restart from the file checkpointer with the same thread id", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-checkpoint-"));
  const checkpointFile = path.join(directory, "run.json");
  try {
    const first = makeRun({
      checkpointer: await FileCheckpointSaver.load(checkpointFile),
      threadId: "restart",
    });
    await first.invoke(makeInput({ items: [item(1), item(2, [1])] }));
    assert.deepEqual(
      first.deps.dispatched.map(({ issueNumber }) => issueNumber),
      [1],
    );

    // Simulate a restart: a fresh saver instance hydrated from disk.
    const second = makeRun({
      checkpointer: await FileCheckpointSaver.load(checkpointFile),
      threadId: "restart",
    });
    await second.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
    const result = await second.resume({ accepted: true });
    assert.equal(isInterrupted(result), true);
    assert.deepEqual(
      second.deps.dispatched.map(({ issueNumber }) => issueNumber),
      [2],
    );
    const state = await second.state();
    assert.deepEqual(state.completed, [1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("checkpoints contain no Issue bodies, prompts, diffs, or credentials", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-checkpoint-"));
  const checkpointFile = path.join(directory, "run.json");
  try {
    const run = makeRun({
      checkpointer: await FileCheckpointSaver.load(checkpointFile),
      threadId: "privacy",
    });
    await run.invoke(makeInput({ items: [item(1)] }));
    await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
    await run.resume({ accepted: true });
    const raw = await readFile(checkpointFile, "utf8");
    for (const marker of ["issueBody", "prompt", "diff", "credential", "password", "token"])
      assert.equal(raw.includes(marker), false, `checkpoint leaks ${marker}`);
    // State carries only the sanitized item fields.
    assert.equal(raw.includes("https://example.com/1"), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the graph CLI starts, pauses, and resumes across separate processes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-cli-"));
  const checkpointFile = path.join(directory, "run.json");
  const inputFile = path.join(directory, "input.json");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    inputFile,
    JSON.stringify({
      items: [item(1)],
      capabilities: [parentRecord, workerRoute("Claude", "sonnet")],
    }),
  );
  const script = new URL("../../scripts/project-issue-graph.mjs", import.meta.url).pathname;
  const options = { env: await freshCheckoutEnv(directory) };
  try {
    const started = await execFileAsync(process.execPath, [
      script,
      "--thread-id",
      "cli-run",
      "--checkpoint-file",
      checkpointFile,
      "--input",
      inputFile,
      "--issues",
      "1",
      "--max-parallel",
      "1",
      "--release-policy",
      "pr-created",
      "--parent-agent",
      "Codex",
      "--parent-model",
      "gpt-5",
      "--auto-assign",
      "--triage",
      "off",
    ], options);
    const paused = JSON.parse(started.stdout);
    assert.equal(paused.status, "paused");
    assert.equal(paused.dispatchInstructions.length, 1);
    assert.equal(paused.dispatchInstructions[0].issue, 1);
    // Roles are on by default, so the first worker is the implementer and
    // the launch command carries its role.
    assert.equal(paused.dispatchInstructions[0].role, "implementer");
    assert.ok(paused.dispatchInstructions[0].dispatchCommand.includes("--role"));

    const resumeArgs = (event) => [
      script,
      "--thread-id",
      "cli-run",
      "--checkpoint-file",
      checkpointFile,
      "--resume-json",
      JSON.stringify(event),
    ];
    await execFileAsync(
      process.execPath,
      resumeArgs({ type: "role-complete", issue: 1, role: "implementer" }), options,
    );
    await execFileAsync(
      process.execPath,
      resumeArgs({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" }), options,
    );
    const finished = await execFileAsync(process.execPath, resumeArgs({ accepted: true }), options);
    const result = JSON.parse(finished.stdout);
    assert.equal(result.status, "complete");
    assert.deepEqual(result.summary.completed, [1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the file checkpointer rejects unsupported and corrupt files with stable reasons", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-checkpoint-"));
  const { writeFile } = await import("node:fs/promises");
  try {
    const wrongFormat = path.join(directory, "wrong.json");
    await writeFile(wrongFormat, JSON.stringify({ format: "something-else/v9" }));
    await assert.rejects(FileCheckpointSaver.load(wrongFormat), /checkpoint-format-unsupported/);

    const corrupt = path.join(directory, "corrupt.json");
    await writeFile(corrupt, "{ not json");
    await assert.rejects(FileCheckpointSaver.load(corrupt), /checkpoint-file-corrupt/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("deleteThread persists across a checkpointer reload", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-checkpoint-"));
  const checkpointFile = path.join(directory, "run.json");
  try {
    const first = makeRun({
      checkpointer: await FileCheckpointSaver.load(checkpointFile),
      threadId: "wipe",
    });
    await first.invoke(makeInput({ items: [item(1)] }));

    const saver = await FileCheckpointSaver.load(checkpointFile);
    assert.notEqual(await saver.getTuple({ configurable: { thread_id: "wipe" } }), undefined);
    await saver.deleteThread("wipe");

    const reloaded = await FileCheckpointSaver.load(checkpointFile);
    assert.equal(await reloaded.getTuple({ configurable: { thread_id: "wipe" } }), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("triage request reservations survive restart and cannot be refunded", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-triage-budget-"));
  const checkpointFile = path.join(directory, "run.json");
  try {
    const saver = await FileCheckpointSaver.load(checkpointFile);
    assert.equal(await saver.beginTriageAttempt("run", "fake-context-hash"), true);
    await saver.reserveTriageBudget({ runId: "run", reserved: 1, providerUnavailable: false });
    const restarted = await FileCheckpointSaver.load(checkpointFile);
    assert.equal(await restarted.beginTriageAttempt("run", "fake-context-hash"), false);
    assert.deepEqual(restarted.triageBudget("run"), {
      runId: "run", reserved: 1, providerUnavailable: false,
    });
    await assert.rejects(
      restarted.reserveTriageBudget({ runId: "run", reserved: 0, providerUnavailable: false }),
      /triage-budget-regression/,
    );
    await restarted.deleteThread("run");
    assert.equal((await FileCheckpointSaver.load(checkpointFile)).triageBudget("run"), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unusual graph thread IDs map to a stable valid triage budget ID", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-triage-id-"));
  try {
    const file = path.join(directory, "run.json");
    const saver = await FileCheckpointSaver.load(file);
    const runId = triageRunId("run.with.dot");
    assert.match(runId, /^[\w-]{1,100}$/);
    await saver.reserveTriageBudget({ runId, reserved: 1, providerUnavailable: false });
    const deps = createDefaultDeps({ cwd: process.cwd(), checkpointer: saver, threadId: "run.with.dot" });
    assert.equal(deps.triageBudget().reserved, 1);
    await saver.deleteThread("run.with.dot");
    assert.equal((await FileCheckpointSaver.load(file)).triageBudget(runId), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the parent runtime receives worker dispatches only when parent.asWorker opts it in (Issue #589)", async () => {
  // parentRecord validates the parent route itself; only the role=worker record can join the pool.
  const capabilities = [parentRecord, workerRoute("Codex", "gpt-5")];
  const excluded = makeRun();
  await excluded.invoke(makeInput({ items: [item(1)], capabilities }));
  assert.equal((await excluded.state()).failureReason, "no-worker-route-available");
  assert.equal(excluded.deps.dispatched.length, 0);

  const included = makeRun();
  await included.invoke(makeInput({ items: [item(1)], capabilities,
    config: { parent: { agent: "Codex", model: "gpt-5", asWorker: true } } }));
  assert.equal((await included.state()).failureReason, undefined);
  assert.equal(included.deps.dispatched.at(-1)?.route.agent, "Codex");
});

test("parseGraphCliArgs validates thread id and resume sources", () => {
  assert.equal(parseGraphCliArgs(["--thread-id", "t", "--parent-as-worker"]).parentAsWorker, "always");
  assert.throws(() => parseGraphCliArgs([]), /thread-id-required/);
  assert.throws(
    () => parseGraphCliArgs(["--thread-id", "t", "--resume-json", "{}", "--resume-file", "x"]),
    /resume-source-conflict/,
  );
  assert.throws(
    () => parseGraphCliArgs(["--thread-id", "t", "--existing-worktree", "foo"]),
    /invalid-flag-value:--existing-worktree:foo/,
  );
  const options = parseGraphCliArgs([
    "--thread-id",
    "t",
    "--issues",
    "1,2",
    "--existing-worktree",
    "3",
    "--auto-assign",
  ]);
  assert.deepEqual(options.issues, ["1", "2"]);
  assert.deepEqual(options.existingWorktrees, [3]);
  assert.equal(options.autoAssign, true);
});

test("classifies failure taxonomy into recoverable and unrecoverable reasons", async () => {
  const { classifyFailure, FAILURE_TRANSITIONS, idempotencyKey } =
    await import("../../scripts/project-issue-graph.mjs");
  assert.equal(classifyFailure("timeout").recoverable, true);
  assert.equal(classifyFailure("session-limit").recoverable, true);
  assert.equal(classifyFailure("provider-unavailable").recoverable, true);
  assert.equal(classifyFailure("worker-crashed").recoverable, true);
  assert.equal(classifyFailure("auth-failed").recoverable, false);
  assert.equal(classifyFailure("policy-blocked").recoverable, false);
  assert.equal(classifyFailure("invalid-input").recoverable, false);

  assert.deepEqual(Array.from(FAILURE_TRANSITIONS.running), ["retrying", "handing_off", "failed"]);
  assert.equal(idempotencyKey(1, "dispatch", 1), "issue-1:dispatch:1");
});

/* ------------------------------------------------------------------ */
/* Role programs (#482)                                                */
/* ------------------------------------------------------------------ */

const roleInput = (items, config = {}) => makeInput({ items, config: { singleWorker: false, ...config } });

test("a role program dispatches the implementer, then the reviewer on a different route", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));

  const implementer = run.deps.dispatched.at(-1);
  assert.equal(implementer.role, "implementer");
  assert.equal(implementer.skill, "issue-implementation");
  assert.equal(implementer.executionMode, "direct-review");

  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  const reviewer = run.deps.dispatched.at(-1);
  assert.equal(reviewer.role, "reviewer");
  assert.equal(reviewer.reviewPass, 1);
  // A reviewer runs no implementation skill; it enters the existing worktree
  // read-only.
  assert.equal(Object.hasOwn(reviewer, "skill"), false);
  // Independent review means a different runtime.
  assert.notEqual(reviewer.route.agent, implementer.route.agent);

  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" });
  const result = await run.resume({ accepted: true });
  assert.deepEqual(result.summary.milestones, [{ issue: 1, type: "pr-created" }]);
  assert.deepEqual(result.summary.completed, [1]);
  assert.deepEqual(result.summary.roles, [
    { issue: 1, executionMode: "direct-review", role: null, status: "awaiting-milestone", reviewPasses: 1 },
  ]);
});

test("a plan-implement-review Issue runs the planner before the implementer", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1, [], { size: "XL" })]));
  const planner = run.deps.dispatched.at(-1);
  assert.equal(planner.role, "planner");
  assert.equal(planner.executionMode, "plan-implement-review");

  await run.resume({ type: "role-complete", issue: 1, role: "planner" });
  const implementer = run.deps.dispatched.at(-1);
  assert.equal(implementer.role, "implementer");
  // The planner already created the worktree.
  assert.equal(implementer.skill, "handoff-issue");
});

test("a milestone reported while the role program is still running is rejected", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const state = await run.state();
  assert.equal(state.lastEventError, "role-program-active:1:implementer");
  assert.deepEqual(state.milestones, []);
  assert.deepEqual(state.completed, []);
});

test("NEEDS_REVISION buys one fix pass, which goes to the milestone without a second review", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "NEEDS_REVISION" });

  const fix = run.deps.dispatched.at(-1);
  assert.equal(fix.role, "implementer");
  assert.equal(fix.skill, "handoff-issue");
  assert.equal(fix.fixCycle, 1);

  const dispatchesBefore = run.deps.dispatched.length;
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  assert.equal(run.deps.dispatched.length, dispatchesBefore, "no second review pass");

  const result = await run.resume({ accepted: true });
  assert.deepEqual(result.summary.milestones, [{ issue: 1, type: "pr-created" }]);
  assert.deepEqual(result.summary.completed, [1]);
  assert.equal(result.summary.roles[0].reviewPasses, 1);
});

test("an interrupted reviewer resumes as the reviewer on another verified route", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  const reviewer = run.deps.dispatched.at(-1);

  await run.resume({ type: "worker-interrupted", issue: 1, reason: "session-limit" });
  const handoff = run.deps.dispatched.at(-1);
  assert.equal(handoff.role, "reviewer");
  // Still a reviewer after the handoff, so still no implementation skill.
  assert.equal(Object.hasOwn(handoff, "skill"), false);
  assert.notEqual(handoff.route.agent, reviewer.route.agent);
  const state = await run.state();
  assert.equal(state.workerExecutions[0].worktreeId, "issue-1");
});

test("mode telemetry is emitted once, at release, with labels and counters only", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" });
  // The gate may still send the program back, so nothing terminal is recorded
  // until the Issue is actually released.
  assert.deepEqual((await run.state()).modeTelemetry, []);

  await run.resume({ accepted: true });
  const state = await run.state();
  assert.equal(state.modeTelemetry.length, 1);
  const record = state.modeTelemetry[0];
  assert.equal(record.issueNumber, 1);
  assert.equal(record.mode, "direct-review");
  assert.equal(record.outcome, "released");
  assert.equal(record.selectionReason, "deterministic-policy");
  assert.equal(record.reviewPasses, 1);
  assert.deepEqual(Object.keys(record.routes.implementer).sort(), ["agent", "model"]);
  const serialized = JSON.stringify(state.modeTelemetry);
  for (const forbidden of ["selector", "prompt", "diff", "body"])
    assert.equal(serialized.includes(forbidden), false, `telemetry leaked ${forbidden}`);
});

test("single-worker mode dispatches one roleless worker per Issue", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  assert.equal(run.deps.dispatched.at(-1).role, undefined);
  const state = await run.state();
  assert.deepEqual(state.roleStates, []);
  await run.resume({ type: "milestone", issue: 1, milestone: "pr-created" });
  const result = await run.resume({ accepted: true });
  assert.deepEqual(result.summary.completed, [1]);
});

test("an integration-gate rejection sends the Issue back to the implementer", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" });

  await run.resume({ accepted: false, reason: "conflicts-with-other-issues-in-run" });
  const fix = run.deps.dispatched.at(-1);
  assert.equal(fix.role, "implementer");
  assert.equal(fix.skill, "handoff-issue");
  const state = await run.state();
  assert.deepEqual(state.milestones, []);
  assert.deepEqual(state.completed, []);
  assert.equal(state.roleStates[0].fixCycles, 1);
});

test("a role whose recorded route left the pool is re-picked from what remains", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  const implementer = run.deps.dispatched.at(-1);
  // Interrupting the implementer excludes its agent for the rest of the run;
  // the reviewer route recorded at program start may be the one left.
  await run.resume({ type: "worker-interrupted", issue: 1, reason: "session-limit" });
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });

  const reviewer = run.deps.dispatched.at(-1);
  assert.equal(reviewer.role, "reviewer");
  const state = await run.state();
  assert.deepEqual(state.unavailableAgents, [implementer.route.agent]);
  assert.notEqual(reviewer.route.agent, implementer.route.agent);
});

test("route identity survives a checkpoint round-trip", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-roles-"));
  try {
    const checkpointFile = path.join(directory, "run.json");
    const deps = makeDeps();
    const first = makeRun({ deps, checkpointer: await FileCheckpointSaver.load(checkpointFile) });
    await first.invoke(roleInput([item(1)]));
    const implementer = deps.dispatched.at(-1);
    assert.equal(implementer.role, "implementer");

    // A fresh saver reloads state from disk, so the role's recorded routes
    // come back as new objects: distinctness must hold on labels, not on
    // object identity.
    const second = makeRun({ deps, checkpointer: await FileCheckpointSaver.load(checkpointFile) });
    const reloaded = await second.state();
    assert.equal(reloaded.roleStates.length, 1, "state came back from disk");
    assert.notEqual(reloaded.roleStates[0].routes.implementer, implementer.route);

    await second.resume({ type: "role-complete", issue: 1, role: "implementer" });
    const reviewer = deps.dispatched.at(-1);
    assert.equal(reviewer.role, "reviewer");
    assert.notEqual(reviewer.route.agent, implementer.route.agent);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a role program completes under --release-policy merged instead of dead-ending", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)], { releasePolicy: "merged" }));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" });

  // pr-created passes the gate but does not release under this policy: the
  // run must stay waitable for the external merge event, not summarize.
  const afterPrCreated = await run.resume({ accepted: true });
  assert.equal(isInterrupted(afterPrCreated), true);
  const waiting = await run.state();
  assert.deepEqual(waiting.milestones, [{ issue: 1, type: "pr-created" }]);
  assert.deepEqual(waiting.completed, []);

  await run.resume({ type: "milestone", issue: 1, milestone: "merged" });
  const result = await run.resume({ accepted: true });
  assert.equal(result.runStatus, "complete");
  assert.deepEqual(result.summary.completed, [1]);
});

test("an implementer route proposal equal to the reviewer's is rejected on a fix cycle", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)], { autoAssign: false }));
  await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ assignments: [{ number: 1, agent: "Grok", model: "grok-4" }] });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "NEEDS_REVISION" });

  // The fix pass must not move the implementer onto the reviewer's runtime.
  const rejected = await run.resume({ assignments: [{ number: 1, agent: "Grok", model: "grok-4" }] });
  assert.equal(isInterrupted(rejected), true);
  assert.equal(
    rejected.__interrupt__[0].value.lastEventError,
    "invalid-assignment:1:implementer-route-not-distinct",
  );
  const accepted = await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  assert.equal(isInterrupted(accepted), true);
  assert.equal(run.deps.dispatched.at(-1).role, "implementer");
  assert.equal(run.deps.dispatched.at(-1).route.agent, "Claude");
});

test("a handoff keeps the reviewer off the implementer's route", async () => {
  const run = makeRun();
  await run.invoke({
    ...roleInput([item(1)]),
    // Three worker routes remain after the parent agent is excluded, so a
    // distinct choice still exists once the reviewer's agent drops out.
    capabilities: [...defaultCapabilities, workerRoute("Gemini", "gemini-3")],
  });
  const implementer = run.deps.dispatched.at(-1);
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  const reviewer = run.deps.dispatched.at(-1);

  // Interrupting the reviewer excludes its agent; the replacement must still
  // differ from the implementer's route, not just fall back to pool[0].
  await run.resume({ type: "worker-interrupted", issue: 1, reason: "timeout" });
  const handoff = run.deps.dispatched.at(-1);
  assert.equal(handoff.role, "reviewer");
  assert.notEqual(handoff.route.agent, reviewer.route.agent);
  assert.notEqual(handoff.route.agent, implementer.route.agent);
});

test("a handoff with no distinct route left shares one and records the degradation", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  const implementer = run.deps.dispatched.at(-1);
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });

  // Only two worker routes exist here, so excluding the reviewer's agent
  // leaves the implementer's route as the single option: continue on it
  // rather than failing the run, and say so.
  await run.resume({ type: "worker-interrupted", issue: 1, reason: "timeout" });
  const handoff = run.deps.dispatched.at(-1);
  assert.equal(handoff.role, "reviewer");
  assert.equal(handoff.route.agent, implementer.route.agent);
  const state = await run.state();
  assert.equal(state.roleStates[0].degraded, "same-route:reviewer:no-distinct-route-left");
});

test("malformed role-complete events are rejected without touching state", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  const before = await run.state();

  // The event's role must match the running worker's role.
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" });
  let state = await run.state();
  assert.equal(state.lastEventError, "invalid-event:role-mismatch:1:reviewer");
  assert.deepEqual(state.roleStates, before.roleStates);

  // A reviewer completion needs a valid verdict.
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "LGTM" });
  state = await run.state();
  assert.equal(state.lastEventError, "invalid-event:invalid-review-verdict:LGTM");
  assert.equal(state.roleStates[0].status, "active");
  assert.equal(state.roleStates[0].reviewPasses, 0);
});

test("a role-complete event in single-worker mode is rejected", async () => {
  const run = makeRun();
  await run.invoke(makeInput({ items: [item(1)] }));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  const state = await run.state();
  assert.equal(state.lastEventError, "invalid-event:no-role-program:1");
  assert.deepEqual(state.roleStates, []);
  assert.deepEqual(state.milestones, []);
});

test("an interrupted planner is handed off away from the implementer's route", async () => {
  const run = makeRun();
  await run.invoke({
    // A third worker route has to remain after the planner's agent is
    // excluded, otherwise sharing is unavoidable.
    ...roleInput([item(1, [], { size: "XL" })]),
    capabilities: [...defaultCapabilities, workerRoute("Gemini", "gemini-3")],
  });
  const planner = run.deps.dispatched.at(-1);
  assert.equal(planner.role, "planner");
  const state = await run.state();
  const implementerRoute = state.roleStates[0].routes.implementer;

  await run.resume({ type: "worker-interrupted", issue: 1, reason: "timeout" });
  const handoff = run.deps.dispatched.at(-1);
  assert.equal(handoff.role, "planner");
  // Without a planner preference this would fall back to pool[0], which is
  // exactly the implementer's route.
  assert.notEqual(handoff.route.agent, implementerRoute.agent);
  assert.notEqual(handoff.route.agent, planner.route.agent);
});

test("a fix pass tells the implementer a PR already exists", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  const first = run.deps.dispatched.at(-1);
  // The first pass creates the PR, so it carries no fix cycle.
  assert.equal(first.role, "implementer");
  assert.equal(Object.hasOwn(first, "fixCycle"), false);
  assert.equal(first.skill, "issue-implementation");

  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "NEEDS_REVISION" });

  const fix = run.deps.dispatched.at(-1);
  assert.equal(fix.role, "implementer");
  assert.equal(fix.fixCycle, 1);
  // handoff-issue resumes the worktree; it never opens a second PR.
  assert.equal(fix.skill, "handoff-issue");
  assert.ok(fix.dispatchCommand === undefined || fix.dispatchCommand.includes("--fix-cycle"));
});

test("an interrupted fix pass keeps its fix cycle across the handoff", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "NEEDS_REVISION" });
  await run.resume({ type: "worker-interrupted", issue: 1, reason: "session-limit" });

  const handoff = run.deps.dispatched.at(-1);
  assert.equal(handoff.role, "implementer");
  assert.equal(handoff.fixCycle, 1, "the replacement worker must still know a PR exists");
});

test("a second integration-gate rejection blocks instead of reopening again", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" });

  // First gate rejection spends the gate's own single reopen.
  await run.resume({ accepted: false, reason: "conflicts-with-other-issues-in-run" });
  let state = await run.state();
  assert.equal(state.roleStates[0].gateReopens, 1);
  assert.equal(state.roleStates[0].status, "active");

  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "PASS" });
  const result = await run.resume({ accepted: false, reason: "conflicts-with-other-issues-in-run" });

  assert.equal(result.runStatus, "blocked");
  state = await run.state();
  assert.equal(state.roleStates[0].status, "blocked");
  assert.equal(state.roleStates[0].blockedReason, "integration-gate-rejected-twice");
  assert.deepEqual(state.milestones, []);
  assert.deepEqual(state.completed, []);
});

test("a role-program dispatch failure hands off with the worktree-creating skill", async () => {
  let failNext = true;
  const deps = makeDeps({
    dispatch: async (job) => {
      deps.dispatched.push(job);
      if (failNext) {
        failNext = false;
        throw new Error("cli-not-found");
      }
      return { pid: 9100 + deps.dispatched.length };
    },
  });
  const run = makeRun({ deps });
  await run.invoke(roleInput([item(1)]));

  const handoff = deps.dispatched.at(-1);
  assert.equal(handoff.role, "implementer");
  // The failed attempt never started a worker, so no worktree exists yet:
  // the replacement must create one rather than resume a missing tree.
  assert.equal(handoff.skill, "issue-implementation");
  const state = await run.state();
  assert.deepEqual(state.unavailableModels, [deps.dispatched[0].route.model]);
  assert.deepEqual(state.unavailableAgents, []);
});

test("a dispatch failure keeps another verified model from the same agent usable", async () => {
  const invalidated = [];
  let failNext = true;
  const capabilities = [
    parentRecord,
    workerRoute("Claude", "claude-sonnet"),
    workerRoute("Claude", "claude-fable"),
  ];
  const deps = makeDeps({
    invalidateCapabilities: async (agent) => {
      invalidated.push(agent);
      return capabilities;
    },
    dispatch: async (job) => {
      deps.dispatched.push(job);
      if (failNext) {
        failNext = false;
        throw new Error("model-credit-unavailable");
      }
      return { pid: 9200 + deps.dispatched.length };
    },
  });
  const run = makeRun({ deps });
  await run.invoke({ ...roleInput([item(1)]), capabilities });

  const state = await run.state();
  const failedModel = deps.dispatched[0].route.model;
  assert.deepEqual(state.unavailableModels, [failedModel]);
  assert.deepEqual(invalidated, ["Claude"]);
  assert.equal(deps.dispatched.at(-1).route.agent, "Claude");
  assert.notEqual(deps.dispatched.at(-1).route.model, failedModel);
});

test("a dispatch failure drops sibling models that the targeted refresh no longer verifies", async () => {
  const invalidated = [];
  let failNext = true;
  const refreshedCapabilities = [parentRecord, workerRoute("Codex", "gpt-5"), workerRoute("Grok", "grok-4")];
  const deps = makeDeps({
    invalidateCapabilities: async (agent) => {
      invalidated.push(agent);
      return refreshedCapabilities;
    },
    dispatch: async (job) => {
      deps.dispatched.push(job);
      if (failNext) {
        failNext = false;
        throw new Error("model-credit-unavailable");
      }
      return { pid: 9300 + deps.dispatched.length };
    },
  });
  const capabilities = [
    parentRecord,
    workerRoute("Codex", "gpt-5"),
    workerRoute("Claude", "claude-sonnet"),
    workerRoute("Claude", "claude-fable"),
    workerRoute("Grok", "grok-4"),
  ];
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1)], capabilities }));

  const state = await run.state();
  assert.deepEqual(invalidated, ["Claude"]);
  assert.deepEqual(state.capabilities, refreshedCapabilities);
  assert.deepEqual(state.unavailableModels, ["claude-sonnet"]);
  assert.deepEqual(
    deps.dispatched.map(({ route }) => `${route.agent}:${route.model}`),
    ["Claude:claude-sonnet", "Grok:grok-4"],
  );
  assert.deepEqual(
    state.workerRoutes.map(({ agent, model }) => ({ agent, model })),
    [{ agent: "Grok", model: "grok-4" }],
  );
  assert.equal(state.workerExecutions[0].agent, "Grok");
  assert.equal(state.workerExecutions[0].model, "grok-4");
});

test("parallel dispatch failures serialize targeted refreshes before handoff", async () => {
  const invalidated = [];
  let refreshedCapabilities = [
    parentRecord,
    workerRoute("Codex", "gpt-5"),
    workerRoute("Claude", "claude-sonnet"),
    workerRoute("Grok", "grok-4"),
    workerRoute("Gemini", "gemini-3"),
  ];
  const deps = makeDeps({
    invalidateCapabilities: async (agent) => {
      invalidated.push(agent);
      refreshedCapabilities = refreshedCapabilities.filter((record) => record.agent !== agent);
      return refreshedCapabilities;
    },
    dispatch: async (job) => {
      deps.dispatched.push(job);
      if (job.route.agent === "Claude" || job.route.agent === "Grok") throw new Error("model-unavailable");
      return { pid: 9400 + deps.dispatched.length };
    },
  });
  const run = makeRun({ deps });
  await run.invoke(
    makeInput({
      items: [item(1), item(2)],
      capabilities: refreshedCapabilities,
      config: { maxParallel: 2 },
    }),
  );

  const state = await run.state();
  assert.deepEqual(invalidated.toSorted(), ["Claude", "Grok"]);
  assert.deepEqual(
    state.capabilities.map(({ agent, model }) => `${agent}:${model}`),
    ["Codex:gpt-5", "Codex:gpt-5", "Gemini:gemini-3"],
  );
  assert.deepEqual(
    deps.dispatched
      .slice(0, 2)
      .map(({ route }) => route.agent)
      .toSorted(),
    ["Claude", "Grok"],
  );
  assert.deepEqual(
    deps.dispatched.slice(2).map(({ route }) => route.agent),
    ["Gemini", "Gemini"],
  );
  assert.deepEqual(
    state.workerRoutes.map(({ agent, model }) => ({ agent, model })),
    [{ agent: "Gemini", model: "gemini-3" }],
  );
  assert.deepEqual(
    state.workerExecutions.map(({ agent, model, status }) => ({ agent, model, status })),
    [
      { agent: "Gemini", model: "gemini-3", status: "running" },
      { agent: "Gemini", model: "gemini-3", status: "running" },
    ],
  );
});

test("a dispatch failure fails closed when its capability cache cannot be invalidated", async () => {
  const deps = makeDeps({
    invalidateCapabilities: async () => {
      throw new Error("cache-read-only");
    },
    dispatch: async () => {
      throw new Error("model-mismatch");
    },
  });
  const run = makeRun({ deps });
  const result = await run.invoke(makeInput({ items: [item(1)] }));

  assert.equal(result.runStatus, "failed");
  assert.equal(result.failureReason, "capability-invalidation-failed:cache-read-only");
  assert.deepEqual(result.unavailableModels, ["sonnet"]);
});

test("two pool records for one runtime do not count as distinct routes", async () => {
  // Same agent+model, different selector: the selector is an invocation
  // detail, so these are one runtime and independent review is impossible.
  const oneRuntime = [
    parentRecord,
    { ...workerRoute("Claude", "sonnet"), selector: "sel sonnet --a" },
    { ...workerRoute("Claude", "sonnet"), selector: "sel sonnet --b" },
  ];
  const run = makeRun();
  await run.invoke({ ...roleInput([item(1)]), capabilities: oneRuntime });
  const state = await run.state();
  // The collapse must be detected and recorded, not pass silently as two
  // "distinct" routes just because the selectors differ.
  assert.match(state.roleStates[0].degraded, /^same-route:\w+:no-distinct-route-left$/);

  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  const implementer = run.deps.dispatched[0];
  const reviewer = run.deps.dispatched.at(-1);
  assert.equal(reviewer.role, "reviewer");
  assert.equal(reviewer.route.agent, implementer.route.agent);
  assert.equal(reviewer.route.model, implementer.route.model);
});

test("a blocked run reports why in the summary", async () => {
  const run = makeRun();
  await run.invoke(roleInput([item(1)]));
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  const result = await run.resume({ type: "role-complete", issue: 1, role: "reviewer", verdict: "REJECTED" });
  assert.equal(result.runStatus, "blocked");
  assert.deepEqual(result.summary.roles, [
    {
      issue: 1,
      executionMode: "direct-review",
      role: null,
      status: "blocked",
      reviewPasses: 1,
      blockedReason: "review-rejected",
    },
  ]);
});

/* ------------------------------------------------------------------ */
/* Shadow triage fail-closed and role-program boundaries (#536)        */
/* ------------------------------------------------------------------ */

const recommendingTriage = async (input) => ({ result: shadowRecommendation(normalizeTriageInput(input)) });

test("shadow reviewer dispatch keeps the pool when a later CLI refresh fails", async () => {
  let refreshes = 0;
  const deps = makeDeps({
    // Only the first selection and its preflight may refresh.
    refreshTriageRoutes: async () => {
      if (++refreshes > 2) throw new Error("cli-unavailable");
      return { capabilities: defaultCapabilities };
    },
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: recommendingTriage,
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  await run.invoke(roleInput([item(1)], { triage: shadowConfig }));
  const implementer = deps.dispatched.at(-1);
  assert.equal(implementer.role, "implementer");
  await run.resume({ type: "role-complete", issue: 1, role: "implementer" });
  const state = await run.state();
  assert.equal(state.failureReason, undefined);
  assert.equal(refreshes, 2);
  assert.equal(deps.dispatched.at(-1).role, "reviewer");
  // The comparison stays on the first dispatched route, not the reviewer's.
  assert.deepEqual(buildSummary(state, "running").shadowTriage[0].assignedRoute, {
    agent: implementer.route.agent,
    model: implementer.route.model,
  });
});

test("a failed CLI refresh for a new selection fails the shadow run closed", async () => {
  const deps = makeDeps({
    refreshTriageRoutes: async () => {
      throw new Error("cli-unavailable");
    },
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: recommendingTriage,
  });
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  assert.equal((await run.state()).failureReason, "triage-route-refresh-failed");
  assert.equal(deps.dispatched.length, 0);
});

test("a failed CLI refresh during dispatch preflight fails the shadow run closed", async () => {
  let refreshes = 0;
  const deps = makeDeps({
    refreshTriageRoutes: async () => {
      if (++refreshes > 1) throw new Error("cli-unavailable");
      return { capabilities: defaultCapabilities };
    },
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: recommendingTriage,
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  assert.equal((await run.state()).failureReason, "triage-route-refresh-failed");
  assert.equal(deps.dispatched.length, 0);
});

test("an Issue edited again after a stale-input re-prompt fails the shadow run closed", async () => {
  let edits = 0;
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => ({ updatedAt: `2026-07-21T00:00:0${++edits}.000Z` }),
    triageEvidence: async () => [],
    runTriage: recommendingTriage,
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  const paused = await run.invoke(makeInput({ items: [item(1)], config: { triage: shadowConfig } }));
  assert.equal(paused.__interrupt__[0].value.assign.issues[0].shadowTriage.reason, "stale-input");
  await run.resume({ assignments: [{ number: 1, agent: "Claude", model: "sonnet" }] });
  assert.equal((await run.state()).failureReason, "stale-input");
  assert.equal(deps.dispatched.length, 0);
});

test("a programmatic shadow config without model or budget uses the normalized defaults", async () => {
  const sent = [];
  const deps = makeDeps({
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    runTriage: async (input, triage) => {
      sent.push({ model: input.model, maxRequests: triage.maxRequests });
      return recommendingTriage(input);
    },
    verifyTriageRoute: async () => ({ ok: true }),
  });
  const run = makeRun({ deps });
  await run.invoke(makeInput({ items: [item(1)], config: { triage: { mode: "shadow" } } }));
  assert.deepEqual(sent, [{ model: "jev-1.13.0", maxRequests: 20 }]);
  assert.equal((await run.state()).triageByIssue[0].result.status, "recommended");
});

test("the file checkpointer rejects malformed triage budget or attempt sections", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "graph-checkpoint-"));
  try {
    const format = "project-issue-graph-checkpoint/v1";
    for (const [name, section] of [
      ["attempts.json", { triageAttempts: { run: "not-a-list" } }],
      ["budgets.json", { triageBudgets: { run: 3 } }],
    ]) {
      const file = path.join(directory, name);
      await writeFile(file, JSON.stringify({ format, storage: {}, writes: {}, ...section }));
      await assert.rejects(FileCheckpointSaver.load(file), /checkpoint-file-corrupt/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function assistedRun(overrides = {}) {
  let requests = 0;
  const deps = makeDeps({
    assistedApproval: async () => true,
    fetchItems: async (config) => ({ items: config.selectors.issues.map((n) => item(Number(n))) }),
    refreshTriageRoutes: async () => ({ capabilities: defaultCapabilities }),
    fetchTriageRevision: async () => revision,
    triageEvidence: async () => [],
    verifyTriageRoute: async () => ({ ok: true }),
    runTriage: async (input) => { requests++; return { result: shadowRecommendation(input) }; },
    ...overrides,
  });
  return { ...makeRun({ deps }), requests: () => requests };
}
const assistedInput = (overrides = {}) => makeInput({ items: [item(1)], config: {
  triage: { ...shadowConfig, mode: "assisted" }, singleWorker: false, ...overrides,
} });
const decisionFor = (prompt, action = "accept", fields = {}) => {
  const result = prompt.__interrupt__[0].value.resolveTriage.issues[0].recommendation;
  return { issue: result.issue, issueUpdatedAt: result.issueUpdatedAt,
    policyVersion: result.policyVersion, routeSetHash: result.routeSetHash,
    evidenceVersion: result.evidenceVersion, action,
    reason: action === "accept" ? "accepted" : action === "fallback" ? "legacy-fallback" : "domain-review",
    ...fields };
};

test("assisted high adoption recomputes the provisional direct-review before any role starts", async () => {
  const run = assistedRun();
  const paused = await run.invoke(assistedInput());
  assert.equal(run.deps.dispatched.length, 0);
  assert.deepEqual((await run.state()).roleStates, []);
  assert.equal((await run.state()).plan.runnable[0].executionMode, "direct-review");
  await run.resume({ triageDecisions: [decisionFor(paused)] });
  const state = await run.state();
  assert.deepEqual(state.roleStates[0].program, ["planner", "implementer", "reviewer"]);
  assert.equal(run.deps.dispatched[0].role, "planner");
  assert.equal(state.plan.runnable[0].riskCategory, "high");
  assert.equal(run.requests(), 1);
  assert.notEqual(state.roleStates[0].routes.implementer.agent, state.roleStates[0].routes.reviewer.agent);
});

test("assisted autoAssign cannot adopt a recommendation or skip manual fallback", async () => {
  const run = assistedRun();
  await run.invoke(assistedInput());
  const manual = await run.resume({});
  assert.equal(manual.__interrupt__[0].value.assign.issues[0].requiresManualAssignment, true);
  assert.equal(run.deps.dispatched.length, 0);
  assert.equal((await run.state()).plan.runnable[0].executionMode, "direct-review");
});

test("uncertain risk/Size rejects accept and permits an explicit high override", async () => {
  const run = assistedRun({ runTriage: async (input) => {
    const result = shadowRecommendation(input);
    result.risk.confidence = 0.4;
    return { result };
  } });
  const first = await run.invoke(assistedInput());
  const again = await run.resume({ triageDecisions: [decisionFor(first)] });
  assert.equal(again.__interrupt__[0].value.lastEventError, "triage-invalid-decision");
  assert.equal(run.deps.dispatched.length, 0);
  await run.resume({ triageDecisions: [decisionFor(again, "override", { riskCategory: "high", size: "S" })] });
  assert.equal(run.deps.dispatched[0].role, "planner");
});

test("an explicit direct-review override conflicts with adopted high risk", async () => {
  const run = assistedRun();
  const input = assistedInput();
  input.items[0].modeOverride = { executionMode: "direct-review", roleProgram: ["implementer", "reviewer"] };
  const first = await run.invoke(input);
  const again = await run.resume({ triageDecisions: [decisionFor(first)] });
  assert.equal(again.__interrupt__[0].value.lastEventError, "triage-mode-conflict");
  assert.equal(run.deps.dispatched.length, 0);
});

test("assisted single-worker requests display shadow-only instead of starting role programs", async () => {
  const run = assistedRun({ assistedApproval: async () => false });
  await run.invoke(assistedInput({ singleWorker: true }));
  const state = await run.state();
  assert.equal(state.config.triage.mode, "shadow");
  assert.equal(buildSummary(state, "in-progress").triageNotice, "triage-single-worker-shadow");
  assert.deepEqual(state.roleStates, []);
});

test("a failed exact route retains high risk and requires an explicit fresh assignment", async () => {
  let checks = 0;
  const run = assistedRun({ verifyTriageRoute: async () => ({ ok: ++checks > 1 }) });
  const first = await run.invoke(assistedInput());
  const manual = await run.resume({ triageDecisions: [decisionFor(first)] });
  assert.equal(manual.__interrupt__[0].value.assign.issues[0].requiresManualAssignment, true);
  const route = manual.__interrupt__[0].value.assign.workerRoutes[0];
  await run.resume({ assignments: [{ number: 1, ...route }] });
  const state = await run.state();
  assert.equal(state.plan.runnable[0].riskCategory, "high");
  assert.equal(state.lastEventError, null);
  assert.equal(run.deps.dispatched[0]?.role, "planner");
  assert.equal(run.requests(), 1);
});

test("an Issue edit before first assisted dispatch is re-evaluated only once", async () => {
  let reads = 0;
  const run = assistedRun({ fetchTriageRevision: async () => ++reads === 1 ? revision :
    { updatedAt: "2026-07-22T00:00:00.000Z" } });
  const first = await run.invoke(assistedInput());
  const again = await run.resume({ triageDecisions: [decisionFor(first)] });
  assert.ok(again.__interrupt__[0].value.resolveTriage);
  assert.equal(run.requests(), 2);
  await run.resume({ triageDecisions: [decisionFor(again)] });
  assert.equal(run.requests(), 2);
  assert.equal(run.deps.dispatched[0].role, "planner");
});

test("an adopted override of a provider fallback is invalidated by an Issue edit", async () => {
  let reads = 0;
  const run = assistedRun({
    fetchTriageRevision: async () => ({ updatedAt: ++reads === 1 ? revision.updatedAt : "2026-07-22T00:00:00.000Z" }),
    runTriage: async (input) => ({ result: fallbackResult(triageContext(input), "provider-error") }),
  });
  const first = await run.invoke(assistedInput());
  const again = await run.resume({ triageDecisions: [decisionFor(first, "override", { riskCategory: "high", size: "S" })] });
  assert.ok(again.__interrupt__[0].value.resolveTriage);
  assert.equal(run.deps.dispatched.length, 0);
  assert.equal((await run.state()).triageByIssue[0].preflightAttempts, 1);
});

test("a changed pool discards a pre-supplied assignment and waits for a fresh manual choice", async () => {
  let refreshes = 0;
  const enlarged = [...defaultCapabilities, workerRoute("Claude", "new-model")];
  const run = assistedRun({ refreshTriageRoutes: async () => ({
    capabilities: ++refreshes === 1 ? defaultCapabilities : enlarged,
  }) });
  const first = await run.invoke({ ...assistedInput(), proposedAssignments: [{ number: 1, agent: "Grok", model: "grok-4" }] });
  const manual = await run.resume({ triageDecisions: [decisionFor(first)] });
  assert.ok(manual.__interrupt__[0].value.assign);
  assert.equal(run.deps.dispatched.length, 0);
  assert.deepEqual((await run.state()).proposedAssignments, []);
  await run.resume({ assignments: [{ number: 1, agent: "Grok", model: "grok-4" }] });
  assert.equal(run.deps.dispatched[0].role, "planner");
  assert.equal(run.requests(), 1);
});

test("a newly added security label overrides a low re-evaluation before dispatch", async () => {
  let reads = 0;
  const run = assistedRun({
    fetchTriageRevision: async () => ({ updatedAt: ++reads === 1 ? revision.updatedAt : "2026-07-22T00:00:00.000Z" }),
    fetchItems: async () => ({ items: [item(1, [], { riskCategory: "high" })] }),
    runTriage: async (input) => {
      const result = shadowRecommendation(input);
      return { result: { ...result, risk: { choice: "low", confidence: 1,
        probabilities: { low: 1, medium: 0, high: 0, critical: 0 } } } };
    },
  });
  const first = await run.invoke(assistedInput());
  const again = await run.resume({ triageDecisions: [decisionFor(first)] });
  assert.ok(again.__interrupt__[0].value.resolveTriage);
  assert.equal(run.deps.dispatched.length, 0);
  await run.resume({ triageDecisions: [decisionFor(again)] });
  const state = await run.state();
  assert.equal(state.plan.runnable[0].riskCategory, "high");
  assert.equal(run.deps.dispatched[0].role, "planner");
});

test("stale recovery fails closed when current Issue metadata cannot be verified", async () => {
  let reads = 0;
  const run = assistedRun({
    fetchTriageRevision: async () => ({ updatedAt: ++reads === 1 ? revision.updatedAt : "2026-07-22T00:00:00.000Z" }),
    fetchItems: async () => { throw new Error("fake-private-error"); },
  });
  const first = await run.invoke(assistedInput());
  await run.resume({ triageDecisions: [decisionFor(first)] });
  const state = await run.state();
  assert.equal(state.failureReason, "triage-metadata-refresh-failed");
  assert.equal(run.deps.dispatched.length, 0);
  assert.equal(run.requests(), 1);
  assert.equal(JSON.stringify(state).includes("fake-private-error"), false);
});

test("approved assisted configuration forwards explicit private consent to the isolated shadow adapter", async () => {
  let childConfig;
  const run = assistedRun({ runTriage: async (input, config) => {
    childConfig = config;
    return { result: shadowRecommendation(input) };
  } });
  const first = await run.invoke(assistedInput({ triage: { ...shadowConfig,
    mode: "assisted", allowPrivateIssues: true } }));
  assert.equal(childConfig.mode, "shadow");
  assert.equal(childConfig.allowPrivateIssues, true);
  assert.equal(run.deps.dispatched.length, 0);
  await run.resume({ triageDecisions: [decisionFor(first)] });
  assert.equal(run.deps.dispatched[0].role, "planner");
});
