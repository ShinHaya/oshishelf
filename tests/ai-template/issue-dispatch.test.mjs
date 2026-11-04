import test from "node:test";
import {
  dispatchWorker,
  leaseHeartbeatIntervalMs,
  startLeaseHeartbeat,
} from "../../scripts/issue-dispatch.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { permissionFingerprintFor } from "../../scripts/ai-template/registry.mjs";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const dispatchCli = path.join(repoRoot, "scripts/issue-dispatch.mjs");

async function makeFakeWorker(scriptBody) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "example-dispatch-exit-"),
  );
  const filePath = path.join(directory, "claude");
  await writeFile(filePath, `#!${process.execPath}\n${scriptBody}\n`, "utf8");
  await chmod(filePath, 0o755);
  return filePath;
}

/** Run the dispatch CLI on a verified-looking route and return its exit and last JSON line. */
function runDispatch(executable, { timeoutMs = 10_000 } = {}) {
  const route = {
    agent: "Claude",
    model: "sonnet",
    role: "worker",
    selector: `${executable} --model sonnet`,
    selectable: true,
    verifiable: true,
    permissionFingerprint: permissionFingerprintFor("claude", repoRoot),
    timeoutMs,
  };
  const result = spawnSync(
    process.execPath,
    [
      dispatchCli,
      "--route-json",
      JSON.stringify(route),
      "--issue",
      "1",
      "--release-policy",
      "pr-created",
      "--next-milestone",
      "pr-created",
    ],
    { encoding: "utf8", timeout: 30_000, cwd: repoRoot },
  );
  const lines = result.stdout.trim().split("\n").filter(Boolean);
  return { status: result.status, final: JSON.parse(lines.at(-1)) };
}

test("dispatch CLI exits 0 when the worker exits 0", async () => {
  const worker = await makeFakeWorker("process.exit(0);");
  const { status, final } = runDispatch(worker);
  assert.equal(status, 0);
  assert.equal(final.status, "exited");
});

test("dispatch CLI exits non-zero when the worker executable is missing", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "example-dispatch-missing-"),
  );
  const { status, final } = runDispatch(path.join(directory, "claude"));
  assert.equal(final.status, "failed");
  assert.equal(final.code, null);
  assert.notEqual(status, 0);
});

test("dispatch CLI propagates a worker's non-zero exit code", async () => {
  const worker = await makeFakeWorker("process.exit(3);");
  const { status, final } = runDispatch(worker);
  assert.equal(status, 3);
  assert.equal(final.status, "failed");
});

test("dispatch CLI exits 128 + signal number when the worker is killed by a signal", async () => {
  const worker = await makeFakeWorker('process.kill(process.pid, "SIGTERM");');
  const { status, final } = runDispatch(worker);
  assert.equal(final.status, "failed");
  assert.equal(final.signal, "SIGTERM");
  assert.equal(status, 143);
});

test("dispatch CLI exits 124 when the worker times out", async () => {
  const worker = await makeFakeWorker("setInterval(() => {}, 60_000);");
  const { status, final } = runDispatch(worker, { timeoutMs: 200 });
  assert.equal(final.status, "timeout");
  assert.equal(status, 124);
});

for (const scenario of [
  {
    name: "accepts a verified Claude alias",
    agent: "Claude",
    token: "sonnet",
    requestedModel: "sonnet",
    accepted: true,
  },
  {
    name: "accepts the exact canonical model",
    agent: "Claude",
    token: "claude-sonnet-4-6",
    requestedModel: "sonnet",
    accepted: true,
  },
  {
    name: "rejects an unrelated alias",
    agent: "Claude",
    token: "opus",
    requestedModel: "sonnet",
  },
  {
    name: "rejects case changes",
    agent: "Claude",
    token: "Sonnet",
    requestedModel: "sonnet",
  },
  {
    name: "rejects partial alias matches",
    agent: "Claude",
    token: "sonnet-extra",
    requestedModel: "sonnet",
  },
  {
    name: "rejects an absent requested model",
    agent: "Claude",
    token: "sonnet",
  },
  {
    name: "rejects aliases for a runtime without reported-model resolution",
    agent: "Codex",
    token: "sonnet",
    requestedModel: "sonnet",
  },
]) {
  test(`dispatch ${scenario.name}`, async () => {
    const launches = [];
    const operation = dispatchWorker(
      {
        route: {
          agent: scenario.agent,
          role: "worker",
          model: "claude-sonnet-4-6",
          requestedModel: scenario.requestedModel,
          selector: `claude --model ${scenario.token}`,
          selectable: true,
          verifiable: true,
          permissionFingerprint: permissionFingerprintFor(
            scenario.agent,
            repoRoot,
          ),
          timeoutMs: 1000,
        },
        issueNumber: 1,
        releasePolicy: "pr-created",
        nextMilestone: "pr-created",
        cwd: repoRoot,
      },
      {
        spawnWorker: async (...args) => {
          launches.push(args);
          return { pid: 123, kill() {}, wait: async () => ({ code: 0 }) };
        },
      },
    );
    if (scenario.accepted) {
      const handle = await operation;
      assert.equal(handle.model, "claude-sonnet-4-6");
      assert.equal(launches.length, 1);
      assert.deepEqual(launches[0][1].slice(0, 2), ["--model", scenario.token]);
    } else {
      await assert.rejects(operation, /^Error: model-mismatch$/);
      assert.equal(launches.length, 0);
    }
  });
}

