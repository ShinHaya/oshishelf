import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const dispatchCli = path.join(repoRoot, "scripts/issue-dispatch.mjs");

async function makeFakeWorker(scriptBody) {
  const directory = await mkdtemp(path.join(tmpdir(), "example-dispatch-exit-"));
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
    timeoutMs,
  };
  const result = spawnSync(
    process.execPath,
    [
      dispatchCli,
      "--route-json", JSON.stringify(route),
      "--issue", "1",
      "--release-policy", "pr-created",
      "--next-milestone", "pr-created",
    ],
    { encoding: "utf8", timeout: 30_000 },
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
  const directory = await mkdtemp(path.join(tmpdir(), "example-dispatch-missing-"));
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
