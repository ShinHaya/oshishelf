import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  validateEvalDataset,
  runTriageEvaluation,
  computeTriageMetrics,
  assessAssistedGate,
  formatTriageReport,
  compareShadowRuns,
  createFakeTransport,
  keywordBaselineAnswers,
  parseEvalArgs,
  DEFAULT_DATASET,
  REQUIRED_TAGS,
  LANGUAGES,
} from "../../scripts/project-issue-triage-eval.mjs";
import {
  buildBenchmarkTasks,
  checkBenchmarkTask,
  runBenchmarkTask,
  benchmarkRoute,
  buildRouteEvidence,
  rankRouteEvidence,
  parseBenchmarkArgs,
  BENCHMARK_VERSION,
} from "../../scripts/project-issue-route-benchmark.mjs";
import { RISKS, SIZES, normalizeRouteEvidence } from "../../scripts/project-issue-triage-contract.mjs";

const execFileAsync = promisify(execFile);
const NOW = Date.parse("2026-10-09T00:00:00Z");
const rawDataset = JSON.parse(await fs.readFile(DEFAULT_DATASET, "utf8"));
const dataset = validateEvalDataset(rawDataset);
const clone = () => structuredClone(rawDataset);

function choice(options, selected, p) {
  const rest = (1 - p) / (options.length - 1);
  return {
    type: "choice",
    choice: selected,
    probabilities: Object.fromEntries(options.map((o) => [o, o === selected ? p : rest])),
    confidence: p,
  };
}
/** Answers with the human label, located by the title the request carries. */
function oracleTransport(p = 0.9) {
  const byTitle = new Map(dataset.cases.map((c) => [c.title, c.label]));
  return createFakeTransport((text) => {
    const labelled = byTitle.get(text.split("\n")[0]);
    return { risk: choice(RISKS, labelled.risk, p), size: choice(SIZES, labelled.size, p) };
  });
}
const evaluate = (transport, options = {}) =>
  runTriageEvaluation(dataset, {
    transport,
    transportKind: "test-fake",
    now: NOW,
    clock: () => 0,
    ...options,
  });

test("dataset meets the design §9 size, split and coverage floors", () => {
  const { summary } = dataset;
  assert.ok(summary.total >= 100);
  assert.ok(summary.highCritical >= 30);
  assert.ok(summary.splits.holdout.highCriticalClassifiable >= 30);
  for (const split of ["tune", "holdout"]) {
    for (const language of LANGUAGES) assert.ok(summary.splits[split].languages[language] > 0);
    for (const tag of REQUIRED_TAGS) assert.ok(summary.splits[split].tags[tag] > 0, `${split}:${tag}`);
  }
  const tuneTitles = new Set(dataset.cases.filter((c) => c.split === "tune").map((c) => c.title));
  assert.ok(dataset.cases.filter((c) => c.split === "holdout").every((c) => !tuneTitles.has(c.title)));
  assert.equal(dataset.labeling.status, "agent-proposed");
});

test("dataset validation rejects unknown fields, duplicates, stray secrets and thin holdouts", () => {
  const extra = clone();
  extra.cases[0].rationale = "free text";
  assert.throws(() => validateEvalDataset(extra), /triage-eval-invalid:case/);
  const duplicate = clone();
  duplicate.cases[1].id = duplicate.cases[0].id;
  assert.throws(() => validateEvalDataset(duplicate), /triage-eval-invalid:id/);
  const stray = clone();
  stray.cases[0].body += "\nContact: someone.fake@example.com";
  assert.throws(() => validateEvalDataset(stray), /tripwire/);
  const thin = clone();
  thin.cases = thin.cases.filter(
    (c) => c.split !== "holdout" || !["high", "critical"].includes(c.label.risk) || c.id < "H040",
  );
  assert.throws(() => validateEvalDataset(thin), /triage-eval-invalid:(holdout-high-critical|too-few)/);
  const unconfirmed = clone();
  unconfirmed.labeling = { status: "human-confirmed", confirmedBy: "Product Owner", confirmedAt: null };
  assert.throws(() => validateEvalDataset(unconfirmed), /labeling/);
});

