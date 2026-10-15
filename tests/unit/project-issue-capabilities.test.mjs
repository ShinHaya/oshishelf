import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  discoverCapabilities,
  loadOrRefreshCapabilities,
} from "../../scripts/project-issue-capabilities.mjs";
import { dispatchWorker } from "../../scripts/project-issue-dispatch.mjs";
import {
  discoverAllCapabilities,
  RUNTIME_ADAPTERS,
} from "../../scripts/project-issue-runtime-adapters/index.mjs";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  REASON_CODES,
  runHeadlessExecProbe,
  splitSelector,
  writeJsonAtomic,
  getRepositoryCommit,
  PROBE_SCHEMA_VERSION,
} from "../../scripts/project-issue-runtime-adapters/shared.mjs";
import { selectWorkerRoutes } from "../../scripts/project-issue-orchestrator.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function makeFakeBin(directory, name, scriptBody) {
  const filePath = path.join(directory, name);
  // Absolute Node shebang so isolated PATH does not need `env node`.
  await writeFile(filePath, `#!${process.execPath}\n${scriptBody}\n`, "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

/**
 * PATH with only the fake bin plus the directory of the current Node binary
 * (for `#!/usr/bin/env node` shebangs). Real agent CLIs are never visible.
 */
function isolatedPath(directory) {
  return `${directory}${path.delimiter}${path.dirname(process.execPath)}`;
}

test("runtime adapters evaluate in fixed Codex → Claude → Grok → Gemini order", () => {
  assert.deepEqual(
    RUNTIME_ADAPTERS.map((adapter) => adapter.agent),
    ["Codex", "Claude", "Grok", "Gemini"],
  );
});

test("discovers only verified routes and keeps partial failures isolated", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-partial-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);

  await makeFakeBin(
    bin,
    "codex",
    `
    const [cmd, sub] = process.argv.slice(2);
    if (cmd === "login" && sub === "status") {
      process.stdout.write("Logged in using ChatGPT\\n");
      process.exit(0);
    }
    if (cmd === "debug" && sub === "models") {
      process.stdout.write(JSON.stringify({
        models: [
          { slug: "gpt-test", display_name: "GPT Test", visibility: "list" },
          { slug: "hidden", display_name: "Hidden", visibility: "hidden" }
        ]
      }));
      process.exit(0);
    }
    process.exit(2);
    `,
  );
  // Claude missing → cli-not-found
  await makeFakeBin(
    bin,
    "grok",
    `
    if (process.argv[2] === "models") {
      process.stdout.write("You are logged in with grok.com.\\n\\nAvailable models:\\n  * grok-test\\n");
      process.exit(0);
    }
    process.exit(2);
    `,
  );
  await makeFakeBin(
    bin,
    "gemini",
    `
    if (process.argv[2] === "models") {
      process.stderr.write("auth required\\n");
      process.exit(1);
    }
    process.exit(2);
    `,
  );

  const result = await discoverCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 5_000,
    workerTimeoutMs: 60_000,
    // Headless-exec wiring is covered by its own tests; stub it here so this
    // test stays focused on auth/model-list discovery.
    headlessExecProbe: async () => ({ ok: true }),
  });

  const workers = result.capabilities.filter((record) => record.role === "worker");
  assert.deepEqual(workers.map((record) => `${record.agent}:${record.model}`).sort(), [
    "Codex:gpt-test",
    "Grok:grok-test",
  ]);
  assert.ok(workers.every((record) => record.selectable && record.verifiable && record.selector));
  assert.ok(workers.every((record) => record.timeoutMs === 60_000));

  const byAgent = Object.fromEntries(
    result.diagnostics
      .filter((entry) => entry.status === "failed")
      .map((entry) => [entry.agent, entry.reason]),
  );
  assert.equal(byAgent.Claude, REASON_CODES.CLI_NOT_FOUND);
  assert.equal(byAgent.Gemini, REASON_CODES.AUTH_UNAVAILABLE);
  // Diagnostics must not look like secrets / prompt dumps.
  for (const entry of result.diagnostics) {
    assert.equal(
      Object.keys(entry).every((key) => ["agent", "status", "reason", "model"].includes(key)),
      true,
    );
  }
});

test("fails closed with empty capabilities when every adapter fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-empty-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  // Empty fake bin → all cli-not-found (node dir only, no agent CLIs)
  const result = await discoverAllCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 2_000,
  });
  assert.deepEqual(result.capabilities, []);
  assert.equal(result.diagnostics.length, 4);
  assert.ok(result.diagnostics.every((entry) => entry.reason === REASON_CODES.CLI_NOT_FOUND));
  assert.deepEqual(selectWorkerRoutes(result.capabilities), []);
});

