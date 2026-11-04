import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { relativePath } from "./registry.mjs";
import { exists, generate, hash, safePath } from "./generate.mjs";
import { loadConsumers } from "./consumers.mjs";

export const MANIFEST = "ai-template.manifest.json";
export const LOCK = ".ai-template/lock.json";
const json = (value) => JSON.stringify(value, null, 2) + "\n";
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const git = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 64 << 20,
  });

/** Repo-owned state, workflows (the delivery App has no workflows permission) and the manifest are never managed. */
const forbidden = (file) =>
  /^(?:\.ai-template|\.git)(?:\/|$)/.test(file) ||
  file.startsWith(".github/workflows/") ||
  file === MANIFEST;
function managedPath(file) {
  relativePath(file);
  if (forbidden(file)) throw new Error(`managed-path-forbidden:${file}`);
  return file;
}

/** `*` stays inside one path segment; `**` spans zero or more whole segments. */
export function compilePattern(pattern) {
  relativePath(pattern.replace(/\*/g, "x"));
  const parts = pattern.split("/");
  if (parts.some((p) => p.includes("**") && p !== "**") || forbidden(pattern))
    throw new Error(`manifest-pattern-invalid:${pattern}`);
  const body = parts
    .map((p, i) =>
      p === "**"
        ? i === parts.length - 1
          ? ".*"
          : "(?:[^/]+/)*"
        : p
            .split("*")
            .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join("[^/]*") + (i === parts.length - 1 ? "" : "/"),
    )
    .join("");
  return new RegExp(`^${body}$`);
}

export function readManifest(from) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(from, MANIFEST), "utf8"));
  } catch {
    throw new Error("manifest-unreadable");
  }
  if (
    !object(manifest) ||
    Object.keys(manifest).some(
      (k) => !["$comment", "version", "managed"].includes(k),
    ) ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.managed) ||
    !manifest.managed.length ||
    manifest.managed.some((p) => typeof p !== "string") ||
    new Set(manifest.managed).size !== manifest.managed.length
  )
    throw new Error("manifest-invalid");
  return {
    patterns: manifest.managed,
    matchers: manifest.managed.map(compilePattern),
  };
}

/** Managed files come from the template's Git index so the lock commit describes the copied bytes. */
export function listManagedFiles(from, { requireClean = true } = {}) {
  from = fs.realpathSync(from);
  if (
    fs.realpathSync(git(from, ["rev-parse", "--show-toplevel"]).trim()) !== from
  )
    throw new Error("ai-template-source-not-toplevel");
  const { patterns, matchers } = readManifest(from);
  const managed = (file) => matchers.some((m) => m.test(file));
  if (requireClean) {
    const status = git(from, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ])
      .split("\0")
      .filter(Boolean);
    for (let i = 0; i < status.length; i++) {
      const dirty = [status[i].slice(3)];
      if (/[RC]/.test(status[i].slice(0, 2))) dirty.push(status[++i]); // Rename/copy sources follow as a bare path.
      for (const file of dirty)
        if (managed(file)) throw new Error(`ai-template-source-dirty:${file}`);
    }
  }
  const files = [],
    hits = new Set();
  for (const entry of git(from, ["ls-files", "-z", "--stage"])
    .split("\0")
    .filter(Boolean)) {
    const [, mode, file] = entry.match(/^(\d+) [0-9a-f]+ \d\t(.+)$/s) ?? [];
    const index = matchers.findIndex((m) => m.test(file));
    if (index < 0) continue;
    matchers.forEach((m, i) => {
      if (m.test(file)) hits.add(i);
    });
    managedPath(file); // Wildcards can reach forbidden paths that the pattern text does not name.
    if (mode !== "100644" && mode !== "100755")
      throw new Error(`managed-not-regular:${file}`);
    files.push({
      file,
      executable: mode === "100755",
      content: fs.readFileSync(path.join(from, file)),
    });
  }
  files.sort((a, b) => (a.file < b.file ? -1 : 1)); // Code-point order keeps the lock locale-independent.
  const commit = git(from, ["rev-parse", "HEAD"]).trim();
  return {
    from,
    commit,
    patterns,
    files,
    unmatched: patterns.filter((_, i) => !hits.has(i)),
  };
}