test("an evaluation cannot claim a rubric different from the deployed classifier", () => {
  const stale = clone();
  stale.rubricVersion = "triage-rubric-524-v1";
  assert.throws(() => validateEvalDataset(stale), /triage-eval-invalid:rubric-version/);
  const oldPolicy = clone();
  oldPolicy.policyVersion = "triage-v1";
  assert.throws(() => validateEvalDataset(oldPolicy), /triage-eval-invalid:policy/);
});

test("the keyword baseline run is reproducible and keeps Issue text out of every output", async () => {
  const transport = createFakeTransport(keywordBaselineAnswers);
  const first = await evaluate(transport, { transportKind: "keyword-baseline" });
  const second = await evaluate(transport, { transportKind: "keyword-baseline" });
  assert.deepEqual(first, second);
  const metrics = computeTriageMetrics(first);
  const output =
    JSON.stringify({ first, metrics }) +
    formatTriageReport(first, metrics, assessAssistedGate(first, metrics));
  for (const item of dataset.cases.filter((c) => c.split === "holdout")) {
    assert.ok(!output.includes(item.title), item.id);
    assert.ok(!output.includes(item.body.slice(0, 24)), item.id);
  }
  assert.equal(metrics.boundary.recordsWithinAllowlist, true);
  assert.equal(metrics.boundary.constraintViolations, 0);
  assert.equal(metrics.sensitive.leaked, 0);
  assert.equal(metrics.sensitive.blockedBeforeSend, metrics.sensitive.expected);
  assert.equal(metrics.cost.requests, metrics.classifiable);
  assert.equal(metrics.cost.price, "unavailable");
});

test("a label-matching transport scores perfectly and has no direct-review misses", async () => {
  const run = await evaluate(oracleTransport());
  const metrics = computeTriageMetrics(run);
  assert.equal(metrics.risk.accuracy, 1);
  assert.equal(metrics.size.accuracy, 1);
  assert.equal(metrics.overrideRate, 0);
  assert.equal(metrics.highCritical.directReviewMisses.length, 0);
  assert.equal(metrics.highCritical.usable, metrics.highCritical.labeled);
  // Brier for p=0.9 on the right class: 0.1^2 + (k-1) * ((0.1/(k-1))^2)
  assert.ok(Math.abs(metrics.risk.brier - (0.01 + 3 * (0.1 / 3) ** 2)) < 1e-9);
  assert.equal(metrics.risk.reliability.at(-1).count, metrics.outcomes.recommended);
});

test("a confident under-classifier is reported as direct-review misses", async () => {
  const run = await evaluate(
    createFakeTransport(() => ({ risk: choice(RISKS, "low", 0.9), size: choice(SIZES, "S", 0.9) })),
  );
  const metrics = computeTriageMetrics(run);
  assert.equal(metrics.highCritical.directReviewMisses.length, metrics.highCritical.labeled);
  assert.equal(metrics.highCritical.missRate, 1);
  assert.equal(
    metrics.risk.confusion.critical.low,
    run.records.filter((r) => r.label.risk === "critical" && r.status === "recommended").length,
  );
  assert.ok(metrics.overrideCauses.riskUnder > 0);
});

test("uncertain answers count as abstentions, not adoptable misses", async () => {
  const run = await evaluate(
    createFakeTransport(() => ({ risk: choice(RISKS, "low", 0.4), size: choice(SIZES, "S", 0.4) })),
  );
  const metrics = computeTriageMetrics(run);
  assert.equal(metrics.outcomes.usable, 0);
  assert.equal(metrics.abstainRate, 1);
  assert.equal(metrics.highCritical.directReviewMisses.length, 0);
  assert.equal(metrics.highCritical.unresolved, metrics.highCritical.labeled);
});