test("records verification-timeout without aborting later adapters", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-timeout-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  // Injected runProcess: Codex always times out; Claude uses an explicit test
  // candidate because the real CLI has no `models` subcommand.
  // Avoids real hung processes that slow subsequent probes under load.
  const runProcess = async (command, args) => {
    const base = path.basename(command);
    if (base === "codex") {
      return {
        code: null,
        signal: "SIGKILL",
        timedOut: true,
        error: "verification-timeout",
        stdout: "",
        stderr: "",
        pid: 0,
      };
    }
    if (base === "claude" && args[0] === "auth" && args[1] === "status") {
      return {
        code: 0,
        signal: null,
        timedOut: false,
        error: null,
        stdout: JSON.stringify({ loggedIn: true }),
        stderr: "",
        pid: 1,
      };
    }
    return { code: 127, signal: null, timedOut: false, error: null, stdout: "", stderr: "", pid: null };
  };
  const resolveExecutable = async (name) => {
    if (name === "codex" || name === "claude") return path.join(bin, name);
    return null;
  };
  // Touch paths so basename resolution stays realistic.
  await makeFakeBin(bin, "codex", "process.exit(0);");
  await makeFakeBin(bin, "claude", "process.exit(0);");

  const result = await discoverAllCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 5_000,
    workerTimeoutMs: 30_000,
    runProcess,
    resolveExecutable,
    adapters: { Claude: { candidateModels: ["sonnet"] } },
    headlessExecProbe: async () => ({ ok: true }),
  });

  assert.ok(
    result.diagnostics.some(
      (entry) => entry.agent === "Codex" && entry.reason === REASON_CODES.VERIFICATION_TIMEOUT,
    ),
  );
  assert.ok(result.capabilities.some((record) => record.agent === "Claude" && record.model === "sonnet"));
});

test("Claude discovers exact models from the project state in .claude.json", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-claude-project-state-"));
  const bin = path.join(directory, "bin");
  const home = path.join(directory, "home");
  const project = path.join(directory, "project");
  await mkdir(bin);
  await mkdir(home);
  await mkdir(project);
  await makeFakeBin(bin, "claude", "process.exit(0);");
  await writeFile(
    path.join(home, ".claude.json"),
    JSON.stringify({
      projects: {
        [project]: {
          lastModelUsage: {
            "claude-sonnet-4-5-20250929": { inputTokens: 1 },
            "claude-opus-4-5-20251101": { inputTokens: 2 },
          },
        },
      },
    }),
  );
  const calls = [];
  const result = await discoverAllCapabilities({
    cwd: project,
    homeDir: home,
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    resolveExecutable: async (name) => (name === "claude" ? path.join(bin, name) : null),
    runProcess: async (command, args) => {
      calls.push(args);
      if (args[0] === "auth" && args[1] === "status") {
        return {
          code: 0,
          signal: null,
          timedOut: false,
          error: null,
          stdout: JSON.stringify({ loggedIn: true }),
          stderr: "",
          pid: 1,
        };
      }
      return { code: 127, signal: null, timedOut: false, error: null, stdout: "", stderr: "", pid: null };
    },
    headlessExecProbe: async ({ args }) => {
      assert.deepEqual(args.slice(0, 1), ["--model"]);
      assert.ok(["claude-sonnet-4-5-20250929", "claude-opus-4-5-20251101"].includes(args[1]));
      assert.deepEqual(args.slice(2, 4), ["--permission-mode", "bypassPermissions"]);
      return { ok: true };
    },
  });

  assert.deepEqual(
    result.capabilities
      .filter((record) => record.agent === "Claude" && record.role === "worker")
      .map((record) => record.model),
    ["claude-sonnet-4-5-20250929", "claude-opus-4-5-20251101"],
  );
  assert.deepEqual(calls, [["auth", "status"]]);
});

test("Claude verifies each candidate independently and excludes a later model that fails", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-claude-per-model-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const claudePath = await makeFakeBin(bin, "claude", "process.exit(0);");
  const probedModels = [];
  const result = await discoverAllCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    only: ["Claude"],
    adapters: { Claude: { candidateModels: ["claude-sonnet", "claude-fable"] } },
    resolveExecutable: async (name) => (name === "claude" ? claudePath : null),
    runProcess: async () => ({
      code: 0,
      signal: null,
      timedOut: false,
      error: null,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      pid: 1,
    }),
    headlessExecProbe: async ({ args }) => {
      const model = args[args.indexOf("--model") + 1];
      probedModels.push(model);
      return model === "claude-sonnet"
        ? { ok: true }
        : { ok: false, reason: REASON_CODES.HEADLESS_EXEC_FAILED };
    },
  });

  assert.deepEqual(probedModels, ["claude-sonnet", "claude-fable"]);
  assert.deepEqual(
    result.capabilities
      .filter((record) => record.agent === "Claude")
      .map((record) => [record.model, record.role]),
    [
      ["claude-sonnet", "worker"],
      ["claude-sonnet", "parent"],
    ],
  );
  assert.deepEqual(
    result.diagnostics.filter((entry) => entry.agent === "Claude"),
    [
      { agent: "Claude", status: "ok", model: "claude-sonnet" },
      {
        agent: "Claude",
        status: "failed",
        reason: REASON_CODES.HEADLESS_EXEC_FAILED,
        model: "claude-fable",
      },
    ],
  );
});

