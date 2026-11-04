import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  isModelAllowed,
  isModelDenied,
  loadRuntimeRegistry,
  matchesModelPattern,
} from "../../scripts/ai-template/registry.mjs";
import {
  discoverCapabilities,
  loadOrRefreshCapabilities,
} from "../../scripts/issue-capabilities.mjs";
import { launchWithAdapter } from "../../scripts/issue-runtime-adapters/index.mjs";
import { selectWorkerRoutes } from "../../scripts/issue-plan.mjs";
import { loadOrchestratorConfig } from "../../scripts/issue-config.mjs";
import {
  DEFAULT_CATALOG_MAX_AGE_HOURS,
  describeCatalog,
  ensureModelCatalog,
  parseModelCatalogCliArgs,
  readModelCatalog,
} from "../../scripts/issue-model-catalog.mjs";

const source = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const HOUR = 3_600_000;
const put = (root, file, value) => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(
    path.join(root, file),
    typeof value === "string" ? value : JSON.stringify(value),
  );
};

/** Repository fixture with the shipped runtime definitions and the given `agents` config. */
function fixture(t, agents) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-catalog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.join(source, "agents"), path.join(root, "agents"), {
    recursive: true,
  });
  put(root, ".ai-template/config.json", { agents });
  // Real executables so freshness checks can stat them; they are never run.
  for (const name of ["opencode", "codex", "claude"])
    put(root, `bin/${name}`, "#!/bin/sh\nexit 0\n");
  return root;
}

/**
 * Fake OpenCode/Codex CLI calls. `state.models` is the listing, `state.version` the `--version`
 * output; `calls` records listing calls only (never `--version`).
 */
function fakeCli(root, state, calls = []) {
  return {
    resolveExecutable: async (name) =>
      ["opencode", "codex"].includes(name)
        ? path.join(root, state.bin ?? "bin", name)
        : null,
    runProcess: async (cli, args) => {
      if (args.includes("--version"))
        return { code: 0, stdout: state.version ?? "fixture-v1" };
      calls.push([path.basename(cli), ...args]);
      if (args.includes("status")) return { code: 0, stdout: "Logged in" };
      if (path.basename(cli) === "codex")
        return {
          code: 0,
          stdout: JSON.stringify({
            models: state.models.map((slug) => ({
              slug,
              display_name: state.labels?.[slug] ?? slug.toUpperCase(),
            })),
          }),
        };
      return { code: 0, stdout: state.models.join("\n") };
    },
    headlessExecProbe: async ({ args }) => {
      const flag = args.includes("--model") ? "--model" : "-m";
      calls.push(["probe", args[args.indexOf(flag) + 1]]);
      return { ok: true };
    },
  };
}

test("refresh stores only identifiers and labels, and a dry run writes nothing", async (t) => {
  const root = fixture(t, { enabled: ["opencode"] });
  const catalogPath = path.join(root, "state/model-catalog.json");
  const cli = fakeCli(root, { models: ["fiction/a", "fiction/b"] });
  const dry = await ensureModelCatalog({
    cwd: root,
    catalogPath,
    refresh: true,
    dryRun: true,
    ...cli,
  });
  assert.equal(dry.written, false);
  assert.equal(fs.existsSync(catalogPath), false);
  assert.deepEqual(
    dry.catalog.agents.opencode.models.map((m) => m.model),
    ["fiction/a", "fiction/b"],
  );

  const result = await ensureModelCatalog({
    cwd: root,
    catalogPath,
    refresh: true,
    ...cli,
  });
  assert.equal(result.written, true);
  const stored = await readModelCatalog(catalogPath);
  assert.deepEqual(Object.keys(stored).sort(), [
    "agents",
    "refreshedAt",
    "runtimeFingerprint",
    "schemaVersion",
  ]);
  assert.deepEqual(Object.keys(stored.agents.opencode).sort(), [
    "cli",
    "models",
    "name",
    "refreshedAt",
    "source",
    "status",
  ]);
  assert.deepEqual(stored.agents.opencode.cli, {
    path: path.join(root, "bin/opencode"),
    version: "fixture-v1",
  });
  assert.deepEqual(stored.agents.opencode.models[0], {
    model: "fiction/a",
    label: "fiction/a",
  });
});