test("throttling stops every later request, and a short budget refuses to start", async () => {
  let calls = 0;
  const run = await evaluate(async () => {
    calls += 1;
    return new Response("", { status: 429 });
  });
  assert.equal(calls, 1);
  assert.equal(run.complete, false);
  assert.equal(
    assessAssistedGate(run, computeTriageMetrics(run)).conditions.find((c) => c.id === "complete-run").status,
    "not-met",
  );
  const reasons = new Set(run.records.filter((r) => r.expectedOutcome === "classify").map((r) => r.reason));
  assert.deepEqual([...reasons].sort(), ["provider-unavailable", "rate-limited"]);
  await assert.rejects(
    evaluate(
      async () => {
        calls += 1;
        return new Response("{}");
      },
      { maxRequests: 5 },
    ),
    /max-requests-below-split/,
  );
  assert.equal(calls, 1);
});

test("the assisted gate never reports met by itself and marks stand-ins unmeasured", async () => {
  const run = await evaluate(oracleTransport());
  const metrics = computeTriageMetrics(run);
  const offline = assessAssistedGate(run, metrics);
  assert.equal(offline.overall, "not-met");
  assert.equal(offline.conditions.find((c) => c.id === "live-jev-measurement").status, "not-met");
  assert.equal(offline.conditions.find((c) => c.id === "zero-direct-review-misses").status, "unmeasured");
  const live = assessAssistedGate(
    { ...run, transportKind: "jev-live", labeling: { status: "human-confirmed" } },
    metrics,
  );
  assert.equal(live.overall, "pending");
  assert.deepEqual(
    live.conditions.filter((c) => c.status !== "met").map((c) => c.id),
    ["override-causes-reviewed", "product-owner-decision"],
  );
  const missed = assessAssistedGate(
    { ...run, transportKind: "jev-live" },
    { ...metrics, highCritical: { ...metrics.highCritical, directReviewMisses: ["H001"] } },
  );
  assert.equal(missed.overall, "not-met");
});

test("an older model, policy, rubric or prompt fingerprint cannot authorize the current classifier", async () => {
  const run = await evaluate(oracleTransport());
  const live = { ...run, transportKind: "jev-live", labeling: { status: "human-confirmed" } };
  const metrics = computeTriageMetrics(run);
  for (const change of [
    { model: "jev-1.12.0" }, { policyVersion: "triage-v1" },
    { rubricVersion: "triage-rubric-524-v1" }, { classifierFingerprint: "0".repeat(64) },
  ]) {
    const gate = assessAssistedGate({ ...live, ...change }, metrics);
    assert.equal(gate.overall, "not-met");
    assert.equal(gate.conditions.find((c) => c.id === "current-classifier").status, "not-met");
  }
});

test("shadow comparison stratifies outcomes by recommendation agreement and flags small samples", () => {
  const routeMap = {
    r0: { agent: "Codex", model: "fixture-a" },
    r1: { agent: "Claude", model: "fixture-b" },
  };
  const recommended = (pick) => ({ status: "recommended", route: { choice: pick }, routeMap });
  const shadowRun = {
    body: "must be ignored",
    assignments: [
      { number: 1, agent: "Codex", model: "fixture-a" },
      { number: 2, agent: "Claude", model: "fixture-b" },
      { number: 3, agent: "Codex", model: "fixture-a" },
      { number: 4, agent: "Codex", model: "fixture-a" },
    ],
    completed: [1, 3],
    roles: [
      { issue: 1, reviewPasses: 2 },
      { issue: 2, reviewPasses: 1 },
    ],
    usage: {
      issues: [
        { number: 1, usage: { inputTokens: 10, outputTokens: 5, wallClockMs: 100 } },
        { number: 2, usage: "unavailable" },
      ],
    },
    shadowTriage: [
      { issue: 1, result: recommended("r0"), assignedRoute: { agent: "Codex", model: "fixture-a" } },
      { issue: 2, result: recommended("r0"), assignedRoute: { agent: "Claude", model: "fixture-b" } },
      { issue: 3, result: recommended("abstain") },
      { issue: 4, result: { status: "fallback", reason: "timeout" } },
    ],
  };
  const manualRun = { assignments: [{ number: 5 }], completed: [5], roles: [], usage: { issues: [] } };
  const report = compareShadowRuns([shadowRun, manualRun]);
  const { agree, disagree, abstain, fallback, unrecorded } = report.byAgreement;
  assert.deepEqual(
    [agree.issues, disagree.issues, abstain.issues, fallback.issues, unrecorded.issues],
    [1, 1, 1, 1, 0],
  );
  assert.equal(agree.completionRate, 1);
  assert.equal(agree.reviewFixRate, 1);
  assert.equal(agree.medianWallClockMs, 100);
  assert.equal(agree.exactTokens, 15);
  assert.equal(disagree.completionRate, 0);
  assert.equal(disagree.reviewFixRate, 0);
  assert.equal(disagree.exactTokens, "unavailable");
  assert.equal(abstain.completionRate, 1);
  assert.equal(fallback.completionRate, 0);
  assert.equal(agree.sample, "insufficient-sample");
  assert.equal(report.context.shadow.completionRate, 0.5);
  assert.equal(report.context.off.completionRate, 1);
  assert.match(report.context.note, /confounded/);
  assert.ok(!JSON.stringify(report).includes("must be ignored"));
});

