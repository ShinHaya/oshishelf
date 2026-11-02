import { loadRuntimeRegistry, findRuntime } from "./ai-template/registry.mjs";
export const AGENT_NAMES = new Map([...loadRuntimeRegistry().aliases].map(([alias, runtime]) => [alias, runtime.name]));
export function normalize(value) { return typeof value === "string" ? value.trim() : ""; }
export function canonicalizeAgent(value, root = process.cwd()) {
  const text = normalize(value);
  return text ? findRuntime(text, root)?.name ?? text : undefined;
}
export function isKnownAgent(value, root = process.cwd()) {
  const runtime = findRuntime(value, root);
  return !!runtime && !runtime.retired;
}

export function isCanonicalDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
