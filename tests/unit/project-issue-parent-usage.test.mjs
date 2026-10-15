import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { Command, MemorySaver } from "@langchain/langgraph";

import {
  decideParentWorker,
  fetchCodexRateLimits,
  normalizeCodexRateLimits,
  parseParentWorkerMode,
  readParentUsage,
} from "../../scripts/project-issue-parent-usage.mjs";
import { loadOrchestratorConfig, mergeOrchestratorConfig } from "../../scripts/project-issue-config.mjs";
import { parseCliArgs, runOrchestration } from "../../scripts/project-issue-orchestrator.mjs";
import { buildOrchestrationGraph, parseGraphCliArgs } from "../../scripts/project-issue-graph.mjs";

// All responses below are fictional fixtures shaped like the Codex App Server
// `account/rateLimits/read` result; no real account data.
const fiveHour = (usedPercent) => ({ usedPercent, windowDurationMins: 300, resetsAt: 1_900_000_000 });
const weekly = (usedPercent) => ({ usedPercent, windowDurationMins: 10_080, resetsAt: 1_900_500_000 });
const response = (rateLimits, extra = {}) => ({
  accountId: "fixture-account",
  ordinaryUsageAllowed: true,
  rateLimits: { limitId: "codex", planType: "plus", rateLimitReachedType: null, ...rateLimits },
  ...extra,
});
const fetchedAt = "2026-10-15T12:00:00.000Z";

/* ------------------------------------------------------------------ */
/* Normalization and the 50% boundary                                  */
/* ------------------------------------------------------------------ */

test("the parent joins at exactly 50% remaining and above, and is excluded below", () => {
  const decide = (used) =>
    decideParentWorker("auto", normalizeCodexRateLimits(response({ primary: fiveHour(used) }), { fetchedAt }));
  assert.deepEqual(decide(50), { eligible: true, reason: "parent-usage-sufficient" });
  assert.deepEqual(decide(49), { eligible: true, reason: "parent-usage-sufficient" });
  assert.deepEqual(decide(0), { eligible: true, reason: "parent-usage-sufficient" });
  assert.deepEqual(decide(51), { eligible: false, reason: "parent-usage-low" });
  assert.deepEqual(decide(100), { eligible: false, reason: "parent-usage-low" });
});

test("the 5-hour window is found by its 300-minute duration in either slot", () => {
  assert.deepEqual(
    normalizeCodexRateLimits(response({ primary: fiveHour(46), secondary: weekly(90) }), { fetchedAt }),
    { status: "ok", remainingPercent: 54, windowDurationMins: 300, resetsAt: 1_900_000_000, fetchedAt },
  );
  // Swapped slots: the weekly value must not be read as the 5-hour one.
  assert.equal(
    normalizeCodexRateLimits(response({ primary: weekly(10), secondary: fiveHour(70) })).remainingPercent,
    30,
  );
  // The multi-bucket codex entry wins over the legacy single-bucket view.
  assert.equal(
    normalizeCodexRateLimits(
      response({ primary: fiveHour(90) }, { rateLimitsByLimitId: { codex: { primary: fiveHour(20) } } }),
    ).remainingPercent,
    80,
  );
});

test("the snapshot carries no account, plan, or raw response fields", () => {
  const usage = normalizeCodexRateLimits(response({ primary: fiveHour(10) }), { fetchedAt });
  assert.deepEqual(Object.keys(usage).sort(), ["fetchedAt", "remainingPercent", "resetsAt", "status", "windowDurationMins"]);
});