test("CLI parsing keeps live evaluation and live benchmarks behind explicit opt-in", () => {
  assert.throws(() => parseEvalArgs(["--transport", "live"]), /live-requires-max-requests/);
  assert.equal(parseEvalArgs(["--transport", "live", "--max-requests", "90"]).maxRequests, 90);
  assert.throws(() => parseEvalArgs(["--split", "everything"]), /invalid-split/);
  assert.throws(() => parseBenchmarkArgs([]), /route-benchmark-requires-live/);
  assert.equal(parseBenchmarkArgs(["--live", "--only", "Claude,Codex"]).only.length, 2);
});

test("the baseline CLI runs offline and prints no Issue text", async () => {
  const script = path.resolve("scripts/project-issue-triage-eval.mjs");
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  const { stdout } = await execFileAsync(process.execPath, [script, "--now", "2026-10-09T00:00:00Z"], {
    env,
  });
  assert.match(stdout, /keyword-baseline/);
  assert.match(stdout, /Jev quality is unmeasured/);
  assert.ok(!stdout.includes(dataset.cases.find((c) => c.split === "holdout").title));
  await assert.rejects(
    execFileAsync(process.execPath, [script, "--transport", "live", "--max-requests", "200"], { env }),
    (error) => /triage-eval-missing-key/.test(error.stderr),
  );
});

/* ------------------------------------------------------------------ */
/* Route benchmark                                                     */
/* ------------------------------------------------------------------ */

const LOCAL_FIXES = {
  clamp: "export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));",
  sum: "export function sum(xs) { let t = 0; for (let i = 0; i < xs.length; i++) t += xs[i]; return t; }",
  isEven: "export const isEven = (n) => n % 2 === 0;",
  capitalize: "export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);",
  range: "export const range = (n) => Array.from({ length: n }, (_, i) => i);",
  unique: "export const unique = (xs) => [...new Set(xs)];",
  maxOf: "export const maxOf = (xs) => (xs.length ? Math.max(...xs) : null);",
  reverseWords: 'export const reverseWords = (s) => s.split(" ").reverse().join(" ");',
  countVowels: "export const countVowels = (s) => (s.match(/[aeiou]/gi) ?? []).length;",
  padLeft: "export const padLeft = (s, n) => s.padStart(n);",
};
/** A reference agent: the minimal correct edit for each fictional task. */
function referenceFix(task) {
  if (task.kind === "docs") return { [task.check.file]: task.check.content };
  if (task.kind === "local-code") return { "lib.mjs": LOCAL_FIXES[task.instruction.match(/`(\w+)`/)[1]] };
  if (task.kind === "cross-component") {
    const [, from, to] = task.instruction.match(/`(\w+)` to `(\w+)`/);
    return {
      "config.mjs": task.files["config.mjs"].replace(from, to),
      "consumer.mjs": `import { settings } from "./config.mjs";\nexport const describe = () => \`${to}=\${settings.${to}}\`;\n`,
    };
  }
  if (task.files["logger.mjs"]) {
    const field = task.instruction.match(/`(\w+)`/)[1];
    return {
      "logger.mjs": `export const formatEvent = (event) => JSON.stringify({ ...event, ...("${field}" in event ? { ${field}: "[REDACTED]" } : {}) });\n`,
    };
  }
  const name = task.instruction.match(/`(\w+)`/)[1];
  return {
    "files.mjs": `import path from "node:path";\nexport const ${name} = (base, name) => { const p = path.join(base, name); const rel = path.relative(base, p); if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("escape"); return p; };\n`,
  };
}
async function materialize(task, files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "route-bench-test-"));
  for (const [name, content] of Object.entries({ ...task.files, ...files }))
    await fs.writeFile(path.join(dir, name), content);
  return dir;
}

