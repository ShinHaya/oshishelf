import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validTimestamp } from "./issue-triage-contract.mjs";

const REPOSITORY_PATTERN =
  /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/** Validate an `owner/name` repository identifier. */
export function parseRepository(value) {
  const match = REPOSITORY_PATTERN.exec(
    typeof value === "string" ? value.trim() : "",
  );
  if (!match) throw new Error("repository-unresolved");
  return {
    owner: match[1],
    name: match[2],
    nameWithOwner: `${match[1]}/${match[2]}`,
  };
}

let resolvedRepository;

/**
 * Resolve the repository whose Issues are orchestrated: `GITHUB_REPOSITORY`
 * (`owner/name`) when set, otherwise the current checkout's `gh repo view`.
 */
export function resolveRepository({ env = process.env } = {}) {
  if (env.GITHUB_REPOSITORY)
    return Promise.resolve(parseRepository(env.GITHUB_REPOSITORY));
  resolvedRepository ??= (async () => {
    const ghEnv = { ...env };
    delete ghEnv.TYPESAFE_API_KEY;
    try {
      const { stdout } = await promisify(execFile)(
        "gh",
        ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
        { env: ghEnv, encoding: "utf8", maxBuffer: 64 * 1024, timeout: 10000 },
      );
      return parseRepository(stdout);
    } catch {
      resolvedRepository = undefined;
      throw new Error("repository-unresolved");
    }
  })();
  return resolvedRepository;
}

/**
 * Read only metadata: the parent must never request the triage Issue body.
 * @param {number} issue
 * @param {{ graphql?: (query: string, variables: { owner?: string, name?: string, number?: number }) => Promise<any>, repository?: string }} [options]
 */
export async function fetchTriageRevision(issue, { graphql, repository } = {}) {
  if (
    !Number.isSafeInteger(issue) ||
    issue <= 0 ||
    typeof graphql !== "function"
  )
    return null;
  try {
    const { owner, name } = repository
      ? parseRepository(repository)
      : await resolveRepository();
    const data = await graphql(
      "query TriageRevision($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){updatedAt}}}",
      { owner, name, number: issue },
    );
    const updatedAt = data?.repository?.issue?.updatedAt;
    return validTimestamp(updatedAt) ? { updatedAt } : null;
  } catch {
    return null;
  }
}

/** Issue-only metadata transport. Never requests Issue bodies. */
export async function repositoryIssueGraphql(query, variables) {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  try {
    const args = ["api", "graphql", "-f", `query=${query}`];
    // -f keeps owner/name literal; -F types the numeric Issue variables.
    for (const [key, value] of Object.entries(variables))
      args.push(typeof value === "string" ? "-f" : "-F", `${key}=${value}`);
    const { stdout } = await promisify(execFile)("gh", args, {
      env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10000,
    });
    const result = JSON.parse(stdout);
    if (result.errors || !result.data) throw new Error();
    return result.data;
  } catch {
    throw new Error("issue-metadata-fetch-failed");
  }
}

/**
 * Fetch explicit Issues and their dependency closure without Issue text.
 * @param {{ issues: unknown[], graphql?: (query: string, variables: { owner?: string, name?: string, number?: number }) => Promise<any>, repository?: string }} options
 */