test("missing, weekly-only, malformed, or blocked usage is unknown and keeps the parent out", () => {
  const cases = [
    [null, "parent-usage-invalid-response"],
    [{}, "parent-usage-invalid-response"],
    [response({ secondary: weekly(0) }), "parent-usage-window-missing"],
    [response({ primary: { usedPercent: 0, windowDurationMins: null } }), "parent-usage-window-missing"],
    [response({ primary: fiveHour(0), secondary: fiveHour(0) }), "parent-usage-window-missing"],
    [response({ primary: { windowDurationMins: 300 } }), "parent-usage-invalid-value"],
    [response({ primary: fiveHour(12.5) }), "parent-usage-invalid-value"],
    [response({ primary: fiveHour("10") }), "parent-usage-invalid-value"],
    [response({ primary: fiveHour(-1) }), "parent-usage-invalid-value"],
    [response({ primary: fiveHour(101) }), "parent-usage-invalid-value"],
    [response({ primary: fiveHour(0) }, { ordinaryUsageAllowed: false }), "parent-usage-blocked"],
    [response({ primary: fiveHour(0), rateLimitReachedType: "rate_limit_reached" }), "parent-usage-blocked"],
  ];
  for (const [raw, reason] of cases) {
    const usage = normalizeCodexRateLimits(raw);
    assert.deepEqual(usage, { status: "unknown", reason }, JSON.stringify(raw));
    assert.deepEqual(decideParentWorker("auto", usage), { eligible: false, reason });
  }
  assert.deepEqual(decideParentWorker("auto", undefined), { eligible: false, reason: "parent-usage-unknown" });
});

test("explicit modes do not consult usage", () => {
  const low = { status: "ok", remainingPercent: 1, windowDurationMins: 300 };
  const high = { status: "ok", remainingPercent: 100, windowDurationMins: 300 };
  assert.deepEqual(decideParentWorker("always", low), { eligible: true, reason: "parent-worker-forced" });
  assert.deepEqual(decideParentWorker("never", high), { eligible: false, reason: "parent-worker-disabled" });
});

/* ------------------------------------------------------------------ */
/* Fetching                                                            */
/* ------------------------------------------------------------------ */

/** Fake `codex app-server`: answers per the supplied handler, records kills. */
function fakeAppServer(handler) {
  const calls = [];
  const spawn = (command, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kills = [];
    child.kill = (signal) => {
      child.kills.push(signal);
      child.signalCode = signal;
      setImmediate(() => child.emit("exit", null, signal));
      return true;
    };
    calls.push({ command, args, child, requests: [] });
    let buffered = "";
    child.stdin.on("data", (chunk) => {
      buffered += chunk;
      let newline;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        calls.at(-1).requests.push(message.method);
        handler(message, (reply) => child.stdout.write(`${JSON.stringify(reply)}\n`), child);
      }
    });
    return child;
  };
  return { spawn, calls };
}

const respondingServer = (result) =>
  fakeAppServer((message, reply) => {
    if (message.method === "initialize") reply({ id: 1, result: { userAgent: "fixture" } });
    if (message.method === "account/rateLimits/read") reply({ id: 2, result });
  });

test("fetches rate limits over the App Server handshake and terminates the server", async () => {
  const server = respondingServer(response({ primary: fiveHour(30) }));
  const result = await fetchCodexRateLimits({ spawn: server.spawn, timeoutMs: 1_000 });
  assert.equal(result.rateLimits.primary.usedPercent, 30);
  const [call] = server.calls;
  assert.deepEqual(call.args, ["app-server"]);
  assert.deepEqual(call.requests, ["initialize", "initialized", "account/rateLimits/read"]);
  assert.deepEqual(call.child.kills, ["SIGTERM"]);
});

test("a silent App Server times out and is terminated", async () => {
  const server = fakeAppServer(() => {});
  await assert.rejects(fetchCodexRateLimits({ spawn: server.spawn, timeoutMs: 20 }), /parent-usage-timeout/);
  assert.deepEqual(server.calls[0].child.kills, ["SIGTERM"]);
});

test("an App Server error or early exit fails the fetch", async () => {
  const erroring = fakeAppServer((message, reply) => {
    if (message.method === "initialize") reply({ id: 1, result: {} });
    if (message.method === "account/rateLimits/read") reply({ id: 2, error: { code: -32600, message: "fixture" } });
  });
  await assert.rejects(fetchCodexRateLimits({ spawn: erroring.spawn, timeoutMs: 1_000 }), /parent-usage-fetch-failed/);
  const exiting = fakeAppServer((_message, _reply, child) => {
    child.exitCode = 1;
    child.emit("exit", 1, null);
  });
  await assert.rejects(fetchCodexRateLimits({ spawn: exiting.spawn, timeoutMs: 1_000 }), /parent-usage-fetch-failed/);
  assert.deepEqual(exiting.calls[0].child.kills, []);
});