/** @param {{ role?: string, env?: Record<string, string>, heartbeats?: any[] }} [options] */
function leaseDispatch({ role, env = {}, heartbeats = [] } = {}) {
  const launches = [];
  const operation = dispatchWorker(
    {
      route: {
        agent: "Claude",
        role: "worker",
        model: "claude-sonnet-4-6",
        requestedModel: "sonnet",
        selector: "claude --model sonnet",
        selectable: true,
        verifiable: true,
        permissionFingerprint: permissionFingerprintFor("claude", repoRoot),
        timeoutMs: 1000,
      },
      issueNumber: 7,
      releasePolicy: "pr-created",
      nextMilestone: "pr-created",
      cwd: repoRoot,
      ...(role === undefined
        ? {}
        : {
            role,
            executionMode: "direct-review",
            skill: "issue-implementation",
          }),
    },
    {
      env,
      ownerPid: 4242,
      spawnWorker: async (...args) => {
        launches.push(args);
        return { pid: 123, kill() {}, wait: async () => ({ code: 0 }) };
      },
      startLeaseHeartbeat: (options) => {
        const record = { options, stopped: false };
        heartbeats.push(record);
        return {
          stop: () => {
            record.stopped = true;
          },
        };
      },
    },
  );
  return { operation, launches, heartbeats };
}

for (const role of [undefined, "implementer"]) {
  test(`dispatch gives the ${role ?? "single"} worker a fresh lease session and renews it while the worker runs`, async () => {
    const { operation, launches, heartbeats } = leaseDispatch({
      role,
      env: {
        ISSUE_WORKTREE_LEASE_TTL_SEC: "60",
        ISSUE_WORKTREE_SESSION: "enclosing-session",
      },
    });
    const handle = await operation;
    const [, args, options] = launches[0];
    const session = options.env.ISSUE_WORKTREE_SESSION;
    assert.match(session, /^dispatch-7-[0-9a-f-]{36}$/);
    assert.equal(options.env.ISSUE_WORKTREE_OWNER_PID, "4242");
    const prompt = args.at(-1);
    assert.ok(prompt.includes(`--session ${session}`), prompt);
    assert.ok(
      prompt.includes(`acquire 7 --agent Claude --session ${session}`),
      prompt,
    );
    assert.equal(heartbeats.length, 1);
    assert.equal(heartbeats[0].options.session, session);
    assert.equal(heartbeats[0].options.ownerPid, 4242);
    assert.equal(heartbeats[0].options.issueNumber, 7);
    assert.equal(heartbeats[0].options.intervalMs, 20_000);
    await handle.wait();
    assert.equal(heartbeats[0].stopped, true);
  });
}

test("dispatch never gives a reviewer a lease session, including one inherited from the parent", async () => {
  const { operation, launches, heartbeats } = leaseDispatch({
    role: "reviewer",
    env: {
      ISSUE_WORKTREE_SESSION: "enclosing-session",
      ISSUE_WORKTREE_OWNER_PID: "99",
    },
  });
  await operation;
  const [, args, options] = launches[0];
  assert.equal(options.env.ISSUE_WORKTREE_SESSION, undefined);
  assert.equal(options.env.ISSUE_WORKTREE_OWNER_PID, undefined);
  assert.ok(!args.at(-1).includes("lease session"));
  assert.equal(heartbeats.length, 0);
});

test("dispatch rejects an invalid lease TTL before launching the worker", async () => {
  const { operation, launches } = leaseDispatch({
    env: { ISSUE_WORKTREE_LEASE_TTL_SEC: "soon" },
  });
  await assert.rejects(operation, /^Error: invalid-lease-ttl$/);
  assert.equal(launches.length, 0);
});

