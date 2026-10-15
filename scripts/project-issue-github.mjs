import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { validTimestamp } from "./project-issue-triage-contract.mjs";
import { OWNER_TYPES } from "./project-issue-assignment.mjs";

export const DEFAULT_PROJECT_FIELD_NAMES = Object.freeze({
  priority: "Priority",
  iteration: "Iteration",
  size: "Size",
  status: "Status",
  startDate: "Start date",
});

export function buildProjectItemsQuery(ownerType) {
  if (!OWNER_TYPES.has(ownerType)) throw new Error("invalid-owner-type");
  return `query ProjectIssueOrchestration($owner: String!, $name: String!, $cursor: String) { ${ownerType}(login: $owner) { projectsV2(first: 10, query: $name) { nodes { title items(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { fieldValues(first: 100) { nodes { ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2FieldCommon { name } } } ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2FieldCommon { name } } } } } content { __typename ... on Issue { number title url blockedBy(first: 100) { nodes { number state } } } } } } } } } }`;
}

function requiredString(value, reason) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(reason);
  return value.trim();
}

function resolveFieldNames(fields = {}) {
  return {
    priority: fields.priority ?? DEFAULT_PROJECT_FIELD_NAMES.priority,
    iteration: fields.iteration ?? DEFAULT_PROJECT_FIELD_NAMES.iteration,
    size: fields.size ?? DEFAULT_PROJECT_FIELD_NAMES.size,
    status: fields.status ?? DEFAULT_PROJECT_FIELD_NAMES.status,
    startDate: fields.startDate ?? DEFAULT_PROJECT_FIELD_NAMES.startDate,
  };
}

/**
 * Fetch Project items and map each Issue to the minimal planning schema.
 * Issue bodies are never requested: dependencies come from GitHub `blockedBy`
 * relations and Priority/Size/Status come from Project fields, so no bounded
 * body extraction is needed. `fields` maps the legacy Project field names
 * (priority / size / …).
 */
export async function fetchProjectItems({ owner, ownerType = "organization", projectName, graphql, fields = {} }) {
  requiredString(owner, "project-owner-required");
  requiredString(projectName, "project-name-required");
  if (typeof graphql !== "function") throw new Error("graphql-required");
  const fieldNames = resolveFieldNames(fields);
  const query = buildProjectItemsQuery(ownerType);
  const nodes = [];
  let cursor = null;
  while (true) {
    const data = await graphql(query, { owner, name: projectName, cursor });
    const projects =
      data?.[ownerType]?.projectsV2?.nodes ??
      (data?.[ownerType]?.projectV2
        ? [{ title: projectName, items: data[ownerType].projectV2.items }]
        : null);
    if (!Array.isArray(projects)) throw new Error("project-not-found");
    const matches = projects.filter((project) => project?.title === projectName);
    if (!matches.length) throw new Error("project-not-found");
    if (matches.length !== 1) throw new Error("project-name-ambiguous");
    const items = matches[0].items;
    if (!Array.isArray(items?.nodes)) throw new Error("project-items-not-found");
    nodes.push(...items.nodes);
    if (!items.pageInfo?.hasNextPage) break;
    if (!items.pageInfo.endCursor) throw new Error("project-pagination-cursor-missing");
    cursor = items.pageInfo.endCursor;
  }
  // Total UTF-8 JSON bytes for every Project item node fetched, including
  // non-Issue nodes that are discarded below. This is a bounded-read metric,
  // not an Issue-body byte count (Issue bodies are never requested).
  let fetchedBytes = 0;
  const mapped = nodes.flatMap((node) => {
    fetchedBytes += Buffer.byteLength(JSON.stringify(node), "utf8");
    if (node.content?.__typename !== "Issue") return [];
    const fieldValues = new Map(
      (node.fieldValues?.nodes ?? []).map((value) => [
        value.field?.name,
        value.name ?? value.date ?? value.title,
      ]),
    );
    const blockedBy = node.content?.blockedBy?.nodes ?? [];
    return [
      {
        number: node.content?.number,
        title: node.content?.title,
        url: node.content?.url,
        status: fieldValues.get(fieldNames.status),
        priority: fieldValues.get(fieldNames.priority),
        iteration: fieldValues.get(fieldNames.iteration),
        size: fieldValues.get(fieldNames.size),
        startDate: fieldValues.get(fieldNames.startDate),
        dependencies: blockedBy.map((dependency) => Number(dependency.number)),
        blockedBy: blockedBy.map(({ number: dependency, state }) => ({
          number: Number(dependency),
          state,
        })),
      },
    ];
  });
  return { items: mapped, fetchedBytes };
}