test("readParentUsage never throws and reports closed reason codes", async () => {
  const now = () => fetchedAt;
  const ok = await readParentUsage("codex", { now, spawn: respondingServer(response({ primary: fiveHour(50) })).spawn });
  assert.deepEqual(ok, { status: "ok", remainingPercent: 50, windowDurationMins: 300, resetsAt: 1_900_000_000, fetchedAt });
  assert.deepEqual(await readParentUsage("Claude", { now }), {
    status: "unknown", reason: "parent-usage-unsupported-runtime", fetchedAt,
  });
  assert.deepEqual(await readParentUsage("Codex", { now, timeoutMs: 20, spawn: fakeAppServer(() => {}).spawn }), {
    status: "unknown", reason: "parent-usage-timeout", fetchedAt,
  });
  const throwing = { Codex: async () => { throw new Error("fixture"); } };
  assert.deepEqual(await readParentUsage("Codex", { now, fetchers: throwing }), {
    status: "unknown", reason: "parent-usage-fetch-failed", fetchedAt,
  });
  const garbage = { Codex: async () => ({ remainingPercent: 99 }) };
  assert.deepEqual(await readParentUsage("Codex", { now, fetchers: garbage }), {
    status: "unknown", reason: "parent-usage-invalid-response", fetchedAt,
  });
});

/* ------------------------------------------------------------------ */
/* Config and CLI precedence                                           */
/* ------------------------------------------------------------------ */

test("legacy booleans map onto modes so the old false default does not disable auto", () => {
  assert.equal(parseParentWorkerMode(undefined), "auto");
  assert.equal(parseParentWorkerMode(false), "auto");
  assert.equal(parseParentWorkerMode(true), "always");
  assert.equal(parseParentWorkerMode("Never"), "never");
  assert.throws(() => parseParentWorkerMode("sometimes"), /config-invalid-parent-as-worker/);
});

test("YAML modes load and CLI flags override them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "parent-usage-config-"));
  const configPath = path.join(directory, "config.yaml");
  const load = async (value) => {
    await writeFile(configPath, `run:\n  maxParallel: 1\n  releasePolicy: merged\n  unavailableModels: none\n  parentAsWorker: ${value}\n`);
    return (await loadOrchestratorConfig(configPath, { cwd: directory })).parentAsWorker;
  };
  assert.equal(await load("false"), "auto");
  assert.equal(await load("never"), "never");
  assert.equal(await load("auto"), "auto");
  assert.equal(await load("true"), "always");

  assert.equal(mergeOrchestratorConfig({ yaml: { parentAsWorker: "never" } }).parentAsWorker, "never");
  assert.equal(
    mergeOrchestratorConfig({ yaml: { parentAsWorker: "never" }, cli: { parentAsWorker: "auto" } }).parentAsWorker,
    "auto",
  );
  assert.equal(mergeOrchestratorConfig({}).parentAsWorker, "auto");
});

test("both CLIs accept --parent-worker-mode and reject a contradicting --parent-as-worker", () => {
  for (const parse of [parseCliArgs, (argv) => parseGraphCliArgs(["--thread-id", "t", ...argv])]) {
    assert.equal(parse(["--parent-worker-mode", "never"]).parentAsWorker, "never");
    assert.equal(parse(["--parent-worker-mode", "always", "--parent-as-worker"]).parentAsWorker, "always");
    assert.equal(parse([]).parentAsWorker, undefined);
    assert.throws(() => parse(["--parent-as-worker", "--parent-worker-mode", "auto"]), /parent-worker-mode-conflict/);
    assert.throws(() => parse(["--parent-worker-mode", "maybe"]), /invalid-flag-value:--parent-worker-mode/);
  }
});

/* ------------------------------------------------------------------ */
/* Classic orchestrator                                                */
/* ------------------------------------------------------------------ */

const record = (agent, model, role) => ({
  agent, model, role, selector: `sel ${model}`, selectable: true, verifiable: true, timeoutMs: 60_000,
});
const capabilities = [record("Codex", "gpt-5", "parent"), record("Codex", "gpt-5", "worker"), record("Claude", "sonnet", "worker")];

