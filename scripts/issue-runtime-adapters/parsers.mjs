import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function parseAuth(stdout) {
  try {
    const json = JSON.parse(String(stdout ?? "").trim());
    return json?.loggedIn === true;
  } catch {
    return /loggedIn"\s*:\s*true/.test(String(stdout ?? ""));
  }
}

async function readSettingsModel(homeDir) {
  try {
    const raw = await fs.readFile(path.join(homeDir, ".claude", "settings.json"), "utf8");
    const settings = JSON.parse(raw);
    if (typeof settings?.model !== "string" || !settings.model.trim()) return null;
    // Strip UI suffixes such as `[1m]`.
    return settings.model
      .trim()
      .replace(/\[[^\]]*\]\s*$/, "")
      .trim();
  } catch {
    return null;
  }
}

function modelEntry(model, requestedModel = model) {
  if (typeof model !== "string" || !model.trim()) return null;
  const normalized = model
    .trim()
    .replace(/\[[^\]]*\]\s*$/, "")
    .trim();
  if (!normalized) return null;
  return {
    model: normalized,
    requestedModel:
      typeof requestedModel === "string" && requestedModel.trim() ? requestedModel.trim() : normalized,
  };
}

function projectPaths(cwd, explicitProjectPath) {
  const start = explicitProjectPath || cwd;
  if (typeof start !== "string" || !start.trim()) return [];
  const paths = [];
  let current = path.resolve(start);
  while (true) {
    paths.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return paths;
}

async function readClaudeJsonModels(homeDir, cwd, explicitProjectPath) {
  try {
    const raw = await fs.readFile(path.join(homeDir, ".claude.json"), "utf8");
    const config = JSON.parse(raw);
    const projects = config?.projects;
    if (!projects || typeof projects !== "object") return null;

    for (const projectPath of projectPaths(cwd, explicitProjectPath)) {
      const project = projects[projectPath];
      const usage = project?.lastModelUsage;
      if (!usage || typeof usage !== "object") continue;
      const models = Object.keys(usage)
        .map((model) => modelEntry(model))
        .filter(Boolean);
      if (models.length) return models;
    }
  } catch {
    // Missing or malformed local state is equivalent to no discovered model.
  }
  return null;
}

async function readAvailableModelOptions(homeDir) {
  try {
    const raw = await fs.readFile(path.join(homeDir, ".claude.json"), "utf8");
    const config = JSON.parse(raw);
    if (!Array.isArray(config?.additionalModelOptionsCache)) return null;
    const models = config.additionalModelOptionsCache
      .map((entry) => modelEntry(entry?.value, entry?.label))
      .filter(Boolean);
    return models.length ? models : null;
  } catch {
    return null;
  }
}


function parseLoginStatus(stdout) {
  const text = String(stdout ?? "");
  try {
    const json = JSON.parse(text);
    if (json?.loggedIn === true || json?.status === "logged-in") return true;
    if (json?.loggedIn === false) return false;
  } catch {
    // plain-text status
  }
  // Require a positive "logged in" and reject the common "Not logged in" form.
  if (/not\s+logged\s+in/i.test(text)) return false;
  if (/\blogged\s+in\b/i.test(text)) return true;
  return false;
}

function parseModelCatalog(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    if (start < 0) return null;
    try {
      payload = JSON.parse(text.slice(start));
    } catch {
      return null;
    }
  }
  const models = Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : null;
  if (!models) return null;
  const out = [];
  for (const entry of models) {
    const slug = typeof entry?.slug === "string" ? entry.slug.trim() : "";
    if (!slug) continue;
    // Prefer models the CLI exposes for interactive/list selection.
    if (entry?.visibility && entry.visibility !== "list") continue;
    const display =
      typeof entry?.display_name === "string" && entry.display_name.trim()
        ? entry.display_name.trim()
        : slug;
    out.push({ model: slug, requestedModel: display });
  }
  return out;
}


