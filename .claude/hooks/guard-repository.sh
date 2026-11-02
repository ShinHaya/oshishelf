#!/bin/sh
# Claude Code PreToolUse guard: block `git commit` outside an Issue worktree
# (.worktrees/issue-*). Defense in depth only; every runtime still owns the
# start gate in docs/github-operations.md section 2.

set -eu

payload=$(cat)
tool=$(printf '%s' "$payload" | jq -r '.tool_name // ""')
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""')

deny() {
  jq -n --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

is_issue_worktree() {
  candidate=$1
  case "$candidate" in
    /*) ;;
    *) candidate=$cwd/$candidate ;;
  esac

  resolved=$(cd "$candidate" 2>/dev/null && git rev-parse --show-toplevel 2>/dev/null) || return 1
  common_dir=$(git -C "$resolved" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1

  case "$resolved:$common_dir" in
    */.worktrees/*:*/.git) return 0 ;;
    *) return 1 ;;
  esac
}

case "$tool" in
  Bash)
    command=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""')
    if printf '%s' "$command" | grep -Eq '(^|[;&|[:space:]])git([[:space:]]+-[^[:space:]]+)*[[:space:]]+commit([[:space:]]|$)'; then
      effective_cwd=$cwd
      leading_cd=$(printf '%s' "$command" | sed -nE 's/^[[:space:]]*cd[[:space:]]+("[^"]*"|'"'"'[^'"'"']*'"'"'|[^;&|[:space:]]+)[[:space:]]*&&.*/\1/p')
      if [ -n "$leading_cd" ]; then
        effective_cwd=$(printf '%s' "$leading_cd" | sed -E 's/^("(.*)"|'"'"'(.*)'"'"')$/\2\3/')
      fi
      if ! is_issue_worktree "$effective_cwd"; then
        deny "Git commits are blocked outside an Issue worktree. Create or resume one with scripts/issue-worktree.sh."
      fi
    fi
    ;;
esac

exit 0
