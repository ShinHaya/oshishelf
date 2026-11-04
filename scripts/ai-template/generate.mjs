import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import {
  loadRuntimeRegistry,
  relativePath,
  templateRoot,
} from "./registry.mjs";

export const hash = (text) => createHash("sha256").update(text).digest("hex");
function writeAtomic(file, contents) {
  const temporary = `${file}.ai-template-${randomBytes(8).toString("hex")}`;
  const mode = exists(file)?.mode & 0o777 || 0o600;
  try {
    fs.writeFileSync(temporary, contents, { flag: "wx", mode });
    fs.renameSync(temporary, file);
  } finally {
    if (exists(temporary)) fs.unlinkSync(temporary);
  }
}
const json = (value) => JSON.stringify(value, null, 2) + "\n";
export const exists = (file) => {
  try {
    return fs.lstatSync(file);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
};
export function safePath(root, relative) {
  relativePath(relative);
  let parent = root;
  for (const part of relative.split("/").slice(0, -1)) {
    parent = path.join(parent, part);
    const stat = exists(parent);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error(`generated-parent-unsafe:${relative}`);
  }
  return path.join(root, relative);
}
/** @returns {Record<string, string>} frontmatter fields plus `body` */
function roleSource(file) {
  const text = fs.readFileSync(file, "utf8");
  const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) throw new Error("role-frontmatter-invalid");
  /** @type {Record<string, string>} */
  const meta = {};
  for (const line of match[1].split("\n")) {
    const item = line.match(/^(name|description|tier|tools): (.+)$/);
    if (!item || Object.hasOwn(meta, item[1]))
      throw new Error("role-frontmatter-invalid");
    try {
      meta[item[1]] = JSON.parse(item[2]);
    } catch {
      meta[item[1]] = item[2];
    }
  }
  if (
    !/^[a-z][a-z0-9-]*$/.test(meta.name) ||
    typeof meta.description !== "string" ||
    !meta.description ||
    !["reasoning", "fast"].includes(meta.tier) ||
    !["read-only", "edit"].includes(meta.tools) ||
    path.basename(file) !== `${meta.name}.md`
  )
    throw new Error("role-frontmatter-invalid");
  return { ...meta, body: match[2].trim() + "\n" };
}
function renderRole(role, spec) {
  const model = spec.models[role.tier];
  if (spec.format === "agent-json")
    return json({
      name: role.name,
      displayName: role.name,
      description: role.description,
      hidden: false,
      customAgentSpec: {
        customAgent: {
          systemPromptSections: [
            { title: "Instructions", content: role.body.trim() },
          ],
        },
      },
    });
  const front = { name: role.name, description: role.description };
  if (model !== "inherit") front.model = model;
  if (spec.format === "claude-markdown")
    front.tools =
      role.tools === "read-only"
        ? "Read, Grep, Glob"
        : "Read, Edit, Write, Grep, Glob, Bash";
  else {
    front.mode = "subagent";
    front.permission =
      role.tools === "read-only"
        ? { "*": "deny", read: "allow", grep: "allow", glob: "allow" }
        : {
            read: "allow",
            edit: "allow",
            grep: "allow",
            glob: "allow",
            bash: "allow",
          };
  }
  return `---\n${Object.entries(front)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n")}\n---\n\n${role.body}`;
}

