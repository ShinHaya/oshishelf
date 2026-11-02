import { loadRuntimeRegistry } from "../../scripts/ai-template/registry.mjs";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { freshCheckoutEnv } from "./helpers/fresh-checkout.mjs";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { migrateLegacyStatePath } from "../../scripts/issue-state-migration.mjs";
import { loadOrchestratorConfig } from "../../scripts/issue-config.mjs";
import { loadOrRefreshCapabilities } from "../../scripts/issue-capabilities.mjs";
import { FileCheckpointSaver } from "../../scripts/issue-graph-checkpointer.mjs";
import { PROBE_SCHEMA_VERSION } from "../../scripts/issue-runtime-adapters/shared.mjs";

const previousPrefix = ["project", "issue"].join("-");
const previousName = (name) => name.replace(/^issue/, previousPrefix);
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-migration-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return await fs.realpath(dir);
}

const yaml = "run:\n  maxParallel: 2\n  releasePolicy: merged\n  unavailableModels: none\n";

test("config loading migrates the old name once and preserves its bytes and mode", async (t) => {
  const dir = await temporary(t);
  await fs.mkdir(path.join(dir, "state"));
  const target = path.join(dir, "state/issue-orchestrator.yaml");
  const source = path.join(path.dirname(target), previousName(path.basename(target)));
  await fs.writeFile(source, yaml, { mode: 0o600 });
  assert.equal((await loadOrchestratorConfig(undefined, { cwd: dir })).maxParallel, 2);
  assert.equal(await fs.readFile(target, "utf8"), yaml);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(source), { code: "ENOENT" });
  const messages = [];
  await migrateLegacyStatePath(target, { notify: (m) => messages.push(m) });
  assert.deepEqual(messages, []);
});

test("new and old state both survive when the new file already exists", async (t) => {
  const dir = await temporary(t);
  const target = path.join(dir, "issue-capabilities.json");
  const source = path.join(dir, previousName(path.basename(target)));
  await fs.writeFile(source, "old");
  await fs.writeFile(target, "new");
  await migrateLegacyStatePath(target, { notify: () => assert.fail("must not announce a migration") });
  assert.equal(await fs.readFile(source, "utf8"), "old");
  assert.equal(await fs.readFile(target, "utf8"), "new");
});

test("dry-run config loading reads the old state without creating files or locks", async (t) => {
  const dir = await temporary(t);
  await fs.mkdir(path.join(dir, "state"));
  const name = previousName("issue-orchestrator.yaml");
  await fs.writeFile(path.join(dir, "state", name), yaml);
  assert.equal((await loadOrchestratorConfig(undefined, { cwd: dir, dryRun: true })).maxParallel, 2);
  assert.deepEqual(await fs.readdir(path.join(dir, "state")), [name]);
});

test("capability loading reuses the migrated cache without probing a real runtime", async (t) => {
  const dir = await temporary(t);
  const cachePath = path.join(dir, "issue-capabilities.json");
  const source = path.join(dir, previousName(path.basename(cachePath)));
  const cache = { capabilities: [], diagnostics: [], cli: {}, probeSchemaVersion: PROBE_SCHEMA_VERSION, runtimeFingerprint: loadRuntimeRegistry().fingerprint };
  await fs.writeFile(source, JSON.stringify(cache));
  const loaded = await loadOrRefreshCapabilities({ cachePath, cwd: dir,
    resolveExecutable: async () => assert.fail("migration must retain a valid cache") });
  assert.equal(loaded.reused, true);
  assert.deepEqual(JSON.parse(await fs.readFile(cachePath, "utf8")), cache);
  await assert.rejects(fs.stat(source), { code: "ENOENT" });
});

test("directory migration preserves checkpoints but refuses their incompatible former format", async (t) => {
  const dir = await temporary(t);
  const target = path.join(dir, "issue-graph");
  const source = path.join(dir, previousName("issue-graph"));
  await fs.mkdir(source);
  const checkpoint = JSON.stringify({ format: `${previousPrefix}-graph-checkpoint/v1`, storage: {} });
  await fs.writeFile(path.join(source, "thread.json"), checkpoint);
  const notices = [];
  await migrateLegacyStatePath(target, { notify: (message) => notices.push(message) });
  assert.equal(notices.length, 1);
  assert.equal(await fs.readFile(path.join(target, "thread.json"), "utf8"), checkpoint);
  await assert.rejects(FileCheckpointSaver.load(path.join(target, "thread.json")), /checkpoint-format-unsupported/);
  await assert.rejects(fs.stat(source), { code: "ENOENT" });
});

test("concurrent startup migrates one file once, and unrelated names are untouched", async (t) => {
  const dir = await temporary(t);
  const target = path.join(dir, "issue-graph-checkpoint.json");
  await fs.writeFile(path.join(dir, previousName(path.basename(target))), "fixture");
  const notices = [];
  await Promise.all(Array.from({ length: 4 }, () => migrateLegacyStatePath(target, {
    notify: (message) => notices.push(message),
  })));
  assert.equal(await fs.readFile(target, "utf8"), "fixture");
  assert.equal(notices.length, 1);
  const unrelated = path.join(dir, "custom.json");
  assert.equal(await migrateLegacyStatePath(unrelated), unrelated);
  assert.deepEqual(await fs.readdir(dir), [path.basename(target)]);
});

test("legacy symlinks are refused without moving their target", async (t) => {
  const dir = await temporary(t);
  const target = path.join(dir, "issue-capabilities.json");
  const payload = path.join(dir, "payload");
  await fs.writeFile(payload, "fixture");
  await fs.symlink(payload, path.join(dir, previousName(path.basename(target))));
  await assert.rejects(migrateLegacyStatePath(target), /state-migration-unsupported-type/);
  assert.equal(await fs.readFile(payload, "utf8"), "fixture");
  await assert.rejects(fs.stat(target), { code: "ENOENT" });
});


test("CLI startup moves default legacy config and keeps stdout as a JSON plan", async (t) => {
  const dir = await temporary(t);
  const root = path.resolve(import.meta.dirname, "../..");
  await fs.cp(path.join(root, "scripts"), path.join(dir, "scripts"), { recursive: true });
  await fs.cp(path.join(root, "agents"), path.join(dir, "agents"), { recursive: true });
  await fs.symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"), "dir");
  await fs.mkdir(path.join(dir, "state"));
  const source = path.join(dir, "state", previousName("issue-orchestrator.yaml"));
  await fs.writeFile(source, yaml);
  const route = (agent, role, model) => ({ agent, role, model, selector: "fixture",
    selectable: true, verifiable: true, timeoutMs: 1000 });
  const inputPath = path.join(dir, "input.json");
  await fs.writeFile(inputPath, JSON.stringify({
    items: [{ number: 1, title: "Fictional issue", url: "https://example.invalid/1",
      status: "Ready", dependencies: [] }],
    options: { parent: { agent: "Codex", model: "fixture-parent", workerMode: "never" },
      capabilities: [route("Codex", "parent", "fixture-parent"), route("Claude", "worker", "fixture-worker")] },
  }));
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    path.join(dir, "scripts/issue-orchestrator.mjs"), "--input", inputPath, "--issues", "1",
  ], { cwd: dir, env: await freshCheckoutEnv(dir), timeout: 30000 });
  assert.equal(JSON.parse(stdout).plan.runnable[0].number, 1);
  assert.match(stderr, /\[issue-state\] migrated/);
  assert.equal(await fs.readFile(path.join(dir, "state/issue-orchestrator.yaml"), "utf8"), yaml);
  await assert.rejects(fs.stat(source), { code: "ENOENT" });
});