test("a catalog is re-listed only when missing, older than the max age, or its CLI version changed", async (t) => {
  const root = fixture(t, { enabled: ["opencode", "codex"] });
  const catalogPath = path.join(root, "catalog.json");
  const state = { models: ["fiction/a"] },
    calls = [];
  const cli = fakeCli(root, state, calls);
  const start = Date.parse("2030-01-01T00:00:00Z");
  const at = (hours) => () => new Date(start + hours * HOUR);

  const first = await ensureModelCatalog({
    cwd: root,
    catalogPath,
    now: at(0),
    ...cli,
  });
  assert.deepEqual(first.refreshedAgents, ["codex", "opencode"]);

  calls.length = 0;
  const fresh = await ensureModelCatalog({
    cwd: root,
    catalogPath,
    now: at(DEFAULT_CATALOG_MAX_AGE_HOURS - 1),
    ...cli,
  });
  assert.deepEqual(fresh.refreshedAgents, []);
  assert.equal(fresh.written, false);
  assert.deepEqual(calls, []);

  // Default max age is one week.
  assert.equal(DEFAULT_CATALOG_MAX_AGE_HOURS, 168);
  const old = await ensureModelCatalog({
    cwd: root,
    catalogPath,
    now: at(DEFAULT_CATALOG_MAX_AGE_HOURS),
    dryRun: true,
    ...cli,
  });
  assert.deepEqual(old.refreshedAgents, ["codex", "opencode"]);
  const custom = await ensureModelCatalog({
    cwd: root,
    catalogPath,
    now: at(2),
    maxAgeHours: 1,
    dryRun: true,
    ...cli,
  });
  assert.deepEqual(custom.refreshedAgents, ["codex", "opencode"]);

  state.version = "fixture-v2";
  const upgraded = await ensureModelCatalog({
    cwd: root,
    catalogPath,
    now: at(1),
    ...cli,
  });
  assert.deepEqual(upgraded.refreshedAgents, ["codex", "opencode"]);
  const stored = await readModelCatalog(catalogPath);
  assert.equal(stored.agents.codex.cli.version, "fixture-v2");
});

test("a runtime is re-listed when its command now resolves to another installation that is still present", async (t) => {
  const root = fixture(t, { enabled: ["opencode", "codex"] });
  put(root, "other-bin/codex", "#!/bin/sh\nexit 0\n");
  const catalogPath = path.join(root, "catalog.json");
  const codex = { models: ["fiction-sol"] };
  const cli = {
    ...fakeCli(root, { models: ["fiction/a"] }),
    adapters: { codex: fakeCli(root, codex) },
  };
  await ensureModelCatalog({ cwd: root, catalogPath, ...cli });
  codex.bin = "other-bin";
  // The old executable still exists and reports the same version; only resolution changed.
  assert.ok(fs.existsSync(path.join(root, "bin/codex")));
  const moved = await ensureModelCatalog({ cwd: root, catalogPath, ...cli });
  assert.deepEqual(moved.refreshedAgents, ["codex"]);
  assert.equal(
    (await readModelCatalog(catalogPath)).agents.codex.cli.path,
    path.join(root, "other-bin/codex"),
  );
});

test("a failed listing is recorded with its reason and retried on the next run", async (t) => {
  const root = fixture(t, { enabled: ["opencode"] });
  const catalogPath = path.join(root, "catalog.json");
  const state = { models: [] };
  const cli = fakeCli(root, state);
  const failed = await ensureModelCatalog({ cwd: root, catalogPath, ...cli });
  assert.deepEqual(failed.catalog.agents.opencode, {
    name: "OpenCode",
    status: "failed",
    reason: "model-not-selectable",
    source: "command",
    cli: { path: path.join(root, "bin/opencode"), version: "fixture-v1" },
    models: [],
    refreshedAt: failed.catalog.agents.opencode.refreshedAt,
  });
  state.models = ["fiction/a"];
  const retried = await ensureModelCatalog({ cwd: root, catalogPath, ...cli });
  assert.deepEqual(retried.refreshedAgents, ["opencode"]);
  assert.equal(retried.catalog.agents.opencode.status, "ok");
});

