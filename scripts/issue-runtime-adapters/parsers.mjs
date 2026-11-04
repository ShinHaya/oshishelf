function parseAuth(stdout) {
  try {
    const json = JSON.parse(String(stdout ?? "").trim());
    return json?.loggedIn === true;
  } catch {
    return /loggedIn"\s*:\s*true/.test(String(stdout ?? ""));
  }
}

/**
 * Claude CLI control-protocol `initialize` response: `models[]` of `{ value, displayName }`.
 * Only those two fields are read; every other response field (account, commands, ...) is dropped.
 * `default` names no specific model and is never a candidate.
 */
function parseInitializeModels(response) {
  if (
    !response ||
    typeof response !== "object" ||
    !Array.isArray(response.models)
  )
    return null;
  const out = [];
  for (const entry of response.models) {
    const value = typeof entry?.value === "string" ? entry.value.trim() : "";
    if (
      !value ||
      value === "default" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value)
    )
      continue;
    const label =
      typeof entry?.displayName === "string" && entry.displayName.trim()
        ? entry.displayName.trim()
        : value;
    if (!out.some((model) => model.model === value))
      out.push({ model: value, requestedModel: label });
  }
  return out.length ? out : null;
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
  const models = Array.isArray(payload?.models)
    ? payload.models
    : Array.isArray(payload)
      ? payload
      : null;
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
    !notLoggedIn &&
    (/\blogged\s+in\b/i.test(text) || /available models/i.test(text));
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
          const id =
            typeof entry === "string" ? entry : (entry?.id ?? entry?.model);
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
          const id =
            typeof entry === "string"
              ? entry
              : (entry?.id ?? entry?.model ?? entry?.name);
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
  if (parser === "login-status")
    return parseLoginStatus(result.stdout) || parseLoginStatus(result.stderr);
  throw new Error("runtime-auth-parser-invalid");
}
export async function parseCatalog(parser, result) {
  if (parser === "codex-models")
    return { models: parseModelCatalog(result.stdout) };
  if (parser === "bullet-models") return parseModelsOutput(result.stdout);
  if (parser === "model-lines") return { models: parseModels(result.stdout) };
  if (parser === "provider-models")
    return {
      models: String(result.stdout ?? "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => /^[a-z0-9][a-z0-9._-]*\/[^\s]+$/i.test(s))
        .map((model) => ({ model, requestedModel: model })),
    };
  if (parser === "json-models") {
    try {
      const items = JSON.parse(result.stdout);
      return {
        models: Array.isArray(items)
          ? items
              .map((e) => (typeof e === "string" ? e : (e?.id ?? e?.model)))
              .filter((e) => typeof e === "string" && e.trim())
              .map((model) => ({ model, requestedModel: model }))
          : null,
      };
    } catch {
      return { models: null };
    }
  }
  if (parser === "claude-initialize")
    return { models: parseInitializeModels(result.response) };
  throw new Error("runtime-model-parser-invalid");
}
