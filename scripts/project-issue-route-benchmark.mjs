#!/usr/bin/env node
/**
 * Route benchmark for RouteEvidence.
 *
 * Every exact model runs the same fictional tasks — ten per kind — in a throwaway
 * sandbox, and a fixed checker decides pass/fail. Only {kind, passed, durationMs}
 * leaves a task; prompts, CLI output and sandbox contents are never persisted.
 * Live runs require `--live` and use routes freshly verified by CLI discovery.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeRouteEvidence,
  normalizeTriageInput,
  triageContext,
  TASK_KINDS,
  TRIAGE_POLICY,
  TRIAGE_DEFAULTS,
} from "./project-issue-triage-contract.mjs";
import {
  runProcess,
  splitSelector,
  reportedModels,
  writeJsonAtomic,
} from "./project-issue-runtime-adapters/shared.mjs";

export const BENCHMARK_VERSION = "route-bench-1.1.0";
export const SAMPLES_PER_KIND = 10;
export const DEFAULT_EVIDENCE_OUTPUT = "state/route-evidence.json";
export const DEFAULT_TASK_TIMEOUT_MS = 600_000;
const CHECK_TIMEOUT_MS = 10_000;
// Mirrors each runtime adapter's headless probe arguments (runtime-adapters/*.mjs).
const HEADLESS_ARGS = { Codex: ["--skip-git-repo-check"], Claude: ["-p"], Grok: ["-p"], Gemini: [] };

/* ------------------------------------------------------------------ */
/* Fictional task set                                                  */
/* ------------------------------------------------------------------ */

const DOCS = [
  ["colour", "color"],
  ["recieve", "receive"],
  ["seperate", "separate"],
  ["occured", "occurred"],
  ["dependant", "dependent"],
  ["untill", "until"],
  ["wich", "which"],
  ["adress", "address"],
  ["accomodate", "accommodate"],
  ["definately", "definitely"],
];
const LOCAL_CODE = [
  [
    "clamp",
    "export const clamp = (v, lo, hi) => Math.min(lo, Math.max(hi, v));",
    "clamp(5, 0, 3) === 3 && clamp(-1, 0, 3) === 0 && clamp(2, 0, 3) === 2",
  ],
  [
    "sum",
    "export function sum(xs) { let t = 0; for (let i = 1; i < xs.length; i++) t += xs[i]; return t; }",
    "sum([1, 2, 3]) === 6 && sum([]) === 0",
  ],
  ["isEven", "export const isEven = (n) => n % 2 === 1;", "isEven(4) && !isEven(3) && isEven(0)"],
  [
    "capitalize",
    "export const capitalize = (s) => s.toLowerCase();",
    'capitalize("fixture") === "Fixture" && capitalize("") === ""',
  ],
  [
    "range",
    "export const range = (n) => Array.from({ length: n + 1 }, (_, i) => i);",
    "JSON.stringify(range(3)) === '[0,1,2]' && range(0).length === 0",
  ],
  [
    "unique",
    "export const unique = (xs) => [...new Set(xs)].sort();",
    "JSON.stringify(unique([3, 1, 3, 2])) === '[3,1,2]'",
  ],
  ["maxOf", "export const maxOf = (xs) => Math.max(...xs);", "maxOf([2, 9, 4]) === 9 && maxOf([]) === null"],
  [
    "reverseWords",
    'export const reverseWords = (s) => s.split("").reverse().join("");',
    'reverseWords("alpha beta gamma") === "gamma beta alpha"',
  ],
  [
    "countVowels",
    "export const countVowels = (s) => (s.match(/[aeio]/gi) ?? []).length;",
    'countVowels("Fixture unit") === 5',
  ],
  [
    "padLeft",
    "export const padLeft = (s, n) => s.padEnd(n);",
    'padLeft("7", 3) === "  7" && padLeft("1234", 2) === "1234"',
  ],
];
// Each instruction states every behavior its hidden check asserts, so the pass
// rate measures the fix rather than luck at guessing the check.
const LOCAL_CODE_SPECS = {
  clamp: "clamp(v, lo, hi) must return v limited to the inclusive range [lo, hi].",
  sum: "sum(xs) must return the sum of every number in xs, and 0 for an empty array.",
  isEven: "isEven(n) must return true for even integers, including 0, and false for odd ones.",
  capitalize:
    "capitalize(s) must upper-case the first character and keep the rest unchanged; an empty string stays empty.",
  range: "range(n) must return [0, 1, ..., n - 1]; range(0) returns an empty array.",
  unique: "unique(xs) must remove duplicates while keeping the order of first occurrence.",
  maxOf: "maxOf(xs) must return the largest number, or null for an empty array.",
  reverseWords: "reverseWords(s) must reverse the order of the space-separated words, not the characters.",
  countVowels: "countVowels(s) must count the vowels a, e, i, o and u in either case.",
  padLeft:
    "padLeft(s, n) must left-pad s with spaces to length n and return s unchanged when it is already at least n long.",
};
const CROSS = [
  ["timeoutMs", "requestTimeoutMs", 5000],
  ["retries", "maxRetries", 3],
  ["host", "serverHost", "fixture.invalid"],
  ["pageSize", "itemsPerPage", 25],
  ["theme", "colorTheme", "dark"],
  ["locale", "displayLocale", "ja-JP"],
  ["limit", "rowLimit", 100],
  ["mode", "runMode", "shadow"],
  ["interval", "pollIntervalMs", 1500],
  ["label", "displayLabel", "Fixture"],
];
const REDACT = ["password", "token", "cardNumber", "cvv", "apiKey"];
const CONTAIN = ["resolveInside", "safeJoin", "withinRoot", "openTarget", "mapUpload"];