test("refresh reports added, removed and relabeled models with their current policy", async (t) => {
  const root = fixture(t, {
    enabled: ["codex"],
    models: {
      codex: { allow: ["fiction-kept", "fiction-new"], deny: ["*astra*"] },
    },
  });
  const catalogPath = path.join(root, "catalog.json");
  const state = { models: ["fiction-kept", "fiction-gone"] };
  await ensureModelCatalog({
    cwd: root,
    catalogPath,
    refresh: true,
    ...fakeCli(root, state),
  });
  state.models = [
    "fiction-kept",
    "fiction-new",
    "fiction-other",
    "fiction-6-astra",
  ];
  const { diff, catalog } = await ensureModelCatalog({
    cwd: root,
    catalogPath,
    refresh: true,
    ...fakeCli(root, state),
  });
  assert.deepEqual(
    describeCatalog(catalog, root).codex.models.map((m) => m.policy),
    ["allowed", "allowed", "not-allowed", "denied"],
  );
  assert.deepEqual(diff, {
    codex: {
      added: [
        { model: "fiction-new", label: "FICTION-NEW", policy: "allowed" },
        {
          model: "fiction-other",
          label: "FICTION-OTHER",
          policy: "not-allowed",
        },
        {
          model: "fiction-6-astra",
          label: "FICTION-6-ASTRA",
          policy: "denied",
        },
      ],
      removed: ["fiction-gone"],
      relabeled: [],
    },
  });
});

test("deny patterns are case-insensitive, `*`-only and win over allow", async (t) => {
  assert.equal(matchesModelPattern("*fable*", "Claude-FABLE-9"), true);
  assert.equal(matchesModelPattern("*fable*", "opus"), false);
  assert.equal(matchesModelPattern("gpt-?", "gpt-6"), false);
  assert.equal(matchesModelPattern("gpt.6", "gpt-6"), false);
  const root = fixture(t, {
    enabled: ["claude", "codex"],
    models: {
      claude: { allow: ["opus", "fable"], deny: ["*fable*"] },
      codex: { deny: ["*astra*"] },
    },
  });
  assert.equal(isModelDenied("claude", "fable", root), true);
  assert.equal(isModelAllowed("claude", "fable", root), false);
  // A route is denied by either its canonical model or the value it was requested with.
  assert.equal(
    isModelAllowed("Claude", "fiction-canonical", root, "fable"),
    false,
  );
  assert.equal(
    isModelAllowed("Claude", "fiction-fable-9", root, "opus"),
    false,
  );
  assert.equal(isModelAllowed("Claude", "fiction-opus-9", root, "opus"), true);
  assert.equal(isModelAllowed("codex", "gpt-6-astra", root), false);
  assert.equal(
    isModelAllowed("codex", "fiction-sol", root, "Fiction ASTRA"),
    false,
  );
  assert.equal(isModelAllowed("codex", "fiction-sol", root), true);
});

test("denied catalog models are never probed or routed, including via cache, explicit records and launch", async (t) => {
  const root = fixture(t, { enabled: ["codex"] });
  const calls = [];
  const cli = fakeCli(
    root,
    { models: ["fiction-sol", "fiction-6-astra"] },
    calls,
  );
  const before = await discoverCapabilities({ cwd: root, ...cli });
  const astra = before.capabilities.find(
    (record) => record.model === "fiction-6-astra" && record.role === "worker",
  );
  assert.ok(astra);

  put(root, ".ai-template/config.json", {
    agents: { enabled: ["codex"], models: { codex: { deny: ["*ASTRA*"] } } },
  });
  calls.length = 0;
  const after = await discoverCapabilities({ cwd: root, ...cli });
  assert.deepEqual(
    [...new Set(after.capabilities.map((record) => record.model))],
    ["fiction-sol"],
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === "probe"),
    [["probe", "fiction-sol"]],
  );
  assert.deepEqual(
    after.diagnostics.filter((entry) => entry.reason === "model-denied"),
    [
      {
        agent: "Codex",
        status: "failed",
        reason: "model-denied",
        model: "fiction-6-astra",
      },
    ],
  );
  assert.deepEqual(
    selectWorkerRoutes(before.capabilities, { cwd: root }).map(
      (record) => record.model,
    ),
    ["fiction-sol"],
  );
  await assert.rejects(
    launchWithAdapter(
      "codex",
      { ...astra, issueNumber: 1, cwd: root, releasePolicy: "merged" },
      { ...cli, spawnWorker: async () => assert.fail("must not launch") },
    ),
    /runtime-model-not-allowed/,
  );
});

