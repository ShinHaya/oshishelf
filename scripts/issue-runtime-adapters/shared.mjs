import { buildRuntimeEnvironment } from "./environment.mjs";
import {
  findRuntime,
  isModelAllowed,
  isPermissionArgument,
  isRetiredCommand,
} from "../ai-template/registry.mjs";
import { evaluateRoute } from "../enterprise-route-policy.mjs";
import { loadRepositoryConfig } from "../repository-config.mjs";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Closed diagnostic reason codes (no free-form secrets). */
export const REASON_CODES = Object.freeze({
  CLI_NOT_FOUND: "cli-not-found",
  AUTH_UNAVAILABLE: "auth-unavailable",
  MODEL_NOT_SELECTABLE: "model-not-selectable",
  MODEL_MISMATCH: "model-mismatch",
  VERIFICATION_TIMEOUT: "verification-timeout",
  PROBE_FAILED: "probe-failed",
  // Headless execution probe outcomes: a route only becomes
  // `verifiable: true` after it actually completes a minimal tool-use task
  // with no TTY attached, not merely after auth/model-list checks pass.
  TTY_REQUIRED: "tty-required",
  NON_AGENTIC_PRINT_MODE: "non-agentic-print-mode",
  HEADLESS_EXEC_FAILED: "headless-exec-failed",
  // Repository config `agents.models.<id>.allow` excludes this exact model; it is never probed.
  MODEL_NOT_ALLOWED: "model-not-allowed",
  // Repository config `agents.models.<id>.deny` matches the requested or reported model.
  MODEL_DENIED: "model-denied",
  // An alias-resolving runtime did not report exactly one canonical model during the probe.
  MODEL_UNRESOLVED: "model-unresolved",
  // Enterprise route attestation (opt-in) did not admit this runtime/model/purpose.
  ENTERPRISE_DENIED: "enterprise-route-denied",
  // The CLI reported denied tool calls and the probe task did not complete.
  PERMISSION_DENIED: "permission-denied",
  // The permission policy leaves this runtime no role it can run; it is never probed.
  PERMISSION_UNAVAILABLE: "permission-unavailable",
});

// Bumped from 30s: CLI authentication / model catalogs
// probes were observed timing out at 30s and passing at 120s in real runs.
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
export const DEFAULT_WORKER_TIMEOUT_MS = 3_600_000;
// The headless execution probe spins up a real agent turn (not just a CLI
// status check), so it gets its own, longer budget.
export const DEFAULT_HEADLESS_PROBE_TIMEOUT_MS = 120_000;

// 6: permission arguments left the selector; records carry the permission fingerprint.
export const PROBE_SCHEMA_VERSION = 6;

/** Stderr/stdout patterns that indicate the CLI demanded a real TTY/PTY. */
const TTY_REQUIRED_PATTERN =
  /(device not configured|inappropriate ioctl for device|enotty|not a tty|no such device or address|raw mode is not supported)/i;

/**
 * Resolve an executable on PATH (or an absolute path). Returns absolute path or null.
 * @param {string} command
 * @param {{ env?: NodeJS.ProcessEnv, pathEnv?: string }} [options]
 */
export async function resolveExecutable(
  command,
  { env = buildRuntimeEnvironment(), pathEnv } = {},
) {
  if (typeof command !== "string" || !command.trim()) return null;
  if (command.includes("/") || command.includes("\\")) {
    try {
      await fs.access(command);
      return path.resolve(command);
    } catch {
      return null;
    }
  }
  const pathValue = pathEnv ?? env.PATH ?? env.Path ?? "";
  const extensions =
    process.platform === "win32"
      ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension);
      try {
        await fs.access(candidate);
        return candidate;
      } catch {
        // try next
      }
    }
  }
  return null;
}

