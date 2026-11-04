# Read-only cloud observation

Provider-independent rules for investigating a failed Cloud deploy or
infrastructure-as-code apply, plus one fictional GCP example. The concrete
command and identity name for a repository live in that repository's
development document (`Deploy failure diagnosis`), not in this file.
`skills/issue-implementation/**` is template-managed and is replaced on sync.
The development document is repo-owned, so a sync keeps the consumer's command.

This template does not add `cloud.observerConfig` or `cloud.diagnoseCommand`
to `.ai-template/config.json`. Repository settings accept only `baseBranch`,
`qualityGates`, and `documents`. A command with caveats stays in prose.
Point at the development document from `AGENTS.md`.

Examples below use `example-project`, `agent-observer`, `example-observer`,
and `user@example.com`. They are not defaults. Do not copy a real project id,
account, URL, or member list into the template or into CI.

## When the CI log is not enough

A deploy or apply can stop after creating a revision that never starts or
never receives traffic. The CI log then shows a failed step and omits the
live condition. Before deciding the cause:

1. Read the repository development document, section `Deploy failure diagnosis`.
2. Run only the read-only command recorded there, with the observer identity
   it names.
3. Compare that output with the failed step. Record the cause in the Issue
   or PR.
4. Change infrastructure through the repository's IaC. Do not hand-edit
   production unless the Product Owner asks, and record any manual change.

If that section records no procedure, stop. Do not invent a provider command
and do not fall back to a broader operator identity.

## Identity

Create one keyless observer service account and grant it view roles only.
Operators impersonate it. The platform mints a short-lived token from the
operator's own login. There is no key file.

- Never create a key for the observer or for any other service account.
- Keep the token in memory. Do not write it to stdout, stderr, a file, CI
  logs, or the repository.
- Grant impersonation (`roles/iam.serviceAccountTokenCreator` on GCP) only to
  operators listed in an IaC variable. Do not commit the variable's value.
  Removing a member revokes access.
- The operator's credentials remain on the machine. Impersonation lowers the
  default privilege. It is not a hard boundary against an agent that switches
  identity. Require approval before write commands (`gcloud` create, update,
  or delete, `terraform apply`, and the equivalent on another provider).
- This pattern does not add a separate OS user or a separate
  `CLOUDSDK_CONFIG` directory. That stronger isolation is out of scope.

### Do not grant access to data

The observer must not be able to read:

- secret values
- datastore or database documents
- analytics or warehouse row data
- storage objects, including infrastructure state
- data-access (private) audit logs

Do not grant a broad role that includes those reads. On GCP,
`roles/iam.securityReviewer` can read data-access audit logs, so it is not an
observer role. Prefer a narrow custom role for any extra metadata read the
diagnosis actually needs.

### Check the grant

After apply, call the provider's permission test **as the observer**. IAM can
take about 30 seconds to propagate. A denial in that window can be
propagation rather than a missing binding. Wait about 30 seconds and test
once more before changing roles.

Confirm both sides: permissions the diagnosis needs are allowed, and the
excluded reads and writes above are denied. Record the result in the Issue or
PR. Do not record tokens or secret values.

## Diagnostic output

The script itself is repo-owned. It contains service names, regions, and
project ids, so it does not live in this template. It runs only as the
observer and prints:

1. Whether the process is impersonating the observer. Warn when it is not.
   Never print the token.
2. For each service: the terminal condition, the traffic target (percent,
   type, and revision), the latest ready revision, and the latest created
   revision.
3. Failed conditions on recent revisions, including revisions that never
   started. On Cloud Run (v2), a revision that never started and was then
   retired can still report `Ready` as succeeded. Read failed conditions such
   as `ContainerHealthy`, and read `Active`. Do not treat `Ready=SUCCEEDED`
   as proof that the revision started.
4. Log entries at WARNING or above for a bounded time window.
5. Failed admin-activity audit entries for that window. Do not read
   data-access audit logs.
6. Request counts grouped by response-code class.
7. Optional metadata the observer is allowed to see, such as a cache-config
   flag or whether a secret has an enabled version. Report presence only,
   never a secret value.

The script does not read secret payloads, datastore documents, analytics
rows, storage objects, or data-access audit logs.

## Public CI