async function classicRun(parent, extraOptions = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "parent-usage-classic-"));
  const input = JSON.parse(
    await readFile(new URL("../fixtures/project-issue-orchestrator/linear.json", import.meta.url), "utf8"),
  );
  return runOrchestration({
    ...input,
    options: {
      maxParallel: 2,
      releasePolicy: "merged",
      parent: { agent: "Codex", model: "gpt-5", ...parent },
      capabilities,
      dryRun: true,
      statePath: path.join(directory, "state.json"),
      ...extraOptions,
    },
  });
}
const usageAt = (remainingPercent) => ({ status: "ok", remainingPercent, windowDurationMins: 300, fetchedAt });

test("classic: auto mode admits the parent at >= 50% and reports a closed decision", async () => {
  const atBoundary = await classicRun({ workerMode: "auto" }, { parentUsage: usageAt(50) });
  assert.deepEqual(atBoundary.workerRoutes.map(({ agent }) => agent), ["Codex", "Claude"]);
  assert.deepEqual(atBoundary.parentWorker, {
    mode: "auto", eligible: true, reason: "parent-usage-sufficient",
    remainingPercent: 50, windowDurationMins: 300, fetchedAt,
  });

  const below = await classicRun({ workerMode: "auto" }, { parentUsage: usageAt(49) });
  assert.deepEqual(below.workerRoutes.map(({ agent }) => agent), ["Claude"]);
  assert.equal(below.parentWorker.reason, "parent-usage-low");

  const unknown = await classicRun({}, { parentUsage: { status: "unknown", reason: "parent-usage-timeout", fetchedAt } });
  assert.deepEqual(unknown.workerRoutes.map(({ agent }) => agent), ["Claude"]);
  assert.deepEqual(unknown.parentWorker, { mode: "auto", eligible: false, reason: "parent-usage-timeout", fetchedAt });

  const missing = await classicRun({});
  assert.deepEqual(missing.workerRoutes.map(({ agent }) => agent), ["Claude"]);
});

test("classic: explicit settings and unavailable agents outrank usage", async () => {
  const forced = await classicRun({ workerMode: "always" }, { parentUsage: usageAt(1) });
  assert.deepEqual(forced.workerRoutes.map(({ agent }) => agent), ["Codex", "Claude"]);
  const legacyForced = await classicRun({ asWorker: true });
  assert.deepEqual(legacyForced.workerRoutes.map(({ agent }) => agent), ["Codex", "Claude"]);
  const disabled = await classicRun({ workerMode: "never" }, { parentUsage: usageAt(100) });
  assert.deepEqual(disabled.workerRoutes.map(({ agent }) => agent), ["Claude"]);
  const unavailable = await classicRun({ workerMode: "auto" }, { parentUsage: usageAt(100), unavailableAgents: ["Codex"] });
  assert.deepEqual(unavailable.workerRoutes.map(({ agent }) => agent), ["Claude"]);
  const unavailableModel = await classicRun({ workerMode: "always" }, { unavailableModels: ["gpt-5"] });
  assert.deepEqual(unavailableModel.workerRoutes.map(({ agent }) => agent), ["Claude"]);
});

/* ------------------------------------------------------------------ */
/* StateGraph                                                          */
/* ------------------------------------------------------------------ */

const graphItem = (number) => ({
  number, title: `Issue ${number}`, url: `https://example.com/${number}`, status: "Ready", priority: "P1", dependencies: [],
});

function graphRun({ usages, parent = {}, capabilityRecords = capabilities, config = {}, read }) {
  const reads = [];
  const dispatched = [];
  const deps = {
    uuid: () => `uuid-${dispatched.length + 1}`,
    now: () => fetchedAt,
    loadCapabilities: async () => { throw new Error("unexpected-discovery"); },
    invalidateCapabilities: async () => capabilityRecords,
    fetchItems: async () => { throw new Error("unexpected-fetch"); },
    dispatch: async (job) => { dispatched.push(job); return { pid: 9000 + dispatched.length }; },
    probeProcess: async () => "alive",
    readParentUsage: read ?? (async (agent) => {
      reads.push(agent);
      return usages[Math.min(reads.length - 1, usages.length - 1)];
    }),
  };
  const graph = buildOrchestrationGraph({ checkpointer: new MemorySaver() });
  const runConfig = { recursionLimit: 100, configurable: { thread_id: "t", deps } };
  const input = (items) => ({
    config: {
      maxParallel: 2, releasePolicy: "pr-created", autoAssign: true, singleWorker: true,
      parent: { agent: "Codex", model: "gpt-5", ...parent },
      selectors: { issues: items.map(({ number }) => String(number)) },
      ...config,
    },
    items,
    capabilities: capabilityRecords,
  });
  return {
    reads,
    dispatched,
    invoke: (items) => graph.invoke(input(items), runConfig),
    resume: (value) => graph.invoke(new Command({ resume: value }), runConfig),
    state: async () => (await graph.getState(runConfig)).values,
  };
}