export async function githubGraphql(query, variables, { token, fetchImpl = fetch } = {}) {
  if (!token) throw new Error("github-token-required");
  const response = await fetchImpl("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await response.json();
  if (!response.ok || payload.errors?.length) throw new Error("github-graphql-failed");
  return payload.data;
}

export function buildProjectByNumberQuery(ownerType) {
  if (!OWNER_TYPES.has(ownerType)) throw new Error("invalid-owner-type");
  return `query GetProject($owner: String!, $number: Int!) {
  ${ownerType}(login: $owner) {
    projectV2(number: $number) {
      id
      fields(first: 100) {
        nodes {
          ... on ProjectV2Field { id name dataType }
          ... on ProjectV2SingleSelectField { id name dataType options { id name } }
        }
      }
      items(first: 100) {
        nodes {
          id
          content { ... on Issue { number } }
          fieldValues(first: 100) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2FieldCommon { name } }
              }
            }
          }
        }
      }
    }
  }
}`;
}

const UPDATE_STATUS_MUTATION = `mutation UpdateStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId itemId: $itemId fieldId: $fieldId value: $value }) {
    projectV2Item { id }
  }
}`;

const READBACK_STATUS_QUERY = `query ReadbackStatus($itemId: ID!) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      fieldValues(first: 100) {
        nodes {
          ... on ProjectV2ItemFieldSingleSelectValue {
            name
            field { ... on ProjectV2FieldCommon { name } }
          }
        }
      }
    }
  }
}`;

/**
 * Transition selected Backlog items to Ready status before orchestration.
 * Follows fail-close pattern: validate all IDs before mutations, perform mutations,
 * then readback and validate. Idempotent: Ready/InProgress/InReview/Done items unchanged.
 */
export async function transitionBacklogToReady({
  projectNumber,
  projectOwner,
  projectOwnerType = "organization",
  selectedIssueNumbers = [],
  dryRun = false,
  graphql,
  fields = {},
}) {
  requiredString(projectOwner, "project-owner-required");
  if (!Number.isSafeInteger(projectNumber) || projectNumber <= 0) throw new Error("invalid-project-number");
  if (typeof graphql !== "function") throw new Error("graphql-required");
  if (!Array.isArray(selectedIssueNumbers)) throw new Error("selected-issue-numbers-required");

  const fieldNames = resolveFieldNames(fields);
  const selectedSet = new Set(selectedIssueNumbers.map(Number));
  if (selectedSet.size === 0) return { transitioned: [] };

  // Phase 1: Fetch Project and validate all IDs before mutations
  const projectData = await graphql(buildProjectByNumberQuery(projectOwnerType), {
    owner: projectOwner,
    number: projectNumber,
  });
  const project = projectData?.[projectOwnerType]?.projectV2;
  if (!project) throw new Error("project-not-found");

  const statusField = project.fields.nodes.find((f) => f.name === fieldNames.status);
  if (!statusField) throw new Error(`project-field-not-found:${fieldNames.status}`);
  if (statusField.dataType !== "SINGLE_SELECT") throw new Error(`project-field-type-mismatch:${fieldNames.status}`);

  const readyOption = statusField.options.find((opt) => opt.name === "Ready");
  if (!readyOption) throw new Error("status-ready-option-not-found");

  const backlogOption = statusField.options.find((opt) => opt.name === "Backlog");
  if (!backlogOption) throw new Error("status-backlog-option-not-found");

  // Map Issue numbers to Project item IDs; identify Backlog items to transition
  const itemsByNumber = new Map(
    project.items.nodes
      .filter((item) => item.content?.number !== undefined)
      .map((item) => [Number(item.content.number), item]),
  );

  const toTransition = [];
  for (const issueNumber of selectedSet) {
    const item = itemsByNumber.get(issueNumber);
    if (!item) throw new Error(`project-item-not-found:${issueNumber}`);

    const statusValue = item.fieldValues.nodes.find((fv) => fv.field?.name === fieldNames.status);
    const currentStatus = statusValue?.name;

    // Only transition if currently Backlog; all other statuses are idempotent (no-op)
    if (currentStatus === "Backlog") {
      toTransition.push({ issueNumber, itemId: item.id });
    }
  }

  if (toTransition.length === 0) return { transitioned: [] };
  if (dryRun) return { transitioned: toTransition.map((t) => t.issueNumber), dryRun: true };

  // Phase 2: Perform mutations
  for (const { itemId } of toTransition) {
    await graphql(UPDATE_STATUS_MUTATION, {
      projectId: project.id,
      itemId,
      fieldId: statusField.id,
      value: { singleSelectOptionId: readyOption.id },
    });
  }

  // Phase 3: Readback and validate all transitions converged
  const failedTransitions = [];
  for (const { issueNumber, itemId } of toTransition) {
    const readback = await graphql(READBACK_STATUS_QUERY, { itemId });
    if (!readback?.node || !Array.isArray(readback.node.fieldValues?.nodes))
      throw new Error(`project-readback-unavailable:${issueNumber}`);

    const statusValue = readback.node.fieldValues.nodes.find((fv) => fv.field?.name === fieldNames.status);
    if (statusValue?.name !== "Ready") {
      failedTransitions.push(issueNumber);
    }
  }

  if (failedTransitions.length) {
    const error = new Error(`status-transition-unconverged:${failedTransitions.join(",")}`);
    error.issues = failedTransitions;
    throw error;
  }

  return { transitioned: toTransition.map((t) => t.issueNumber) };
}

const REPOSITORY_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/** Validate an `owner/name` repository identifier. */
export function parseRepository(value) {
  const match = REPOSITORY_PATTERN.exec(typeof value === "string" ? value.trim() : "");
  if (!match) throw new Error("repository-unresolved");
  return { owner: match[1], name: match[2], nameWithOwner: `${match[1]}/${match[2]}` };
}

let resolvedRepository;

/**
 * Resolve the repository whose Issues are orchestrated: `GITHUB_REPOSITORY`
 * (`owner/name`) when set, otherwise the current checkout's `gh repo view`.
 */
export function resolveRepository({ env = process.env } = {}) {
  if (env.GITHUB_REPOSITORY) return Promise.resolve(parseRepository(env.GITHUB_REPOSITORY));
  resolvedRepository ??= (async () => {
    const ghEnv = { ...env };
    delete ghEnv.TYPESAFE_API_KEY;
    delete ghEnv.GH_PROJECT_TOKEN;
    try {
      const { stdout } = await promisify(execFile)(
        "gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
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

/** Read only metadata: the parent must never request the triage Issue body. */
export async function fetchTriageRevision(issue, { graphql, repository } = {}) {
  if (!Number.isSafeInteger(issue) || issue <= 0 || typeof graphql !== "function") return null;
  try {
    const { owner, name } = repository ? parseRepository(repository) : await resolveRepository();
    const data = await graphql(
      "query TriageRevision($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){updatedAt}}}",
      { owner, name, number: issue },
    );
    const updatedAt = data?.repository?.issue?.updatedAt;
    return validTimestamp(updatedAt) ? { updatedAt } : null;
  } catch { return null; }
}


/** Issue-only metadata transport. Never requests bodies or uses Project credentials. */
export async function repositoryIssueGraphql(query, variables) {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  delete env.GH_PROJECT_TOKEN;
  try {
    const args = ["api", "graphql", "-f", `query=${query}`];
    // -f keeps owner/name literal; -F types the numeric Issue variables.
    for (const [key, value] of Object.entries(variables))
      args.push(typeof value === "string" ? "-f" : "-F", `${key}=${value}`);
    const { stdout } = await promisify(execFile)("gh", args, {
      env, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10000,
    });
    const result = JSON.parse(stdout);
    if (result.errors || !result.data) throw new Error();
    return result.data;
  } catch {
    throw new Error("issue-metadata-fetch-failed");
  }
}

/** Fetch explicit Issues and their dependency closure without Project or Issue text. */
export async function fetchRepositoryIssues({ issues, graphql = repositoryIssueGraphql, repository }) {
  if (!Array.isArray(issues) || !issues.length || issues.some((n) => !Number.isSafeInteger(Number(n)) || Number(n) <= 0))
    throw new Error("issue-numbers-required");
  const { owner, name, nameWithOwner } = repository ? parseRepository(repository) : await resolveRepository();
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
  let fetchedBytes = 0;
  while (pending.length) {
    const number = pending.shift();
    if (items.has(number)) continue;
    if (items.size >= 256) throw new Error("issue-dependency-limit");
    const data = await graphql(query, { owner, name, number });
    const issue = data?.repository?.issue;
    if (!issue || issue.number !== number || !["OPEN", "CLOSED"].includes(issue.state) ||
        !Array.isArray(issue.labels?.nodes) || !Array.isArray(issue.blockedBy?.nodes))
      throw new Error("issue-metadata-unavailable");
    if (issue.labels.pageInfo?.hasNextPage !== false || issue.blockedBy.pageInfo?.hasNextPage !== false)
      throw new Error("issue-metadata-truncated");
    const priority = issue.labels.nodes.map((l) => l.name).filter((l) => /^priority:P[0-3]$/.test(l));
    if (priority.length > 1) throw new Error("issue-priority-ambiguous");
    const dependencies = issue.blockedBy.nodes;
    if (dependencies.some((d) => d.repository?.nameWithOwner?.toLowerCase() !== nameWithOwner.toLowerCase() ||
        !Number.isSafeInteger(d.number) || d.number <= 0 || !["OPEN", "CLOSED"].includes(d.state)))
      throw new Error("issue-dependency-unavailable");
    items.set(number, {
      number, title: issue.title, url: issue.url,
      status: issue.state === "OPEN" ? "Ready" : "Done",
      ...(priority.length ? { priority: priority[0].slice(9) } : {}),
      ...(issue.labels.nodes.some((l) => l.name === "security") ? { riskCategory: "high" } : {}),
      dependencies: dependencies.map((d) => d.number),
      blockedBy: dependencies.map(({ number, state }) => ({ number, state })),
    });
    fetchedBytes += Buffer.byteLength(JSON.stringify(issue));
    pending.push(...dependencies.map((d) => d.number));
  }
  return { items: [...items.values()], fetchedBytes };
}