Actions logs on a public repository are world-readable. A failed deploy job
may add one annotation that points at the local procedure. It must not print
cloud logs, resource payloads, or tokens.

```yaml
- name: Point to live cloud diagnosis
  if: failure()
  run: >-
    echo "::error::Deploy or apply failed. Inspect live resources with the
    read-only observer documented in docs/development.md#deploy-failure-diagnosis.
    This Actions log is not the diagnosis."
```

## GCP example

Fictional project `example-project`. The account id `agent-observer` and the
configuration name `example-observer` are examples. A consumer chooses its own
names and records them in its development document.

View roles that match the diagnostic output above:

- `roles/cloudasset.viewer`
- `roles/logging.viewer` (admin and ordinary logs, not private logs)
- `roles/monitoring.viewer`
- `roles/run.viewer`
- `roles/secretmanager.viewer` (secret metadata, not the payload)
- `roles/artifactregistry.reader` (omit this when image bytes are sensitive)
- `roles/bigquery.metadataViewer`
- `roles/serviceusage.serviceUsageViewer`
- `roles/cloudbuild.builds.viewer`

Add a custom role only for extra metadata the diagnosis needs, for example
`resourcemanager.projects.getIamPolicy`. Do not add data-access permissions
to that role.

Impersonation is `roles/iam.serviceAccountTokenCreator` on the observer
service account, for each member of the uncommitted IaC variable (for example
`observer_members = ["user:user@example.com"]`).

Each operator creates a separate gcloud configuration and does not activate it:

```bash
gcloud config configurations create example-observer --no-activate
gcloud config set project example-project --configuration example-observer
gcloud config set account user@example.com --configuration example-observer
gcloud config set auth/impersonate_service_account \
  agent-observer@example-project.iam.gserviceaccount.com \
  --configuration example-observer
```

Agents select it only for read-only inspection:

```bash
CLOUDSDK_ACTIVE_CONFIG_NAME=example-observer <diagnose-command recorded in docs/development.md>
```

Permission test, still as the observer. `gcloud projects` has no
`test-iam-permissions` command. Call Resource Manager
`projects.testIamPermissions`:

`POST https://cloudresourcemanager.googleapis.com/v1/projects/{projectId}:testIamPermissions`

The response body lists only the permissions the caller has. Print that list.
Do not print the token, the request, or an error body. `gcloud auth
print-access-token` writes the token to its own stdout; capture it in memory
and do not echo it. These names are the example allow and deny lists, not a
count to copy.

```javascript
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const projectId = "example-project";
const permissions = [
  "run.services.get",
  "run.revisions.list",
  "logging.logEntries.list",
  "monitoring.timeSeries.list",
  "secretmanager.secrets.get",
  "secretmanager.versions.access",
  "secretmanager.versions.add",
  "datastore.entities.get",
  "bigquery.tables.getData",
  "storage.objects.get",
  "logging.privateLogEntries.list",
  "run.services.update",
  "iam.serviceAccountKeys.create",
  "resourcemanager.projects.setIamPolicy",
];

const { stdout } = await execFileAsync(
  "gcloud",
  ["auth", "print-access-token"],
  {
    env: { ...process.env, CLOUDSDK_ACTIVE_CONFIG_NAME: "example-observer" },
  },
);
const token = stdout.trim();
const response = await fetch(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${encodeURIComponent(projectId)}:testIamPermissions`,
  {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ permissions }),
  },
);
const body = await response.json().catch(() => ({}));
if (!response.ok) {
  console.error(`testIamPermissions failed: HTTP ${response.status}`);
  process.exitCode = 1;
} else {
  console.log((body.permissions ?? []).join("\n"));
}
```

Run it with `node --input-type=module` so the top-level `await` is valid even
when the consumer repository is not an ES module. A non-success response
prints only the HTTP status.

Allowed for this example: `run.services.get`, `run.revisions.list`,
`logging.logEntries.list`, `monitoring.timeSeries.list`,
`secretmanager.secrets.get`.

Denied for this example: `secretmanager.versions.access` (secret values),
`secretmanager.versions.add`, `datastore.entities.get`, `bigquery.tables.getData`,
`storage.objects.get`, `logging.privateLogEntries.list`,
`run.services.update`, `iam.serviceAccountKeys.create`,
`resourcemanager.projects.setIamPolicy`.