test("graph: auto mode admits the parent at >= 50% and excludes it below", async () => {
  const parentOnly = [record("Codex", "gpt-5", "parent"), record("Codex", "gpt-5", "worker")];
  const admitted = graphRun({ usages: [usageAt(50)], capabilityRecords: parentOnly });
  await admitted.invoke([graphItem(1)]);
  assert.equal(admitted.dispatched.at(-1)?.route.agent, "Codex");
  assert.deepEqual((await admitted.state()).parentUsage, usageAt(50));

  const excluded = graphRun({ usages: [usageAt(49)], capabilityRecords: parentOnly });
  await excluded.invoke([graphItem(1)]);
  const state = await excluded.state();
  assert.equal(state.failureReason, "no-worker-route-available");
  assert.equal(excluded.dispatched.length, 0);
  assert.deepEqual(state.summary.routing.parentWorker, {
    mode: "auto", eligible: false, reason: "parent-usage-low", remainingPercent: 49, windowDurationMins: 300, fetchedAt,
  });
});

test("graph: unknown usage or a runtime without a usage reader falls back to other routes", async () => {
  const unknown = graphRun({ usages: [{ status: "unknown", reason: "parent-usage-fetch-failed" }] });
  await unknown.invoke([graphItem(1)]);
  assert.equal(unknown.dispatched.at(-1).route.agent, "Claude");

  const rejecting = graphRun({ read: async () => { throw new Error("fixture-crash"); } });
  await rejecting.invoke([graphItem(1)]);
  assert.equal(rejecting.dispatched.at(-1).route.agent, "Claude");
  assert.equal((await rejecting.state()).parentUsage.reason, "parent-usage-fetch-failed");
});

test("graph: fixed modes never read usage", async () => {
  const forced = graphRun({ usages: [usageAt(0)], parent: { workerMode: "always" } });
  await forced.invoke([graphItem(1), graphItem(2)]);
  assert.deepEqual(forced.dispatched.map(({ route }) => route.agent), ["Codex", "Claude"]);
  const disabled = graphRun({ usages: [usageAt(100)], parent: { workerMode: "never" } });
  await disabled.invoke([graphItem(1), graphItem(2)]);
  assert.deepEqual(disabled.dispatched.map(({ route }) => route.agent), ["Claude", "Claude"]);
  assert.deepEqual([...forced.reads, ...disabled.reads], []);
});

test("graph: handoff re-judges the parent without touching the running worker", async () => {
  const capabilityRecords = [...capabilities, record("Grok", "grok-4", "worker")];
  // Discovery and the first assignment see 80%; the handoff sees 30%.
  const run = graphRun({ usages: [usageAt(80), usageAt(80), usageAt(30)], capabilityRecords });
  await run.invoke([graphItem(1), graphItem(2)]);
  const before = await run.state();
  assert.deepEqual(before.workerExecutions.map(({ issue, agent }) => [issue, agent]), [[1, "Codex"], [2, "Claude"]]);

  await run.resume({ type: "worker-interrupted", issue: 2, reason: "timeout" });
  const after = await run.state();
  const byIssue = Object.fromEntries(after.workerExecutions.map((execution) => [execution.issue, execution]));
  // Claude was lost, and the parent no longer qualifies: Grok takes the handoff.
  assert.equal(byIssue[2].agent, "Grok");
  assert.equal(byIssue[2].skill, "handoff-issue");
  // The parent's running worker keeps its route and attempt.
  assert.equal(byIssue[1].agent, "Codex");
  assert.equal(byIssue[1].attempt, 1);
  assert.equal(byIssue[1].status, "running");
  assert.equal(run.reads.length, 3);
  assert.equal(after.parentUsage.remainingPercent, 30);
});
