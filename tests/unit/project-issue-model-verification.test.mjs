import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, readFile, writeFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverCapabilities, loadOrRefreshCapabilities, refreshWorkerRoutes, verifyWorkerRoute } from "../../scripts/project-issue-capabilities.mjs";

import { launchWithAdapter } from "../../scripts/project-issue-runtime-adapters/index.mjs";
import { selectWorkerRoutes } from "../../scripts/project-issue-plan.mjs";
import { runHeadlessExecProbe, PROBE_SCHEMA_VERSION, getRepositoryCommit } from "../../scripts/project-issue-runtime-adapters/shared.mjs";

async function fakeRuntime(t, agent) {
  const directory = await mkdtemp(path.join(tmpdir(), "example-model-verification-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = { Codex: "codex", Claude: "claude", Grok: "grok", Gemini: "gemini" }[agent];
  const cliPath = path.join(directory, name);
  const models = ["working", "unavailable", "quota", "unauthorized", "substituted", "working-last"];
  await writeFile(cliPath, `#!${process.execPath}
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    const root = require("node:path").dirname(process.argv[1]);
    const models = fs.existsSync(root + "/catalog.json")
      ? JSON.parse(fs.readFileSync(root + "/catalog.json", "utf8")) : ${JSON.stringify(models)};
    if (args.includes("status")) {
      console.log(JSON.stringify({loggedIn:true})); process.exit(0);
    }
    if (args.includes("models")) {
      console.log(JSON.stringify(${agent === "Codex" ? '{models:models.map(slug=>({slug}))}' : 'models'}));
      process.exit(0);
    }
    if (args.includes("--version")) { console.log("test-cli-1"); process.exit(0); }
    const model = args[args.indexOf(${agent === "Codex" ? '"-m"' : '"--model"'}) + 1];
    const disabled = fs.existsSync(root + "/disabled.json")
      ? JSON.parse(fs.readFileSync(root + "/disabled.json", "utf8")) : [];
    if (["unavailable", "quota", "unauthorized", ...disabled].includes(model)) {
      console.error("fake-private-diagnostic " + model); process.exit(1);
    }
    const prompt = args.at(-1);
    const target = prompt.match(/exact path:\\s*(\\S+)/)[1];
    const marker = prompt.match(/nothing else:\\s*(\\S+)/)[1];
    fs.writeFileSync(target, marker);
    console.error("model: " + (model === "substituted" ? "unexpected-model" : model));
  `);
  await chmod(cliPath, 0o755);
  return {
    directory,
    options: {
      only: [agent],
      env: { ...process.env, PATH: directory },
      pathEnv: directory,
      homeDir: directory,
      timeoutMs: 15_000,
      headlessProbeTimeoutMs: 15_000,
      ...(agent === "Claude" ? { adapters: { Claude: { candidateModels: models } } } : {}),
    },
  };
}

for (const agent of ["Codex", "Claude", "Grok", "Gemini"]) {
  test(`${agent} only exposes individually successful exact models`, async (t) => {
    const { options } = await fakeRuntime(t, agent);
    const result = await discoverCapabilities(options);
    assert.deepEqual(result.capabilities.filter(r => r.role === "worker").map(r => r.model),
      ["working", "working-last"]);
    const failures = result.diagnostics.filter(d => d.status === "failed");
    assert.deepEqual(failures.map(d => d.model), ["unavailable", "quota", "unauthorized", "substituted"]);
    assert.equal(failures.at(-1).reason, "model-mismatch");
    assert.equal(JSON.stringify(result).includes("fake-private-diagnostic"), false);
  });
}

test("fresh triage batches ignore caches and retain parent/model exclusions", async (t) => {
  const { directory, options } = await fakeRuntime(t, "Codex");
  const cachePath = path.join(directory, "cache.json");
  await writeFile(cachePath, "untouched cache");
  const first = await refreshWorkerRoutes({ ...options, cachePath, outputPath: cachePath });
  assert.deepEqual(first.workerRoutes.map(r => r.model), ["working", "working-last"]);
  await writeFile(path.join(directory, "disabled.json"), JSON.stringify(["working"]));
  const second = await refreshWorkerRoutes({ ...options, cachePath, unavailableModels: ["working-last"] });
  assert.deepEqual(second.workerRoutes, []);
  assert.equal(await readFile(cachePath, "utf8"), "untouched cache");
  const parent = await refreshWorkerRoutes({ ...options, parentAgent: "Codex" });
  assert.deepEqual(parent.workerRoutes, []);
});

test("dispatch preflight rechecks entitlement, catalog membership and exact selector", async (t) => {
  const { directory, options } = await fakeRuntime(t, "Codex");
  const { workerRoutes } = await refreshWorkerRoutes(options);
  const route = workerRoutes[0];
  assert.equal((await verifyWorkerRoute(route, options)).ok, true);
  assert.equal((await verifyWorkerRoute(route, { ...options, unavailableAgents: ["Codex"] })).ok, false);
  assert.equal((await verifyWorkerRoute({ ...route, selector: "/never/execute-this" }, options)).ok, false);
  await writeFile(path.join(directory, "disabled.json"), JSON.stringify([route.model]));
  assert.deepEqual(await verifyWorkerRoute(route, options), { ok: false, reason: "headless-exec-failed" });
  await writeFile(path.join(directory, "catalog.json"), JSON.stringify(["working-last"]));
  assert.deepEqual(await verifyWorkerRoute(route, options), { ok: false, reason: "model-not-selectable" });
});

test("a timeout or thrown probe failure does not hide later usable models or leak errors", async (t) => {
  const { options } = await fakeRuntime(t, "Codex");
  const result = await discoverCapabilities({
    ...options,
    headlessExecProbe: async ({ expectedModel }) => {
      if (expectedModel === "working") return { ok: false, reason: "verification-timeout" };
      if (expectedModel !== "working-last") throw new Error("fake-private-probe-error");
      return { ok: true };
    },
  });
  assert.deepEqual(result.capabilities.filter(r => r.role === "worker").map(r => r.model), ["working-last"]);
  assert.equal(result.diagnostics[0].reason, "verification-timeout");
  assert.equal(JSON.stringify(result).includes("fake-private-probe-error"), false);
});

for (const [outcome, reason] of [
  [{ code: null, timedOut: true }, "verification-timeout"],
  [{ code: 1 }, "headless-exec-failed"],
  [{ stdout: '{"model":"other-model"}' }, "model-mismatch"],
]) {
  test(`a written artifact cannot hide ${reason}`, async () => {
    const result = await runHeadlessExecProbe({
      cliPath: "/fake-cli", expectedModel: "requested-model",
      run: async (_command, args) => {
        const prompt = args.at(-1);
        await writeFile(prompt.match(/exact path:\s*(\S+)/)[1],
          prompt.match(/nothing else:\s*(\S+)/)[1]);
        return { code: 0, timedOut: false, stdout: "", stderr: "", ...outcome };
      },
    });
    assert.deepEqual(result, { ok: false, reason });
  });
}

test("ordinary cache reuses partial success while explicit refresh rechecks unavailable siblings", async (t) => {
  const { directory, options } = await fakeRuntime(t, "Codex");
  const cachePath = path.join(directory, "capabilities.json");
  await discoverCapabilities({ ...options, outputPath: cachePath });
  await writeFile(path.join(directory, "disabled.json"), JSON.stringify(["working"]));
  const cached = await loadOrRefreshCapabilities({ ...options, cachePath });
  assert.equal(cached.reused, true);
  assert.ok(cached.capabilities.some(r => r.model === "working"));
  const refreshed = await loadOrRefreshCapabilities({ ...options, cachePath, refresh: true });
  assert.equal(refreshed.reused, false);
  assert.equal(refreshed.capabilities.some(r => r.model === "working"), false);
  assert.ok(refreshed.capabilities.some(r => r.model === "working-last"));
});

test("an agent with no successful model is retried on the next cache read", async (t) => {
  const { directory, options } = await fakeRuntime(t, "Codex");
  const cachePath = path.join(directory, "capabilities.json");
  const disabled = path.join(directory, "disabled.json");
  await writeFile(disabled, JSON.stringify(["working", "working-last"]));
  await discoverCapabilities({ ...options, outputPath: cachePath });
  await rm(disabled);
  const recovered = await loadOrRefreshCapabilities({ ...options, cachePath });
  assert.equal(recovered.reused, false);
  assert.ok(recovered.capabilities.some(r => r.model === "working"));
});

test("Antigravity is excluded from discovery, including explicit CLI overrides", async (t) => {
  const { directory, options } = await fakeRuntime(t, "Gemini");
  const agy = path.join(directory, "agy");
  await rename(path.join(directory, "gemini"), agy);
  let invoked = 0;
  for (const adapters of [undefined, { Gemini: { cliPath: agy } }]) {
    const result = await discoverCapabilities({ ...options, adapters, runProcess: async () => { invoked++; throw Error("unexpected retired runtime"); } });
    assert.deepEqual(result.capabilities, []);
  }
  assert.equal(invoked, 0);
});

test("retired routes cannot return through explicit worker pools or dispatch", async () => {
  let spawned = 0;
  const record = { agent: "Gemini", model: "fixture", selector: '"/retired path/agy" --model fixture --print', role: "worker", selectable: true, verifiable: true, timeoutMs: 1000 };
  for (const retired of [record, { ...record, agent: "Antigravity" }, { ...record, agent: "agy" }]) {
    assert.deepEqual(selectWorkerRoutes([retired]), []);
    assert.equal((await verifyWorkerRoute(retired)).ok, false);
    await assert.rejects(launchWithAdapter(retired.agent, retired, { spawnWorker: () => { spawned++; } }), /runtime-retired/);
  }
  assert.equal(spawned, 0);
  const native = { ...record, selector: "/native/gemini --model fixture" };
  assert.deepEqual(selectWorkerRoutes([native]), [native]);
});

test("fresh-looking Antigravity cache is discarded before CLI version checks", async (t) => {
  const { directory, options } = await fakeRuntime(t, "Gemini");
  const agy = path.join(directory, "agy");
  await rename(path.join(directory, "gemini"), agy);
  const cachePath = path.join(directory, "capabilities.json");
  await writeFile(cachePath, JSON.stringify({
    probeSchemaVersion: PROBE_SCHEMA_VERSION, repositoryCommit: await getRepositoryCommit(process.cwd()),
    capabilities: [{ agent: "Gemini", model: "working", role: "worker", selector: `${agy} --model working --print`, selectable: true, verifiable: true, timeoutMs: 1000 }],
    diagnostics: [], cli: { Gemini: { path: agy, version: "test-cli-1" } },
  }));
  let invoked = 0;
  const result = await loadOrRefreshCapabilities({ ...options, cachePath, runProcess: async () => { invoked++; throw Error("retired runtime invoked"); } });
  assert.deepEqual(result.capabilities, []);
  assert.equal(result.reused, false);
  assert.equal(invoked, 0);
});
