#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadRuntimeRegistry } from "./ai-template/registry.mjs";
import { generate } from "./ai-template/generate.mjs";
import { check, renderSyncSummary, sync } from "./ai-template/sync.mjs";
import { loadConsumers } from "./ai-template/consumers.mjs";

const USAGE = "usage: ai-template.mjs agents list | agents resolve=<alias> | generate | check | test" +
  " | sync --from <template> [--adopt] [--source-repository <owner/name>] [--pr-body <file>]" +
  " | consumers [--repo <owner/name>] [--root <path>]";
function take(args, flag, { value = true } = {}) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  if (!value) { args.splice(index, 1); return true; }
  if (!args[index + 1] || args[index + 1].startsWith("--")) throw new Error(`ai-template-${flag.slice(2)}-missing`);
  return args.splice(index, 2)[1];
}

export function run(argv, root = process.cwd()) {
  const args = [...argv];
  const rootArg = take(args, "--root");
  if (rootArg !== undefined) root = path.resolve(rootArg);
  if (args.length === 2 && args[0] === "agents" && args[1] === "list") {
    const registry = loadRuntimeRegistry(root);
    return registry.runtimes.map(r => ({ id: r.id, name: r.name, aliases: r.aliases,
      status: r.retired ? "retired" : registry.enabled.includes(r) ? "enabled" : "disabled" }));
  }
  if (args.length === 2 && args[0] === "agents" && args[1].startsWith("resolve=")) {
    const r = loadRuntimeRegistry(root).aliases.get(args[1].slice(8).trim().toLowerCase());
    if (!r || r.retired) throw new Error("runtime-agent-invalid");
    return r.id;
  }
  if (args.length === 1 && args[0] === "generate") return generate(root);
  if (args.length === 1 && args[0] === "check") return check(root);
  if (args[0] === "sync") {
    const from = take(args, "--from");
    const adopt = take(args, "--adopt", { value: false }) ?? false;
    const sourceRepository = take(args, "--source-repository");
    const body = take(args, "--pr-body");
    if (!from || args.length !== 1) throw new Error(USAGE);
    const result = sync({ from: path.resolve(from), root, adopt, sourceRepository });
    if (body) fs.writeFileSync(body, renderSyncSummary(result, { sourceRepository }));
    return result;
  }
  if (args[0] === "consumers") {
    const repo = take(args, "--repo");
    if (args.length !== 1) throw new Error(USAGE);
    const consumers = loadConsumers(path.join(root, "sync/consumers.json"));
    const selected = repo ? consumers.filter(c => c.repo.toLowerCase() === repo.toLowerCase()) : consumers;
    if (repo && !selected.length) throw new Error("consumers-repo-unknown");
    return selected;
  }
  throw new Error(USAGE);
}

/** Run the managed suite without a shell so file names are never interpreted. */
export function runTests(root = process.cwd()) {
  const directory = path.join(root, "tests/ai-template");
  const files = fs.readdirSync(directory).filter(f => f.endsWith(".test.mjs")).sort().map(f => path.join(directory, f));
  if (!files.length) throw new Error("ai-template-tests-missing");
  return spawnSync(process.execPath, ["--test", ...files], { cwd: root, stdio: "inherit" }).status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === "test") {
      if (args.length > 1) throw new Error(USAGE);
      process.exitCode = runTests();
    } else {
      const result = run(args);
      console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
      if (args.includes("check") && result.ok === false) {
        console.error("Managed or generated files differ from the template. Fix managed files in the template repository, then sync; rerun `generate` for generated files.");
        process.exitCode = 1;
      }
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