/** Plan and validate everything before touching generated files or settings. */
export function generate(root = process.cwd(), { dryRun = false } = {}) {
  root = fs.realpathSync(root);
  const registry = loadRuntimeRegistry(root);
  const statePath = safePath(root, ".ai-template/generated.json");
  if (exists(statePath)?.isSymbolicLink())
    throw new Error("generated-state-unsafe");
  const previous = exists(statePath)
    ? JSON.parse(fs.readFileSync(statePath, "utf8"))
    : { version: 1, files: {}, hooks: [] };
  if (
    previous.version !== 1 ||
    !previous.files ||
    typeof previous.files !== "object" ||
    Array.isArray(previous.files) ||
    !Array.isArray(previous.hooks)
  )
    throw new Error("generated-state-invalid");
  const legacy = JSON.parse(
    fs.readFileSync(
      path.join(templateRoot, "agents/legacy-generated.json"),
      "utf8",
    ),
  );
  const outputs = new Map();
  function add(file, output) {
    safePath(root, file);
    if (
      [
        "skills",
        "scripts",
        "agents",
        ".ai-template",
        ".github",
        ".githooks",
      ].includes(file.split("/")[0])
    )
      throw new Error("generated-source-collision");
    if (outputs.has(file) && json(outputs.get(file)) !== json(output))
      throw new Error(`generated-output-conflict:${file}`);
    outputs.set(file, output);
  }
  const skillsDir = safePath(root, "skills/index"); // Check the directory itself is not a symlink.
  const skills = exists(path.dirname(skillsDir))
    ? fs
        .readdirSync(path.dirname(skillsDir))
        .filter(
          (name) =>
            /^[a-z0-9][a-z0-9-]*$/.test(name) &&
            exists(safePath(root, `skills/${name}/SKILL.md`))?.isFile(),
        )
    : [];
  for (const name of registry.localSkills)
    if (!skills.includes(name)) throw new Error(`local-skill-missing:${name}`);
  const roleDir = path.join(registry.sourceRoot, "agents/roles");
  const roles = fs.existsSync(roleDir)
    ? fs
        .readdirSync(roleDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => roleSource(path.join(roleDir, f)))
    : [];
  for (const runtime of registry.enabled) {
    for (const dir of runtime.skills.discoveryDirs)
      for (const skill of skills.sort()) {
        const file = `${dir}/${skill}`;
        if (file === `skills/${skill}`)
          throw new Error("generated-source-collision");
        add(file, {
          type: "link",
          target: path.posix.relative(
            path.posix.dirname(file),
            `skills/${skill}`,
          ),
        });
      }
    if (runtime.subagents)
      for (const role of roles) {
        const spec = runtime.subagents;
        const file = `${spec.directory}/${role.name}${spec.format === "agent-json" ? "/agent.json" : ".md"}`;
        if (file.startsWith("agents/roles/"))
          throw new Error("generated-source-collision");
        add(file, { type: "file", content: renderRole(role, spec) });
      }
  }
  const files = {};
  const writes = [],
    removals = [];
  const matches = (file, stat, entry) =>
    entry?.type === "link"
      ? stat?.isSymbolicLink() && fs.readlinkSync(file) === entry.target
      : entry?.type === "file" &&
        stat?.isFile() &&
        !stat.isSymbolicLink() &&
        hash(fs.readFileSync(file)) === entry.hash;
  for (const [relative, output] of outputs) {
    const file = safePath(root, relative),
      stat = exists(file);
    const owned = previous.files[relative];
    const desired =
      output.type === "link"
        ? output
        : { type: "file", hash: hash(output.content) };
    const exact = matches(file, stat, desired);
    const legacyMatch =
      stat?.isFile() &&
      !stat.isSymbolicLink() &&
      legacy[relative]?.type === "file" &&
      legacy[relative].hash === hash(fs.readFileSync(file));
    if (stat && !matches(file, stat, owned) && !legacyMatch && !exact)
      throw new Error(`generated-collision:${relative}`);
    files[relative] = desired;
    if (!exact) writes.push([file, output]);
  }
  // On first adoption, unchanged legacy outputs of disabled runtimes can be removed.
  const obsolete = { ...legacy, ...previous.files };
  for (const [relative, entry] of Object.entries(obsolete)) {
    if (outputs.has(relative)) continue;
    const file = safePath(root, relative),
      stat = exists(file);
    if (!stat) continue;
    if (!matches(file, stat, entry))
      throw new Error(`generated-edited:${relative}`);
    removals.push(file);
  }
  const hooks = [];
  const hookFiles = new Set([
    ...previous.hooks.map((h) => h.file),
    ...registry.runtimes.flatMap((r) => (r.hooks ?? []).map((h) => h.file)),
  ]);
  const settingsWrites = [];
  for (const relative of hookFiles) {
    if (
      !/^\.[^/]+\/.+\.json$/.test(relative) ||
      relative.startsWith(".ai-template/")
    )
      throw new Error("generated-settings-path-invalid");
    const file = safePath(root, relative),
      stat = exists(file);
    if (stat && (!stat.isFile() || stat.isSymbolicLink()))
      throw new Error(`generated-settings-unsafe:${relative}`);
    const settings = stat ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
    if (
      !settings ||
      typeof settings !== "object" ||
      Array.isArray(settings) ||
      (settings.hooks !== undefined &&
        (!settings.hooks ||
          typeof settings.hooks !== "object" ||
          Array.isArray(settings.hooks)))
    )
      throw new Error("generated-settings-invalid");
    const before = json(settings);
    settings.hooks ??= {};
    // Entries are identified by exact recorded bytes, never by a broad matcher.
    const old = [
      ...previous.hooks.filter((h) => h.file === relative),
      ...registry.runtimes.flatMap((r) =>
        (r.hooks ?? []).filter((h) => h.file === relative),
      ),
    ];
    for (const h of old) {
      if (
        settings.hooks[h.event] !== undefined &&
        !Array.isArray(settings.hooks[h.event])
      )
        throw new Error("generated-settings-invalid");
      if (settings.hooks[h.event])
        settings.hooks[h.event] = settings.hooks[h.event].filter(
          (e) => json(e) !== json(h.entry),
        );
    }
    for (const runtime of registry.enabled)
      for (const h of runtime.hooks ?? []) {
        if (h.file !== relative) continue;
        const entry = structuredClone(h.entry);
        if (
          !Array.isArray(entry.hooks) ||
          entry.hooks.some(
            (h) => h.type !== "command" || typeof h.command !== "string",
          )
        )
          throw new Error("runtime-hook-invalid");
        entry.hooks.forEach((h) => {
          h.command = `# ai-template:${runtime.id}\n${h.command}`;
        });
        settings.hooks[h.event] ??= [];
        if (!Array.isArray(settings.hooks[h.event]))
          throw new Error("generated-settings-invalid");
        settings.hooks[h.event] = settings.hooks[h.event].filter(
          (e) => json(e) !== json(entry),
        );
        settings.hooks[h.event].push(entry);
        hooks.push({ file: relative, event: h.event, entry });
      }
    for (const event of Object.keys(settings.hooks))
      if (settings.hooks[event].length === 0) delete settings.hooks[event];
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    if (json(settings) !== before) settingsWrites.push([file, json(settings)]);
  }
  const next = json({
    version: 1,
    files: Object.fromEntries(
      Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
    ),
    hooks,
  });
  if (dryRun) {
    const pending = [
      ...removals,
      ...writes.map(([file]) => file),
      ...settingsWrites.map(([file]) => file),
    ];
    if (!exists(statePath) || fs.readFileSync(statePath, "utf8") !== next)
      pending.push(statePath);
    return {
      pending: pending
        .map((file) => path.relative(root, file).split(path.sep).join("/"))
        .sort(),
    };
  }
  for (const file of removals) fs.unlinkSync(file);
  for (const [file, output] of writes) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (exists(file)) fs.unlinkSync(file);
    if (output.type === "link") fs.symlinkSync(output.target, file);
    else fs.writeFileSync(file, output.content);
  }
  for (const [file, contents] of settingsWrites) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeAtomic(file, contents);
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  if (!exists(statePath) || fs.readFileSync(statePath, "utf8") !== next)
    writeAtomic(statePath, next);
  return {
    generated: Object.keys(files).length,
    written: writes.length + settingsWrites.length,
    removed: removals.length,
  };
}
