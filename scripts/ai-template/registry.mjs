import {
  buildRuntimeEnvironment,
  mergeEnvironmentPolicies,
  validateEnvironmentPolicy,
} from "../issue-runtime-adapters/environment.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  hasControlCharacter,
  loadRepositoryConfig,
} from "../repository-config.mjs";
import { validateUsageDefinition } from "../issue-runtime-adapters/usage.mjs";
import { validateSchema } from "./schema.mjs";

export const templateRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`runtime-config-unreadable:${path.basename(file)}`);
  }
};
export function relativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    value.includes("\\") ||
    hasControlCharacter(value) ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((p) => !p || p === "." || p === "..") ||
    value.split("/").includes(".git")
  )
    throw new Error("runtime-path-invalid");
  return value;
}

/** Re-read settings per operation so disabling a runtime invalidates live/cached routes. */
export function loadRuntimeRegistry(root = process.cwd()) {
  root = path.resolve(root);
  const sourceRoot = fs.existsSync(path.join(root, "agents/runtimes"))
    ? root
    : templateRoot;
  const schema = readJson(
    path.join(templateRoot, "agents/runtimes.schema.json"),
  );
  const configSchema = readJson(
    path.join(templateRoot, "agents/config.schema.json"),
  );
  const configFile = path.join(root, ".ai-template/config.json");
  const config = fs.existsSync(configFile) ? readJson(configFile) : {};
  if (config.agents && Object.hasOwn(config.agents, "environment")) {
    const policies = config.agents.environment;
    if (!policies || typeof policies !== "object" || Array.isArray(policies))
      throw new Error("runtime-env-policy-invalid");
    for (const policy of Object.values(policies))
      validateEnvironmentPolicy(policy);
  }
  validateSchema(config, configSchema);
  loadRepositoryConfig(root); // Repository settings retain their separate strict contract.
  const runtimes = [];
  const aliases = new Map();
  const commands = new Map();
  for (const directory of [
    path.join(sourceRoot, "agents/runtimes"),
    path.join(root, ".ai-template/runtimes"),
  ]) {
    if (!fs.existsSync(directory)) continue;
    for (const file of fs
      .readdirSync(directory)
      .filter((f) => f.endsWith(".json"))
      .sort()) {
      const runtime = readJson(path.join(directory, file));
      validateEnvironmentPolicy(runtime.environment);
      validateSchema(runtime, schema, file);
      validateUsageDefinition(runtime.usage);
      if (runtime.usage && runtime.usageUnavailable)
        throw new Error("runtime-usage-conflict");
      if (file !== `${runtime.id}.json`)
        throw new Error("runtime-id-filename-mismatch");
      if (
        !runtime.retired &&
        ["models", "selectorArgs", "probeArgs", "promptArgs", "skills"].some(
          (k) => runtime[k] === undefined,
        )
      )
        throw new Error(`runtime-definition-incomplete:${runtime.id}`);
      for (const alias of [runtime.id, runtime.name, ...runtime.aliases]) {
        const key = alias.toLowerCase();
        if (alias !== alias.trim() || !/^[a-z][a-z0-9-]*$/i.test(alias))
          throw new Error("runtime-alias-invalid");
        if (aliases.has(key) && aliases.get(key) !== runtime)
          throw new Error(`runtime-alias-conflict:${key}`);
        aliases.set(key, runtime);
      }
      for (const command of runtime.commands) {
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(command))
          throw new Error("runtime-command-invalid");
        if (commands.has(command.toLowerCase()))
          throw new Error("runtime-command-conflict");
        commands.set(command.toLowerCase(), runtime);
      }
      if (!runtime.retired && runtime.permissions === undefined)
        throw new Error(`runtime-definition-incomplete:${runtime.id}`);
      for (const arg of [
        ...(runtime.selectorArgs ?? []),
        ...(runtime.probeArgs ?? []),
        ...(runtime.promptArgs ?? []),
      ]) {
        if (/[{}]/.test(arg) && arg !== "{model}")
          throw new Error("runtime-argument-placeholder-invalid");
        // Permission arguments come only from the permission profiles, never from a selector.
        if (isPermissionArgument(arg, runtime))
          throw new Error(`runtime-permission-flag-misplaced:${runtime.id}`);
      }
      validatePermissionDefinition(runtime);
      // A control-protocol listing replaces the list command and needs its own parser.
      if (
        runtime.models &&
        ((runtime.models.parser === "claude-initialize") !==
          Boolean(runtime.models.control) ||
          (runtime.models.control &&
            (runtime.models.args.length ||
              runtime.models.control.args.some((arg) => /[{}]/.test(arg)))))
      )
        throw new Error(`runtime-models-control-invalid:${runtime.id}`);
      for (const dir of runtime.skills?.discoveryDirs ?? []) relativePath(dir);
      if (runtime.subagents) {
        relativePath(runtime.subagents.directory);
        if (
          runtime.subagents.format === "agent-json" &&
          Object.values(runtime.subagents.models).some((m) => m !== "inherit")
        )
          throw new Error("runtime-agent-json-model-must-inherit");
      }
      for (const hook of runtime.hooks ?? []) relativePath(hook.file);
      runtimes.push(runtime);
    }
  }
  runtimes.sort(
    (a, b) => a.evaluationOrder - b.evaluationOrder || a.id.localeCompare(b.id),
  );
  const enabledIds =
    config.agents?.enabled ??
    runtimes.filter((r) => r.enabledByDefault && !r.retired).map((r) => r.id);
  for (const id of enabledIds) {
    const runtime = aliases.get(id);
    if (!runtime || id !== runtime.id || runtime.retired)
      throw new Error(`runtime-enabled-invalid:${id}`);
  }
  for (const skill of config.localSkills ?? [])
    if (!/^[a-z0-9][a-z0-9-]*$/.test(skill))
      throw new Error("runtime-local-skill-invalid");
  const enabled = runtimes.filter(
    (r) => enabledIds.includes(r.id) && !r.retired,
  );
  // Optional per-runtime model policy. Keys must be exact IDs of enabled runtimes.
  // `allow` is an exact list; `deny` is a case-insensitive `*` pattern list that wins over `allow`.
  const allowedModels = new Map();
  const deniedModels = new Map();
  for (const [id, entry] of Object.entries(config.agents?.models ?? {}).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const runtime = aliases.get(id);
    if (!runtime || id !== runtime.id || !enabled.includes(runtime))
      throw new Error(`runtime-models-invalid:${id}`);
    if (!entry.allow && !entry.deny)
      throw new Error(`runtime-models-invalid:${id}`);
    if (entry.allow) allowedModels.set(id, [...entry.allow].sort());
    if (entry.deny) deniedModels.set(id, [...entry.deny].sort());
  }
  const permissions = loadPermissionPolicy(config.agents?.permissions, {
    aliases,
    enabled,
  });
  for (const [id, policy] of Object.entries(config.agents?.environment ?? {})) {
    const runtime = aliases.get(id);
    if (!runtime || runtime.id !== id || runtime.retired)
      throw new Error("runtime-env-policy-invalid");
    validateEnvironmentPolicy(policy);
  }
  for (const runtime of runtimes)
    runtime.environment = mergeEnvironmentPolicies(
      runtime.environment,
      config.agents?.environment?.[runtime.id],
    );
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        runtimes,
        enabledIds,
        ...(allowedModels.size ? { allowedModels: [...allowedModels] } : {}),
        ...(deniedModels.size ? { deniedModels: [...deniedModels] } : {}),
        permissions,
      }),
    )
    .digest("hex");
  return {
    permissions,
    root,
    sourceRoot,
    runtimes,
    enabled,
    aliases,
    commands,
    allowedModels,
    deniedModels,
    localSkills: config.localSkills ?? [],
    fingerprint,
  };
}

