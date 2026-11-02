import { loadRuntimeRegistry } from "../../scripts/ai-template/registry.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  applyMilestone,
  buildRunPlan,
  buildUsageReport,
  parseCliArgs,
  normalizeIssues,
  runOrchestration,
  selectIssues,
  selectWorkerRoutes,
  validateCapabilities,
  validateIssues,
} from "../../scripts/issue-orchestrator.mjs";
import {
  DEFAULT_CONFIG_PATH,
  loadOrchestratorConfig,
  mergeOrchestratorConfig,
} from "../../scripts/issue-config.mjs";
import {
  PROBE_SCHEMA_VERSION,
  getRepositoryCommit,
} from "../../scripts/issue-runtime-adapters/shared.mjs";

const execFileAsync = promisify(execFile);

const fixtures = new URL("./fixtures/issue-orchestrator/", import.meta.url);
const load = async (name) => JSON.parse(await readFile(new URL(name, fixtures), "utf8"));
const workerRoute = (agent, model) => ({
  agent,
  model,
  role: "worker",
  selector: "test-selector",
  selectable: true,
  verifiable: true,
  timeoutMs: 60_000,
});
const runOptions = {
  maxParallel: 3,
  releasePolicy: "merged",
  parent: { agent: "Codex", model: "gpt-5" },
  capabilities: [
    {
      agent: "Codex",
      model: "gpt-5",
      role: "parent",
      selector: "test-selector",
      selectable: true,
      verifiable: true,
      timeoutMs: 60_000,
    },
    workerRoute("Codex", "gpt-5"),
    workerRoute("Claude", "sonnet"),
  ],
};
const usage = {
  inputTokens: 12,
  cachedInputTokens: 2,
  outputTokens: 3,
  toolCalls: 4,
  waitCalls: 5,
  wallClockMs: 600,
  fetchedBytes: 700,
};

test("schedules A then B then C as dependencies complete", async () => {
  const items = normalizeIssues((await load("linear.json")).items);
  assert.deepEqual(
    buildRunPlan(items, { ...runOptions, completed: [] }).runnable.map(({ number }) => number),
    [101],
  );
  assert.deepEqual(
    buildRunPlan(items, { ...runOptions, completed: [101] }).runnable.map(({ number }) => number),
    [102],
  );
  assert.deepEqual(
    buildRunPlan(items, { ...runOptions, completed: [101, 102] }).runnable.map(({ number }) => number),
    [103],
  );
});

test("orders concurrent branches by Priority then Issue number", async () => {
  const items = normalizeIssues((await load("branching.json")).items);
  // 203 is P1 and 202 is P2, so 203 runs first despite the higher number.
  assert.deepEqual(
    buildRunPlan(items, { ...runOptions, completed: [201] }).runnable.map(({ number }) => number),
    [203, 202],
  );
});

test("sorts missing or unknown priorities after known ones and ties by number", () => {
  const items = normalizeIssues([
    { number: 3, title: "C", url: "u3", status: "Ready", dependencies: [] },
    { number: 2, title: "B", url: "u2", status: "Ready", priority: "P0", dependencies: [] },
    { number: 1, title: "A", url: "u1", status: "Ready", priority: "mystery", dependencies: [] },
  ]);
  assert.deepEqual(
    buildRunPlan(items, { ...runOptions }).runnable.map(({ number }) => number),
    [2, 1, 3],
  );
});

test("rejects an unknown dependency before scheduling", async () => {
  const input = (await load("linear.json")).items;
  input[1].dependencies = [999];
  assert.throws(() => validateIssues(normalizeIssues(input)), /unknown-dependency:102:999/);
});

test("rejects a dependency cycle before scheduling", async () => {
  const input = (await load("linear.json")).items;
  input[0].dependencies = [103];
  assert.throws(() => validateIssues(normalizeIssues(input)), /dependency-cycle/);
});

test("requires no agent, model, or order assignment fields on items", async () => {
  const items = normalizeIssues([
    {
      number: 901,
      title: "Assignment-free",
      url: "https://example.invalid/issues/901",
      status: "Ready",
      dependencies: [],
    },
  ]);
  assert.equal(items[0].number, 901);
  const plan = buildRunPlan(items, runOptions);
  assert.equal(plan.runnable[0].skill, "issue-implementation");
  for (const field of ["primary", "sub", "model", "order"])
    assert.equal(Object.hasOwn(plan.runnable[0], field), false);
});