const assertScript = (imports, condition) => `${imports}\nif (!(${condition})) process.exit(1);\n`;

/** Deterministic task list pinned by BENCHMARK_VERSION: ten tasks per kind. */
export function buildBenchmarkTasks() {
  const tasks = [];
  DOCS.forEach(([wrong, right], i) => {
    const line = (word) => `The fixture service will ${word} the request in step ${i + 1}.`;
    tasks.push({
      id: `docs-${i + 1}`,
      kind: "docs",
      files: { "README.md": `# Fixture ${i + 1}\n\n${line(wrong)}\nKeep this line unchanged.\n` },
      instruction: `In README.md, fix the misspelled word "${wrong}" so it reads "${right}". Change nothing else.`,
      check: {
        type: "file-equals",
        file: "README.md",
        content: `# Fixture ${i + 1}\n\n${line(right)}\nKeep this line unchanged.\n`,
      },
    });
  });
  LOCAL_CODE.forEach(([name, source, condition], i) => {
    tasks.push({
      id: `local-code-${i + 1}`,
      kind: "local-code",
      files: { "lib.mjs": `${source}\n` },
      instruction: `lib.mjs exports a buggy function \`${name}\`. Fix it: ${LOCAL_CODE_SPECS[name]} Keep the export name and signature.`,
      check: { type: "node-assert", script: assertScript(`import { ${name} } from "./lib.mjs";`, condition) },
    });
  });
  CROSS.forEach(([from, to, value], i) => {
    const literal = JSON.stringify(value);
    tasks.push({
      id: `cross-component-${i + 1}`,
      kind: "cross-component",
      files: {
        "config.mjs": `export const settings = { ${from}: ${literal} };\n`,
        "consumer.mjs": `import { settings } from "./config.mjs";\nexport const describe = () => \`${from}=\${settings.${from}}\`;\n`,
      },
      instruction: `Rename the setting \`${from}\` to \`${to}\` in config.mjs, and update consumer.mjs so describe() returns "${to}=<value>".`,
      check: {
        type: "node-assert",
        script: assertScript(
          'import { settings } from "./config.mjs";\nimport { describe } from "./consumer.mjs";',
          `settings.${to} === ${literal} && !("${from}" in settings) && describe() === ${JSON.stringify(`${to}=${value}`)}`,
        ),
      },
    });
  });
  REDACT.forEach((field, i) => {
    tasks.push({
      id: `security-${i + 1}`,
      kind: "security",
      files: { "logger.mjs": "export const formatEvent = (event) => JSON.stringify(event);\n" },
      instruction: `formatEvent in logger.mjs leaks the \`${field}\` field into logs. Replace that field's value with "[REDACTED]" in the output and keep every other field.`,
      check: {
        type: "node-assert",
        script: assertScript(
          'import { formatEvent } from "./logger.mjs";\nconst out = formatEvent({ user: "fixture-user", ' +
            field +
            ': "fixture-value" });',
          'typeof out === "string" && !out.includes("fixture-value") && out.includes("[REDACTED]") && out.includes("fixture-user")',
        ),
      },
    });
  });
  CONTAIN.forEach((name, i) => {
    tasks.push({
      id: `security-${REDACT.length + i + 1}`,
      kind: "security",
      files: {
        "files.mjs": `import path from "node:path";\nexport const ${name} = (base, name) => path.join(base, name);\n`,
      },
      instruction: `\`${name}\` in files.mjs must never return a path outside \`base\`. Throw an Error for any name that escapes it; keep returning the joined path otherwise.`,
      check: {
        type: "node-assert",
        script: assertScript(
          `import { ${name} } from "./files.mjs";\nconst escapes = (n) => { try { ${name}("/fixture-root", n); return false; } catch { return true; } };`,
          `${name}("/fixture-root", "a/b.txt") === "/fixture-root/a/b.txt" && escapes("../x") && escapes("a/../../x") && !escapes("a/../b")`,
        ),
      },
    });
  });
  return tasks;
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

/** Fixed checker; runs after the agent, so the agent never sees or edits it. */
export async function checkBenchmarkTask(dir, task, { run = runProcess } = {}) {
  if (task.check.type === "file-equals") {
    try {
      return (await fs.readFile(path.join(dir, task.check.file), "utf8")) === task.check.content;
    } catch {
      return false;
    }
  }
  const checkDir = await fs.mkdtemp(path.join(os.tmpdir(), "route-check-"));
  try {
    // Copy only the task's own files so stray agent output cannot shadow them.
    for (const name of Object.keys(task.files))
      await fs.copyFile(path.join(dir, name), path.join(checkDir, name));
    await fs.writeFile(path.join(checkDir, "check.mjs"), task.check.script);
    const result = await run(process.execPath, ["check.mjs"], {
      timeoutMs: CHECK_TIMEOUT_MS,
      cwd: checkDir,
      env: { PATH: process.env.PATH ?? "" },
    });
    return !result.timedOut && result.code === 0;
  } catch {
    return false;
  } finally {
    await fs.rm(checkDir, { recursive: true, force: true }).catch(() => {});
  }
}

const routeModel = (route) => route.requestedModel ?? route.model;

/**
 * Run one task on one verified route. Returns only closed fields; a CLI that
 * reports a different model than requested invalidates the whole route.
 */
export async function runBenchmarkTask(
  route,
  task,
  { run = runProcess, timeoutMs = DEFAULT_TASK_TIMEOUT_MS, env = process.env, clock = Date.now } = {},
) {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "route-bench-"));
  try {
    for (const [name, content] of Object.entries(task.files))
      await fs.writeFile(path.join(sandbox, name), content);
    const tokens = splitSelector(route.selector);
    const prompt = `${task.instruction}\nWork only on the files in the current directory. Do not ask questions. Do not explain your steps.`;
    const workerEnv = { ...env };
    delete workerEnv.TYPESAFE_API_KEY;
    const started = clock();
    const result = await run(tokens[0], [...tokens.slice(1), ...(HEADLESS_ARGS[route.agent] ?? []), prompt], {
      timeoutMs,
      env: workerEnv,
      cwd: sandbox,
    });
    const durationMs = Math.max(0, Math.round(clock() - started));
    if (reportedModels(result).some((model) => model !== route.model))
      return { kind: task.kind, modelMismatch: true };
    // A non-zero exit or timeout is a CLI/quota/session failure, not a wrong fix:
    // counting it as failed would rank the route low for reasons unrelated to quality.
    if (result.timedOut || result.code !== 0) return { kind: task.kind, infrastructureFailure: true };
    return { kind: task.kind, passed: await checkBenchmarkTask(sandbox, task, { run }), durationMs };
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

/** Aggregate closed task results into a validated RouteEvidence record. */
export function buildRouteEvidence(
  route,
  results,
  { profileVersion, evaluatedAt, benchmarkVersion = BENCHMARK_VERSION },
) {
  const tasks = TASK_KINDS.map((kind) => {
    const ofKind = results.filter((r) => r.kind === kind);
    if (!ofKind.length) return null;
    return {
      kind,
      samples: ofKind.length,
      passed: ofKind.filter((r) => r.passed === true).length,
      medianDurationMs: median(ofKind.map((r) => r.durationMs)),
    };
  }).filter(Boolean);
  return normalizeRouteEvidence({
    agent: route.agent,
    model: routeModel(route),
    profileVersion,
    benchmarkVersion,
    evaluatedAt,
    tasks,
  });
}

export async function benchmarkRoute(route, tasks, options = {}) {
  const results = [];
  for (const task of tasks) {
    const result = await runBenchmarkTask(route, task, options);
    // A substituted model makes every sample unattributable; publish nothing.
    if (result.modelMismatch) return { status: "model-mismatch" };
    // Likewise an interrupted route publishes nothing and must be rerun in full.
    if (result.infrastructureFailure) return { status: "incomplete" };
    results.push(result);
  }
  return { status: "measured", results };
}

/* ------------------------------------------------------------------ */
/* Comparison                                                          */
/* ------------------------------------------------------------------ */

/**
 * Deterministic reading of design §4's route rubric over the evidence the
 * triage child would actually receive (same 30-day, pool, sample and version
 * filters). Abstains on <2 comparable candidates or a tie.
 */
export function rankRouteEvidence(evidence, { routes, kinds, now = Date.now() }) {
  if (!kinds.length || !kinds.every((kind) => TASK_KINDS.includes(kind)))
    return { choice: "abstain", reason: "unknown-kind" };
  const input = normalizeTriageInput({
    issue: 1,
    issueUpdatedAt: "2026-01-01T00:00:00Z",
    routes,
    routeEvidence: evidence,
    policyVersion: TRIAGE_POLICY,
    model: TRIAGE_DEFAULTS.model,
  });
  const usable = triageContext(input, now).evidence;
  const scored = usable
    .map((record) => {
      const relevant = kinds.map((kind) => record.tasks.find((task) => task.kind === kind));
      if (relevant.some((task) => !task || task.samples < SAMPLES_PER_KIND)) return null;
      return {
        route: { agent: record.agent, model: record.model },
        passRate: relevant.reduce((s, t) => s + t.passed / t.samples, 0) / relevant.length,
        durationMs: relevant.reduce((s, t) => s + t.medianDurationMs, 0) / relevant.length,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.passRate - a.passRate || a.durationMs - b.durationMs);
  if (scored.length < 2)
    return { choice: "abstain", reason: "fewer-than-two-comparable", candidates: scored };
  const [first, second] = scored;
  if (first.passRate === second.passRate && first.durationMs === second.durationMs)
    return { choice: "abstain", reason: "tie", candidates: scored };
  return {
    choice: first.route,
    reason: first.passRate > second.passRate ? "pass-rate" : "duration",
    candidates: scored,
  };
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

export function parseBenchmarkArgs(argv) {
  const options = {
    live: false,
    output: DEFAULT_EVIDENCE_OUTPUT,
    only: [],
    models: [],
    timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`route-benchmark-missing-value:${arg}`);
      return next;
    };
    if (arg === "--live") options.live = true;
    else if (arg === "--output") options.output = value();
    else if (arg === "--only") options.only.push(...value().split(","));
    else if (arg === "--model") options.models.push(value());
    else if (arg === "--parent-agent") options.parentAgent = value();
    else if (arg === "--timeout-ms") options.timeoutMs = Number(value());
    else throw new Error(`route-benchmark-unknown-argument:${arg}`);
  }
  if (!options.live) throw new Error("route-benchmark-requires-live");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    throw new Error("route-benchmark-invalid-timeout");
  return options;
}

async function main(argv) {
  const options = parseBenchmarkArgs(argv);
  // Imported lazily so offline tests of this module never load discovery.
  const { refreshWorkerRoutes } = await import("./project-issue-capabilities.mjs");
  const discovery = await refreshWorkerRoutes({
    ...(options.only.length ? { only: options.only } : {}),
    ...(options.parentAgent ? { parentAgent: options.parentAgent } : {}),
  });
  const routes = discovery.workerRoutes.filter(
    (route) => !options.models.length || options.models.includes(routeModel(route)),
  );
  if (!routes.length) throw new Error("route-benchmark-no-verified-route");
  const tasks = buildBenchmarkTasks();
  const evidence = [];
  const outcomes = [];
  for (const route of routes) {
    const evaluatedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const measured = await benchmarkRoute(route, tasks, { timeoutMs: options.timeoutMs });
    outcomes.push({ agent: route.agent, model: routeModel(route), status: measured.status });
    if (measured.status !== "measured") continue;
    const version =
      discovery.cli?.[route.agent]?.version ?? discovery.cli?.[route.agent.toLowerCase()]?.version;
    const profileVersion = /^[\w .()+-]{1,100}$/.test(version ?? "") ? version : "unknown";
    evidence.push(buildRouteEvidence(route, measured.results, { profileVersion, evaluatedAt }));
  }
  await writeJsonAtomic(options.output, evidence);
  process.stdout.write(
    `${JSON.stringify({ benchmarkVersion: BENCHMARK_VERSION, output: options.output, outcomes, evidence }, null, 2)}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    const code = /^route-benchmark-[\w:-]+$/.test(error?.message ?? "")
      ? error.message
      : "route-benchmark-failed";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  });
}
