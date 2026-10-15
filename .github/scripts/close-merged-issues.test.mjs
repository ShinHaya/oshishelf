import assert from "node:assert/strict";
import test from "node:test";
import closeMergedIssues, { closingIssueNumbers } from "./close-merged-issues.mjs";

test("recognizes explicit closing directives, deduplicating same-repository issues", () => {
  assert.deepEqual(closingIssueNumbers("Closes #49\nFixes #50, #51.\n- Resolves #49\nCLOSED #52\nFixed #53"), [49, 50, 51, 52, 53]);
});
test("ignores references, cross-repository issues, examples and comments", () => {
  assert.deepEqual(closingIssueNumbers("Related #49\nPartially fixes #50\nCloses other/repo#51\nCloses #52 and other/repo#53\n```\nCloses #54\n```\n<!--\nCloses #55\n-->\n> Closes #56\n    example Closes #57"), []);
});

function fixture({ merged = true, base = "develop", body = "Closes #49, #50, #51" } = {}) {
  const updates = [];
  let reads = 0;
  const current = { number: 58, merged, body, base: { ref: base, repo: { full_name: "example/app" } } };
  return {
    updates,
    get reads() { return reads; },
    args: {
      context: { repo: { owner: "example", repo: "app" }, payload: { pull_request: current } },
      core: { info() {} },
      github: { rest: {
        pulls: { get: async () => { reads++; return { data: current }; } },
        issues: {
          get: async ({ issue_number }) => ({ data: { state: issue_number === 50 ? "closed" : "open", ...(issue_number === 51 ? { pull_request: {} } : {}) } }),
          update: async (input) => { updates.push(input); },
        },
      } },
    },
  };
}
test("closes only open issues after a develop merge (PR58 regression)", async () => {
  const f = fixture();
  await closeMergedIssues(f.args);
  assert.deepEqual(f.updates, [{ owner: "example", repo: "app", issue_number: 49, state: "closed", state_reason: "completed" }]);
});
test("unmerged PRs and other target branches do not read or update issues", async () => {
  for (const options of [{ merged: false }, { base: "main" }, { base: "feature" }]) {
    const f = fixture(options);
    await closeMergedIssues(f.args);
    assert.equal(f.reads, 0);
    assert.deepEqual(f.updates, []);
  }
});
test("rechecks merged state from the API before closing issues", async () => {
  const f = fixture();
  f.args.github.rest.pulls.get = async () => ({ data: { merged: false } });
  await closeMergedIssues(f.args);
  assert.deepEqual(f.updates, []);
});
