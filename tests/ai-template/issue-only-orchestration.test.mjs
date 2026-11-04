import test from "node:test";
import { freshCheckoutEnv } from "./helpers/fresh-checkout.mjs";
import { isolatedScriptRoot } from "./helpers/script-root.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchRepositoryIssues } from "../../scripts/issue-github.mjs";
import { loadOrchestratorConfig } from "../../scripts/issue-config.mjs";
import {
  normalizeIssues,
  selectIssues,
  buildRunPlan,
} from "../../scripts/issue-plan.mjs";

const issue = (number, state = "OPEN", dependencies = []) => ({
  number,
  state,
  title: `Fictional issue ${number}`,
  url: `https://example.invalid/${number}`,
  labels: {
    nodes: [{ name: "priority:P1" }],
    pageInfo: { hasNextPage: false },
  },
  blockedBy: {
    nodes: dependencies.map(([number, state]) => ({
      number,
      state,
      repository: { nameWithOwner: "example-org/example-repo" },
    })),
    pageInfo: { hasNextPage: false },
  },
});

test("Issue-only planning fetches the closure without bodies", async () => {
  const seen = [];
  const fetched = await fetchRepositoryIssues({
    issues: [1],
    repository: "example-org/example-repo",
    graphql: async (query, { number }) => {
      assert.doesNotMatch(query, /fieldValues|\bbody\b/);
      seen.push(number);
      return {
        repository: {
          issue:
            number === 1
              ? issue(1, "OPEN", [[2, "CLOSED"]])
              : issue(2, "CLOSED"),
        },
      };
    },
  });
  assert.deepEqual(seen, [1, 2]);
  assert.equal(fetched.items[0].priority, "P1");
  assert.equal(fetched.items[0].size, undefined);
  const selected = selectIssues(fetched.items, { issues: [1] });
  const plan = buildRunPlan(
    normalizeIssues(selected.items, { completed: selected.completed }),
    {
      completed: selected.completed,
      maxParallel: 1,
      releasePolicy: "merged",
    },
  );
  assert.deepEqual(
    plan.runnable.map((i) => i.number),
    [1],
  );
});

test("a security label preserves high risk through Issue-only planning", async () => {
  const value = issue(1);
  value.labels.nodes.push({ name: "security" });
  const fetched = await fetchRepositoryIssues({
    issues: [1],
    repository: "example-org/example-repo",
    graphql: async () => ({ repository: { issue: value } }),
  });
  const plan = buildRunPlan(normalizeIssues(fetched.items), {
    maxParallel: 1,
    releasePolicy: "merged",
  });
  assert.equal(plan.runnable[0].riskCategory, "high");
  assert.deepEqual(plan.runnable[0].roleProgram, [
    "planner",
    "implementer",
    "reviewer",
  ]);
});

test("open Issue blockers prevent implementation without a board status", async () => {
  const fetched = await fetchRepositoryIssues({
    issues: [1],
    repository: "example-org/example-repo",
    graphql: async (_query, { number }) => ({
      repository: {
        issue: number === 1 ? issue(1, "OPEN", [[2, "OPEN"]]) : issue(2),
      },
    }),
  });
  assert.throws(
    () => selectIssues(fetched.items, { issues: [1] }),
    /dependency-open:1:2/,
  );
});

