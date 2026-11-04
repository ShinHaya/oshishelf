#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const documentKeys = new Set([
  "requirements",
  "architecture",
  "development",
  "testing",
  "security",
  "githubOperations",
  "manualTest",
]);
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (field) => {
  throw new Error(`repository-config-invalid:${field}`);
};
/** True when `value` contains U+0000-U+001F or U+007F. */
export const hasControlCharacter = (value) =>
  [...value].some((ch) => ch < " " || ch === "\x7f");
const text = (value, field) => {
  if (typeof value !== "string" || !value.trim() || hasControlCharacter(value))
    fail(field);
  return value.trim();
};

/** Optional repo-owned settings. Reads data only; never runs quality gates. */
export function loadRepositoryConfig(root = process.cwd()) {
  root = path.resolve(root);
  let source;
  try {
    source = fs.readFileSync(
      path.join(root, ".ai-template/config.json"),
      "utf8",
    );
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error("repository-config-unreadable", { cause: error });
    return {
      repository: { baseBranch: "main", qualityGates: [], documents: {} },
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error("repository-config-invalid-json");
  }
  if (!object(parsed)) fail("root");
  for (const key of Object.keys(parsed))
    if (
      ![
        "$schema",
        "repository",
        "agents",
        "enterprise",
        "localSkills",
      ].includes(key)
    )
      fail("root-key");
  // Opt-in enterprise route attestation (Issue #65): a closed boolean-only object.
  if (parsed.enterprise !== undefined) {
    if (
      !object(parsed.enterprise) ||
      Object.keys(parsed.enterprise).some((k) => k !== "routeAttestation") ||
      (parsed.enterprise.routeAttestation !== undefined &&
        typeof parsed.enterprise.routeAttestation !== "boolean")
    )
      fail("enterprise");
  }
  // Runtime/skill registration belongs to its own validator; do not interpret it here.
  const repository = parsed.repository === undefined ? {} : parsed.repository;
  if (!object(repository)) fail("repository");
  for (const key of Object.keys(repository))
    if (!["baseBranch", "qualityGates", "documents"].includes(key))
      fail("repository-key");
  const baseBranch = text(
    repository.baseBranch === undefined ? "main" : repository.baseBranch,
    "baseBranch",
  );
  if (
    baseBranch.startsWith("-") ||
    baseBranch.startsWith("refs/") ||
    baseBranch.includes("@{")
  )
    fail("baseBranch");
  try {
    execFileSync("git", ["check-ref-format", "--branch", baseBranch], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    fail("baseBranch");
  }
  const qualityGates =
    repository.qualityGates === undefined ? [] : repository.qualityGates;
  if (!Array.isArray(qualityGates)) fail("qualityGates");
  const gates = qualityGates.map((value) => text(value, "qualityGates"));
  const documents =
    repository.documents === undefined ? {} : repository.documents;
  if (!object(documents)) fail("documents");
  const locations = {};
  for (const [key, value] of Object.entries(documents)) {
    if (!documentKeys.has(key)) fail("document-key");
    const relative = text(value, `documents.${key}`);
    const resolved = path.resolve(root, relative);
    if (
      path.isAbsolute(relative) ||
      relative.includes("\\") ||
      /^[A-Za-z]:/.test(relative) ||
      resolved === root ||
      !resolved.startsWith(root + path.sep)
    )
      fail(`documents.${key}`);
    locations[key] = relative;
  }
  return {
    repository: { baseBranch, qualityGates: gates, documents: locations },
  };
}

function main(argv) {
  let root = process.cwd();
  let key;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!["--root", "--get"].includes(flag) || argv[i + 1] === undefined)
      throw new Error("repository-config-invalid-arguments");
    const value = argv[++i];
    if (flag === "--root") root = value;
    else key = value;
  }
  const config = loadRepositoryConfig(root);
  if (
    key !== undefined &&
    !["baseBranch", "qualityGates", "documents"].includes(key)
  )
    throw new Error("repository-config-invalid-key");
  const value = key === undefined ? config : config.repository[key];
  process.stdout.write(
    `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
