#!/usr/bin/env node
import { buildRuntimeEnvironment } from "./issue-runtime-adapters/environment.mjs";

/**
 * Dispatch a single issue worker on a verified capability route.
 *
 * Uses the same exact selector / model pair that capability discovery recorded.
 * On timeout or interruption, only the worker process tree is terminated; the
 * Issue worktree is left untouched for handoff-issue.
 *
 * A worker that owns the Issue worktree (single-worker mode or the implementer
 * role) gets a fresh lease session ID. While the worker runs, the dispatcher
 * renews that session's lease (a heartbeat) and records its own PID as the
 * owner, because some runtimes run commands through a long-running server
 * whose PID would otherwise pin the lease after the worker exits.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRoleDispatchPayload, ROLES } from "./issue-roles.mjs";
import { launchWithAdapter } from "./issue-runtime-adapters/index.mjs";
import {
  selectorHasPermissionArgs,
  selectorTargetsRoute,
} from "./issue-runtime-adapters/shared.mjs";
import {
  findRuntime,
  loadRuntimeRegistry,
  resolvePermission,
  runtimeEnvironment,
  runtimePermissionSummary,
} from "./ai-template/registry.mjs";

const WORKTREE_HELPER = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "issue-worktree.sh",
);
export const DEFAULT_LEASE_TTL_SEC = 3600;
const HEARTBEAT_HELPER_TIMEOUT_MS = 60_000;

/**
 * Resolve the permission profile `role` runs with on this route, failing closed.
 * The route must carry no permission argv of its own and must have been probed
 * under the current permission policy; the argv itself is rebuilt at launch.
 * @returns {{ profile: string, enforcement: string }}
 */
export function routePermission(route, role, root) {
  if (selectorHasPermissionArgs(route, root))
    throw new Error("route-permission-args-forbidden");
  const runtime = findRuntime(route.agent, root, { enabledOnly: true });
  if (!runtime) throw new Error(`dispatch-adapter-unavailable:${route.agent}`);
  const registry = loadRuntimeRegistry(root);
  if (
    route.permissionFingerprint !==
    runtimePermissionSummary(registry, runtime).fingerprint
  )
    throw new Error("route-permission-mismatch");
  const permission = resolvePermission(registry, runtime, role);
  if (permission.unavailable) throw new Error(permission.unavailable);
  return { profile: permission.profile, enforcement: permission.enforcement };
}

/** Reviewers and planners only read the worktree; they never hold its lease. */
export function roleOwnsWorktreeLease(role) {
  return role === undefined || role === ROLES.IMPLEMENTER;
}

/**
 * Renew well inside the lease lifetime (a third of it), so one missed or slow
 * renewal does not let the lease lapse while the worker is still running.
 * @param {NodeJS.ProcessEnv} env
 */
export function leaseHeartbeatIntervalMs(env = process.env) {
  const raw = env.ISSUE_WORKTREE_LEASE_TTL_SEC;
  const ttlSec =
    raw === undefined || raw === "" ? DEFAULT_LEASE_TTL_SEC : Number(raw);
  if (!Number.isSafeInteger(ttlSec) || ttlSec <= 0)
    throw new Error("invalid-lease-ttl");
  return Math.max(1_000, Math.floor((ttlSec * 1_000) / 3));
}