test("the benchmark has ten unique tasks per kind whose checkers separate fixed from unfixed", async () => {
  const tasks = buildBenchmarkTasks();
  assert.equal(new Set(tasks.map((t) => t.id)).size, tasks.length);
  for (const kind of ["docs", "local-code", "cross-component", "security"])
    assert.equal(tasks.filter((t) => t.kind === kind).length, 10);
  assert.deepEqual(buildBenchmarkTasks(), tasks);
  for (const task of tasks) {
    const unfixed = await materialize(task, {});
    const fixed = await materialize(task, referenceFix(task));
    try {
      assert.equal(await checkBenchmarkTask(unfixed, task), false, `${task.id} unfixed`);
      assert.equal(await checkBenchmarkTask(fixed, task), true, `${task.id} fixed`);
    } finally {
      await fs.rm(unfixed, { recursive: true, force: true });
      await fs.rm(fixed, { recursive: true, force: true });
    }
  }
});

const route = { agent: "Claude", model: "fixture-model", selector: "fixture-cli --model fixture-model" };
/** Fake CLI: applies the reference fix in its cwd, like an agent would. */
function fakeCli({ fix = true, stdout = "", seen = [], code = 0, timedOut = false } = {}) {
  return async (command, args, options) => {
    if (command === process.execPath) {
      const { runProcess } = await import("../../scripts/project-issue-runtime-adapters/shared.mjs");
      return runProcess(command, args, options);
    }
    seen.push({ command, args, env: options.env });
    const task = buildBenchmarkTasks().find((t) => args.at(-1).startsWith(t.instruction));
    if (fix)
      for (const [name, content] of Object.entries(referenceFix(task)))
        await fs.writeFile(path.join(options.cwd, name), content);
    return { code, timedOut, stdout, stderr: "" };
  };
}

test("a benchmark task returns closed fields only and strips the Jev key from the worker", async () => {
  const seen = [];
  let tick = 0;
  const task = buildBenchmarkTasks()[0];
  const result = await runBenchmarkTask(route, task, {
    run: fakeCli({ seen }),
    env: { PATH: process.env.PATH, TYPESAFE_API_KEY: "fake-key" },
    clock: () => (tick += 250),
  });
  assert.deepEqual(result, { kind: "docs", passed: true, durationMs: 250 });
  assert.equal(seen[0].command, "fixture-cli");
  assert.deepEqual(seen[0].args.slice(0, 3), ["--model", "fixture-model", "-p"]);
  assert.equal(seen[0].env.TYPESAFE_API_KEY, undefined);
  const failed = await runBenchmarkTask(route, task, { run: fakeCli({ fix: false }) });
  assert.equal(failed.passed, false);
});

test("a substituted model invalidates the whole route", async () => {
  const outcome = await benchmarkRoute(route, buildBenchmarkTasks().slice(0, 3), {
    run: fakeCli({ stdout: '{"model":"other-model"}\n' }),
  });
  assert.deepEqual(outcome, { status: "model-mismatch" });
});

