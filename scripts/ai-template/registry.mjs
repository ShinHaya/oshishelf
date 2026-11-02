import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { hasControlCharacter, loadRepositoryConfig } from "../repository-config.mjs";
import { validateUsageDefinition } from "../issue-runtime-adapters/usage.mjs";
import { validateSchema } from "./schema.mjs";

export const templateRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const readJson = file => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`runtime-config-unreadable:${path.basename(file)}`); }
};
export function relativePath(value) {
  if (typeof value !== "string" || !value || value !== value.trim() || value.includes("\\") || hasControlCharacter(value) ||
    path.posix.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.split("/").some(p => !p || p === "." || p === "..") ||
    value.split("/").includes(".git")) throw new Error("runtime-path-invalid");
  return value;
}

/** Re-read settings per operation so disabling a runtime invalidates live/cached routes. */
export function loadRuntimeRegistry(root = process.cwd()) {
  root = path.resolve(root);
  const sourceRoot = fs.existsSync(path.join(root, "agents/runtimes")) ? root : templateRoot;
  const schema = readJson(path.join(templateRoot, "agents/runtimes.schema.json"));
  const configSchema = readJson(path.join(templateRoot, "agents/config.schema.json"));
  const configFile = path.join(root, ".ai-template/config.json");
  const config = fs.existsSync(configFile) ? readJson(configFile) : {};
  validateSchema(config, configSchema);
  loadRepositoryConfig(root); // Repository settings retain their separate strict contract.
  const runtimes = [];
  const aliases = new Map();
  const commands = new Map();
  for (const directory of [path.join(sourceRoot, "agents/runtimes"), path.join(root, ".ai-template/runtimes")]) {
    if (!fs.existsSync(directory)) continue;
    for (const file of fs.readdirSync(directory).filter(f => f.endsWith(".json")).sort()) {
      const runtime = readJson(path.join(directory, file));
      validateSchema(runtime, schema, file);
      validateUsageDefinition(runtime.usage);
      if (runtime.usage && runtime.usageUnavailable) throw new Error("runtime-usage-conflict");
      if (file !== `${runtime.id}.json`) throw new Error("runtime-id-filename-mismatch");
      if (!runtime.retired && ["models", "selectorArgs", "probeArgs", "promptArgs", "skills"].some(k => runtime[k] === undefined))
        throw new Error(`runtime-definition-incomplete:${runtime.id}`);
      for (const alias of [runtime.id, runtime.name, ...runtime.aliases]) {
        const key = alias.toLowerCase();
        if (alias !== alias.trim() || !/^[a-z][a-z0-9-]*$/i.test(alias)) throw new Error("runtime-alias-invalid");
        if (aliases.has(key) && aliases.get(key) !== runtime) throw new Error(`runtime-alias-conflict:${key}`);
        aliases.set(key, runtime);
      }
      for (const command of runtime.commands) {
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(command)) throw new Error("runtime-command-invalid");
        if (commands.has(command.toLowerCase())) throw new Error("runtime-command-conflict");
        commands.set(command.toLowerCase(), runtime);
      }
      for (const arg of [...(runtime.selectorArgs ?? []), ...(runtime.probeArgs ?? []), ...(runtime.promptArgs ?? [])])
        if (/[{}]/.test(arg) && arg !== "{model}") throw new Error("runtime-argument-placeholder-invalid");
      for (const dir of runtime.skills?.discoveryDirs ?? []) relativePath(dir);
      if (runtime.subagents) {
        relativePath(runtime.subagents.directory);
        if (runtime.subagents.format === "agent-json" && Object.values(runtime.subagents.models).some(m => m !== "inherit"))
          throw new Error("runtime-agent-json-model-must-inherit");
      }
      for (const hook of runtime.hooks ?? []) relativePath(hook.file);
      runtimes.push(runtime);
    }
  }
  runtimes.sort((a,b) => a.evaluationOrder - b.evaluationOrder || a.id.localeCompare(b.id));
  const enabledIds = config.agents?.enabled ?? runtimes.filter(r => r.enabledByDefault && !r.retired).map(r => r.id);
  for (const id of enabledIds) {
    const runtime = aliases.get(id);
    if (!runtime || id !== runtime.id || runtime.retired) throw new Error(`runtime-enabled-invalid:${id}`);
  }
  for (const skill of config.localSkills ?? []) if (!/^[a-z0-9][a-z0-9-]*$/.test(skill)) throw new Error("runtime-local-skill-invalid");
  const enabled = runtimes.filter(r => enabledIds.includes(r.id) && !r.retired);
  const fingerprint = createHash("sha256").update(JSON.stringify({ runtimes, enabledIds })).digest("hex");
  return { root, sourceRoot, runtimes, enabled, aliases, commands, localSkills: config.localSkills ?? [], fingerprint };
}
export function findRuntime(value, root = process.cwd(), { enabledOnly = false } = {}) {
  const registry = loadRuntimeRegistry(root);
  const runtime = registry.aliases.get(String(value ?? "").trim().toLowerCase());
  return runtime && (!enabledOnly || registry.enabled.includes(runtime)) ? runtime : null;
}
export function isRetiredCommand(command, root = process.cwd()) {
  const name = String(command ?? "").split(/[\\/]/).at(-1).replace(/\.exe$/i, "").toLowerCase();
  return loadRuntimeRegistry(root).commands.get(name)?.retired === true;
}
