#!/usr/bin/env node

/**
 * Dispatch a single project-issue worker on a verified capability route.
 *
 * Uses the same exact selector / model pair that capability discovery recorded.
 * On timeout or interruption, only the worker process tree is terminated; the
 * Issue worktree is left untouched for handoff-issue.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildRoleDispatchPayload } from "./project-issue-roles.mjs";
import { launchWithAdapter } from "./project-issue-runtime-adapters/index.mjs";
import { splitSelector } from "./project-issue-runtime-adapters/shared.mjs";

/**
 * Launch a worker for one Issue on one capability route.
 *
 * @param {object} input
 * @param {object} input.route - capability record (agent, model, selector, timeoutMs, …)
 * @param {number} input.issueNumber
 * @param {string} input.releasePolicy
 * @param {string} input.nextMilestone
 * @param {string} [input.role] - planner | implementer | reviewer; omitted in single-worker mode
 * @param {string} [input.skill] - issue-implementation | handoff-issue
 * @param {string} [input.executionMode]
 * @param {number} [input.reviewPass]
 * @param {number} [input.fixCycle] - >0 means the implementer is fixing review findings
 * @param {string} [input.cwd]
 */
export async function dispatchWorker(input, ctx = {}) {
  const route = input?.route;
  if (!route?.agent || !route?.model || !route?.selector) throw new Error("route-required");
  if (route.selectable !== true || route.verifiable !== true) throw new Error("route-not-verified");
  if (!Number.isSafeInteger(route.timeoutMs) || route.timeoutMs <= 0)
    throw new Error("invalid-route-timeout");
  if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0)
    throw new Error("issue-number-required");
  if (!input.releasePolicy) throw new Error("release-policy-required");
  if (!input.nextMilestone) throw new Error("next-milestone-required");

  // Ensure the selector still parses and still targets the same model token.
  const tokens = splitSelector(route.selector);
  if (!tokens.includes(route.model)) throw new Error("model-mismatch");

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
          ...(input.reviewPass === undefined ? {} : { reviewPass: input.reviewPass }),
          ...(input.fixCycle === undefined ? {} : { fixCycle: input.fixCycle }),
        });

  const job = {
    ...rolePayload,
    agent: route.agent,
    model: route.model,
    requestedModel: route.requestedModel,
    selector: route.selector,
    timeoutMs: route.timeoutMs,
    cwd: input.cwd,
  };

  // Development-only Jev credentials belong to the triage child, never workers.
  const workerEnv = { ...(ctx.env ?? process.env) };
  delete workerEnv.TYPESAFE_API_KEY;
  const handle = await launchWithAdapter(route.agent, job, { ...ctx, env: workerEnv });
  return {
    agent: route.agent,
    model: route.model,
    selector: route.selector,
    issueNumber: input.issueNumber,
    ...(input.role === undefined ? {} : { role: input.role }),
    pid: handle.pid,
    kill: handle.kill,
    wait: handle.wait,
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
    if (value === undefined || value.startsWith("--")) throw new Error(`missing-flag-value:${flag}`);
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
    ...(cli.executionMode === undefined ? {} : { executionMode: cli.executionMode }),
    ...(cli.reviewPass === undefined ? {} : { reviewPass: Number(cli.reviewPass) }),
    ...(cli.fixCycle === undefined ? {} : { fixCycle: Number(cli.fixCycle) }),
  });
  process.stdout.write(
    `${JSON.stringify({
      status: "started",
      agent: handle.agent,
      model: handle.model,
      issueNumber: handle.issueNumber,
      ...(handle.role === undefined ? {} : { role: handle.role }),
      pid: handle.pid,
    })}\n`,
  );
  const result = await handle.wait();
  process.stdout.write(
    `${JSON.stringify({
      status: result.timedOut ? "timeout" : result.code === 0 ? "exited" : "failed",
      code: result.code,
      timedOut: Boolean(result.timedOut),
      pid: result.pid,
    })}\n`,
  );
  if (result.timedOut) process.exitCode = 124;
  else if (result.code) process.exitCode = result.code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: "error", reason: error.message })}\n`);
    process.exitCode = 1;
  });
}