test("CLI failures and timeouts abort the route instead of counting as failed tasks", async () => {
  const tasks = buildBenchmarkTasks().slice(0, 3);
  assert.deepEqual(await benchmarkRoute(route, tasks, { run: fakeCli({ code: 1 }) }), {
    status: "incomplete",
  });
  assert.deepEqual(await benchmarkRoute(route, tasks, { run: fakeCli({ timedOut: true }) }), {
    status: "incomplete",
  });
});

test("local-code instructions state the behaviors their hidden checks assert", () => {
  const byId = Object.fromEntries(buildBenchmarkTasks().map((t) => [t.id, t.instruction]));
  assert.match(byId["local-code-6"], /order of first occurrence/);
  assert.match(byId["local-code-7"], /null for an empty array/);
  assert.match(byId["local-code-10"], /unchanged when it is already at least n long/);
});

test("RouteEvidence aggregates per kind and validates against the triage contract", () => {
  const results = buildBenchmarkTasks().map((task, i) => ({
    kind: task.kind,
    passed: i % 3 !== 0,
    durationMs: 1000 + i,
  }));
  const evidence = buildRouteEvidence(route, results, {
    profileVersion: "1.0.0 (fixture)",
    evaluatedAt: "2026-10-01T00:00:00Z",
  });
  assert.equal(evidence.benchmarkVersion, BENCHMARK_VERSION);
  assert.deepEqual(
    evidence.tasks.map((t) => t.samples),
    [10, 10, 10, 10],
  );
  assert.deepEqual(normalizeRouteEvidence(evidence), evidence);
  assert.deepEqual(Object.keys(evidence).sort(), [
    "agent",
    "benchmarkVersion",
    "evaluatedAt",
    "model",
    "profileVersion",
    "tasks",
  ]);
  assert.throws(() => normalizeRouteEvidence({ ...evidence, prompt: "raw" }), /triage-invalid-structure/);
});

test("route ranking follows the rubric and abstains on stale, mixed, tied or thin evidence", () => {
  const routes = [
    { agent: "Codex", model: "fixture-a" },
    { agent: "Claude", model: "fixture-b" },
  ];
  const record = (r, passed, ms, extra = {}) => ({
    ...r,
    profileVersion: "1",
    benchmarkVersion: BENCHMARK_VERSION,
    evaluatedAt: "2026-10-01T00:00:00Z",
    tasks: ["docs", "local-code", "cross-component", "security"].map((kind) => ({
      kind,
      samples: 10,
      passed,
      medianDurationMs: ms,
    })),
    ...extra,
  });
  const rank = (evidence, kinds = ["security"]) => rankRouteEvidence(evidence, { routes, kinds, now: NOW });
  assert.deepEqual(rank([record(routes[0], 9, 900), record(routes[1], 7, 100)]).choice, routes[0]);
  assert.equal(rank([record(routes[0], 8, 900), record(routes[1], 8, 100)]).reason, "duration");
  assert.equal(rank([record(routes[0], 8, 100), record(routes[1], 8, 100)]).choice, "abstain");
  assert.equal(rank([record(routes[0], 9, 100)]).choice, "abstain");
  assert.equal(
    rank([record(routes[0], 9, 100, { evaluatedAt: "2026-08-01T00:00:00Z" }), record(routes[1], 7, 100)])
      .choice,
    "abstain",
  );
  assert.equal(
    rank([record(routes[0], 9, 100, { benchmarkVersion: "route-bench-0.9.0" }), record(routes[1], 7, 100)])
      .choice,
    "abstain",
  );
  assert.equal(
    rank([record({ agent: "Codex", model: "not-in-pool" }, 10, 100), record(routes[1], 7, 100)]).choice,
    "abstain",
  );
  assert.equal(rank([record(routes[0], 9, 100), record(routes[1], 7, 100)], ["unknown"]).choice, "abstain");
});