test("plans a deterministic execution mode and role program per runnable Issue", async () => {
  const items = normalizeIssues([
    {
      number: 901,
      title: "Small and low risk",
      url: "https://example.invalid/issues/901",
      status: "Ready",
      size: "S",
      dependencies: [],
    },
    {
      number: 902,
      title: "Large",
      url: "https://example.invalid/issues/902",
      status: "Ready",
      size: "XL",
      dependencies: [],
    },
  ]);
  const plan = buildRunPlan(items, { ...runOptions, maxParallel: 2 });
  const byNumber = new Map(plan.runnable.map((item) => [item.number, item]));
  assert.equal(byNumber.get(901).executionMode, "direct-review");
  assert.deepEqual(byNumber.get(901).roleProgram, ["implementer", "reviewer"]);
  assert.equal(byNumber.get(902).executionMode, "plan-implement-review");
  assert.deepEqual(byNumber.get(902).roleProgram, ["planner", "implementer", "reviewer"]);
});

test("routes an existing Issue worktree through handoff-issue", async () => {
  const items = normalizeIssues((await load("linear.json")).items);
  const plan = buildRunPlan(items, { ...runOptions, completed: [], existingWorktrees: [101] });
  assert.equal(plan.runnable[0].skill, "handoff-issue");
});

test("milestones create resumable state without carrying implementation logs", () => {
  const state = applyMilestone(
    {},
    {
      issue: 101,
      type: "merged",
      usage,
      log: "secret implementation log",
    },
    { issueNumbers: [101], releasePolicy: "merged" },
  );
  assert.deepEqual(state, {
    completed: [101],
    milestones: [{ issue: 101, type: "merged" }],
    usage: { 101: usage },
  });
});

test("reports the complete usage schema and marks a mixed total as partial", () => {
  assert.deepEqual(buildUsageReport({ 101: usage }, [101, 102]), {
    issues: [
      { number: 101, usage },
      { number: 102, usage: "unavailable" },
    ],
    total: { status: "partial", availableIssues: [101], unavailableIssues: [102], usage },
  });
});

test("dry-run returns a plan without writing state and ignores milestones unless simulated", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-orchestrator-"));
  const statePath = path.join(directory, "state.json");
  await writeFile(statePath, '{"sentinel":true}\n');
  const input = await load("linear.json");
  const before = await readFile(statePath, "utf8");

  const result = await runOrchestration({
    ...input,
    options: { ...runOptions, dryRun: true, statePath },
    milestone: { issue: 101, type: "merged" },
  });

  assert.equal(result.dryRun, true);
  assert.equal(await readFile(statePath, "utf8"), before);
  assert.deepEqual(
    result.plan.runnable.map(({ number }) => number),
    [101],
  );
  assert.deepEqual(
    result.workerRoutes.map(({ agent }) => agent),
    ["Claude"],
  );

  const simulated = await runOrchestration({
    ...input,
    options: { ...runOptions, dryRun: true, simulateMilestone: true, statePath },
    milestone: { issue: 101, type: "merged" },
  });
  assert.equal(await readFile(statePath, "utf8"), before);
  assert.deepEqual(simulated.state.completed, [101]);
  assert.deepEqual(
    simulated.plan.runnable.map(({ number }) => number),
    [102],
  );
});

test("execute mode persists milestone state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-orchestrator-"));
  const statePath = path.join(directory, "state.json");
  const input = await load("linear.json");
  await runOrchestration({
    ...input,
    options: { ...runOptions, dryRun: false, statePath },
    milestone: { issue: 101, type: "merged" },
  });
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state.completed, [101]);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

test("concurrent milestone transactions preserve both events and usage records", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-orchestrator-concurrent-"));
  const statePath = path.join(directory, "state.json");
  const input = await load("linear.json");
  const secondUsage = { ...usage, inputTokens: 99 };
  await Promise.all([
    runOrchestration({
      ...input,
      options: { ...runOptions, dryRun: false, statePath },
      milestone: { issue: 101, type: "merged", usage },
    }),
    runOrchestration({
      ...input,
      options: { ...runOptions, dryRun: false, statePath },
      milestone: { issue: 102, type: "merged", usage: secondUsage },
    }),
  ]);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  assert.deepEqual(state.completed, [101, 102]);
  assert.deepEqual(
    [...state.milestones].sort((left, right) => left.issue - right.issue),
    [
      { issue: 101, type: "merged" },
      { issue: 102, type: "merged" },
    ],
  );
  assert.deepEqual(state.usage, { 101: usage, 102: secondUsage });
});

test("reclaims a stale state lock left by a crashed process", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-orchestrator-stale-lock-"));
  const statePath = path.join(directory, "state.json");
  const lockPath = `${statePath}.lock`;
  await mkdir(lockPath);
  const stale = new Date(Date.now() - 60_000);
  await utimes(lockPath, stale, stale);
  const input = await load("linear.json");
  const result = await runOrchestration({
    ...input,
    options: { ...runOptions, dryRun: false, statePath },
    milestone: { issue: 101, type: "merged", usage },
  });
  assert.deepEqual(result.state.completed, [101]);
});

