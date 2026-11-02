# Skills

Agent Skills shared by every AI coding agent used in this repository. Each
directory holds a `SKILL.md` (the instruction body) and, where the Codex CLI
needs an explicit interface, an `agents/openai.yaml`.

Run `node scripts/ai-template.mjs generate` to create the discovery symlinks declared
by enabled runtime definitions. All links point at `skills/<name>`; edit only the
files under `skills/`. Inspect runtime IDs with `node scripts/ai-template.mjs agents list`.

## Workflow skills

| Skill | Use when |
| --- | --- |
| [`create-issue`](create-issue/SKILL.md) | Filing or standardizing an Issue with labels and native `Blocked by` dependencies |
| [`issue-implementation`](issue-implementation/SKILL.md) | Implementing exactly one Issue end to end: worktree gate, commit, independent reviewer pass, PR, CI monitoring |
| [`handoff-issue`](handoff-issue/SKILL.md) | Resuming an existing Issue worktree after a session limit, interruption, or agent change |
| [`orchestrate-issues-implementation`](orchestrate-issues-implementation/SKILL.md) | Coordinating several Issues: dependency order, run-time agent/model routing, role programs, integration gate |

The workflow skills call these tools:

| Tool | Used by |
| --- | --- |
| `scripts/issue-worktree.sh` (`create` / `status` / `handoff` / `release` / `cleanup`) | `issue-implementation`, `handoff-issue` |
| `scripts/issue-dispatch.mjs --role reviewer` | `issue-implementation` (pre-PR review), `orchestrate-issues-implementation` |
| `scripts/issue-orchestrator.mjs`, `issue-capabilities.mjs`, `issue-graph.mjs` | `orchestrate-issues-implementation` |
| `scripts/repository-config.mjs` (repository settings as data) | workflow and documentation review skills |
| `gh` (Issues, PRs, checks) | all workflow skills |

## Documentation review skills

Each skill owns its review criteria. Use this repository's `AGENTS.md` to find
its development guidance, product direction, quality gates and document owners.
Explicit overrides are available through `node scripts/repository-config.mjs`:
`repository.baseBranch`, `repository.qualityGates`, and `repository.documents`.
Empty command lists and omitted locations are resolved from `AGENTS.md`; never assume a package
manager, a test command, or a documentation directory. Record reviews in the
Issue or PR.

| Skill | Review target |
| --- | --- |
| [`requirements-review`](requirements-review/SKILL.md) | The configured canonical requirements document (or the one identified in `AGENTS.md`) |
| [`architecture-review`](architecture-review/SKILL.md) | The configured canonical architecture document (or the one identified in `AGENTS.md`) |
| [`design-doc-review`](design-doc-review/SKILL.md) | A detailed design in a GitHub Issue or PR |

## Craft skills

| Skill | Use when |
| --- | --- |
| [`writing-good-tests`](writing-good-tests/SKILL.md) | Writing or reviewing tests |

## Adding a skill

Keep `SKILL.md` self-contained and free of project-specific product detail that
belongs in the repository documentation identified by `AGENTS.md`. A skill that a user should be able to invoke directly needs
`user-invocable: true` in its frontmatter. Regenerate discovery links:

```bash
node scripts/ai-template.mjs generate
```

Repo-owned skills stay under `skills/`; list their names in `localSkills` in
`.ai-template/config.json` so missing local skills fail generation.
