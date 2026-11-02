import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hasControlCharacter, loadRepositoryConfig } from "../../scripts/repository-config.mjs";
import { verifyRepositoryFreshness } from "../../scripts/issue-runtime-adapters/shared.mjs";

const reader = path.resolve(import.meta.dirname, "../../scripts/repository-config.mjs");
async function temporary(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "repository-settings-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return fs.realpath(dir);
}
async function writeConfig(root, config) {
  await fs.mkdir(path.join(root, ".ai-template"), { recursive: true });
  await fs.writeFile(path.join(root, ".ai-template/config.json"), JSON.stringify(config));
}
const git = (cwd, ...args) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});

test("absent repository settings preserve the existing trunk and defer commands/documents to AGENTS", async (t) => {
  const dir = await temporary(t);
  assert.deepEqual(loadRepositoryConfig(dir), { repository: { baseBranch: "main", qualityGates: [], documents: {} } });
});

test("settings and CLI expose repository-owned values as data without executing commands", async (t) => {
  const dir = await temporary(t);
  const marker = path.join(dir, "must-not-exist");
  const repository = { baseBranch: "release/next", qualityGates: [`touch ${marker}`, "npm run check"],
    documents: { requirements: "README.md", architecture: "handbook/design.md" } };
  await writeConfig(dir, { repository, agents: { enabled: ["fixture-runtime"] }, localSkills: ["fixture-skill"] });
  assert.deepEqual(loadRepositoryConfig(dir), { repository });
  const stdout = execFileSync(process.execPath, [reader, "--root", dir, "--get", "qualityGates"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(stdout), repository.qualityGates);
  const documents = execFileSync(process.execPath, [reader, "--root", dir, "--get", "documents"], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(documents), repository.documents);
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
});

test("malformed settings, unsafe refs, and escaping document paths fail closed", async (t) => {
  const dir = await temporary(t);
  const cases = [
    null, [], { repository: null }, { repository: { baseBranch: null } },
    { repository: { qualityGates: null } }, { repository: { documents: null } }, { repositry: {} }, { repository: [] }, { repository: { baseBranc: "develop" } },
    ...["bad name", "../main", "@{-1}", "refs/heads/main", "--upload-pack=fixture", "main~1", "bad\nbranch"]
      .map((baseBranch) => ({ repository: { baseBranch } })),
    { repository: { qualityGates: "npm test" } }, { repository: { qualityGates: [""] } },
    { repository: { qualityGates: ["echo fixture\nother"] } },
    { repository: { documents: [] } }, { repository: { documents: { unsupported: "README.md" } } },
    ...["../outside.md", "/outside.md", ".", "C:\\outside.md", "nested/../../outside.md"]
      .map((requirements) => ({ repository: { documents: { requirements } } })),
  ];
  for (const config of cases) {
    await writeConfig(dir, config);
    assert.throws(() => loadRepositoryConfig(dir), /repository-config-invalid/);
  }
  await fs.writeFile(path.join(dir, ".ai-template/config.json"), "{broken");
  assert.throws(() => loadRepositoryConfig(dir), /repository-config-invalid-json/);
});

test("control characters are exactly U+0000-U+001F and U+007F", () => {
  for (const value of ["\x00", "a\x1fb", "\t", "end\x7f"]) assert.equal(hasControlCharacter(value), true, JSON.stringify(value));
  for (const value of ["", " ", "~", "\x80", "設計.md", "fixture-😀"]) assert.equal(hasControlCharacter(value), false, JSON.stringify(value));
});

test("freshness follows the configured trunk, rejecting a checkout after that remote advances", async (t) => {
  const dir = await temporary(t);
  const remote = path.join(dir, "remote.git");
  const producer = path.join(dir, "producer");
  const checkout = path.join(dir, "checkout with spaces");
  git(dir, "init", "--bare", remote);
  git(dir, "init", "-b", "develop", producer);
  git(producer, "config", "user.name", "Fixture");
  git(producer, "config", "user.email", "fixture@example.invalid");
  await fs.writeFile(path.join(producer, "fixture.txt"), "first\n");
  git(producer, "add", "."); git(producer, "commit", "-m", "fixture first");
  git(producer, "remote", "add", "origin", remote); git(producer, "push", "origin", "develop");
  git(dir, "clone", "--branch", "develop", remote, checkout);
  await writeConfig(checkout, { repository: { baseBranch: "develop" } });
  await verifyRepositoryFreshness(checkout);
  await fs.writeFile(path.join(producer, "fixture.txt"), "second\n");
  git(producer, "add", "."); git(producer, "commit", "-m", "fixture second"); git(producer, "push", "origin", "develop");
  await assert.rejects(verifyRepositoryFreshness(checkout), /orchestrator-checkout-stale:head=.*origin\/develop=/);
  git(checkout, "merge", "--ff-only", "origin/develop");
  await verifyRepositoryFreshness(checkout);
});
