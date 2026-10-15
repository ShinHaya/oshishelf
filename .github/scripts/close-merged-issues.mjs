// Explicit closing directives only: incidental references must not close issues.
export function closingIssueNumbers(body = "") {
  const numbers = new Set();
  let fenced = false;
  let inComment = false;
  for (const rawLine of body.split(/\r?\n/)) {
    let line = rawLine;
    if (inComment) {
      const end = line.indexOf("-->");
      if (end === -1) continue;
      line = line.slice(end + 3);
      inComment = false;
    }
    line = line.replace(/<!--[\s\S]*?-->/g, "");
    const start = line.indexOf("<!--");
    if (start !== -1) {
      line = line.slice(0, start);
      inComment = true;
    }
    if (/^\s*(`{3,}|~{3,})/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const directive = line.match(/^\s*(?:[-*]\s+)?(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+((?:#[1-9]\d*\s*,?\s*)+)\s*\.?\s*$/i);
    if (!directive) continue;
    for (const match of directive[1].matchAll(/#([1-9]\d*)/g)) {
      const number = Number(match[1]);
      if (Number.isSafeInteger(number)) numbers.add(number);
    }
  }
  return [...numbers];
}

export default async function closeMergedIssues({ github, context, core }) {
  const pull = context.payload.pull_request;
  if (!pull?.merged || pull.base.ref !== "develop") return;
  // Use GitHub's current PR data rather than trusting only an event snapshot.
  const { data: current } = await github.rest.pulls.get({
    ...context.repo,
    pull_number: pull.number,
  });
  if (!current.merged || current.base.ref !== "develop" || current.base.repo.full_name !== `${context.repo.owner}/${context.repo.repo}`) return;
  for (const issue_number of closingIssueNumbers(current.body ?? "")) {
    const { data: issue } = await github.rest.issues.get({ ...context.repo, issue_number });
    if (issue.pull_request || issue.state === "closed") continue;
    await github.rest.issues.update({
      ...context.repo,
      issue_number,
      state: "closed",
      state_reason: "completed",
    });
    core.info(`Closed #${issue_number} after merging PR #${current.number} into develop.`);
  }
}