test("lease heartbeat interval is a third of the lease TTL with a one-second floor", () => {
  assert.equal(leaseHeartbeatIntervalMs({}), 1_200_000);
  assert.equal(
    leaseHeartbeatIntervalMs({ ISSUE_WORKTREE_LEASE_TTL_SEC: "60" }),
    20_000,
  );
  assert.equal(
    leaseHeartbeatIntervalMs({ ISSUE_WORKTREE_LEASE_TTL_SEC: "1" }),
    1_000,
  );
  for (const bad of ["0", "-5", "1.5", "abc"]) {
    assert.throws(
      () => leaseHeartbeatIntervalMs({ ISSUE_WORKTREE_LEASE_TTL_SEC: bad }),
      /invalid-lease-ttl/,
    );
  }
});

async function waitFor(
  condition,
  { timeoutMs = 20_000, intervalMs = 20 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline)
      throw new Error("condition not met before timeout");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test("lease heartbeat renews as the owner, survives failed beats, and stops cleanly", async () => {
  const calls = [];
  const heartbeat = startLeaseHeartbeat({
    issueNumber: 7,
    session: "dispatch-7-example",
    ownerPid: 4242,
    intervalMs: 10,
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      EXAMPLE_RUNTIME_TOKEN: "fake-runtime-value",
      UNRELATED_SECRET: "fake-unrelated-value",
    },
    runHelper: async (args, options) => {
      calls.push({ args, options });
      if (calls.length === 1) throw new Error("no lifecycle metadata yet");
    },
  });
  await waitFor(() => calls.length >= 3);
  heartbeat.stop();
  const stoppedAt = calls.length;
  assert.deepEqual(calls[0].args, [
    "acquire",
    "7",
    "--session",
    "dispatch-7-example",
    "--heartbeat",
  ]);
  assert.equal(calls[0].options.env.ISSUE_WORKTREE_OWNER_PID, "4242");
  assert.equal(calls[0].options.env.EXAMPLE_RUNTIME_TOKEN, undefined);
  assert.equal(calls[0].options.env.UNRELATED_SECRET, undefined);
  assert.equal(calls[0].options.cwd, repoRoot);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(calls.length, stoppedAt);
});

test(
  "lease heartbeat extends a real Issue worktree lease through the lifecycle helper",
  { timeout: 120_000 },
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "example-dispatch-lease-"));
    const remote = path.join(root, "remote.git");
    const repo = path.join(root, "repo");
    const git = (...args) => {
      const result = spawnSync("git", args, { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    try {
      git("init", "--bare", remote);
      git("init", "-b", "main", repo);
      git("-C", repo, "config", "user.name", "Test");
      git("-C", repo, "config", "user.email", "test@example.invalid");
      git("-C", repo, "commit", "--allow-empty", "-m", "init");
      git("-C", repo, "remote", "add", "origin", remote);
      git("-C", repo, "push", "-u", "origin", "main");
      const session = "dispatch-397-example";
      const helper = path.join(repoRoot, "scripts/issue-worktree.sh");
      const env = {
        ...process.env,
        ISSUE_WORKTREE_SKIP_GITHUB: "1",
        ISSUE_WORKTREE_LEASE_TTL_SEC: "600",
      };
      const created = spawnSync(
        "bash",
        [
          helper,
          "create",
          "397",
          "lease-heartbeat",
          "--agent",
          "claude",
          "--session",
          session,
          "--repo",
          repo,
        ],
        { encoding: "utf8", env },
      );
      assert.equal(created.status, 0, created.stderr);
      const stateFile = path.join(repo, ".git/issue-worktrees/397.json");
      const state = JSON.parse(await readFile(stateFile, "utf8"));
      state.owner.expires_at_epoch = Math.floor(Date.now() / 1000) + 5;
      await writeFile(stateFile, `${JSON.stringify(state)}\n`, "utf8");

      const heartbeat = startLeaseHeartbeat({
        issueNumber: 397,
        session,
        ownerPid: process.pid,
        intervalMs: 100,
        cwd: repo,
        env,
      });
      try {
        await waitFor(async () => {
          const owner = JSON.parse(await readFile(stateFile, "utf8")).owner;
          return owner.expires_at_epoch > Math.floor(Date.now() / 1000) + 500;
        });
      } finally {
        heartbeat.stop();
      }
      const owner = JSON.parse(await readFile(stateFile, "utf8")).owner;
      assert.equal(owner.pid, process.pid);
      assert.equal(owner.agent, "claude");
      assert.equal(owner.active, true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
