#!/usr/bin/env bash
# setup-hooks.sh — wire up the git hooks for this repo.
#
# Idempotent. Run this once after cloning, and again any time the
# .githooks/ contents are pulled fresh. It does the minimum:
#
#   1. verify required commands are available
#   2. stop, changing nothing, if core.hooksPath (any scope) points elsewhere
#   3. mark every hook executable
#   4. point `git config core.hooksPath` at .githooks
#
# The hooks themselves live in .githooks/ so they are tracked in git
# and kept in sync across machines.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$REPO_ROOT"

if [ ! -d ".githooks" ]; then
  printf 'error: .githooks directory not found at %s/.githooks\n' "$REPO_ROOT" >&2
  exit 1
fi

# --- 1. Verify required tools ------------------------------------
missing=0
require() {
  local cmd=$1 hint=$2
  if ! command -v "$cmd" >/dev/null 2>&1; then
    printf 'missing: %s — %s\n' "$cmd" "$hint" >&2
    missing=$((missing + 1))
  fi
}

require bash "any modern bash (3.2+ ok); pre-installed on macOS"
require git  "https://git-scm.com/"

if [ "$missing" -gt 0 ]; then
  printf '\ninstall the missing tools above and re-run this script.\n' >&2
  exit 1
fi

# --- 2. Do not silently replace another hook configuration ------
# Check the effective value: a global or system hook manager is replaced by
# a local setting just as surely as a local one.
SCOPED=$(git config --show-scope --get core.hooksPath 2>/dev/null || echo "")
SCOPE=${SCOPED%%$'\t'*}
CURRENT=${SCOPED#*$'\t'}
if [ -n "$CURRENT" ] && [ "$CURRENT" != ".githooks" ]; then
  printf 'error: existing core.hooksPath = %s (%s config); inspect it before changing hooks\n' "$CURRENT" "$SCOPE" >&2
  case "$SCOPE" in
    local|worktree)
      printf 'to use .githooks, run: git config --%s --unset core.hooksPath, then re-run this script.\n' "$SCOPE" >&2 ;;
    *)
      printf 'it also applies to other repositories; to use .githooks in this repository only, run: git config --local core.hooksPath .githooks\n' >&2 ;;
  esac
  exit 1
fi

# --- 3. Make hook files executable -------------------------------
find .githooks -type f \( -name 'pre-commit' -o -name '*.sh' \) \
  -exec chmod +x {} +

# --- 4. Point git at the hooks dir -------------------------------
if [ "$CURRENT" = ".githooks" ]; then
  printf 'core.hooksPath already set to .githooks\n'
elif [ -n "$CURRENT" ]; then
  printf 'error: existing core.hooksPath is set to %s; unset it with git config --local --unset core.hooksPath before running this script\n' "$CURRENT" >&2
  exit 1
else
  git config --local core.hooksPath .githooks
  printf 'set core.hooksPath = .githooks\n'
fi

printf '\nhooks installed. See AGENTS.md for repository quality gates.\n'