test("requires maxParallel to be a positive integer and limits the runnable group", async () => {
  const items = normalizeIssues((await load("branching.json")).items);
  for (const maxParallel of [undefined, 0, -1, 1.5])
    assert.throws(
      () => buildRunPlan(items, { ...runOptions, maxParallel, completed: [201] }),
      /invalid-max-parallel/,
    );
  assert.deepEqual(
    buildRunPlan(items, { ...runOptions, maxParallel: 1, completed: [201] }).runnable.map(
      ({ number }) => number,
    ),
    [203],
  );
});

test("requires a release policy and completes only its matching milestone", async () => {
  const items = normalizeIssues((await load("linear.json")).items);
  assert.throws(
    () => buildRunPlan(items, { ...runOptions, releasePolicy: undefined }),
    /invalid-release-policy/,
  );
  assert.throws(
    () => buildRunPlan(items, { ...runOptions, releasePolicy: "deployed" }),
    /invalid-release-policy/,
  );
  const issueNumbers = items.map(({ number }) => number);
  const afterPr = applyMilestone(
    {},
    { issue: 101, type: "pr-created" },
    { issueNumbers, releasePolicy: "merged" },
  );
  assert.deepEqual(afterPr.completed, []);
  const afterMerge = applyMilestone(
    afterPr,
    { issue: 101, type: "merged" },
    { issueNumbers, releasePolicy: "merged" },
  );
  assert.deepEqual(afterMerge.completed, [101]);
});

test("does not infer completion from status text", async () => {
  const raw = (await load("linear.json")).items;
  raw[0].status = "Done";
  const plan = buildRunPlan(normalizeIssues(raw), runOptions);
  assert.deepEqual(plan.runnable, []);
  assert.deepEqual(plan.skipped, [{ number: 101, reason: "status-not-runnable:Done" }]);
});

test("rejects milestones for unknown issues and types outside the allowlist", () => {
  const context = { issueNumbers: [101], releasePolicy: "merged" };
  assert.throws(
    () => applyMilestone({}, { issue: 999, type: "merged" }, context),
    /unknown-milestone-issue:999/,
  );
  assert.throws(
    () => applyMilestone({}, { issue: 101, type: "completed" }, context),
    /invalid-milestone-type:completed/,
  );
});

test("treats Start date as optional metadata and rejects impossible dates", async () => {
  const raw = (await load("linear.json")).items;
  raw[0].startDate = "2026-02-30";
  assert.throws(() => normalizeIssues(raw), /invalid-start-date:101/);
  const withoutDate = (await load("linear.json")).items;
  delete withoutDate[0].startDate;
  const items = normalizeIssues(withoutDate);
  assert.equal(buildRunPlan(items, runOptions).runnable[0].number, 101);
});

test("requires selectable, verifiable, bounded capability records for the parent", () => {
  const required = [{ agent: "Claude", model: "Fable", role: "parent" }];
  const capabilities = required.map((route) => ({
    ...route,
    selector: "runtime-specific",
    selectable: true,
    verifiable: true,
    timeoutMs: 60_000,
  }));
  assert.deepEqual(validateCapabilities(required, capabilities), capabilities);
  assert.throws(
    () => validateCapabilities(required, [{ ...capabilities[0], verifiable: false }]),
    /routing-unavailable:parent:Claude:Fable/,
  );
});

test("matches a display model name through an explicit requestedModel capability", () => {
  const required = [{ agent: "Grok", model: "Grok 4.5", role: "parent" }];
  const capabilities = [
    {
      agent: "Grok",
      requestedModel: "Grok 4.5",
      model: "grok-4.5",
      role: "parent",
      selector: "grok --model grok-4.5",
      selectable: true,
      verifiable: true,
      timeoutMs: 30_000,
    },
  ];
  assert.deepEqual(validateCapabilities(required, capabilities), capabilities);
});

test("does not treat a canonical model identifier as proof for a different request", () => {
  const required = [{ agent: "Grok", model: "Grok 4.5", role: "parent" }];
  assert.throws(
    () =>
      validateCapabilities(required, [
        {
          agent: "Grok",
          model: "grok-4.5",
          role: "parent",
          selector: "grok --model grok-4.5",
          selectable: true,
          verifiable: true,
          timeoutMs: 30_000,
        },
      ]),
    /routing-unavailable:parent:Grok:Grok 4\.5/,
  );
});