/** Case-insensitive match where `*` is the only wildcard; every other character is literal. */
export function matchesModelPattern(pattern, value) {
  if (typeof value !== "string" || !value) return false;
  const source = String(pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "i").test(value);
}

/** The identifiers a route or catalog entry is known by: canonical `model` and the requested value. */
function identifiers(model, requestedModel) {
  return [model, requestedModel].filter(
    (value) => typeof value === "string" && value.length > 0,
  );
}

/** True when the runtime's `deny` list matches the model or its requested value. */
export function isModelDenied(
  agent,
  model,
  root = process.cwd(),
  requestedModel,
) {
  const registry = loadRuntimeRegistry(root);
  const runtime = registry.aliases.get(
    String(agent ?? "")
      .trim()
      .toLowerCase(),
  );
  const denied = runtime ? registry.deniedModels.get(runtime.id) : undefined;
  return (
    Boolean(denied) &&
    identifiers(model, requestedModel).some((value) =>
      denied.some((pattern) => matchesModelPattern(pattern, value)),
    )
  );
}

/**
 * True unless the runtime declares an allowlist containing neither identifier, or a deny pattern matches.
 * The allowlist is exact: no wildcards, suffixes or case folding. `requestedModel` is the value the
 * catalog passes to `--model`, which differs from `model` only for runtimes that resolve aliases.
 */