test("an alias allowlist admits the canonical model the alias resolves to, and deny applies to that model", async (t) => {
  const root = fixture(t, {
    enabled: ["claude"],
    models: { claude: { allow: ["fiction-latest"], deny: ["*fable*"] } },
  });
  const listing = (models) => ({
    status: "ok",
    cliPath: path.join(root, "bin/claude"),
    source: "control:initialize",
    models: models.map((model) => ({ model, label: model })),
  });
  const reports = {
    "fiction-latest": "fiction-model-9",
    "fiction-old-8": "fiction-old-8",
  };
  const probe = async ({ args }) => ({
    ok: true,
    reportedModel: reports[args[args.indexOf("--model") + 1]],
  });
  const result = await discoverCapabilities({
    cwd: root,
    headlessExecProbe: probe,
    catalogListings: { claude: listing(["fiction-latest", "fiction-old-8"]) },
  });
  assert.deepEqual(
    result.capabilities
      .filter((record) => record.role === "worker")
      .map((record) => [record.model, record.requestedModel]),
    [["fiction-model-9", "fiction-latest"]],
  );
  assert.deepEqual(
    result.diagnostics.find((entry) => entry.model === "fiction-old-8"),
    {
      agent: "Claude",
      status: "failed",
      reason: "model-not-allowed",
      model: "fiction-old-8",
    },
  );
  assert.deepEqual(
    selectWorkerRoutes(result.capabilities, { cwd: root }).map(
      (record) => record.model,
    ),
    ["fiction-model-9"],
  );
  let launched = false;
  await launchWithAdapter(
    "claude",
    {
      ...result.capabilities[0],
      issueNumber: 1,
      cwd: root,
      releasePolicy: "merged",
    },
    {
      spawnWorker: async () => {
        launched = true;
        return { pid: 1 };
      },
    },
  );
  assert.equal(launched, true);

  // If the alias starts resolving to a denied model, the route is dropped.
  reports["fiction-latest"] = "fiction-fable-10";
  const denied = await discoverCapabilities({
    cwd: root,
    headlessExecProbe: probe,
    catalogListings: { claude: listing(["fiction-latest"]) },
  });
  assert.deepEqual(denied.capabilities, []);
  assert.deepEqual(denied.diagnostics, [
    {
      agent: "Claude",
      status: "failed",
      reason: "model-denied",
      model: "fiction-latest",
    },
  ]);
});

test("capability discovery re-probes only the agent whose catalog candidates changed", async (t) => {
  const root = fixture(t, { enabled: ["opencode", "codex"] });
  const cachePath = path.join(root, "state/issue-capabilities.json");
  const opencode = { models: ["fiction/a"] },
    codex = { models: ["fiction-sol"] },
    calls = [];
  const cli = {
    ...fakeCli(root, opencode, calls),
    adapters: { codex: fakeCli(root, codex, calls) },
  };
  const first = await loadOrRefreshCapabilities({
    cwd: root,
    cachePath,
    ...cli,
  });
  assert.equal(first.reused, false);
  assert.ok(fs.existsSync(path.join(root, "state/model-catalog.json")));

  calls.length = 0;
  const reused = await loadOrRefreshCapabilities({
    cwd: root,
    cachePath,
    ...cli,
  });
  assert.equal(reused.reused, true);
  assert.deepEqual(calls, []);

  opencode.models = ["fiction/a", "fiction/b"];
  calls.length = 0;
  const changed = await loadOrRefreshCapabilities({
    cwd: root,
    cachePath,
    refreshCatalog: true,
    ...cli,
  });
  assert.deepEqual(changed.reprobedAgents, ["OpenCode"]);
  assert.deepEqual(changed.catalogRefreshedAgents, ["codex", "opencode"]);
  assert.deepEqual(
    calls.filter((call) => call[0] === "probe").map((call) => call[1]),
    ["fiction/a", "fiction/b"],
  );
  assert.deepEqual(
    [...new Set(changed.capabilities.map((record) => record.model))].sort(),
    ["fiction-sol", "fiction/a", "fiction/b"],
  );

  // A label-only change (same value, CLI path and version) still re-probes that agent alone:
  // an alias keeps its value while its label names a new generation.
  codex.labels = { "fiction-sol": "Fiction Sol Next" };
  calls.length = 0;
  const relabeled = await loadOrRefreshCapabilities({
    cwd: root,
    cachePath,
    refreshCatalog: true,
    ...cli,
  });
  assert.deepEqual(relabeled.reprobedAgents, ["Codex"]);
  assert.deepEqual(
    calls.filter((call) => call[0] === "probe").map((call) => call[1]),
    ["fiction-sol"],
  );

  // A dry run neither writes the catalog nor the capability cache.
  const catalogBefore = fs.readFileSync(
    path.join(root, "state/model-catalog.json"),
    "utf8",
  );
  const cacheBefore = fs.readFileSync(cachePath, "utf8");
  opencode.models = ["fiction/c"];
  await loadOrRefreshCapabilities({
    cwd: root,
    cachePath,
    refreshCatalog: true,
    dryRun: true,
    ...cli,
  });
  assert.equal(
    fs.readFileSync(path.join(root, "state/model-catalog.json"), "utf8"),
    catalogBefore,
  );
  assert.equal(fs.readFileSync(cachePath, "utf8"), cacheBefore);
});