test("rejects requests matching neither the display name nor the canonical identifier", () => {
  const required = [{ agent: "Grok", model: "Grok 4.5", role: "parent" }];
  assert.throws(
    () =>
      validateCapabilities(required, [
        {
          agent: "Grok",
          requestedModel: "Other model",
          model: "grok-4.5",
          role: "parent",
          selector: "grok --model grok-4.5",
          selectable: true,
          verifiable: true,
          timeoutMs: 30_000,
        },
      ]),
    /routing-unavailable:parent:Grok:Grok 4\.5/,
  );
});

test("accepts the exact canonical ID or display name on the same verified capability", async () => {
  const capability = {
    agent: "Codex",
    model: "gpt-6.1-sol",
    requestedModel: "GPT-6.1-Sol",
    role: "parent",
    selector: "codex exec -m gpt-6.1-sol",
    selectable: true,
    verifiable: true,
    timeoutMs: 60_000,
  };
  const input = await load("linear.json");
  for (const model of ["gpt-6.1-sol", "GPT-6.1-Sol"]) {
    const result = await runOrchestration({
      ...input,
      options: {
        ...runOptions,
        dryRun: true,
        parent: { agent: "Codex", model },
        capabilities: [capability, workerRoute("Claude", "sonnet")],
      },
    });
    assert.deepEqual(result.plan.runnable.map(({ number }) => number), [101]);
    assert.deepEqual(validateCapabilities([{ agent: "Codex", model, role: "parent" }], [capability]), [capability]);
    assert.throws(
      () => validateCapabilities([{ agent: "Codex", model, role: "parent" }], [{ ...capability, verifiable: false }]),
      /routing-unavailable/,
    );
  }
  for (const model of ["gpt-6-sol", "GPT-6-Sol", "GPT-6.1-SOL"]) {
    assert.throws(
      () => validateCapabilities([{ agent: "Codex", model, role: "parent" }], [capability]),
      /routing-unavailable/,
    );
  }
});

test("requires a canonical model when requestedModel is supplied", () => {
  const required = [{ agent: "Grok", model: "Grok 4.5", role: "parent" }];
  assert.throws(
    () =>
      validateCapabilities(required, [
        {
          agent: "Grok",
          requestedModel: "Grok 4.5",
          role: "parent",
          selector: "grok --model grok-4.5",
          selectable: true,
          verifiable: true,
          timeoutMs: 30_000,
        },
      ]),
    /routing-unavailable:parent:Grok:Grok 4\.5/,
  );
});

test("builds the run-scoped worker route pool from capability records", () => {
  const routes = selectWorkerRoutes(runOptions.capabilities);
  assert.deepEqual(
    routes.map(({ agent, model }) => `${agent}:${model}`),
    ["Codex:gpt-5", "Claude:sonnet"],
  );
});

test("excludes every model of the parent agent from the worker route pool", () => {
  const capabilities = [
    workerRoute("Codex", "gpt-5"),
    workerRoute("Codex", "gpt-5-mini"),
    workerRoute("Claude", "sonnet"),
    workerRoute("agy", "gemini-2.5-pro"),
    workerRoute("Grok", "grok-4"),
  ];
  assert.deepEqual(
    selectWorkerRoutes(capabilities, { parentAgent: "Codex" }).map(({ agent, model }) => `${agent}:${model}`),
    ["Claude:sonnet", "Grok:grok-4"],
  );
});

test("parentAsWorker opts the parent agent back into the worker route pool (Issue #589)", () => {
  const capabilities = [workerRoute("Codex", "gpt-5"), workerRoute("Claude", "sonnet")];
  assert.deepEqual(
    selectWorkerRoutes(capabilities, { parentAgent: "Codex", parentAsWorker: true }).map(({ agent }) => agent),
    ["Codex", "Claude"],
  );
  // The parent is still validated, and run-scoped exclusions still win.
  assert.throws(() => selectWorkerRoutes(capabilities, { parentAgent: "agy", parentAsWorker: true }), /runtime-retired/);
  assert.deepEqual(
    selectWorkerRoutes(capabilities, { parentAgent: "Codex", parentAsWorker: true, unavailableAgents: ["Codex"] })
      .map(({ agent }) => agent),
    ["Claude"],
  );
});

test("does not treat retired agy as an eligible Gemini runtime alias", () => {
  const capabilities = [workerRoute("Gemini", "fixture"), workerRoute("Claude", "sonnet")];
  assert.throws(() => selectWorkerRoutes(capabilities, { parentAgent: "agy" }), /runtime-retired/);
  assert.throws(() => validateCapabilities(
    [{ agent: "agy", model: "fixture", role: "parent" }],
    [{ ...capabilities[0], role: "parent" }],
  ), /routing-unavailable/);
});