test("Claude uses the available-model cache when project usage is absent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-claude-model-cache-"));
  const bin = path.join(directory, "bin");
  const home = path.join(directory, "home");
  await mkdir(bin);
  await mkdir(home);
  await makeFakeBin(bin, "claude", "process.exit(0);");
  await writeFile(
    path.join(home, ".claude.json"),
    JSON.stringify({ additionalModelOptionsCache: [{ value: "claude-fable-5[1m]", label: "Fable" }] }),
  );
  const result = await discoverAllCapabilities({
    cwd: path.join(directory, "unused-project"),
    homeDir: home,
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    resolveExecutable: async (name) => (name === "claude" ? path.join(bin, name) : null),
    runProcess: async () => ({
      code: 0,
      signal: null,
      timedOut: false,
      error: null,
      stdout: JSON.stringify({ loggedIn: true }),
      stderr: "",
      pid: 1,
    }),
    headlessExecProbe: async () => ({ ok: true }),
  });

  const worker = result.capabilities.find((record) => record.agent === "Claude" && record.role === "worker");
  assert.equal(worker.model, "claude-fable-5");
  assert.equal(worker.requestedModel, "Fable");
});

test("rejects model catalog parse failures as model-not-selectable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-mismatch-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await makeFakeBin(bin, "codex", "process.exit(0);");
  const runProcess = async (command, args) => {
    if (path.basename(command) !== "codex") {
      return { code: 127, signal: null, timedOut: false, error: null, stdout: "", stderr: "", pid: null };
    }
    if (args[0] === "login" && args[1] === "status") {
      return {
        code: 0,
        signal: null,
        timedOut: false,
        error: null,
        stdout: "Logged in\n",
        stderr: "",
        pid: 1,
      };
    }
    if (args[0] === "debug" && args[1] === "models") {
      return {
        code: 0,
        signal: null,
        timedOut: false,
        error: null,
        stdout: "not-json-and-no-models",
        stderr: "",
        pid: 2,
      };
    }
    return { code: 2, signal: null, timedOut: false, error: null, stdout: "", stderr: "", pid: 3 };
  };
  const result = await discoverAllCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 3_000,
    runProcess,
    resolveExecutable: async (name) => (name === "codex" ? path.join(bin, "codex") : null),
  });
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.agent === "Codex" && entry.reason === REASON_CODES.MODEL_NOT_SELECTABLE,
    ),
  );
  assert.equal(result.capabilities.filter((record) => record.agent === "Codex").length, 0);
});

test("writes capabilities atomically and never leaves a partial final file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-atomic-"));
  const outputPath = path.join(directory, "capabilities.json");
  await writeJsonAtomic(outputPath, { capabilities: [{ agent: "old" }], diagnostics: [] });
  const before = await readFile(outputPath, "utf8");

  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await makeFakeBin(
    bin,
    "grok",
    `
    if (process.argv[2] === "models") {
      process.stdout.write("You are logged in.\\nAvailable models:\\n  * grok-atomic\\n");
      process.exit(0);
    }
    process.exit(2);
    `,
  );

  const result = await discoverCapabilities({
    outputPath,
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 3_000,
    workerTimeoutMs: 12_000,
    headlessExecProbe: async () => ({ ok: true }),
  });
  assert.equal(result.outputPath, outputPath);
  const after = JSON.parse(await readFile(outputPath, "utf8"));
  assert.notEqual(after.capabilities[0]?.agent, "old");
  assert.ok(after.capabilities.some((record) => record.model === "grok-atomic"));
  assert.ok(before.includes("old"));
  // No tmp leftovers that look like the final name without .tmp
  const finalStat = await stat(outputPath);
  assert.ok(finalStat.isFile());
});