export async function fetchRepositoryIssues({
  issues,
  graphql = repositoryIssueGraphql,
  repository,
}) {
  if (
    !Array.isArray(issues) ||
    !issues.length ||
    issues.some((n) => !Number.isSafeInteger(Number(n)) || Number(n) <= 0)
  )
    throw new Error("issue-numbers-required");
  const { owner, name, nameWithOwner } = repository
    ? parseRepository(repository)
    : await resolveRepository();
  const query = `query IssueOnlyPlan($owner:String!, $name:String!, $number:Int!) {
    repository(owner:$owner, name:$name) {
      issue(number:$number) {
        number title url state
        labels(first:100) { nodes { name } pageInfo { hasNextPage } }
        blockedBy(first:100) {
          nodes { number state repository { nameWithOwner } }
          pageInfo { hasNextPage }
        }
      }
    }
  }`;
  const pending = [...new Set(issues.map(Number))];
  const items = new Map();
  const verifiedExternal = new Set();
  let fetchedBytes = 0;
  while (pending.length) {
    const number = pending.shift();
    if (items.has(number)) continue;
    if (items.size >= 256) throw new Error("issue-dependency-limit");
    const data = await graphql(query, { owner, name, number });
    const issue = data?.repository?.issue;
    if (
      !issue ||
      issue.number !== number ||
      !["OPEN", "CLOSED"].includes(issue.state) ||
      !Array.isArray(issue.labels?.nodes) ||
      !Array.isArray(issue.blockedBy?.nodes)
    )
      throw new Error("issue-metadata-unavailable");
    if (
      issue.labels.pageInfo?.hasNextPage !== false ||
      issue.blockedBy.pageInfo?.hasNextPage !== false
    )
      throw new Error("issue-metadata-truncated");
    const priority = issue.labels.nodes
      .map((l) => l.name)
      .filter((l) => /^priority:P[0-3]$/.test(l));
    if (priority.length > 1) throw new Error("issue-priority-ambiguous");
    const dependencies = issue.blockedBy.nodes;
    if (
      dependencies.some(
        (d) =>
          typeof d.repository?.nameWithOwner !== "string" ||
          !Number.isSafeInteger(d.number) ||
          d.number <= 0 ||
          !["OPEN", "CLOSED"].includes(d.state),
      )
    )
      throw new Error("issue-dependency-unavailable");
    const localDependencies = [];
    for (const dependency of dependencies) {
      if (
        dependency.repository.nameWithOwner.toLowerCase() ===
        nameWithOwner.toLowerCase()
      ) {
        localDependencies.push(dependency);
        continue;
      }
      let external;
      try {
        external = parseRepository(dependency.repository.nameWithOwner);
      } catch {
        throw new Error("issue-dependency-unavailable");
      }
      const key = `${external.nameWithOwner.toLowerCase()}#${dependency.number}`;
      if (dependency.state !== "CLOSED")
        throw new Error("issue-dependency-unavailable");
      if (verifiedExternal.has(key)) continue;
      const result = await graphql(
        `
          query ExternalBlocker(
            $owner: String!
            $name: String!
            $number: Int!
          ) {
            repository(owner: $owner, name: $name) {
              issue(number: $number) {
                number
                state
                closedByPullRequestsReferences(first: 100) {
                  nodes {
                    state
                    mergedAt
                  }
                  pageInfo {
                    hasNextPage
                  }
                }
              }
            }
          }
        `,
        {
          owner: external.owner,
          name: external.name,
          number: dependency.number,
        },
      );
      const blocker = result?.repository?.issue;
      const links = blocker?.closedByPullRequestsReferences;
      if (
        blocker?.number !== dependency.number ||
        blocker.state !== "CLOSED" ||
        !Array.isArray(links?.nodes) ||
        links.pageInfo?.hasNextPage !== false ||
        !links.nodes.some(
          (pr) =>
            pr?.state === "MERGED" &&
            typeof pr.mergedAt === "string" &&
            !Number.isNaN(Date.parse(pr.mergedAt)),
        )
      )
        throw new Error("issue-dependency-unavailable");
      fetchedBytes += Buffer.byteLength(JSON.stringify(blocker));
      verifiedExternal.add(key);
    }
    items.set(number, {
      number,
      title: issue.title,
      url: issue.url,
      status: issue.state === "OPEN" ? "Ready" : "Done",
      ...(priority.length ? { priority: priority[0].slice(9) } : {}),
      ...(issue.labels.nodes.some((l) => l.name === "security")
        ? { riskCategory: "high" }
        : {}),
      dependencies: localDependencies.map((d) => d.number),
      blockedBy: localDependencies.map(({ number, state }) => ({
        number,
        state,
      })),
    });
    fetchedBytes += Buffer.byteLength(JSON.stringify(issue));
    pending.push(...localDependencies.map((d) => d.number));
  }
  return { items: [...items.values()], fetchedBytes };
}