/** @returns {Promise<void>} */
function runWorktreeHelper(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    execFile(
      "bash",
      [WORKTREE_HELPER, ...args],
      { cwd, env, timeout: HEARTBEAT_HELPER_TIMEOUT_MS },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

/**
 * Periodically renew one session's Issue worktree lease until stop().
 *
 * Each beat is `issue-worktree.sh acquire --heartbeat`, which only extends a
 * lease this session actively holds: it never creates, reactivates, or takes
 * over a lease. A failed beat is expected before the worker has created or
 * handed off the worktree, so failures are ignored and the next beat retries.
 * Once the worker exits and beats stop, the lease expires and can be handed off.
 *
 * @param {object} input
 * @param {number} input.issueNumber
 * @param {string} input.session
 * @param {number} input.ownerPid - recorded as owner.pid on each renewal
 * @param {number} input.intervalMs
 * @param {string} [input.cwd]
 * @param {NodeJS.ProcessEnv} [input.env]
 * @param {(args: string[], options: { cwd?: string, env: NodeJS.ProcessEnv }) => Promise<unknown>} [input.runHelper]
 */
export function startLeaseHeartbeat({
  issueNumber,
  session,
  ownerPid,
  intervalMs,
  cwd,
  env = process.env,
  runHelper = runWorktreeHelper,
}) {
  const helperEnv = {
    ...buildRuntimeEnvironment({ parentEnv: env }),
    ISSUE_WORKTREE_OWNER_PID: String(ownerPid),
    ...(env.ISSUE_WORKTREE_LEASE_TTL_SEC
      ? { ISSUE_WORKTREE_LEASE_TTL_SEC: env.ISSUE_WORKTREE_LEASE_TTL_SEC }
      : {}),
  };
  const args = [
    "acquire",
    String(issueNumber),
    "--session",
    session,
    "--heartbeat",
  ];
  let stopped = false;
  let inFlight = false;
  const beat = () => {
    if (stopped || inFlight) return;
    inFlight = true;
    Promise.resolve()
      .then(() => runHelper(args, { cwd, env: helperEnv }))
      .catch(() => {})
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(beat, intervalMs);
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * Launch a worker for one Issue on one capability route.
 *
 * @param {object} input
 * @param {import("./issue-runtime-adapters/shared.mjs").CapabilityRecord} input.route - capability record (agent, model, selector, timeoutMs, …)
 * @param {number} input.issueNumber
 * @param {string} input.releasePolicy
 * @param {string} input.nextMilestone
 * @param {string} [input.purpose] - enterprise attestation purpose; defaults to the role
 * @param {string} [input.role] - planner | implementer | reviewer; omitted in single-worker mode
 * @param {string} [input.skill] - issue-implementation | handoff-issue
 * @param {string} [input.executionMode]
 * @param {number} [input.reviewPass]
 * @param {number} [input.fixCycle] - >0 means the implementer is fixing review findings
 * @param {string} [input.cwd]
 */
export async function dispatchWorker(input, ctx = {}) {
  const route = input?.route;
  if (!route?.agent || !route?.model || !route?.selector)
    throw new Error("route-required");
  if (route.selectable !== true || route.verifiable !== true)
    throw new Error("route-not-verified");
  if (!Number.isSafeInteger(route.timeoutMs) || route.timeoutMs <= 0)
    throw new Error("invalid-route-timeout");
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0)
    throw new Error("issue-number-required");
  if (!input.releasePolicy) throw new Error("release-policy-required");
  if (!input.nextMilestone) throw new Error("next-milestone-required");

  // Ensure the selector still parses and still targets the same model token.
  if (!selectorTargetsRoute(route, input.cwd ?? ctx.cwd))
    throw new Error("model-mismatch");
  const permission = routePermission(route, input.role, input.cwd ?? ctx.cwd);

  // The role-scoped half of the job goes through the closed-payload builder,
  // so the deny-list guard runs on the live dispatch path, not only in tests.
  const rolePayload =
    input.role === undefined
      ? {
          issueNumber: input.issueNumber,
          releasePolicy: input.releasePolicy,
          nextMilestone: input.nextMilestone,
          ...(input.skill === undefined ? {} : { skill: input.skill }),
        }
      : buildRoleDispatchPayload({
          role: input.role,
          issueNumber: input.issueNumber,
          executionMode: input.executionMode,
          skill: input.skill,
          releasePolicy: input.releasePolicy,
          nextMilestone: input.nextMilestone,
          ...(input.reviewPass === undefined
            ? {}
            : { reviewPass: input.reviewPass }),
          ...(input.fixCycle === undefined ? {} : { fixCycle: input.fixCycle }),
        });

  const workerEnv = runtimeEnvironment(
    findRuntime(route.agent, input.cwd ?? ctx.cwd) ?? { name: route.agent },
    { ...ctx, cwd: input.cwd ?? ctx.cwd },
  );

  const ownsLease = roleOwnsWorktreeLease(input.role);
  const leaseSession = ownsLease
    ? (ctx.leaseSessionId ?? `dispatch-${input.issueNumber}-${randomUUID()}`)
    : undefined;
  const ownerPid = ctx.ownerPid ?? process.pid;
  const heartbeatIntervalMs = ownsLease
    ? leaseHeartbeatIntervalMs(ctx.env ?? process.env)
    : undefined;
  if (ownsLease) {
    // The env reaches a CLI-spawned worker's shell; the prompt carries the
    // same session to runtimes whose commands run in a separate server.
    workerEnv.ISSUE_WORKTREE_SESSION = leaseSession;
    workerEnv.ISSUE_WORKTREE_OWNER_PID = String(ownerPid);
  }

  const job = {
    ...rolePayload,
    agent: route.agent,
    model: route.model,
    requestedModel: route.requestedModel,
    selector: route.selector,
    timeoutMs: route.timeoutMs,
    cwd: input.cwd,
    // Enterprise route attestation: the purpose is the dispatch role; absent means denied there.
    ...((input.purpose ?? input.role)
      ? { purpose: input.purpose ?? input.role }
      : {}),
    ...(leaseSession === undefined ? {} : { leaseSession }),
  };

  const handle = await launchWithAdapter(route.agent, job, {
    ...ctx,
    env: workerEnv,
    leaseOwnerPid: ownerPid,
  });
  const heartbeat = ownsLease
    ? (ctx.startLeaseHeartbeat ?? startLeaseHeartbeat)({
        issueNumber: input.issueNumber,
        session: leaseSession,
        ownerPid,
        intervalMs: heartbeatIntervalMs,
        cwd: input.cwd ?? ctx.cwd,
        env: ctx.env ?? process.env,
      })
    : undefined;
  // Heartbeats last exactly as long as the worker: stop on exit or spawn error.
  const done = Promise.resolve(handle.wait()).finally(() => heartbeat?.stop());
  return {
    agent: route.agent,
    model: route.model,
    selector: route.selector,
    issueNumber: input.issueNumber,
    ...(input.role === undefined ? {} : { role: input.role }),
    permission,
    pid: handle.pid,
    kill: handle.kill,
    wait: () => done,
    get timedOut() {
      return handle.timedOut;
    },
  };
}

export function parseDispatchCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const valueFlags = new Map([
      ["--route-json", "routeJson"],
      ["--issue", "issue"],
      ["--release-policy", "releasePolicy"],
      ["--next-milestone", "nextMilestone"],
      ["--role", "role"],
      ["--skill", "skill"],
      ["--execution-mode", "executionMode"],
      ["--review-pass", "reviewPass"],
      ["--fix-cycle", "fixCycle"],
      ["--cwd", "cwd"],
    ]);
    const key = valueFlags.get(flag);
    if (!key) throw new Error(`unknown-flag:${flag}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`missing-flag-value:${flag}`);
    options[key] = value;
  }
  if (!options.routeJson) throw new Error("route-json-required");
  if (!options.issue) throw new Error("issue-required");
  if (!options.releasePolicy) throw new Error("release-policy-required");
  if (!options.nextMilestone) throw new Error("next-milestone-required");
  // These flags are machine-generated; a bad value must fail closed rather
  // than reach the prompt as "review pass NaN".
  for (const [flag, key] of [
    ["--review-pass", "reviewPass"],
    ["--fix-cycle", "fixCycle"],
  ]) {
    if (options[key] === undefined) continue;
    const value = Number(options[key]);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error(`invalid-flag-value:${flag}:${options[key]}`);
  }
  return options;
}

/**
 * Map a worker wait() result to the dispatcher's process exit code. Any
 * failure is non-zero: a spawn error reports `code: null`, so the plain
 * `code` value alone would read as success.
 */
export function dispatchExitCode(result) {
  if (result.timedOut) return 124;
  if (Number.isSafeInteger(result.code) && result.code > 0) return result.code;
  if (result.signal) return 128 + (os.constants.signals[result.signal] ?? 0);
  if (result.code === 0 && !result.error) return 0;
  return 1;
}

async function main() {
  const cli = parseDispatchCliArgs(process.argv.slice(2));
  const route = JSON.parse(cli.routeJson);
  const handle = await dispatchWorker({
    route,
    issueNumber: Number(cli.issue),
    releasePolicy: cli.releasePolicy,
    nextMilestone: cli.nextMilestone,
    cwd: cli.cwd,
    ...(cli.role === undefined ? {} : { role: cli.role }),
    ...(cli.skill === undefined ? {} : { skill: cli.skill }),
    ...(cli.executionMode === undefined
      ? {}
      : { executionMode: cli.executionMode }),
    ...(cli.reviewPass === undefined
      ? {}
      : { reviewPass: Number(cli.reviewPass) }),
    ...(cli.fixCycle === undefined ? {} : { fixCycle: Number(cli.fixCycle) }),
  });
  process.stdout.write(
    `${JSON.stringify({
      status: "started",
      agent: handle.agent,
      model: handle.model,
      issueNumber: handle.issueNumber,
      ...(handle.role === undefined ? {} : { role: handle.role }),
      permission: handle.permission,
      pid: handle.pid,
    })}\n`,
  );
  const result = await handle.wait();
  const exitCode = dispatchExitCode(result);
  process.stdout.write(
    `${JSON.stringify({
      status: result.timedOut
        ? "timeout"
        : exitCode === 0
          ? "exited"
          : "failed",
      code: result.code,
      signal: result.signal ?? null,
      timedOut: Boolean(result.timedOut),
      pid: result.pid,
    })}\n`,
  );
  process.exitCode = exitCode;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ status: "error", reason: error.message })}\n`,
    );
    process.exitCode = 1;
  });
}