test("dispatches a non-Codex route with the exact probe selector and model", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-dispatch-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const marker = path.join(directory, "launched.json");
  await makeFakeBin(
    bin,
    "grok",
    `
    const fs = require("node:fs");
    const marker = process.env.EXAMPLE_LAUNCH_MARKER;
    fs.writeFileSync(marker, JSON.stringify({ argv: process.argv.slice(2) }));
    process.exit(0);
    `,
  );
  const grokPath = path.join(bin, "grok");
  const route = {
    agent: "Grok",
    model: "grok-4.5",
    requestedModel: "Grok 4.5",
    role: "worker",
    selector: `${grokPath} --model grok-4.5`,
    selectable: true,
    verifiable: true,
    timeoutMs: 10_000,
  };

  const handle = await dispatchWorker(
    {
      route,
      issueNumber: 413,
      releasePolicy: "merged",
      nextMilestone: "pr-created",
      cwd: directory,
    },
    { env: { ...process.env, PATH: isolatedPath(bin), EXAMPLE_LAUNCH_MARKER: marker } },
  );
  const waited = await handle.wait();
  assert.equal(waited.code, 0);
  assert.equal(waited.timedOut, false);

  const launched = JSON.parse(await readFile(marker, "utf8"));
  assert.deepEqual(launched.argv.slice(0, 2), ["--model", "grok-4.5"]);
  assert.match(launched.argv.at(-1), /Issue: #413/);
  assert.match(launched.argv.at(-1), /agent=Grok/);
  assert.doesNotMatch(launched.argv.at(-1), /password|token|BEGIN /i);
});

test("dispatch timeout kills only the worker process tree", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-dispatch-timeout-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await makeFakeBin(
    bin,
    "claude",
    `
    setInterval(() => {}, 60_000);
    `,
  );
  const claudePath = path.join(bin, "claude");
  const route = {
    agent: "Claude",
    model: "sonnet",
    role: "worker",
    selector: `${claudePath} --model sonnet`,
    selectable: true,
    verifiable: true,
    timeoutMs: 200,
  };
  const handle = await dispatchWorker({
    route,
    issueNumber: 1,
    releasePolicy: "pr-created",
    nextMilestone: "pr-created",
  });
  const waited = await handle.wait();
  assert.equal(waited.timedOut, true);
});

test("splitSelector preserves quoted multi-word model ids used by Gemini", () => {
  assert.deepEqual(splitSelector(`/bin/gemini --model "Gemini 3.1 Pro (High)" --print`), [
    "/bin/gemini",
    "--model",
    "Gemini 3.1 Pro (High)",
    "--print",
  ]);
});

test("Gemini adapter records native CLI models with exact display names", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-gemini-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const geminiPath = path.join(bin, "gemini");
  await makeFakeBin(bin, "gemini", "process.exit(0);");
  const result = await discoverAllCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 3_000,
    workerTimeoutMs: 9_000,
    resolveExecutable: async (name) => (name === "gemini" || name === geminiPath ? geminiPath : null),
    runProcess: async (command, args) => {
      if (path.basename(command) === "gemini" && args[0] === "models") {
        return {
          code: 0,
          signal: null,
          timedOut: false,
          error: null,
          stdout: "Gemini 3.1 Pro (High)\nGemini 3.5 Flash (Medium)\n",
          stderr: "",
          pid: 1,
        };
      }
      return { code: 127, signal: null, timedOut: false, error: null, stdout: "", stderr: "", pid: null };
    },
    headlessExecProbe: async () => ({ ok: true }),
  });
  const geminiWorkers = result.capabilities.filter(
    (record) => record.agent === "Gemini" && record.role === "worker",
  );
  assert.deepEqual(geminiWorkers.map((record) => record.model).sort(), [
    "Gemini 3.1 Pro (High)",
    "Gemini 3.5 Flash (Medium)",
  ]);
  assert.ok(geminiWorkers[0].selector.includes("--model"));
  assert.ok(geminiWorkers[0].selector.includes("Gemini 3.1 Pro (High)"));
  assert.doesNotMatch(geminiWorkers[0].selector, /--print-timeout|--dangerously-skip-permissions/);
});

test("capabilities CLI module is importable from the repository root", async () => {
  const script = path.join(repoRoot, "scripts/project-issue-capabilities.mjs");
  assert.equal((await stat(script)).isFile(), true);
});

test("rejects Not logged in Codex/Grok status as auth-unavailable", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-auth-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await makeFakeBin(bin, "codex", "process.exit(0);");
  await makeFakeBin(bin, "grok", "process.exit(0);");
  const runProcess = async (command, args) => {
    const base = path.basename(command);
    if (base === "codex" && args[0] === "login") {
      return {
        code: 0,
        signal: null,
        timedOut: false,
        error: null,
        stdout: "Not logged in\n",
        stderr: "",
        pid: 1,
      };
    }
    if (base === "grok" && args[0] === "models") {
      return {
        code: 0,
        signal: null,
        timedOut: false,
        error: null,
        stdout: "Not logged in. Please run grok login.\n",
        stderr: "",
        pid: 2,
      };
    }
    return { code: 127, signal: null, timedOut: false, error: null, stdout: "", stderr: "", pid: null };
  };
  const result = await discoverAllCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    runProcess,
    resolveExecutable: async (name) => (name === "codex" || name === "grok" ? path.join(bin, name) : null),
  });
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.agent === "Codex" && entry.reason === REASON_CODES.AUTH_UNAVAILABLE,
    ),
  );
  assert.ok(
    result.diagnostics.some(
      (entry) => entry.agent === "Grok" && entry.reason === REASON_CODES.AUTH_UNAVAILABLE,
    ),
  );
  assert.equal(result.capabilities.length, 0);
});

