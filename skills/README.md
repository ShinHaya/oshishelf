# Skills

Agent Skills shared by every AI coding agent used in this repository. Each
directory holds a `SKILL.md` (the instruction body) and, where the Codex CLI
needs an explicit interface, an `agents/openai.yaml`.

Agents discover them through symlinks: `.claude/skills/<name>` (Claude Code)
and `.agents/skills/<name>` (Codex and other `.agents`-aware runtimes) both
point at `skills/<name>`. Edit only the files under `skills/`.

## Workflow skills

| Skill | Use when |
| --- | --- |
| [`create-issue`](create-issue/SKILL.md) | Filing or standardizing an Issue with labels and native `Blocked by` dependencies |
| [`issue-implementation`](issue-implementation/SKILL.md) | Implementing exactly one Issue end to end: worktree gate, commit, independent reviewer pass, PR, CI monitoring |
| [`handoff-issue`](handoff-issue/SKILL.md) | Resuming an existing Issue worktree after a session limit, interruption, or agent change |
| [`orchestrate-project-issues`](orchestrate-project-issues/SKILL.md) | Coordinating several Issues: dependency order, run-time agent/model routing, role programs, integration gate |

The workflow skills call these tools:

| Tool | Used by |
| --- | --- |
| `scripts/issue-worktree.sh` (`create` / `status` / `handoff` / `release` / `cleanup`) | `issue-implementation`, `handoff-issue` |
| `scripts/project-issue-dispatch.mjs --role reviewer` | `issue-implementation` (pre-PR review), `orchestrate-project-issues` |
| `scripts/project-issue-orchestrator.mjs`, `project-issue-capabilities.mjs`, `project-issue-graph.mjs` | `orchestrate-project-issues` |
| `gh` (Issues, PRs, checks) | all workflow skills |

## Documentation review skills

Each skill owns its review criteria; [`docs/development.md`](../docs/development.md)
links here without duplicating them. Record review results in the Issue or
PR.

| Skill | Review target |
| --- | --- |
| [`requirements-review`](requirements-review/SKILL.md) | Product requirements in `README.md` / `AGENTS.md` |
| [`architecture-review`](architecture-review/SKILL.md) | Architecture in `README.md` |
| [`design-doc-review`](design-doc-review/SKILL.md) | A detailed design in a GitHub Issue or PR |

## Craft skills

| Skill | Use when |
| --- | --- |
| [`writing-good-tests`](writing-good-tests/SKILL.md) | Writing or reviewing tests |

## Adding a skill

Keep `SKILL.md` self-contained and free of project-specific product detail that
belongs in `docs/`. Add the matching discovery symlinks:

```bash
ln -s ../../skills/<name> .claude/skills/<name>
ln -s ../../skills/<name> .agents/skills/<name>
```