/**
 * Run a short probe process with a hard timeout. On timeout, signals the
 * direct child (probes stay non-detached for reliable SIGTERM). Callers must
 * extract only machine-readable fields from stdout/stderr and must not persist
 * credentials, prompts, Issue bodies, or model response bodies in diagnostics.
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv, cwd?: string, input?: string, killSignal?: NodeJS.Signals }} [options]
 */
export function runProcess(
  command,
  args,
  {
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    env,
    cwd,
    input,
    killSignal = "SIGTERM",
  } = {},
) {
  if (!env) return Promise.reject(new Error("runtime-env-policy-required"));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("invalid-timeout-ms"));
  }
  return new Promise((resolve) => {
    let timedOut = false;
    let settled = false;
    // Probes stay in the parent's process group so SIGTERM/SIGKILL reach the
    // CLI reliably; worker launches use spawnWorker (detached) instead.
    const child = spawn(command, args, {
      env,
      cwd,
      stdio:
        input === undefined
          ? ["ignore", "pipe", "pipe"]
          : ["pipe", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout?.on("data", (chunk) => stdoutChunks.push(chunk));
    child.stderr?.on("data", (chunk) => stderrChunks.push(chunk));
    if (input !== undefined && child.stdin) {
      child.stdin.end(input);
    }

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const killTree = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            env: buildRuntimeEnvironment(),
          });
        } else {
          child.kill(signal);
        }
      } catch {
        // already exited
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(killSignal);
      // Escalate to SIGKILL, then force-resolve so a stuck child cannot hang the probe.
      setTimeout(() => {
        killTree("SIGKILL");
        finish({
          code: null,
          signal: "SIGKILL",
          timedOut: true,
          error: "verification-timeout",
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          pid: child.pid ?? null,
        });
      }, 500).unref?.();
    }, timeoutMs);

    child.on("error", (/** @type {NodeJS.ErrnoException} */ error) => {
      finish({
        code: null,
        signal: null,
        timedOut,
        error: error.code ?? error.message,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        pid: child.pid ?? null,
      });
    });

    child.on("close", (code, signal) => {
      finish({
        code,
        signal,
        timedOut,
        error: null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        pid: child.pid ?? null,
      });
    });
  });
}

/**
 * Verify that a CLI can actually complete a minimal tool-use task headlessly
 * (no TTY, no human present) rather than merely answering an auth/model-list
 * check. Spawns the CLI in a throwaway sandbox directory with a fixed,
 * generated task ("create this exact file with this exact marker") and
 * classifies the result with a closed reason code. Never persists the
 * prompt text, stdout, stderr, or the marker itself — only the pass/fail
 * verdict and (on failure) a reason code leave this function.
 *
 * @param {object} options
 * @param {string} [options.cliPath] - resolved absolute path to the CLI.
 * @param {string} [options.expectedModel]
 * @param {typeof runProcess} [options.run]
 * @param {number} [options.timeoutMs]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string[]} [options.args] - selector args (model flags etc.) to place
 *   before the generated task prompt; must not include the prompt itself.
 * @param {boolean} [options.resolveModel] - the selector passes an alias; require
 *   exactly one reported canonical model and return it instead of comparing.
 * @returns {Promise<{ok: true, reportedModel?: string} | {ok: false, reason: string}>}
 */