/**
 * Fake bin that parses the probe's own prompt out of its final argv element
 * and reacts one of four documented ways, so `runHeadlessExecProbe` can be
 * exercised end-to-end without a real agent CLI (Issue #434).
 */
async function makeProbeReactingBin(directory, name, behavior) {
  const bodies = {
    completes: `
      const fs = require("node:fs");
      const prompt = process.argv[process.argv.length - 1];
      const pathMatch = prompt.match(/exact path:\\s*(\\S+)/);
      const markerMatch = prompt.match(/nothing else:\\s*(\\S+)/);
      if (pathMatch && markerMatch) fs.writeFileSync(pathMatch[1], markerMatch[1]);
      process.exit(0);
    `,
    ttyRequired: `
      process.stderr.write("Error: Device not configured (os error 6)\\n");
      process.exit(1);
    `,
    printOnly: `
      process.stdout.write("Sure — here is a description of that file.\\n");
      process.exit(0);
    `,
    execFails: `
      process.stderr.write("unexpected internal error\\n");
      process.exit(1);
    `,
    hangs: `
      setInterval(() => {}, 60_000);
    `,
  };
  return makeFakeBin(directory, name, bodies[behavior]);
}

test("runHeadlessExecProbe passes when the CLI writes the exact requested artifact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-headless-probe-ok-"));
  const cliPath = await makeProbeReactingBin(directory, "probe-cli", "completes");
  const result = await runHeadlessExecProbe({ cliPath, args: ["--model", "x"], timeoutMs: 10_000 });
  assert.deepEqual(result, { ok: true });
});

test("runHeadlessExecProbe reports tty-required when the CLI demands a real terminal", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-headless-probe-tty-"));
  const cliPath = await makeProbeReactingBin(directory, "probe-cli", "ttyRequired");
  const result = await runHeadlessExecProbe({ cliPath, args: [], timeoutMs: 10_000 });
  assert.deepEqual(result, { ok: false, reason: REASON_CODES.TTY_REQUIRED });
});

test("runHeadlessExecProbe reports non-agentic-print-mode on a clean exit with no artifact", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-headless-probe-print-"));
  const cliPath = await makeProbeReactingBin(directory, "probe-cli", "printOnly");
  const result = await runHeadlessExecProbe({ cliPath, args: [], timeoutMs: 10_000 });
  assert.deepEqual(result, { ok: false, reason: REASON_CODES.NON_AGENTIC_PRINT_MODE });
});

test("runHeadlessExecProbe reports headless-exec-failed on an unexplained non-zero exit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-headless-probe-failed-"));
  const cliPath = await makeProbeReactingBin(directory, "probe-cli", "execFails");
  const result = await runHeadlessExecProbe({ cliPath, args: [], timeoutMs: 10_000 });
  assert.deepEqual(result, { ok: false, reason: REASON_CODES.HEADLESS_EXEC_FAILED });
});

test("runHeadlessExecProbe reports verification-timeout and cleans up its sandbox", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-headless-probe-timeout-"));
  const cliPath = await makeProbeReactingBin(directory, "probe-cli", "hangs");
  const result = await runHeadlessExecProbe({ cliPath, args: [], timeoutMs: 300 });
  assert.deepEqual(result, { ok: false, reason: REASON_CODES.VERIFICATION_TIMEOUT });
});

test("runHeadlessExecProbe never leaks the generated prompt or marker in its result", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-headless-probe-secrecy-"));
  const cliPath = await makeProbeReactingBin(directory, "probe-cli", "printOnly");
  const result = await runHeadlessExecProbe({ cliPath, args: [], timeoutMs: 10_000 });
  assert.deepEqual(Object.keys(result).sort(), ["ok", "reason"]);
});

test("a failed headless probe zeroes out an adapter's records instead of trusting auth/model checks alone", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-probe-wiring-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await makeFakeBin(
    bin,
    "grok",
    `
    if (process.argv[2] === "models") {
      process.stdout.write("You are logged in with grok.com.\\n\\nAvailable models:\\n  * grok-test\\n");
      process.exit(0);
    }
    process.exit(2);
    `,
  );
  const result = await discoverAllCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 5_000,
    only: ["Grok"],
    headlessExecProbe: async () => ({ ok: false, reason: REASON_CODES.TTY_REQUIRED }),
  });
  assert.deepEqual(result.capabilities, []);
  assert.deepEqual(
    result.diagnostics.filter((entry) => entry.agent === "Grok"),
    [{ agent: "Grok", status: "failed", reason: REASON_CODES.TTY_REQUIRED, model: "grok-test" }],
  );
});