function parseModelsOutput(stdout) {
  const text = String(stdout ?? "");
  if (!text.trim()) return { loggedIn: false, models: null };
  const notLoggedIn = /not\s+logged\s+in/i.test(text);
  const loggedIn =
    !notLoggedIn && (/\blogged\s+in\b/i.test(text) || /available models/i.test(text));
  const models = [];
  for (const line of text.split(/\r?\n/)) {
    const bullet = line.trim().match(/^\*\s+(\S+)/);
    if (bullet) {
      const id = bullet[1];
      // Skip annotation-only tokens.
      if (id === "(default)") continue;
      models.push({ model: id, requestedModel: id });
      continue;
    }
  }
  // Also accept a pure list of model ids (for fakes / future JSON).
  if (!models.length) {
    try {
      const json = JSON.parse(text.trim());
      if (Array.isArray(json)) {
        for (const entry of json) {
          const id = typeof entry === "string" ? entry : entry?.id ?? entry?.model;
          if (typeof id === "string" && id.trim()) {
            models.push({ model: id.trim(), requestedModel: id.trim() });
          }
        }
      }
    } catch {
      // not JSON
    }
  }
  return { loggedIn, models: models.length ? models : null };
}


function parseModels(stdout) {
  const text = String(stdout ?? "").trim();
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) {
      return json
        .map((entry) => {
          const id = typeof entry === "string" ? entry : (entry?.id ?? entry?.model ?? entry?.name);
          if (typeof id !== "string" || !id.trim()) return null;
          return { model: id.trim(), requestedModel: id.trim() };
        })
        .filter(Boolean);
    }
  } catch {
    // line list
  }
  const models = [];
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim();
    if (!name) continue;
    if (/^available models/i.test(name) || /^usage of/i.test(name)) continue;
    // Reject prose/tips: require a product-style model display name.
    // Preserve model labels returned by the CLI, including spaces.
    if (!/^(Gemini|Claude|GPT)\b/i.test(name)) continue;
    if (/[.!?]$/.test(name)) continue;
    models.push({ model: name, requestedModel: name });
  }
  return models.length ? models : null;
}


export function parseAuthentication(parser, result) {
  if (parser === "logged-in-json") return parseAuth(result.stdout);
  if (parser === "login-status") return parseLoginStatus(result.stdout) || parseLoginStatus(result.stderr);
  throw new Error("runtime-auth-parser-invalid");
}
export async function parseCatalog(parser, result, ctx) {
  if (parser === "codex-models") return { models: parseModelCatalog(result.stdout) };
  if (parser === "bullet-models") return parseModelsOutput(result.stdout);
  if (parser === "model-lines") return { models: parseModels(result.stdout) };
  if (parser === "provider-models") return { models: String(result.stdout ?? "").split(/\r?\n/)
    .map(s => s.trim()).filter(s => /^[a-z0-9][a-z0-9._-]*\/[^\s]+$/i.test(s)).map(model => ({ model, requestedModel: model })) };
  if (parser === "json-models") {
    try {
      const items = JSON.parse(result.stdout);
      return { models: Array.isArray(items) ? items.map(e => typeof e === "string" ? e : e?.id ?? e?.model)
        .filter(e => typeof e === "string" && e.trim()).map(model => ({ model, requestedModel: model })) : null };
    } catch { return { models: null }; }
  }
  if (parser === "claude-local") {
    if (typeof ctx.settingsModel === "string" && ctx.settingsModel.trim()) return { models: [modelEntry(ctx.settingsModel)] };
    if (Array.isArray(ctx.candidateModels) && ctx.candidateModels.length) return { models: ctx.candidateModels
      .map(e => typeof e === "string" ? modelEntry(e) : modelEntry(e?.model, e?.requestedModel)).filter(Boolean) };
    const home = ctx.homeDir ?? os.homedir();
    let models = await readClaudeJsonModels(home, ctx.cwd, ctx.projectPath);
    if (!models?.length) models = await readAvailableModelOptions(home);
    if (!models?.length) { const legacy = await readSettingsModel(home); if (legacy) models = [modelEntry(legacy)]; }
    return { models };
  }
  throw new Error("runtime-model-parser-invalid");
}