export function isModelAllowed(
  agent,
  model,
  root = process.cwd(),
  requestedModel,
) {
  const registry = loadRuntimeRegistry(root);
  const runtime = registry.aliases.get(
    String(agent ?? "")
      .trim()
      .toLowerCase(),
  );
  const allowed = runtime ? registry.allowedModels.get(runtime.id) : undefined;
  if (isModelDenied(agent, model, root, requestedModel)) return false;
  return (
    !allowed ||
    identifiers(model, requestedModel).some((value) => allowed.includes(value))
  );
}
export function findRuntime(
  value,
  root = process.cwd(),
  { enabledOnly = false } = {},
) {
  const registry = loadRuntimeRegistry(root);
  const runtime = registry.aliases.get(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
  return runtime && (!enabledOnly || registry.enabled.includes(runtime))
    ? runtime
    : null;
}
export function isRetiredCommand(command, root = process.cwd()) {
  const name = String(command ?? "")
    .split(/[\\/]/)
    .at(-1)
    .replace(/\.exe$/i, "")
    .toLowerCase();
  return loadRuntimeRegistry(root).commands.get(name)?.retired === true;
}

/** Named permission profiles a runtime definition may declare. */
export const PERMISSION_PROFILES = Object.freeze([
  "workspace-write",
  "worktree-setup",
  "read-only",
  "bypass",
]);
/** The worker roles a profile is chosen for; a single worker runs as the implementer. */
export const PERMISSION_ROLES = Object.freeze([
  "implementer",
  "planner",
  "reviewer",
]);
export const DEFAULT_ROLE_PROFILES = Object.freeze({
  implementer: "workspace-write",
  planner: "worktree-setup",
  reviewer: "read-only",
});
/**
 * Arguments that skip or loosen a CLI's permission checks on any runtime. They may
 * appear only in a runtime's `bypass` profile, never in a selector or another profile.
 */
const BYPASS_TOKENS = Object.freeze([
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--dangerously-bypass-approvals-and-sandbox",
  "--always-approve",
  "--approve-for-me",
  "--auto",
  "--yolo",
  "--full-auto",
  "bypassPermissions",
]);

const matchesFlag = (arg, flag) => arg === flag || arg.startsWith(`${flag}=`);
const isBypassToken = (arg) =>
  BYPASS_TOKENS.some((token) => matchesFlag(String(arg), token));

/** True when `arg` belongs to the permission layer: a reserved flag of this runtime or a bypass token. */
export function isPermissionArgument(arg, runtime) {
  const text = String(arg ?? "");
  return (
    isBypassToken(text) ||
    (runtime?.permissions?.flags ?? []).some((flag) => matchesFlag(text, flag))
  );
}

function allowPlaceholder(runtime) {
  const allowArgs = runtime.permissions.allowArgs;
  if (!allowArgs) return null;
  const placeholders = allowArgs.filter((arg) => /[{}]/.test(arg));
  if (placeholders.length !== 1)
    throw new Error(`runtime-permission-allow-args-invalid:${runtime.id}`);
  const [arg] = placeholders;
  if (arg === "{rule}") return "rule";
  if (arg.replace("{rules}", "").includes("{") || !arg.includes("{rules}"))
    throw new Error(`runtime-permission-allow-args-invalid:${runtime.id}`);
  if (arg.replace("{rules}", "").includes("}"))
    throw new Error(`runtime-permission-allow-args-invalid:${runtime.id}`);
  return "rules";
}

/** A joined `{rules}` list is comma-separated, so a rule must not contain a comma itself. */
function validateAllowRules(runtime, rules) {
  const form = allowPlaceholder(runtime);
  if (!form)
    throw new Error(`runtime-permission-allow-unsupported:${runtime.id}`);
  for (const rule of rules)
    if (
      rule !== rule.trim() ||
      hasControlCharacter(rule) ||
      (form === "rules" && rule.includes(","))
    )
      throw new Error(`runtime-permission-rule-invalid:${runtime.id}`);
}

function validatePermissionDefinition(runtime) {
  const permissions = runtime.permissions;
  if (!permissions) return;
  const fail = () => {
    throw new Error(`runtime-permission-profile-invalid:${runtime.id}`);
  };
  allowPlaceholder(runtime);
  const reserved = (arg) =>
    !arg.startsWith("-") ||
    permissions.flags.some((flag) => matchesFlag(arg, flag));
  for (const arg of permissions.allowArgs ?? [])
    if (arg !== "{rule}" && !reserved(arg))
      throw new Error(`runtime-permission-flag-unreserved:${runtime.id}`);
  for (const [name, profile] of Object.entries(permissions.profiles)) {
    if (profile.args.some((arg) => /[{}]/.test(arg)))
      throw new Error("runtime-argument-placeholder-invalid");
    // Every flag a profile sets is reserved, so a route selector can never set it again.
    if (profile.args.some((arg) => !reserved(arg)))
      throw new Error(`runtime-permission-flag-unreserved:${runtime.id}`);
    if (name === "bypass") {
      if (profile.enforcement !== "none" || profile.allow) fail();
    } else if (
      profile.enforcement === "none" ||
      profile.args.some(isBypassToken)
    )
      fail();
    if (profile.allow) validateAllowRules(runtime, profile.allow);
  }
}

/**
 * Normalize repository config `agents.permissions`. Bypass is never a default: a role
 * may map to `bypass` only when every enabled runtime is named in `allowBypass`.
 */
function loadPermissionPolicy(raw = {}, { aliases, enabled }) {
  const enabledRuntime = (id) => {
    const runtime = aliases.get(String(id).toLowerCase());
    if (!runtime || runtime.id !== id || !enabled.includes(runtime))
      throw new Error(`runtime-permission-invalid:${id}`);
    return runtime;
  };
  const roles = { ...DEFAULT_ROLE_PROFILES, ...(raw.roles ?? {}) };
  const allowBypass = [...(raw.allowBypass ?? [])].sort();
  for (const id of allowBypass)
    if (!enabledRuntime(id).permissions.profiles.bypass)
      throw new Error(`runtime-permission-bypass-undefined:${id}`);
  if (Object.values(roles).includes("bypass"))
    for (const runtime of enabled)
      if (!allowBypass.includes(runtime.id))
        throw new Error(`runtime-permission-bypass-not-allowed:${runtime.id}`);
  const runtimes = {};
  for (const [id, profiles] of Object.entries(raw.runtimes ?? {}).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const runtime = enabledRuntime(id);
    runtimes[id] = {};
    for (const [name, entry] of Object.entries(profiles).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (!runtime.permissions.profiles[name])
        throw new Error(`runtime-permission-invalid:${id}`);
      validateAllowRules(runtime, entry.allow);
      runtimes[id][name] = { allow: [...entry.allow] };
    }
  }
  return {
    roles: Object.fromEntries(PERMISSION_ROLES.map((r) => [r, roles[r]])),
    allowBypass,
    requireEnforcement: [...(raw.requireEnforcement ?? [])].sort(),
    runtimes,
  };
}

function expandAllowArgs(runtime, rules) {
  if (!rules.length) return [];
  const form = allowPlaceholder(runtime);
  if (form === "rule")
    return rules.flatMap((rule) =>
      runtime.permissions.allowArgs.map((arg) =>
        arg === "{rule}" ? rule : arg,
      ),
    );
  return runtime.permissions.allowArgs.map((arg) =>
    arg.replace("{rules}", rules.join(",")),
  );
}

/**
 * The permission profile, argv and enforcement a runtime runs `role` with. The argv
 * is passed to spawn as-is (never re-split), so rules containing spaces stay intact.
 * @param {ReturnType<typeof loadRuntimeRegistry>} registry
 * @param {{ id: string, permissions?: any }} runtime
 * @param {string} [role] - omitted for a single worker, which runs as the implementer
 */
export function resolvePermission(registry, runtime, role = "implementer") {
  if (!PERMISSION_ROLES.includes(role))
    throw new Error(`runtime-permission-role-invalid:${role}`);
  const profileName = registry.permissions.roles[role];
  const profile = runtime?.permissions?.profiles?.[profileName];
  if (!profile)
    throw new Error(`runtime-permission-unavailable:${runtime?.id}`);
  const allow =
    registry.permissions.runtimes[runtime.id]?.[profileName]?.allow ??
    profile.allow ??
    [];
  const args = [...profile.args, ...expandAllowArgs(runtime, allow)];
  const unavailable = !profile.network
    ? "route-permission-insufficient"
    : registry.permissions.requireEnforcement.includes(profileName) &&
        profile.enforcement !== "cli"
      ? "route-permission-unenforced"
      : null;
  return {
    role,
    profile: profileName,
    args,
    enforcement: profile.enforcement,
    network: profile.network,
    ...(unavailable ? { unavailable } : {}),
  };
}

/**
 * The roles a runtime can run under the current policy, and a fingerprint of every
 * role's resolved argv. A route probed under another policy no longer matches it.
 */
export function runtimePermissionSummary(registry, runtime) {
  const resolved = PERMISSION_ROLES.map((role) =>
    resolvePermission(registry, runtime, role),
  );
  return {
    roles: resolved.filter((r) => !r.unavailable).map((r) => r.role),
    fingerprint: createHash("sha256")
      .update(JSON.stringify(resolved))
      .digest("hex"),
  };
}

/** The current permission fingerprint of an enabled runtime, or null when it is not enabled. */
export function permissionFingerprintFor(agent, root = process.cwd()) {
  const registry = loadRuntimeRegistry(root);
  const runtime = registry.aliases.get(
    String(agent ?? "")
      .trim()
      .toLowerCase(),
  );
  return runtime && registry.enabled.includes(runtime)
    ? runtimePermissionSummary(registry, runtime).fingerprint
    : null;
}

/** Resolve overrides by canonical runtime ID, including for caller-supplied definitions. */
export function runtimeEnvironment(definition, ctx = {}, lease = undefined) {
  const registered = findRuntime(definition.id ?? definition.name, ctx.cwd);
  const policy = mergeEnvironmentPolicies(
    definition.environment,
    registered?.environment,
  );
  return buildRuntimeEnvironment({
    parentEnv: ctx.env ?? process.env,
    policy,
    lease,
  });
}