test("discoverAllCapabilities respects an only filter for targeted re-probes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-only-filter-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await makeFakeBin(bin, "codex", "process.exit(2);");
  await makeFakeBin(bin, "grok", "process.exit(2);");
  const result = await discoverAllCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 2_000,
    only: ["grok"],
  });
  // Only Grok was asked for; Codex/Claude/Gemini never ran (no diagnostics at all).
  assert.deepEqual(
    result.diagnostics.map((entry) => entry.agent),
    ["Grok"],
  );
});

test("discoverCapabilities records per-agent CLI path/version metadata and a probedAt timestamp", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-metadata-"));
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  await makeFakeBin(
    bin,
    "grok",
    `
    if (process.argv[2] === "--version") {
      process.stdout.write("grok-fake 9.9.9\\n");
      process.exit(0);
    }
    if (process.argv[2] === "models") {
      process.stdout.write("You are logged in.\\nAvailable models:\\n  * grok-meta\\n");
      process.exit(0);
    }
    process.exit(2);
    `,
  );
  const result = await discoverCapabilities({
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
    timeoutMs: 3_000,
    workerTimeoutMs: 12_000,
    headlessExecProbe: async () => ({ ok: true }),
  });
  assert.equal(result.cli.Grok.path, path.join(bin, "grok"));
  assert.equal(result.cli.Grok.version, "grok-fake 9.9.9");
  assert.equal(typeof result.probedAt, "string");
  assert.ok(!Number.isNaN(Date.parse(result.probedAt)));
});

test("loadOrRefreshCapabilities reuses a fresh cache without spawning any adapter", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-reuse-"));
  const cachePath = path.join(directory, "capabilities.json");
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const cliPath = await makeFakeBin(bin, "grok", "process.exit(9);"); // would fail if ever re-invoked
  const cached = {
    capabilities: [
      {
        agent: "Grok",
        model: "grok-cached",
        role: "worker",
        selector: `${cliPath} --model grok-cached`,
        selectable: true,
        verifiable: true,
        timeoutMs: 60_000,
      },
    ],
    diagnostics: [{ agent: "Grok", status: "ok", model: "grok-cached" }],
    cli: { Grok: { path: cliPath, version: "cached-version-9.9.9" } },
    probedAt: "2026-01-01T00:00:00.000Z",
    probeSchemaVersion: PROBE_SCHEMA_VERSION,
    repositoryCommit: await getRepositoryCommit(process.cwd()),
  };
  await writeJsonAtomic(cachePath, cached);
  // Fake bin's own --version differs from the cache -> would be detected as
  // stale by a real run; stub readCliVersion via runProcess to match instead,
  // proving the freshness check (not just file presence) drives reuse.
  const runProcess = async (command, args) => {
    if (args[0] === "--version") {
      return {
        code: 0,
        signal: null,
        timedOut: false,
        error: null,
        stdout: "cached-version-9.9.9\n",
        stderr: "",
        pid: 1,
      };
    }
    return { code: 9, signal: null, timedOut: false, error: null, stdout: "", stderr: "", pid: 2 };
  };
  const result = await loadOrRefreshCapabilities({ cachePath, runProcess });
  assert.equal(result.reused, true);
  assert.deepEqual(result.capabilities, cached.capabilities);
});