test("orchestration degrades to the remaining agents below maxParallel", async () => {
  const input = await load("branching.json");
  const result = await runOrchestration({
    ...input,
    options: { ...runOptions, dryRun: true, maxParallel: 4 },
  });
  assert.deepEqual(
    result.workerRoutes.map(({ agent }) => agent),
    ["Claude"],
  );
});

test("excludes run-scoped unavailable agents and models from the route pool", () => {
  const routes = selectWorkerRoutes(runOptions.capabilities, { unavailableAgents: ["codex"] });
  assert.deepEqual(
    routes.map(({ agent }) => agent),
    ["Claude"],
  );
  assert.deepEqual(
    selectWorkerRoutes(runOptions.capabilities, { unavailableModels: ["sonnet"] }).map(({ agent }) => agent),
    ["Codex"],
  );
  const requested = [
    {
      ...workerRoute("Grok", "grok-4.5"),
      requestedModel: "Grok 4.5",
    },
  ];
  assert.deepEqual(selectWorkerRoutes(requested, { unavailableModels: ["Grok 4.5"] }), []);
});

test("matches unavailable agent names case-insensitively outside the built-in vocabulary", () => {
  assert.deepEqual(selectWorkerRoutes([workerRoute("Qwen", "qwen-3")], { unavailableAgents: ["qwen"] }), []);
});

test("skips unverified routes and rejects malformed worker capability records", () => {
  const unverified = { ...workerRoute("Codex", "gpt-5"), verifiable: false };
  assert.deepEqual(selectWorkerRoutes([unverified]), []);
  assert.throws(
    () => selectWorkerRoutes([{ ...workerRoute("Codex", "gpt-5"), timeoutMs: 0 }]),
    /invalid-capability-record:Codex/,
  );
  assert.throws(
    () => selectWorkerRoutes([{ ...workerRoute("Codex", " ") }]),
    /invalid-capability-record:Codex/,
  );
  assert.throws(
    () => selectWorkerRoutes([{ ...workerRoute("Codex", "gpt-5"), selector: " " }]),
    /invalid-capability-record:Codex/,
  );
  assert.throws(
    () => selectWorkerRoutes([{ ...workerRoute("Codex", " gpt-5") }]),
    /invalid-capability-record:Codex/,
  );
  assert.throws(
    () => selectWorkerRoutes([{ ...workerRoute(" Codex ", "gpt-5") }]),
    /invalid-capability-record: Codex /,
  );
  assert.throws(
    () => selectWorkerRoutes([{ ...workerRoute("Codex", "gpt-5"), selectable: /** @type {boolean} */ (/** @type {unknown} */ ("false")) }]),
    /invalid-capability-record:Codex/,
  );
  assert.throws(
    () => selectWorkerRoutes([{ ...workerRoute("Codex", "gpt-5"), verifiable: /** @type {boolean} */ (/** @type {unknown} */ ("false")) }]),
    /invalid-capability-record:Codex/,
  );
});

test("stops with no-worker-route-available when issues are runnable without any route", async () => {
  const input = await load("linear.json");
  input.options = {
    ...runOptions,
    capabilities: runOptions.capabilities.filter((capability) => capability.role === "parent"),
  };
  await assert.rejects(runOrchestration(input), /no-worker-route-available/);
});

test("a run-scoped unavailable agent removes only that route, never a substitute", async () => {
  const input = await load("linear.json");
  const result = await runOrchestration({
    ...input,
    options: { ...runOptions, dryRun: true, unavailableAgents: ["Codex"] },
  });
  assert.deepEqual(
    result.workerRoutes.map(({ agent }) => agent),
    ["Claude"],
  );
  // The next run recomputes availability from fresh capability records.
  const recovered = await runOrchestration({ ...input, options: { ...runOptions, dryRun: true } });
  assert.deepEqual(
    recovered.workerRoutes.map(({ agent }) => agent),
    ["Claude"],
  );
});

test("persists a completing milestone even when routing then fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-orchestrator-capability-"));
  const statePath = path.join(directory, "state.json");
  const input = await load("linear.json");
  const parentOnly = runOptions.capabilities.filter((capability) => capability.role === "parent");
  await assert.rejects(
    runOrchestration({
      ...input,
      options: { ...runOptions, dryRun: false, statePath, capabilities: parentOnly },
      milestone: { issue: 101, type: "merged", usage },
    }),
    /no-worker-route-available/,
  );
  assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")).completed, [101]);
});

test("allows an empty worker route pool when nothing is runnable", async () => {
  const raw = (await load("linear.json")).items.map((item) => ({ ...item, status: "Done" }));
  const result = await runOrchestration({
    items: raw,
    options: {
      ...runOptions,
      dryRun: true,
      capabilities: runOptions.capabilities.filter((capability) => capability.role === "parent"),
    },
  });
  assert.deepEqual(result.plan.runnable, []);
  assert.deepEqual(result.workerRoutes, []);
});