test("model policy entries accept deny-only lists and reject empty shapes", async (t) => {
  const root = fixture(t, {
    enabled: ["codex"],
    models: { codex: { deny: ["*astra*"] } },
  });
  assert.deepEqual(
    [...loadRuntimeRegistry(root).deniedModels],
    [["codex", ["*astra*"]]],
  );
  for (const models of [
    { codex: {} },
    { codex: { deny: [] } },
    { codex: { deny: ["has space"] } },
    { codex: { block: ["x"] } },
  ]) {
    put(root, ".ai-template/config.json", {
      agents: { enabled: ["codex"], models },
    });
    assert.throws(
      () => loadRuntimeRegistry(root),
      /runtime-(config|models)-invalid/,
    );
  }
});

test("run.modelCatalog.maxAgeHours is the only catalog setting and must be positive", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-catalog-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (catalog) =>
    put(
      root,
      "run.yaml",
      `run:\n  maxParallel: 1\n  releasePolicy: merged\n  unavailableModels: none\n${catalog}`,
    );
  write("  modelCatalog:\n    maxAgeHours: 72\n");
  assert.deepEqual(
    (await loadOrchestratorConfig("run.yaml", { cwd: root })).modelCatalog,
    { maxAgeHours: 72 },
  );
  write("");
  assert.equal(
    (await loadOrchestratorConfig("run.yaml", { cwd: root })).modelCatalog,
    undefined,
  );
  /** @type {Array<[string, RegExp]>} */
  const invalid = [
    [
      "  modelCatalog:\n    maxAgeHours: 0\n",
      /config-invalid-model-catalog-max-age-hours/,
    ],
    [
      "  modelCatalog:\n    maxAgeHours: soon\n",
      /config-invalid-model-catalog-max-age-hours/,
    ],
    [
      "  modelCatalog:\n    refresh: true\n",
      /config-unknown-key:run.modelCatalog.refresh/,
    ],
    ["  modelCatalog: 24\n", /config-invalid-model-catalog/],
  ];
  for (const [catalog, reason] of invalid) {
    write(catalog);
    await assert.rejects(
      loadOrchestratorConfig("run.yaml", { cwd: root }),
      reason,
    );
  }
});

test("model-catalog CLI accepts only its documented commands and flags", () => {
  assert.deepEqual(
    parseModelCatalogCliArgs([
      "refresh",
      "--agent",
      "claude",
      "--agent",
      "codex",
      "--dry-run",
    ]),
    { command: "refresh", agents: ["claude", "codex"], dryRun: true },
  );
  assert.deepEqual(
    parseModelCatalogCliArgs(["show", "--max-age-hours", "12"]),
    { command: "show", agents: [], maxAgeHours: 12 },
  );
  for (const argv of [
    [],
    ["list"],
    ["refresh", "--agent"],
    ["show", "--dry-run"],
    ["show", "--max-age-hours", "-1"],
    ["refresh", "--max-age-hours", "1"],
  ])
    assert.throws(() => parseModelCatalogCliArgs(argv));
});