test("a merged cross-repository blocker releases the Issue without colliding with local numbers", async () => {
  const value = issue(1, "OPEN", [
    [1, "CLOSED"],
    [2, "CLOSED"],
  ]);
  value.blockedBy.nodes[0].repository.nameWithOwner = "other/project";
  const fetched = await fetchRepositoryIssues({
    issues: [1],
    repository: "example-org/example-repo",
    graphql: async (query, vars) => {
      assert.doesNotMatch(query, /\bbody\b/);
      if (vars.owner === "other")
        return {
          repository: {
            issue: {
              number: 1,
              state: "CLOSED",
              closedByPullRequestsReferences: {
                nodes: [{ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        };
      return {
        repository: { issue: vars.number === 1 ? value : issue(2, "CLOSED") },
      };
    },
  });
  const selected = selectIssues(fetched.items, { issues: [1] });
  const plan = buildRunPlan(
    normalizeIssues(selected.items, { completed: selected.completed }),
    {
      completed: selected.completed,
      maxParallel: 1,
      releasePolicy: "merged",
    },
  );
  assert.deepEqual(
    plan.runnable.map((item) => item.number),
    [1],
  );
  assert.deepEqual(fetched.items[0].dependencies, [2]);
});

test("cross-repository blockers require complete merged-PR evidence", async () => {
  for (const links of [
    { nodes: [], pageInfo: { hasNextPage: false } },
    {
      nodes: [{ state: "CLOSED", mergedAt: null }],
      pageInfo: { hasNextPage: false },
    },
    {
      nodes: [{ state: "MERGED", mergedAt: "2026-01-01T00:00:00Z" }],
      pageInfo: { hasNextPage: true },
    },
    null,
  ]) {
    const value = issue(1, "OPEN", [[2, "CLOSED"]]);
    value.blockedBy.nodes[0].repository.nameWithOwner = "other/project";
    await assert.rejects(
      fetchRepositoryIssues({
        issues: [1],
        repository: "example-org/example-repo",
        graphql: async (_query, vars) => ({
          repository: {
            issue:
              vars.owner === "other"
                ? {
                    number: 2,
                    state: "CLOSED",
                    closedByPullRequestsReferences: links,
                  }
                : value,
          },
        }),
      }),
      /issue-dependency-unavailable/,
    );
  }
});

test("truncated, ambiguous and cross-repository Issue metadata fail closed", async () => {
  for (const [
    mutate,
    reason,
  ] of /** @type {[(i: ReturnType<typeof issue>) => void, string][]} */ ([
    [
      (i) => {
        i.blockedBy.pageInfo.hasNextPage = true;
      },
      "issue-metadata-truncated",
    ],
    [
      (i) => {
        i.labels.nodes.push({ name: "priority:P2" });
      },
      "issue-priority-ambiguous",
    ],
    [
      (i) => {
        i.blockedBy.nodes[0].repository.nameWithOwner = "fixture/other";
      },
      "issue-dependency-unavailable",
    ],
  ])) {
    await assert.rejects(
      fetchRepositoryIssues({
        issues: [1],
        repository: "example-org/example-repo",
        graphql: async () => {
          const value = issue(1, "OPEN", [[2, "CLOSED"]]);
          mutate(value);
          return { repository: { issue: value } };
        },
      }),
      new RegExp(reason),
    );
  }
});

test("CLI plans from Issue numbers and a run-only config, stripping unrelated keys from gh", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "issue-only-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, "config.yaml");
  await writeFile(
    config,
    "run:\n  maxParallel: 1\n  releasePolicy: merged\n  unavailableModels: none\n",
  );
  const settings = await loadOrchestratorConfig(config);
  assert.equal(settings.maxParallel, 1);
  const gh = path.join(dir, "gh");
  await writeFile(
    gh,
    `#!/bin/sh
[ -z "\${TYPESAFE_API_KEY:-}" ] || exit 9
case "$*" in
  *fieldValues*|*' body '*) exit 10 ;;
esac
printf '%s\\n' '${JSON.stringify({ data: { repository: { issue: issue(1) } } })}'
`,
  );
  await chmod(gh, 0o755);
  const capabilities = path.join(dir, "capabilities.json");
  await writeFile(
    capabilities,
    JSON.stringify([
      {
        agent: "Codex",
        model: "fixture-parent",
        role: "parent",
        selector: "fixture",
        selectable: true,
        verifiable: true,
        timeoutMs: 1000,
      },
      {
        agent: "Claude",
        model: "fixture-worker",
        role: "worker",
        selector: "fixture",
        selectable: true,
        verifiable: true,
        timeoutMs: 1000,
      },
    ]),
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      path.join(isolatedScriptRoot(t), "scripts/issue-orchestrator.mjs"),
      "--issues",
      "1",
      "--dry-run",
      "--config",
      config,
      "--capabilities-file",
      capabilities,
      "--parent-agent",
      "Codex",
      "--parent-model",
      "fixture-parent",
    ],
    {
      cwd: dir,
      env: {
        ...(await freshCheckoutEnv(dir)),
        TYPESAFE_API_KEY: "fake-key",
        GITHUB_REPOSITORY: "example-org/example-repo",
      },
    },
  );
  const result = JSON.parse(stdout);
  assert.equal(result.plan.runnable[0].number, 1);
  assert.equal(result.statusTransitions, undefined);
});

test("repository identity comes from GITHUB_REPOSITORY and dependency checks ignore case", async () => {
  const { parseRepository, resolveRepository } =
    await import("../../scripts/issue-github.mjs");
  assert.deepEqual(
    await resolveRepository({
      env: { GITHUB_REPOSITORY: "example-org/example-repo" },
    }),
    {
      owner: "example-org",
      name: "example-repo",
      nameWithOwner: "example-org/example-repo",
    },
  );
  for (const value of [
    "",
    "example-org",
    "example-org/",
    "/example-repo",
    "a/b/c",
    "example org/repo",
  ])
    assert.throws(() => parseRepository(value), /repository-unresolved/);
  let variables;
  const fetched = await fetchRepositoryIssues({
    issues: [1],
    repository: "Example-Org/Example-Repo",
    graphql: async (_query, vars) => {
      variables = vars;
      const value = issue(1);
      value.blockedBy.nodes = [
        {
          number: 2,
          state: "CLOSED",
          repository: { nameWithOwner: "example-org/example-repo" },
        },
      ];
      return { repository: { issue: vars.number === 1 ? value : issue(2) } };
    },
  });
  assert.deepEqual(
    fetched.items.map((item) => item.number),
    [1, 2],
  );
  assert.equal(variables.owner, "Example-Org");
  assert.equal(variables.name, "Example-Repo");
});