test("loadOrRefreshCapabilities re-probes only the agent invalidated by a runtime failure", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-invalidate-"));
  const cachePath = path.join(directory, "capabilities.json");
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const grokPath = await makeFakeBin(bin, "grok", "process.exit(9);");
  const codexPath = await makeFakeBin(bin, "codex", "process.exit(9);");
  const cached = {
    capabilities: [
      {
        agent: "Grok",
        model: "grok-cached",
        role: "worker",
        selector: `${grokPath} --model grok-cached`,
        selectable: true,
        verifiable: true,
        timeoutMs: 60_000,
      },
      {
        agent: "Codex",
        model: "gpt-cached",
        role: "worker",
        selector: `${codexPath} exec -m gpt-cached`,
        selectable: true,
        verifiable: true,
        timeoutMs: 60_000,
      },
    ],
    diagnostics: [
      { agent: "Grok", status: "ok", model: "grok-cached" },
      { agent: "Codex", status: "ok", model: "gpt-cached" },
    ],
    cli: {
      Grok: { path: grokPath, version: "v1" },
      Codex: { path: codexPath, version: "v1" },
    },
    probedAt: "2026-01-01T00:00:00.000Z",
    probeSchemaVersion: PROBE_SCHEMA_VERSION,
    repositoryCommit: await getRepositoryCommit(process.cwd()),
  };
  await writeJsonAtomic(cachePath, cached);
  const runProcess = async (command, args) => {
    if (args[0] === "--version")
      return { code: 0, signal: null, timedOut: false, error: null, stdout: "v1\n", stderr: "", pid: 1 };
    return { code: 2, signal: null, timedOut: false, error: null, stdout: "", stderr: "", pid: 2 };
  };
  const result = await loadOrRefreshCapabilities({
    cachePath,
    runProcess,
    resolveExecutable: async (name) => (name === "grok" ? grokPath : name === "codex" ? codexPath : null),
    invalidateAgents: ["Grok"],
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
  });
  assert.equal(result.reused, false);
  assert.deepEqual(result.reprobedAgents, ["Grok"]);
  // Codex's cached "ok" entry survives untouched; Grok was dropped and
  // re-probed (and failed, since the fake bin only knows how to exit 9).
  assert.deepEqual(
    result.capabilities.map((record) => record.agent),
    ["Codex"],
  );
  const onDisk = JSON.parse(await readFile(cachePath, "utf8"));
  assert.deepEqual(
    onDisk.capabilities.map((record) => record.agent),
    ["Codex"],
  );
});

test("loadOrRefreshCapabilities --refresh ignores the cache and re-probes everything", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-refresh-"));
  const cachePath = path.join(directory, "capabilities.json");
  await writeJsonAtomic(cachePath, {
    capabilities: [
      {
        agent: "Grok",
        model: "stale",
        role: "worker",
        selector: "stale-selector",
        selectable: true,
        verifiable: true,
        timeoutMs: 1_000,
      },
    ],
    diagnostics: [],
    cli: {},
    probedAt: "2026-01-01T00:00:00.000Z",
    probeSchemaVersion: PROBE_SCHEMA_VERSION,
    repositoryCommit: await getRepositoryCommit(process.cwd()),
  });
  const result = await loadOrRefreshCapabilities({
    cachePath,
    refresh: true,
    env: { ...process.env, PATH: path.dirname(process.execPath) }, // no real agent CLIs visible
    pathEnv: path.dirname(process.execPath),
    timeoutMs: 2_000,
  });
  assert.equal(result.reused, false);
  assert.deepEqual(result.capabilities, []);
  assert.ok(result.diagnostics.every((entry) => entry.reason === REASON_CODES.CLI_NOT_FOUND));
});

test("loadOrRefreshCapabilities never writes the cache file during a dry run", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-dryrun-cache-"));
  const cachePath = path.join(directory, "capabilities.json");
  await loadOrRefreshCapabilities({
    cachePath,
    dryRun: true,
    env: { ...process.env, PATH: path.dirname(process.execPath) },
    pathEnv: path.dirname(process.execPath),
    timeoutMs: 2_000,
  });
  await assert.rejects(() => stat(cachePath), /ENOENT/);
});

test("loadOrRefreshCapabilities canonicalizes invalidateAgents casing before diffing against the cache", async () => {
  // Regression for a review finding on this Issue: a lowercase --invalidate-agent
  // name must not survive into the case-sensitive cache-merge filter, or the
  // stale cached record for that agent (canonical casing) would never be
  // dropped while the re-probe's fresh record for it gets appended anyway —
  // duplicate/conflicting routes for the same agent in the rewritten cache.
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-casing-"));
  const cachePath = path.join(directory, "capabilities.json");
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const grokPath = await makeFakeBin(
    bin,
    "grok",
    `
    if (process.argv[2] === "models") {
      process.stdout.write("You are logged in.\\nAvailable models:\\n  * grok-fresh\\n");
      process.exit(0);
    }
    process.exit(2);
    `,
  );
  const cached = {
    capabilities: [
      {
        agent: "Grok",
        model: "grok-cached",
        role: "worker",
        selector: `${grokPath} --model grok-cached`,
        selectable: true,
        verifiable: true,
        timeoutMs: 60_000,
      },
    ],
    diagnostics: [{ agent: "Grok", status: "ok", model: "grok-cached" }],
    cli: { Grok: { path: grokPath, version: "v1" } },
    probedAt: "2026-01-01T00:00:00.000Z",
    probeSchemaVersion: PROBE_SCHEMA_VERSION,
    repositoryCommit: await getRepositoryCommit(process.cwd()),
  };
  await writeJsonAtomic(cachePath, cached);
  const result = await loadOrRefreshCapabilities({
    cachePath,
    invalidateAgents: ["grok"], // lowercase, unlike the canonical "Grok" in the cache
    headlessExecProbe: async () => ({ ok: true }),
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
  });
  assert.equal(result.reprobedAgents.length, 1);
  // Exactly one Grok worker route survives — the fresh one, not a duplicate
  // of the stale cached one plus the fresh one.
  const grokWorkers = result.capabilities.filter(
    (record) => record.agent === "Grok" && record.role === "worker",
  );
  assert.equal(grokWorkers.length, 1);
  assert.equal(grokWorkers[0].model, "grok-fresh");
});

