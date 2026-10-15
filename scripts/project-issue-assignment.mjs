/**
 * Canonical Issue metadata vocabulary shared by Project defaults and
 * multi-Issue orchestration, plus the agent-name vocabulary used by
 * run-time routing. Agent/model assignment is decided dynamically at
 * orchestration time and is never stored in Issue bodies or Project
 * fields; legacy assignment fields in old Issues are ignored.
 */

/** Agent runtimes that can be routed at orchestration time. */
export const AGENT_NAMES = new Map([
  ["claude", "Claude"],
  ["codex", "Codex"],
  ["gemini", "Gemini"],
  ["grok", "Grok"],
]);

/** English + Japanese labels → canonical field key. */
const FIELD_ALIASES = new Map([
  ["priority", "priority"],
  ["size", "size"],
  ["feature group", "featureGroup"],
]);

export function normalize(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** Canonical agent casing when known; otherwise the trimmed input. */
export function canonicalizeAgent(value) {
  const text = normalize(value);
  if (!text) return undefined;
  return AGENT_NAMES.get(text.toLowerCase()) ?? text;
}

export function isKnownAgent(value) {
  return AGENT_NAMES.has(normalize(value).toLowerCase());
}

export function isCanonicalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export const OWNER_TYPES = new Set(["organization"]);

/**
 * Parse `<!-- name:start -->` … `<!-- name:end -->` key/value bullet lines into
 * a plain object of canonical keys. Lines whose label is not in the current
 * vocabulary (for example legacy AI Assignee / Model / Order fields) are
 * ignored rather than rejected.
 */
export function parseMarkedBlock(body, markerName) {
  const text = String(body ?? "");
  const escaped = markerName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = text.match(
    new RegExp(`<!--\\s*${escaped}:start\\s*-->([\\s\\S]*?)<!--\\s*${escaped}:end\\s*-->`, "i"),
  )?.[1];
  if (!block) return {};
  const values = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.match(/^\s*-\s*([^:]+?)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const key = FIELD_ALIASES.get(match[1].trim().toLowerCase());
    if (key) values[key] = match[2].trim();
  }
  return values;
}

/**
 * Bounded Issue metadata: Priority / Size / Feature group from the
 * project-metadata block only. The legacy implementation-assignment block
 * (multi-line or one-line) is ignored entirely.
 */
export function parseProjectMetadata(body) {
  const values = parseMarkedBlock(body, "project-metadata");
  return {
    priority: values.priority ? normalize(values.priority) : undefined,
    size: values.size ? normalize(values.size) : undefined,
    featureGroup: values.featureGroup ? normalize(values.featureGroup) : undefined,
  };
}