test("CLI rejects unknown flags", async () => {
  const script = new URL("../../scripts/issue-orchestrator.mjs", import.meta.url);
  const fixture = new URL("./fixtures/issue-orchestrator/linear.json", import.meta.url);
  await assert.rejects(
    execFileAsync(process.execPath, [script.pathname, "--input", fixture.pathname, "--unknown"]),
    ({ stderr }) => stderr.includes("unknown-flag:--unknown"),
  );
});

test("CLI dry-run discovery does not write the capabilities cache file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-orchestrator-dry-cap-"));
  const inputPath = path.join(directory, "input.json");
  const capabilitiesOutput = path.join(directory, "capabilities.json");
  const fixture = await load("linear.json");
  // No pre-baked capabilities: forces the discovery path.
  await writeFile(
    inputPath,
    JSON.stringify({
      ...fixture,
      options: {
        maxParallel: 3,
        releasePolicy: "merged",
        parent: { agent: "Codex", model: "gpt-test" },
        dryRun: true,
      },
    }),
  );
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "git"), `#!${process.execPath}\nprocess.exit(0);\n`, "utf8");
  await chmod(path.join(bin, "git"), 0o755);

  const script = new URL("../../scripts/issue-orchestrator.mjs", import.meta.url);
  // Isolate PATH so discovery fails fast with cli-not-found (no real agent probes).
  const isolatedEnv = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}`,
  };
  try {
    await execFileAsync(
      process.execPath,
      [
        script.pathname,
        "--input",
        inputPath,
        "--issues",
        "101",
        "--dry-run",
        "--parent-agent",
        "Codex",
        "--parent-model",
        "gpt-test",
        "--capabilities-output",
        capabilitiesOutput,
      ],
      { timeout: 30_000, env: isolatedEnv },
    );
  } catch {
    // routing-unavailable / no-worker-route-available is fine for this assertion
  }
  await assert.rejects(() => stat(capabilitiesOutput), /ENOENT/);
});

test("CLI reuses a fresh capabilities cache instead of re-probing every adapter (Issue #434)", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-orchestrator-cache-reuse-"));
  const inputPath = path.join(directory, "input.json");
  const capabilitiesOutput = path.join(directory, "capabilities.json");
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const codexPath = path.join(bin, "codex");
  // If the orchestrator ever re-probed instead of reusing the cache, this
  // fake bin would fail every real check (exit 9) except --version, which
  // must keep matching the cached version so freshness passes trivially.
  await writeFile(
    codexPath,
    `#!${process.execPath}\nif (process.argv[2] === "--version") { process.stdout.write("codex-fake 1.0.0\\n"); process.exit(0); }\nprocess.exit(9);\n`,
    "utf8",
  );
  await chmod(codexPath, 0o755);
  await writeFile(path.join(bin, "git"), `#!${process.execPath}\nprocess.exit(0);\n`, "utf8");
  await chmod(path.join(bin, "git"), 0o755);

  const cachedRoute = {
    agent: "Codex",
    model: "gpt-cached",
    selector: `${codexPath} exec -m gpt-cached`,
    selectable: true,
    verifiable: true,
    timeoutMs: 3_600_000,
  };
  const cachedClaudeRoute = {
    agent: "Claude",
    model: "sonnet-cached",
    selector: "claude --model sonnet-cached",
    selectable: true,
    verifiable: true,
    timeoutMs: 3_600_000,
  };
  await writeFile(
    capabilitiesOutput,
    JSON.stringify({
      capabilities: [
        { ...cachedRoute, role: "worker" },
        { ...cachedRoute, role: "parent" },
        { ...cachedClaudeRoute, role: "worker" },
      ],
      diagnostics: [{ agent: "Codex", status: "ok", model: "gpt-cached" }],
      cli: { Codex: { path: codexPath, version: "codex-fake 1.0.0" } },
      probedAt: "2026-01-01T00:00:00.000Z",
      probeSchemaVersion: PROBE_SCHEMA_VERSION, runtimeFingerprint: loadRuntimeRegistry().fingerprint,
      repositoryCommit: await getRepositoryCommit(process.cwd()),
    }),
  );

  const fixture = await load("linear.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      ...fixture,
      options: {
        maxParallel: 3,
        releasePolicy: "merged",
        parent: { agent: "Codex", model: "gpt-cached" },
        dryRun: true,
      },
    }),
  );
  const script = new URL("../../scripts/issue-orchestrator.mjs", import.meta.url);
  const isolatedEnv = { ...process.env, PATH: bin };
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      script.pathname,
      "--input",
      inputPath,
      "--issues",
      "101",
      "--dry-run",
      "--parent-agent",
      "Codex",
      "--parent-model",
      "gpt-cached",
      "--capabilities-output",
      capabilitiesOutput,
    ],
    { timeout: 30_000, env: isolatedEnv },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.capabilityCacheStatus, "reused");
  assert.deepEqual(
    result.workerRoutes.map(({ agent, model }) => `${agent}:${model}`),
    ["Claude:sonnet-cached"],
  );
});

