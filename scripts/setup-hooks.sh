#!/usr/bin/env bash
# setup-hooks.sh — wire up the git hooks for this repo.
#
# Idempotent. Run this once after cloning, and again any time the
# .githooks/ contents are pulled fresh. It does the minimum:
#
#   1. verify required commands are available
#   2. mark every hook executable
#   3. point `git config core.hooksPath` at .githooks
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

# Do not silently replace another local hook configuration.
CURRENT=$(git config --local --get core.hooksPath 2>/dev/null || true)
if [ -n "$CURRENT" ] && [ "$CURRENT" != ".githooks" ]; then
  printf 'error: existing core.hooksPath = %s; inspect it before changing hooks\n' "$CURRENT" >&2
  exit 1
fi
chmod +x .githooks/pre-commit
git config --local core.hooksPath .githooks
printf 'hooks installed: pnpm lint and pnpm typecheck\n'
