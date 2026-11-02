import fs from "node:fs";
import { execFileSync } from "node:child_process";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Template-only delivery list: one entry per consumer repository and its PR base branch. */
export function loadConsumers(file) {
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); } catch { throw new Error("consumers-unreadable"); }
  const fail = field => { throw new Error(`consumers-invalid:${field}`); };
  if (!object(parsed) || Object.keys(parsed).some(k => !["$comment", "consumers"].includes(k)) || !Array.isArray(parsed.consumers)) fail("root");
  const seen = new Set();
  return parsed.consumers.map((entry, i) => {
    if (!object(entry) || Object.keys(entry).some(k => !["repo", "base", "autoMerge"].includes(k))) fail(`consumers[${i}]`);
    if (typeof entry.repo !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(entry.repo)) fail(`consumers[${i}].repo`);
    if (seen.has(entry.repo.toLowerCase())) fail(`consumers[${i}].repo-duplicate`);
    seen.add(entry.repo.toLowerCase());
    if (typeof entry.base !== "string" || entry.base.startsWith("-") || entry.base.startsWith("refs/")) fail(`consumers[${i}].base`);
    try { execFileSync("git", ["check-ref-format", "--branch", entry.base], { stdio: "ignore" }); }
    catch { fail(`consumers[${i}].base`); }
    if (entry.autoMerge !== undefined && typeof entry.autoMerge !== "boolean") fail(`consumers[${i}].autoMerge`);
    return { repo: entry.repo, base: entry.base, autoMerge: entry.autoMerge ?? false };
  });
}