export async function runHeadlessExecProbe({
  cliPath,
  args = [],
  expectedModel,
  resolveModel = false,
  run = runProcess,
  timeoutMs = DEFAULT_HEADLESS_PROBE_TIMEOUT_MS,
  env = buildRuntimeEnvironment(),
} = {}) {
  const sandboxDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "headless-probe-"),
  );
  try {
    const marker = randomBytes(8).toString("hex");
    const artifactPath = path.join(sandboxDir, "probe.txt");
    const prompt = [
      `Create a new file at this exact path: ${artifactPath}`,
      `The file must contain exactly this text and nothing else: ${marker}`,
      "Do not modify or create any other file. Do not ask questions. Do not explain your steps.",
    ].join("\n");

    const result = await run(cliPath, [...args, prompt], {
      timeoutMs,
      env,
      cwd: sandboxDir,
    });

    let artifactMatches = false;
    try {
      artifactMatches =
        (await fs.readFile(artifactPath, "utf8")).trim() === marker;
    } catch {
      artifactMatches = false;
    }
    if (result.timedOut)
      return { ok: false, reason: REASON_CODES.VERIFICATION_TIMEOUT };
    const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const reported = [...new Set(reportedModels(result))];
    if (
      !resolveModel &&
      expectedModel &&
      reported.some((model) => model !== expectedModel)
    ) {
      return { ok: false, reason: REASON_CODES.MODEL_MISMATCH };
    }
    if (artifactMatches && result.code === 0) {
      if (!resolveModel) return { ok: true };
      // Canonical identity comes only from the runtime's machine-readable report.
      return reported.length === 1
        ? { ok: true, reportedModel: reported[0] }
        : { ok: false, reason: REASON_CODES.MODEL_UNRESOLVED };
    }
    if (reportsPermissionDenials(result))
      return { ok: false, reason: REASON_CODES.PERMISSION_DENIED };
    if (TTY_REQUIRED_PATTERN.test(combinedOutput))
      return { ok: false, reason: REASON_CODES.TTY_REQUIRED };
    // Exited cleanly but produced no artifact: a print/response-only mode
    // that never actually exercised a tool (observed for `agy --print`).
    if (result.code === 0)
      return { ok: false, reason: REASON_CODES.NON_AGENTIC_PRINT_MODE };
    return { ok: false, reason: REASON_CODES.HEADLESS_EXEC_FAILED };
  } finally {
    await fs.rm(sandboxDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Read explicit CLI model metadata only; never return or persist raw output. */
export function reportedModels(result) {
  const models = [];
  for (const output of [result.stdout, result.stderr]) {
    for (const line of String(output ?? "").split(/\r?\n/)) {
      try {
        const event = JSON.parse(line);
        if (typeof event?.model === "string") models.push(event.model);
      } catch {
        // Plain-text CLI session headers may report the selected canonical model.
        const match = line.match(/^model:\s*(\S+)\s*$/);
        if (match) models.push(match[1]);
      }
    }
  }
  return models;
}

/** True when a machine-readable result event lists denied tool calls. Reads only the count. */
export function reportsPermissionDenials(result) {
  for (const output of [result.stdout, result.stderr])
    for (const line of String(output ?? "").split(/\r?\n/)) {
      try {
        const denials = JSON.parse(line)?.permission_denials;
        if (Array.isArray(denials) && denials.length > 0) return true;
      } catch {
        // not a JSON event
      }
    }
  return false;
}

/** Verify one exact candidate, isolating failures and exposing closed reasons only. */
export async function verifyModelCandidate(candidate, ctx = {}) {
  try {
    const tokens = splitSelector(candidate.selector);
    const result = await (ctx.headlessExecProbe ?? runHeadlessExecProbe)({
      cliPath: tokens[0],
      args: [...tokens.slice(1), ...(ctx.extraArgs ?? [])],
      expectedModel: candidate.model,
      resolveModel: ctx.resolveModel === true,
      run: ctx.run ?? runProcess,
      timeoutMs:
        ctx.headlessProbeTimeoutMs ?? DEFAULT_HEADLESS_PROBE_TIMEOUT_MS,
      env: ctx.env ?? buildRuntimeEnvironment(),
    });
    if (result?.ok === true) {
      if (ctx.resolveModel !== true) return { ok: true };
      return typeof result.reportedModel === "string" && result.reportedModel
        ? { ok: true, reportedModel: result.reportedModel }
        : { ok: false, reason: REASON_CODES.MODEL_UNRESOLVED };
    }
    return {
      ok: false,
      reason: Object.values(REASON_CODES).includes(result?.reason)
        ? result.reason
        : REASON_CODES.HEADLESS_EXEC_FAILED,
    };
  } catch {
    return { ok: false, reason: REASON_CODES.PROBE_FAILED };
  }
}

/**
 * Quote a selector argument when it contains whitespace.
 * Returns null when the value cannot be represented safely (e.g. embedded quotes).
 */
export function quoteSelectorArg(value) {
  const text = String(value ?? "");
  if (!text || /["']/.test(text)) return null;
  if (/\s/.test(text)) return `"${text}"`;
  return text;
}

/** Split a selector string into argv tokens; supports simple double quotes. */
export function splitSelector(selector) {
  if (typeof selector !== "string" || !selector.trim()) {
    throw new Error("invalid-selector");
  }
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = re.exec(selector)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  if (!tokens.length) throw new Error("invalid-selector");
  return tokens;
}

/** Match only exact model tokens recorded by discovery for this runtime. */
export function selectorTargetsRoute(route, root = process.cwd()) {
  const tokens = splitSelector(route.selector);
  if (tokens.includes(route.model)) return true;
  return (
    findRuntime(route.agent, root)?.models?.resolveReportedModel === true &&
    typeof route.requestedModel === "string" &&
    route.requestedModel.length > 0 &&
    tokens.includes(route.requestedModel)
  );
}

/**
 * True when a selector carries permission-layer arguments. Permission argv is rebuilt
 * from the registry on every launch, so a selector from a cache, run state or a
 * hand-written `--route` can never add or loosen permissions.
 */
export function selectorHasPermissionArgs(route, root = process.cwd()) {
  const runtime = findRuntime(route?.agent, root);
  return splitSelector(route.selector)
    .slice(1)
    .some((token) => isPermissionArgument(token, runtime));
}

/** Retirement is registry data, including executable aliases in cached selectors. */
export function isRetiredRuntimeRoute(route, root = process.cwd()) {
  if (findRuntime(route?.agent, root)?.retired) return true;
  if (typeof route?.selector !== "string" || !route.selector.trim())
    return false;
  return isRetiredCommand(splitSelector(route.selector)[0], root);
}

/** A route excluded by the runtime's model allowlist or deny patterns (model or requested value). */
export function isDisallowedModelRoute(route, root = process.cwd()) {
  if (!isModelAllowed(route?.agent, route?.model, root, route?.requestedModel))
    return true;
  // Enterprise mode (opt-in): the live attestation must also admit the route. Purpose is checked at launch.
  const runtime = findRuntime(route?.agent, root);
  return !evaluateRoute(
    {
      runtime: runtime?.id,
      requestedModel: route?.requestedModel ?? route?.model,
      model: route?.model,
    },
    { root },
  ).allow;
}

/**
 * @typedef {{ agent: string, model: string, requestedModel?: string, role: string, selector: string,
 *   timeoutMs: number, selectable: boolean, verifiable: boolean, permissionFingerprint?: string,
 *   permissionRoles?: string[] }} CapabilityRecord
 */
/**
 * @param {{ agent: string, model?: string, requestedModel?: string, role: string, selector: string,
 *   timeoutMs?: number, selectable?: boolean, verifiable?: boolean, permissionFingerprint?: string,
 *   permissionRoles?: string[] }} fields
 * @returns {CapabilityRecord}
 */
export function capabilityRecord({
  agent,
  requestedModel,
  model,
  role,
  selector,
  timeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
  selectable = true,
  verifiable = true,
  permissionFingerprint,
  permissionRoles,
}) {
  const record = {
    agent,
    model,
    role,
    selector,
    selectable,
    verifiable,
    timeoutMs,
  };
  if (requestedModel !== undefined) record.requestedModel = requestedModel;
  // Hashes and role names only: the permission argv itself is rebuilt at launch.
  if (permissionFingerprint !== undefined)
    record.permissionFingerprint = permissionFingerprint;
  if (permissionRoles !== undefined)
    record.permissionRoles = [...permissionRoles];
  return record;
}

/**
 * @typedef {{ agent?: string, status?: string, reason?: string, model?: string }} Diagnostic
 * @param {Diagnostic} [fields]
 * @returns {Diagnostic}
 */
export function diagnostic({ agent, status, reason, model } = {}) {
  const entry = { agent, status };
  if (reason !== undefined) entry.reason = reason;
  if (model !== undefined) entry.model = model;
  return entry;
}

/**
 * Best-effort `<cli> --version` read for cache-freshness comparison only.
 * Never throws; returns null on any failure so a version check never blocks
 * discovery. Output is a short version string, not prompt/response content.
 */
export async function readCliVersion(
  cliPath,
  {
    run = runProcess,
    timeoutMs = 10_000,
    env = buildRuntimeEnvironment(),
  } = {},
) {
  try {
    const result = await run(cliPath, ["--version"], { timeoutMs, env });
    if (result.timedOut || result.code !== 0) return null;
    const text = String(result.stdout ?? "").trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * Returns the current HEAD commit SHA.
 */
export async function getRepositoryCommit(cwd) {
  try {
    const result = await runProcess("git", ["rev-parse", "HEAD"], {
      cwd,
      env: process.env,
    });
    if (result.code !== 0) return null;
    return String(result.stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Verify that the checkout contains the configured remote base branch.
 * Throws if fetching fails or HEAD does not contain that branch.
 */
export async function verifyRepositoryFreshness(cwd) {
  const { baseBranch } = loadRepositoryConfig(cwd).repository;
  const baseRef = `origin/${baseBranch}`;
  const fetchResult = await runProcess("git", ["fetch", "origin", baseBranch], {
    cwd,
    env: process.env,
  });
  if (fetchResult.code !== 0) {
    throw new Error("orchestrator-checkout-stale:fetch-failed");
  }

  const mergeBaseResult = await runProcess(
    "git",
    ["merge-base", "--is-ancestor", baseRef, "HEAD"],
    { cwd, env: process.env },
  );
  if (mergeBaseResult.code !== 0) {
    const headResult = await runProcess("git", ["rev-parse", "HEAD"], {
      cwd,
      env: process.env,
    });
    const baseResult = await runProcess("git", ["rev-parse", baseRef], {
      cwd,
      env: process.env,
    });

    const formatSha = (res) => {
      const out = String(res.stdout ?? "").trim();
      const err = String(res.stderr ?? "").trim();
      return out || (err ? `error(${err.replace(/\\n/g, " ")})` : "unknown");
    };

    const headSha = formatSha(headResult);
    const baseSha = formatSha(baseResult);
    throw new Error(
      `orchestrator-checkout-stale:head=${headSha},${baseRef}=${baseSha}`,
    );
  }
}

/** Write JSON atomically so partial output is never a successful result. */
export async function writeJsonAtomic(filePath, value) {
  const absolute = path.resolve(filePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const tempPath = `${absolute}.tmp.${process.pid}.${Date.now()}`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await fs.writeFile(tempPath, payload, "utf8");
    await fs.rename(tempPath, absolute);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // ignore cleanup failures
    }
    throw error;
  }
  return absolute;
}

/**
 * Spawn a long-running worker and return a handle that can kill only that
 * process tree. Does not capture or persist stdout/stderr to run state.
 * @param {string} command
 * @param {string[]} args
 * @param {{ timeoutMs?: number, env?: NodeJS.ProcessEnv, cwd?: string }} [options]
 */
export function spawnWorker(command, args, { timeoutMs, env, cwd } = {}) {
  if (!env) throw new Error("runtime-env-policy-required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("invalid-timeout-ms");
  }
  const workerEnv = { ...env };
  delete workerEnv.TYPESAFE_API_KEY;
  const child = spawn(command, args, {
    env: workerEnv,
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  // Drain pipes so the child cannot block on a full buffer; discard contents.
  child.stdout?.on("data", () => {});
  child.stderr?.on("data", () => {});

  let timedOut = false;
  let exitResult;
  const killTree = (/** @type {NodeJS.Signals} */ signal = "SIGTERM") => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          env: buildRuntimeEnvironment(),
        });
      } else {
        process.kill(-child.pid, signal);
      }
    } catch {
      try {
        child.kill(signal);
      } catch {
        // already exited
      }
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killTree("SIGTERM");
    setTimeout(() => killTree("SIGKILL"), 1_000).unref?.();
  }, timeoutMs);

  // Register close/error once at spawn so late wait() callers still resolve.
  const done = new Promise((resolve) => {
    const finish = (result) => {
      if (exitResult) return;
      clearTimeout(timer);
      exitResult = result;
      resolve(result);
    };
    child.on("close", (code, signal) => {
      finish({ code, signal, timedOut, pid: child.pid });
    });
    child.on("error", () => {
      finish({
        code: null,
        signal: null,
        timedOut,
        pid: child.pid,
        error: true,
      });
    });
  });

  return {
    pid: child.pid,
    kill: killTree,
    wait: () => done,
    get timedOut() {
      return timedOut;
    },
  };
}

const NO_STATE_LEAK_RULE =
  "Do not store credentials, Issue bodies, prompts, diffs, or model response bodies in orchestrator run state.";

// issue-implementation (and handoff-issue, which continues its workflow)
// dispatches its own reviewer before the PR. Under a role program the
// orchestrator already runs the one review pass per Issue as a separate role,
// so an implementer that also followed the skill would review the Issue twice
// on a route the run state never records.
const SKIP_SKILL_REVIEW_RULE =
  "Do NOT dispatch a reviewer role or run the skill's review step yourself: the orchestrator runs the review as a separate role. Go straight to push and pull request handling.";

/**
 * Role-specific instructions. Each role runs as its own CLI process, so a
 * later role cannot see an earlier role's conversation — it reads the Issue,
 * the worktree, and the diff for itself.
 */
function roleInstructions({ role, issueNumber, skill, reviewPass, fixCycle }) {
  if (role === "planner")
    return [
      `Plan the implementation of exactly one GitHub Issue. Do not implement it.`,
      // Deliberately NOT an implementation skill: issue-implementation and
      // handoff-issue both drive implementation through to a pull request,
      // which would contradict "do not implement it". The planner sets up the
      // worktree directly instead.
      `Set up the Issue worktree with \`bash scripts/issue-worktree.sh ${
        skill === "handoff-issue" ? "handoff" : "create"
      } ${issueNumber} ...\` (see AGENTS.md for this repository's worktree rules), then work only inside the path it prints. Do not run issue-implementation or handoff-issue.`,
      `Post the implementation plan and detailed design as a comment on Issue #${issueNumber} using gh issue comment. Do not create repository design/spec/report files.`,
      "Report role-complete with role=planner when the plan comment is posted. Return its URL. Do not implement, commit, push, or open a pull request.",
    ];
  if (role === "reviewer") {
    const pass = reviewPass ?? 1;
    return [
      `Independently review the changes for this Issue (review pass ${pass}). Do not modify, commit, push, or merge anything.`,
      `Read-only: work inside the existing Issue worktree (.worktrees/issue-${issueNumber}-*). Do not run issue-implementation, handoff-issue, or any other implementation skill — they commit.`,
      "Consult the Issue's stated acceptance criteria, the pull request body, the changed file paths, the branch diff, and the test-run summary. You have no access to the implementer's reasoning and must not ask for it.",
      // The findings have to outlive this process: the next role runs as a
      // separate CLI and can only read what is on GitHub or on disk.
      `Post your findings as ONE pull request comment (\`gh pr comment\`), starting with the exact line \`role=reviewer pass=${pass} verdict=<PASS|NEEDS_REVISION|REJECTED>\` followed by the findings list. GitHub's review feature is unavailable because the PR author and the reviewer share one account, so do not use \`gh pr review\`.`,
      "Then report role-complete with role=reviewer and that same verdict.",
    ];
  }
  if (Number(fixCycle) > 0)
    return [
      `Address the reviewer's findings for this Issue (fix cycle ${fixCycle}). A pull request already exists.`,
      `Use the repository ${skill} skill to resume the existing Issue worktree.`,
      SKIP_SKILL_REVIEW_RULE,
      `Read the findings with \`gh pr view --comments\`: take the newest comment whose first line starts with \`role=reviewer\`.`,
      "Do NOT create a pull request — push to the same branch so the existing one updates.",
      `After pushing, post ONE pull request comment starting with the exact line \`role=implementer fix-cycle=${fixCycle}\`, stating per finding what you changed or why you did not.`,
      "Then report role-complete with role=implementer.",
    ];
  return [
    `Implement exactly one GitHub Issue using the repository ${skill} skill.`,
    SKIP_SKILL_REVIEW_RULE,
    "Report role-complete with role=implementer once the work is committed, pushed, and the pull request exists.",
  ];
}

/**
 * Build the minimal worker prompt — role, Issue number, route labels, and the
 * non-sensitive lease session ID for a worker that owns the Issue worktree.
 * No Issue body, diff, or personal data ever enters the prompt.
 * @param {{ issueNumber: number, agent: string, model: string, releasePolicy: string, nextMilestone: string,
 *   role?: string, skill?: string, reviewPass?: number, fixCycle?: number, leaseSession?: string }} fields
 */
export function buildWorkerPrompt({
  issueNumber,
  agent,
  model,
  releasePolicy,
  nextMilestone,
  role,
  skill = "issue-implementation",
  reviewPass,
  fixCycle,
  leaseSession,
}) {
  const lease =
    leaseSession === undefined
      ? []
      : leaseInstructions({ issueNumber, agent, leaseSession });
  if (!role) {
    // Single-worker mode: one worker owns the whole Issue, as before roles.
    return [
      "Implement exactly one GitHub Issue using the repository issue-implementation (or handoff-issue) skill.",
      `Issue: #${issueNumber}`,
      `Assigned route: agent=${agent} model=${model}`,
      `Release policy: ${releasePolicy}`,
      `Next milestone: ${nextMilestone}`,
      ...lease,
      NO_STATE_LEAK_RULE,
    ].join("\n");
  }
  return [
    ...roleInstructions({ role, issueNumber, skill, reviewPass, fixCycle }),
    `Issue: #${issueNumber}`,
    `Role: ${role}`,
    `Assigned route: agent=${agent} model=${model}`,
    `Release policy: ${releasePolicy}`,
    `Next milestone: ${nextMilestone}`,
    ...lease,
    NO_STATE_LEAK_RULE,
  ].join("\n");
}

/**
 * The dispatcher-issued lease session. Some runtimes run shell commands in a
 * separate long-running server that does not inherit the worker's environment,
 * so the session travels in the prompt as well as in ISSUE_WORKTREE_SESSION.
 */
function leaseInstructions({ issueNumber, agent, leaseSession }) {
  return [
    `Issue worktree lease session: ${leaseSession}`,
    `Pass \`--session ${leaseSession}\` to every scripts/issue-worktree.sh create, acquire, handoff, and release call for Issue #${issueNumber}. The dispatcher renews this lease while you run; do not invent another session ID.`,
    `Before each commit and each push, run \`bash scripts/issue-worktree.sh acquire ${issueNumber} --agent ${agent} --session ${leaseSession}\`. If it fails, stop without committing or pushing: another session has taken over the Issue.`,
  ];
}
