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
});

// Bumped from 30s: the Claude CLI's `auth status` / `models`
// probes were observed timing out at 30s and passing at 120s in real runs.
export const DEFAULT_PROBE_TIMEOUT_MS = 60_000;
export const DEFAULT_WORKER_TIMEOUT_MS = 3_600_000;
// The headless execution probe spins up a real agent turn (not just a CLI
// status check), so it gets its own, longer budget.
export const DEFAULT_HEADLESS_PROBE_TIMEOUT_MS = 120_000;

export const PROBE_SCHEMA_VERSION = 4;

/** Stderr/stdout patterns that indicate the CLI demanded a real TTY/PTY. */
const TTY_REQUIRED_PATTERN =
  /(device not configured|inappropriate ioctl for device|enotty|not a tty|no such device or address|raw mode is not supported)/i;

/**
 * Resolve an executable on PATH (or an absolute path). Returns absolute path or null.
 */
export async function resolveExecutable(command, { env = process.env, pathEnv } = {}) {
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
    process.platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean) : [""];
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
 */
export function runProcess(
  command,
  args,
  {
    timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
    env = process.env,
    cwd,
    input,
    killSignal = "SIGTERM",
  } = {},
) {
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
      stdio: input === undefined ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
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
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
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

    child.on("error", (error) => {
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
 * @param {string} options.cliPath - resolved absolute path to the CLI.
 * @param {string[]} options.args - selector args (model flags etc.) to place
 *   before the generated task prompt; must not include the prompt itself.
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
export async function runHeadlessExecProbe({
  cliPath,
  args = [],
  expectedModel,
  run = runProcess,
  timeoutMs = DEFAULT_HEADLESS_PROBE_TIMEOUT_MS,
  env = process.env,
} = {}) {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), "headless-probe-"));
  try {
    const marker = randomBytes(8).toString("hex");
    const artifactPath = path.join(sandboxDir, "probe.txt");
    const prompt = [
      `Create a new file at this exact path: ${artifactPath}`,
      `The file must contain exactly this text and nothing else: ${marker}`,
      "Do not modify or create any other file. Do not ask questions. Do not explain your steps.",
    ].join("\n");

    const result = await run(cliPath, [...args, prompt], { timeoutMs, env, cwd: sandboxDir });

    let artifactMatches = false;
    try {
      artifactMatches = (await fs.readFile(artifactPath, "utf8")).trim() === marker;
    } catch {
      artifactMatches = false;
    }
    if (result.timedOut) return { ok: false, reason: REASON_CODES.VERIFICATION_TIMEOUT };
    const combinedOutput = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (expectedModel && reportedModels(result).some((model) => model !== expectedModel)) {
      return { ok: false, reason: REASON_CODES.MODEL_MISMATCH };
    }
    if (artifactMatches && result.code === 0) return { ok: true };
    if (TTY_REQUIRED_PATTERN.test(combinedOutput)) return { ok: false, reason: REASON_CODES.TTY_REQUIRED };
    // Exited cleanly but produced no artifact: a print/response-only mode
    // that never actually exercised a tool (observed for `agy --print`).
    if (result.code === 0) return { ok: false, reason: REASON_CODES.NON_AGENTIC_PRINT_MODE };
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
        // Codex's CLI session header reports the selected canonical model.
        const match = line.match(/^model:\s*(\S+)\s*$/);
        if (match) models.push(match[1]);
      }
    }
  }
  return models;
}