test("loadOrRefreshCapabilities rejects an --invalidate-agent name that matches no adapter", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-invalidate-unknown-"));
  const cachePath = path.join(directory, "capabilities.json");
  await writeJsonAtomic(cachePath, {
    capabilities: [],
    diagnostics: [],
    cli: {},
    probedAt: "2026-01-01T00:00:00.000Z",
    probeSchemaVersion: PROBE_SCHEMA_VERSION,
    repositoryCommit: await getRepositoryCommit(process.cwd()),
  });
  await assert.rejects(
    () => loadOrRefreshCapabilities({ cachePath, invalidateAgents: ["Foo"] }),
    /unknown-invalidate-agent:Foo/,
  );
});

test("loadOrRefreshCapabilities always re-probes a cached agent whose last diagnostic was failed", async () => {
  // A transient failure (auth lapse, a one-off timeout) must not be trusted
  // as permanent just because the agent has no `cli` metadata to detect
  // drift against — otherwise it stays excluded from routing until a human
  // notices and passes --refresh/--invalidate-agent (Issue #434 review).
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-failed-restale-"));
  const cachePath = path.join(directory, "capabilities.json");
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const _grokPath = await makeFakeBin(
    bin,
    "grok",
    `
    if (process.argv[2] === "models") {
      process.stdout.write("You are logged in.\\nAvailable models:\\n  * grok-recovered\\n");
      process.exit(0);
    }
    process.exit(2);
    `,
  );
  await writeJsonAtomic(cachePath, {
    capabilities: [],
    diagnostics: [{ agent: "Grok", status: "failed", reason: REASON_CODES.AUTH_UNAVAILABLE }],
    cli: {},
    probedAt: "2026-01-01T00:00:00.000Z",
    probeSchemaVersion: PROBE_SCHEMA_VERSION,
    repositoryCommit: await getRepositoryCommit(process.cwd()),
  });
  const result = await loadOrRefreshCapabilities({
    cachePath,
    headlessExecProbe: async () => ({ ok: true }),
    env: { ...process.env, PATH: isolatedPath(bin) },
    pathEnv: isolatedPath(bin),
  });
  assert.equal(result.reused, false);
  assert.deepEqual(result.reprobedAgents, ["Grok"]);
  assert.ok(
    result.capabilities.some((record) => record.agent === "Grok" && record.model === "grok-recovered"),
  );
});

test("loadOrRefreshCapabilities's freshness check uses discovery's timeout budget, not readCliVersion's own shorter default", async () => {
  // Regression for a review finding: discoverCapabilities records `version`
  // under a 60s budget, but the freshness re-check previously defaulted to
  // readCliVersion's own 10s default whenever the caller didn't pass an
  // explicit timeoutMs — reading `null` for a slow-but-unchanged CLI, judging
  // it stale, and re-probing (and rewriting the cache) on every single run.
  const directory = await mkdtemp(path.join(tmpdir(), "example-cap-freshness-timeout-"));
  const cachePath = path.join(directory, "capabilities.json");
  const bin = path.join(directory, "bin");
  await mkdir(bin);
  const grokPath = await makeFakeBin(bin, "grok", "process.exit(0);");
  await writeJsonAtomic(cachePath, {
    capabilities: [
      {
        agent: "Grok",
        model: "grok-cached",
        role: "worker",
        selector: `${grokPath} --model grok-cached`,
        selectable: true,
        verifiable: true,
        timeoutMs: 60_000,
      },
    ],
    diagnostics: [{ agent: "Grok", status: "ok", model: "grok-cached" }],
    cli: { Grok: { path: grokPath, version: "v1" } },
    probedAt: "2026-01-01T00:00:00.000Z",
    probeSchemaVersion: PROBE_SCHEMA_VERSION,
    repositoryCommit: await getRepositoryCommit(process.cwd()),
  });
  let observedTimeoutMs;
  const runProcess = async (command, args, opts) => {
    if (args[0] === "--version") {
      observedTimeoutMs = opts.timeoutMs;
      return { code: 0, signal: null, timedOut: false, error: null, stdout: "v1\n", stderr: "", pid: 1 };
    }
    return { code: 2, signal: null, timedOut: false, error: null, stdout: "", stderr: "", pid: 2 };
  };
  const result = await loadOrRefreshCapabilities({ cachePath, runProcess }); // no explicit timeoutMs
  assert.equal(result.reused, true);
  assert.equal(observedTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS);
});