function readLock(root) {
  const file = safePath(root, LOCK),
    stat = exists(file);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error("lock-unsafe");
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error("lock-invalid");
  }
  if (
    !object(lock) ||
    lock.version !== 1 ||
    !object(lock.source) ||
    typeof lock.source.commit !== "string" ||
    !object(lock.files) ||
    Object.entries(lock.files).some(([f, e]) => {
      managedPath(f);
      return (
        !object(e) ||
        !/^[0-9a-f]{64}$/.test(e.sha256) ||
        typeof e.executable !== "boolean"
      );
    })
  )
    throw new Error("lock-invalid");
  return lock;
}

const isExecutable = (stat) => (stat.mode & 0o111) !== 0;
const regular = (stat) => stat.isFile() && !stat.isSymbolicLink();
function writeFile(file, content, executable) {
  const mode = executable ? 0o755 : 0o644;
  const temporary = `${file}.ai-template-${randomBytes(8).toString("hex")}`;
  try {
    fs.writeFileSync(temporary, content, { flag: "wx", mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } finally {
    if (exists(temporary)) fs.unlinkSync(temporary);
  }
}
function pruneParents(root, file) {
  for (
    let dir = path.dirname(file);
    dir !== root && dir.startsWith(root + path.sep);
    dir = path.dirname(dir)
  ) {
    if (fs.readdirSync(dir).length) return;
    fs.rmdirSync(dir);
  }
}
function localSkills(root) {
  let config;
  try {
    config = JSON.parse(
      fs.readFileSync(path.join(root, ".ai-template/config.json"), "utf8"),
    );
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw new Error("repository-config-invalid-json", { cause: error });
  }
  const skills = config?.localSkills ?? [];
  if (!Array.isArray(skills) || skills.some((s) => typeof s !== "string"))
    throw new Error("runtime-local-skill-invalid");
  return skills;
}

/**
 * Copy managed files into `root`, propagate deletions and record the lock. Validates everything first.
 * @param {{ from?: string, root?: string, adopt?: boolean, sourceRepository?: string }} [options]
 */
export function sync({
  from,
  root = process.cwd(),
  adopt = false,
  sourceRepository,
} = {}) {
  root = fs.realpathSync(root);
  const source = listManagedFiles(from);
  if (source.from === root) throw new Error("ai-template-sync-self");
  if (
    sourceRepository !== undefined &&
    !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(sourceRepository)
  )
    throw new Error("source-repository-invalid");
  const previous = readLock(root);
  const owned = previous?.files ?? {};
  const protectedSkills = localSkills(root);
  const result = {
    from: previous?.source.commit ?? null,
    to: source.commit,
    written: [],
    removed: [],
    drift: [],
    adopted: [],
  };
  const writes = [],
    removals = [];
  const next = new Set(source.files.map((f) => f.file));
  const isLocalSkill = (relative) =>
    protectedSkills.includes(relative.match(/^skills\/([^/]+)\//)?.[1]);
  for (const { file: relative, content, executable } of source.files) {
    if (isLocalSkill(relative))
      throw new Error(`managed-collision:${relative}`);
    const file = safePath(root, relative),
      stat = exists(file);
    if (stat && !regular(stat))
      throw new Error(`managed-collision:${relative}`);
    const current = stat && {
      sha256: hash(fs.readFileSync(file)),
      executable: isExecutable(stat),
    };
    const wanted = { sha256: hash(content), executable };
    if (
      current &&
      current.sha256 === wanted.sha256 &&
      current.executable === wanted.executable
    )
      continue;
    if (!current && owned[relative]) result.drift.push(relative);
    else if (current && owned[relative]) {
      if (
        current.sha256 !== owned[relative].sha256 ||
        current.executable !== owned[relative].executable
      )
        result.drift.push(relative);
    } else if (current) {
      if (!adopt && current.sha256 !== wanted.sha256)
        throw new Error(`managed-collision:${relative}`);
      result.adopted.push(relative);
    }
    writes.push([file, content, executable]);
    result.written.push(relative);
  }
  for (const [relative, entry] of Object.entries(owned)) {
    if (next.has(relative)) continue;
    if (isLocalSkill(relative))
      throw new Error(`managed-collision:${relative}`);
    const file = safePath(root, relative),
      stat = exists(file);
    if (!stat) continue;
    if (!regular(stat)) throw new Error(`managed-collision:${relative}`);
    if (
      hash(fs.readFileSync(file)) !== entry.sha256 ||
      isExecutable(stat) !== entry.executable
    )
      result.drift.push(relative);
    removals.push(file);
    result.removed.push(relative);
  }
  for (const file of removals) {
    fs.unlinkSync(file);
    pruneParents(root, file);
  }
  for (const [file, content, executable] of writes) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFile(file, content, executable);
  }
  const lock = json({
    version: 1,
    source: {
      ...(sourceRepository ? { repository: sourceRepository } : {}),
      commit: source.commit,
    },
    files: Object.fromEntries(
      source.files.map((f) => [
        f.file,
        { sha256: hash(f.content), executable: f.executable },
      ]),
    ),
  });
  const lockFile = safePath(root, LOCK);
  if (!exists(lockFile) || fs.readFileSync(lockFile, "utf8") !== lock) {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    writeFile(lockFile, lock, false);
  }
  result.drift.sort();
  return result;
}

/** Report drift without writing. The template itself has no lock but owns the manifest and consumer list. */
export function check(root = process.cwd()) {
  root = fs.realpathSync(root);
  const problems = [];
  const attempt = (fn) => {
    try {
      fn();
    } catch (error) {
      problems.push(error.message);
    }
  };
  attempt(() => {
    const lock = readLock(root);
    for (const [relative, entry] of Object.entries(lock?.files ?? {})) {
      const file = safePath(root, relative),
        stat = exists(file);
      if (!stat) problems.push(`managed-missing:${relative}`);
      else if (
        !regular(stat) ||
        hash(fs.readFileSync(file)) !== entry.sha256 ||
        isExecutable(stat) !== entry.executable
      )
        problems.push(`managed-modified:${relative}`);
    }
  });
  attempt(() => {
    for (const file of generate(root, { dryRun: true }).pending)
      problems.push(`generated-stale:${file}`);
  });
  if (exists(path.join(root, MANIFEST)))
    attempt(() => {
      const { files, unmatched } = listManagedFiles(root, {
        requireClean: false,
      });
      for (const pattern of unmatched)
        problems.push(`manifest-pattern-unmatched:${pattern}`);
      const state = path.join(root, ".ai-template/generated.json");
      const generated = exists(state)
        ? Object.keys(JSON.parse(fs.readFileSync(state, "utf8")).files ?? {})
        : [];
      for (const { file } of files)
        if (generated.includes(file) || file === LOCK)
          problems.push(`manifest-generated-overlap:${file}`);
      if (exists(path.join(root, "sync/consumers.json")))
        loadConsumers(path.join(root, "sync/consumers.json"));
    });
  return { ok: problems.length === 0, problems };
}

/**
 * Markdown for the consumer PR; lists paths only, never file contents.
 * @param {{ from: string | null, to: string, written: string[], removed: string[], drift: string[], adopted: string[] }} result
 * @param {{ sourceRepository?: string }} [options]
 */
export function renderSyncSummary(result, { sourceRepository } = {}) {
  const short = (sha) => (sha ? sha.slice(0, 12) : "(none)");
  const range =
    sourceRepository && result.from
      ? `[\`${short(result.from)}...${short(result.to)}\`](https://github.com/${sourceRepository}/compare/${result.from}...${result.to})`
      : `\`${short(result.from)}\` → \`${short(result.to)}\``;
  const list = (title, files) =>
    files.length
      ? [
          `### ${title} (${files.length})`,
          "",
          ...files.map((f) => `- \`${f}\``),
          "",
        ]
      : [];
  return [
    `Automated sync of managed AI template files${sourceRepository ? ` from \`${sourceRepository}\`` : ""}.`,
    "",
    `Source range: ${range}`,
    "",
    "Managed files are owned by the template. Fix them with a pull request to the template repository; direct edits here fail `node scripts/ai-template.mjs check`.",
    "",
    "### Consumer CI verification",
    "",
    "- [ ] Confirm the consumer CI runs `node scripts/ai-template.mjs check`, `node scripts/ai-template.mjs test`, and `bash scripts/test-issue-worktree.sh` on pull requests. Install the managed suite dependencies and required tools in that CI environment.",
    "- [ ] If any command is missing, add it to the consumer-owned CI and verify it passes before merging. This sync does not modify consumer workflows.",
    "",
    ...list(
      "Locally modified managed files reverted to the template",
      result.drift,
    ),
    ...list("Existing files adopted as managed", result.adopted),
    ...list("Written", result.written),
    ...list("Removed", result.removed),
  ].join("\n");
}