test("CLI preserves input-provided unavailable agents when YAML and flags omit them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-orchestrator-input-options-"));
  const inputPath = path.join(directory, "input.json");
  const fixture = await load("linear.json");
  await writeFile(
    inputPath,
    JSON.stringify({
      ...fixture,
      options: { ...runOptions, dryRun: true, unavailableAgents: ["Codex"] },
    }),
  );
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "git"), `#!${process.execPath}\nprocess.exit(0);\n`, "utf8");
  await chmod(path.join(bin, "git"), 0o755);

  const script = new URL("../../scripts/issue-orchestrator.mjs", import.meta.url);
  const isolatedEnv = { ...process.env, PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}` };

  const { stdout } = await execFileAsync(
    process.execPath,
    [script.pathname, "--input", inputPath, "--issues", "101"],
    { env: isolatedEnv },
  );

  assert.deepEqual(
    JSON.parse(stdout).workerRoutes.map(({ agent }) => agent),
    ["Claude"],
  );
});

test("loads and normalizes the orchestrator YAML config", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-orchestrator-config-"));
  const configPath = path.join(directory, "settings.yaml");
  await writeFile(
    configPath,
    "run:\n  maxParallel: 4\n  releasePolicy: merged\n  unavailableModels: none\n  unavailableAgents:\n    - Codex\n",
  );
  assert.equal(DEFAULT_CONFIG_PATH, "state/issue-orchestrator.yaml");
  assert.deepEqual(await loadOrchestratorConfig(configPath, { cwd: directory }), {
    maxParallel: 4,
    releasePolicy: "merged",
    unavailableModels: [],
    unavailableAgents: ["Codex"],
    parentAsWorker: "auto",
  });
  await writeFile(configPath, "run:\n  maxParallel: 1\n  releasePolicy: merged\n  unavailableModels: none\n  parentAsWorker: true\n");
  assert.equal((await loadOrchestratorConfig(configPath, { cwd: directory })).parentAsWorker, "always");
  await writeFile(configPath, "run:\n  maxParallel: 1\n  releasePolicy: merged\n  unavailableModels: none\n  parentAsWorker: yes please\n");
  await assert.rejects(loadOrchestratorConfig(configPath, { cwd: directory }), /config-invalid-parent-as-worker/);
});

test("rejects malformed and unsafe orchestrator YAML configs", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-orchestrator-config-invalid-"));
  const writeConfig = async (name, value) => {
    const file = path.join(directory, name);
    await writeFile(file, value);
    return file;
  };
  await assert.rejects(
    loadOrchestratorConfig(
      await writeConfig(
        "unknown.yaml",
        `run:\n  maxParallel: 1\n  releasePolicy: merged\n  unavailableModels: none\nextra: true\n`,
      ),
      { cwd: directory },
    ),
    /config-unknown-key:root\.extra/,
  );
  await assert.rejects(
    loadOrchestratorConfig(
      await writeConfig(
        "invalid.yaml",
        `run:\n  maxParallel: 0\n  releasePolicy: merged\n  unavailableModels: none\n`,
      ),
      { cwd: directory },
    ),
    /config-invalid-max-parallel/,
  );
  await assert.rejects(
    loadOrchestratorConfig(
      await writeConfig(
        "retired-board.yaml",
        "project: {}\nrun:\n  maxParallel: 1\n  releasePolicy: merged\n  unavailableModels: none\n",
      ),
      { cwd: directory },
    ),
    /config-unknown-key:root\.project/,
  );
});

test("merges explicit CLI values over YAML values", () => {
  assert.deepEqual(
    mergeOrchestratorConfig({
      defaults: { maxParallel: 1, unavailableModels: [], unavailableAgents: [] },
      yaml: {
        maxParallel: 4,
        releasePolicy: "merged",
        unavailableModels: ["Fable"],
        unavailableAgents: ["Claude"],
      },
      cli: { maxParallel: 2 },
    }),
    {
      maxParallel: 2,
      releasePolicy: "merged",
      unavailableModels: ["Fable"],
      unavailableAgents: ["Claude"],
      parentAsWorker: "auto",
    },
  );
});

test("selects Issues with AND across dimensions and OR within a dimension", () => {
  const items = [
    { number: 1, priority: "P1", iteration: "Sprint 1", size: "M", dependencies: [] },
    { number: 2, priority: "P1", iteration: "Sprint 2", size: "S", dependencies: [] },
    { number: 3, priority: "P2", iteration: "Sprint 1", size: "M", dependencies: [] },
  ];
  assert.deepEqual(
    selectIssues(items, { priority: ["P1"], size: ["M"] }).items.map(({ number }) => number),
    [1],
  );
  assert.deepEqual(
    selectIssues(items, { iteration: ["Sprint 1", "Sprint 2"] }).items.map(({ number }) => number),
    [1, 2, 3],
  );
});

test("adds recursive dependencies to selected Issues", () => {
  const items = [
    { number: 3, priority: "P1", iteration: "Sprint 1", size: "M", dependencies: [2] },
    { number: 2, priority: "P2", iteration: "Sprint 1", size: "S", dependencies: [1] },
    { number: 1, priority: "P2", iteration: "Sprint 1", size: "XS", dependencies: [] },
  ];
  assert.deepEqual(
    selectIssues(items, { issues: [3] }).items.map(({ number }) => number),
    [1, 2, 3],
  );
});

test("treats closed Blocked by Issues as completed and stops on open dependencies", () => {
  const items = [
    {
      number: 3,
      priority: "P1",
      iteration: "Sprint 1",
      size: "M",
      dependencies: [2],
      blockedBy: [{ number: 2, state: "CLOSED" }],
    },
    { number: 2, priority: "P2", iteration: "Sprint 1", size: "S", dependencies: [] },
  ];
  const selected = selectIssues(items, { issues: [3] });
  assert.deepEqual(
    selected.items.map(({ number }) => number),
    [3],
  );
  assert.deepEqual(selected.completed, [2]);
  assert.throws(
    () =>
      selectIssues([{ ...items[0], blockedBy: [{ number: 2, state: "OPEN" }] }, items[1]], {
        issues: [3],
      }),
    /dependency-open:3:2/,
  );
});

test("requires an Issue selector and rejects run-date filtering", () => {
  assert.throws(() => selectIssues([{ number: 1, dependencies: [] }], {}), /issue-filter-required/);
  assert.throws(() => parseCliArgs(["--run-date", "2026-07-16"]), /unknown-flag:--run-date/);
});

test("the create-issue agent prompt does not request abolished assignment metadata", async () => {
  const promptConfig = await readFile(
    new URL("../../skills/create-issue/agents/openai.yaml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(promptConfig, /primary|sub AI|AI Assignee|Model|Order/i);
  assert.match(promptConfig, /labels and native Issue dependencies/);
});

test("parses the documented operational Issue CLI flags", () => {
  assert.deepEqual(
    parseCliArgs([
      "--dry-run",
      "--simulate-milestone",
      "--max-parallel",
      "2",
      "--release-policy",
      "pr-created",
      "--unavailable-model",
      "Fable",
      "--unavailable-model",
      "sonnet",
      "--unavailable-agent",
      "Codex",
      "--refresh",
      "--invalidate-agent",
      "Grok",
      "--issues",
      "101,102",
      "--priority",
      "P1",
      "--iteration",
      "Sprint 1",
      "--size",
      "M",
      "--state-path",
      "/tmp/state.json",
      "--existing-worktree",
      "101",
      "--existing-worktree",
      "102",
      "--milestone-json",
      '{"issue":101,"type":"pr-created"}',
      "--parent-agent",
      "Codex",
      "--parent-model",
      "gpt-5",
      "--config",
      "state/custom.yaml",
    ]),
    {
          dryRun: true,
      simulateMilestone: true,
      maxParallel: 2,
      releasePolicy: "pr-created",
      unavailableModels: ["Fable", "sonnet"],
      unavailableAgents: ["Codex"],
      refresh: true,
      invalidateAgents: ["Grok"],
      statePath: "/tmp/state.json",
      existingWorktrees: [101, 102],
      milestoneJson: '{"issue":101,"type":"pr-created"}',
      parentAgent: "Codex",
      parentModel: "gpt-5",
      configPath: "state/custom.yaml",
      issues: ["101", "102"],
      priority: ["P1"],
      iteration: ["Sprint 1"],
      size: ["M"],
    },
  );
  assert.equal(parseCliArgs(["--parent-provider", "Claude"]).parentAgent, "Claude");
  assert.equal(parseCliArgs(["--parent-as-worker"]).parentAsWorker, "always");
  assert.throws(() => parseCliArgs(["--mystery"]), /unknown-flag:--mystery/);
});
