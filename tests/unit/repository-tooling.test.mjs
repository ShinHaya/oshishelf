import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifyRepositoryFreshness } from "../../scripts/project-issue-runtime-adapters/shared.mjs";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "../..");

test("hook setup preserves an existing hooksPath and installs pnpm gates idempotently", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "oshishelf-hooks-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "scripts"));
  await mkdir(path.join(dir, ".githooks"));
  for (const file of ["scripts/setup-hooks.sh", ".githooks/pre-commit"])
    await copyFile(path.join(root, file), path.join(dir, file));
  await exec("git", ["init", dir]);
  await exec("git", ["config", "core.hooksPath", "custom-hooks"], { cwd: dir });
  await assert.rejects(exec("bash", ["scripts/setup-hooks.sh"], { cwd: dir }), /existing core.hooksPath/);
  assert.equal((await exec("git", ["config", "core.hooksPath"], { cwd: dir })).stdout.trim(), "custom-hooks");
  await exec("git", ["config", "--unset", "core.hooksPath"], { cwd: dir });
  await exec("bash", ["scripts/setup-hooks.sh"], { cwd: dir });
  await exec("bash", ["scripts/setup-hooks.sh"], { cwd: dir });
  const log = path.join(dir, "calls");
  const pnpm = path.join(dir, "pnpm");
  await writeFile(pnpm, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TOOLING_TEST_LOG"\n');
  await chmod(pnpm, 0o755);
  await exec("bash", [".githooks/pre-commit"], { cwd: dir, env: {
    ...process.env, PATH: `${dir}:${process.env.PATH}`, TOOLING_TEST_LOG: log,
  } });
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(log, "utf8"), "lint\ntypecheck\n");
});

test("freshness uses develop even when main has unrelated history", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "oshishelf-freshness-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const remote = path.join(dir, "remote.git");
  const repo = path.join(dir, "repo");
  await exec("git", ["init", "--bare", remote]);
  await exec("git", ["init", "-b", "develop", repo]);
  const git = (...args) => exec("git", args, { cwd: repo });
  await git("config", "user.email", "fictional@example.invalid");
  await git("config", "user.name", "Fictional Test");
  await git("commit", "--allow-empty", "-m", "develop base");
  await git("remote", "add", "origin", remote);
  await git("push", "origin", "develop");
  await git("checkout", "--orphan", "main");
  await git("commit", "--allow-empty", "-m", "unrelated main");
  await git("push", "origin", "main");
  await git("checkout", "develop");
  await verifyRepositoryFreshness(repo);
  await git("checkout", "main");
  await assert.rejects(verifyRepositoryFreshness(repo), /orchestrator-checkout-stale:.*origin\/develop=/);
});