/** Verify one exact candidate, isolating failures and exposing closed reasons only. */
export async function verifyModelCandidate(candidate, ctx = {}) {
  try {
    const tokens = splitSelector(candidate.selector);
    const result = await (ctx.headlessExecProbe ?? runHeadlessExecProbe)({
      cliPath: tokens[0],
      args: [...tokens.slice(1), ...(ctx.extraArgs ?? [])],
      expectedModel: candidate.model,
      run: ctx.run ?? runProcess,
      timeoutMs: ctx.headlessProbeTimeoutMs ?? DEFAULT_HEADLESS_PROBE_TIMEOUT_MS,
      env: ctx.env ?? process.env,
    });
    if (result?.ok === true) return { ok: true };
    return {
      ok: false,
      reason: Object.values(REASON_CODES).includes(result?.reason)
        ? result.reason : REASON_CODES.HEADLESS_EXEC_FAILED,
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

/** Antigravity was withdrawn by the Product Owner; do not revive cached routes. */
export function isAntigravityCommand(command) {
  return typeof command === "string" && /^(agy|antigravity)(?:\.exe)?$/i.test(command.split(/[\\/]/).at(-1));
}
export function isRetiredRuntimeRoute(route) {
  if (/^(agy|antigravity)$/i.test(String(route?.agent ?? "").trim())) return true;
  if (typeof route?.selector !== "string" || !route.selector.trim()) return false;
  return isAntigravityCommand(splitSelector(route.selector)[0]);
}

export function capabilityRecord({
  agent,
  requestedModel,
  model,
  role,
  selector,
  timeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
  selectable = true,
  verifiable = true,
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
  return record;
}

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
export async function readCliVersion(cliPath, { run = runProcess, timeoutMs = 10_000, env = process.env } = {}) {
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
    const result = await runProcess("git", ["rev-parse", "HEAD"], { cwd });
    if (result.code !== 0) return null;
    return String(result.stdout ?? "").trim() || null;
  } catch {
    return null;
  }
}

/**
 * Verify that the repository checkout is not stale compared to origin/develop.
 * Throws if fetch fails or if HEAD does not contain origin/develop.
 */
export async function verifyRepositoryFreshness(cwd) {
  const fetchResult = await runProcess("git", ["fetch", "origin", "develop"], { cwd });
  if (fetchResult.code !== 0) {
    throw new Error("orchestrator-checkout-stale:fetch-failed");
  }

  const mergeBaseResult = await runProcess("git", ["merge-base", "--is-ancestor", "origin/develop", "HEAD"], { cwd });
  if (mergeBaseResult.code !== 0) {
    const headResult = await runProcess("git", ["rev-parse", "HEAD"], { cwd });
    const originMainResult = await runProcess("git", ["rev-parse", "origin/develop"], { cwd });

    const formatSha = (res) => {
      const out = String(res.stdout ?? "").trim();
      const err = String(res.stderr ?? "").trim();
      return out || (err ? `error(${err.replace(/\\n/g, " ")})` : "unknown");
    };

    const headSha = formatSha(headResult);
    const originMainSha = formatSha(originMainResult);
    throw new Error(`orchestrator-checkout-stale:head=${headSha},origin/develop=${originMainSha}`);
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
 */
export function spawnWorker(command, args, { timeoutMs, env = process.env, cwd } = {}) {
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
  const killTree = (signal = "SIGTERM") => {
    if (!child.pid) return;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
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
      finish({ code: null, signal: null, timedOut, pid: child.pid, error: true });
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
      } ${issueNumber} ...\` (see docs/github-operations.md §2), then work only inside the path it prints. Do not run issue-implementation or handoff-issue.`,
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
      `Read the findings with \`gh pr view --comments\`: take the newest comment whose first line starts with \`role=reviewer\`.`,
      "Do NOT create a pull request — push to the same branch so the existing one updates.",
      `After pushing, post ONE pull request comment starting with the exact line \`role=implementer fix-cycle=${fixCycle}\`, stating per finding what you changed or why you did not.`,
      "Then report role-complete with role=implementer.",
    ];
  return [
    `Implement exactly one GitHub Issue using the repository ${skill} skill.`,
    "Report role-complete with role=implementer once the work is committed, pushed, and the pull request exists.",
  ];
}

/**
 * Build the minimal worker prompt — role, Issue number, and route labels
 * only. No Issue body, diff, or personal data ever enters the prompt.
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
}) {
  if (!role) {
    // Single-worker mode: one worker owns the whole Issue, as before roles.
    return [
      "Implement exactly one GitHub Issue using the repository issue-implementation (or handoff-issue) skill.",
      `Issue: #${issueNumber}`,
      `Assigned route: agent=${agent} model=${model}`,
      `Release policy: ${releasePolicy}`,
      `Next milestone: ${nextMilestone}`,
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
    NO_STATE_LEAK_RULE,
  ].join("\n");
}
