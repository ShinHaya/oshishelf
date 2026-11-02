#!/usr/bin/env bash

set -euo pipefail

SOURCE_ROOT=$(cd "$(dirname "$0")/.." && pwd)
HELPER="$SOURCE_ROOT/scripts/issue-worktree.sh"
RUNTIMES=$(node "$SOURCE_ROOT/scripts/ai-template.mjs" agents list)
FIRST_AGENT=$(printf '%s' "$RUNTIMES" | jq -r '[.[] | select(.status == "enabled")][0].id')
SECOND_AGENT=$(printf '%s' "$RUNTIMES" | jq -r '[.[] | select(.status == "enabled")][1].id')
ALIAS_AGENT=$(printf '%s' "$RUNTIMES" | jq -r '[.[] | select(.aliases | length > 0) | select(.status != "retired")][0].id')
ALIAS=$(printf '%s' "$RUNTIMES" | jq -r '[.[] | select(.aliases | length > 0) | select(.status != "retired")][0].aliases[0]')
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/issue-worktree.XXXXXX")
trap 'rm -rf "$TMP_ROOT"' EXIT

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  exit 1
}

assert_eq() {
  [ "$1" = "$2" ] || fail "expected '$2', got '$1'"
}

assert_contains() {
  case "$1" in
    *"$2"*) ;;
    *) fail "expected output to contain '$2', got: $1" ;;
  esac
}

assert_fails() {
  local output status
  set +e
  output=$("$@" 2>&1)
  status=$?
  set -e
  [ "$status" -ne 0 ] || fail "expected command to fail: $*"
  printf '%s\n' "$output"
}

setup_repo() {
  local remote=$1 repo=$2 branch=${3:-main}
  git init --bare "$remote" >/dev/null
  git init -b "$branch" "$repo" >/dev/null
  git -C "$repo" config user.name Test
  git -C "$repo" config user.email test@example.invalid
  printf 'fixture\n' > "$repo/README.md"
  git -C "$repo" add README.md
  git -C "$repo" commit -m init >/dev/null
  git -C "$repo" remote add origin "$remote"
  git -C "$repo" push -u origin "$branch" >/dev/null
}

REMOTE="$TMP_ROOT/remote.git"
REPO="$TMP_ROOT/repo with spaces"
setup_repo "$REMOTE" "$REPO"

# A temporary fetch failure must not block creation when the last fetched
# origin/main is already available locally.
git -C "$REPO" remote set-url origin "$TMP_ROOT/unavailable-remote.git"
ISSUE_WORKTREE_SKIP_GITHUB=1 "$HELPER" create 366 offline-base --agent "$FIRST_AGENT" --session offline-session --repo "$REPO"
OFFLINE_WORKTREE="$REPO/.worktrees/issue-366-offline-base"
[ -d "$OFFLINE_WORKTREE" ] || fail "offline worktree was not created from cached origin/main"

# If the remote-tracking ref is also absent, local main is the final safe
# fallback rather than creating a branch from an unrelated ref.
git -C "$REPO" update-ref -d refs/remotes/origin/main
ISSUE_WORKTREE_SKIP_GITHUB=1 "$HELPER" create 367 local-main-base --agent "$FIRST_AGENT" --session local-main-session --repo "$REPO"
LOCAL_MAIN_WORKTREE="$REPO/.worktrees/issue-367-local-main-base"
[ -d "$LOCAL_MAIN_WORKTREE" ] || fail "worktree was not created from local main"
git -C "$REPO" remote set-url origin "$REMOTE"
git -C "$REPO" fetch origin

ISSUE_WORKTREE_SKIP_GITHUB=1 "$HELPER" create 365 demo --agent "$FIRST_AGENT" --session session-a --repo "$REPO"
WORKTREE="$REPO/.worktrees/issue-365-demo"
[ -d "$WORKTREE" ] || fail "worktree was not created"
assert_eq "$(git -C "$WORKTREE" branch --show-current)" "issue-365-demo"

STATUS=$("$HELPER" status 365 --repo "$REPO" --json)
assert_eq "$(printf '%s' "$STATUS" | jq -r .issue)" "365"
assert_eq "$(printf '%s' "$STATUS" | jq -r .handoff_epoch)" "1"

OUT=$(assert_fails "$HELPER" acquire 365 --agent "$SECOND_AGENT" --session session-b --repo "$REPO")
assert_contains "$OUT" "use handoff"

"$HELPER" handoff 365 --agent "$FIRST_AGENT" --session session-a --repo "$REPO" >/dev/null
assert_eq "$("$HELPER" status 365 --repo "$REPO" --json | jq -r .handoff_epoch)" "1"

OUT=$(assert_fails "$HELPER" handoff 365 --agent "$FIRST_AGENT" --session session-b --repo "$REPO")
assert_contains "$OUT" "owner process is still running"

COMMON=$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir)
STATE_FILE="$COMMON/issue-worktrees/365.json"

# A lifecycle lock abandoned by a dead process is reclaimed safely.
mkdir "$COMMON/issue-worktrees/365.lock"
printf '999999:%s\n' "$(date +%s)" > "$COMMON/issue-worktrees/365.lock/owner"
"$HELPER" acquire 365 --agent "$FIRST_AGENT" --session session-a --repo "$REPO"
[ ! -e "$COMMON/issue-worktrees/365.lock" ] || fail "dead lifecycle lock was not reclaimed"

jq '.owner.pid=999999' "$STATE_FILE" > "$STATE_FILE.tmp" && mv "$STATE_FILE.tmp" "$STATE_FILE"

"$HELPER" handoff 365 --agent "$FIRST_AGENT" --session session-b --repo "$REPO" >/dev/null
STATUS=$("$HELPER" status 365 --repo "$REPO" --json)
assert_eq "$(printf '%s' "$STATUS" | jq -r .handoff_epoch)" "2"
assert_eq "$(printf '%s' "$STATUS" | jq -r .owner.agent)" "$FIRST_AGENT"

"$HELPER" release 365 --session session-b --repo "$REPO" >/dev/null
OUT=$(assert_fails "$HELPER" acquire 365 --agent "$SECOND_AGENT" --session session-c --repo "$REPO")
assert_contains "$OUT" "use handoff"
printf 'dirty\n' > "$WORKTREE/dirty.txt"
OUT=$(assert_fails env ISSUE_WORKTREE_PR_STATE=MERGED "$HELPER" cleanup 365 --pr 999 --repo "$REPO")
assert_contains "$OUT" "dirty"
rm "$WORKTREE/dirty.txt"

OUT=$(assert_fails env ISSUE_WORKTREE_PR_STATE=CLOSED "$HELPER" cleanup 365 --pr 999 --repo "$REPO")
assert_contains "$OUT" "MERGED"

ISSUE_WORKTREE_PR_STATE=MERGED "$HELPER" cleanup 365 --pr 999 --repo "$REPO"
[ ! -e "$WORKTREE" ] || fail "worktree still exists after cleanup"
if git -C "$REPO" show-ref --verify --quiet refs/heads/issue-365-demo; then
  fail "local branch still exists after cleanup"
fi

"$HELPER" release 366 --session offline-session --repo "$REPO" >/dev/null
ISSUE_WORKTREE_PR_STATE=MERGED "$HELPER" cleanup 366 --pr 998 --repo "$REPO"
[ ! -e "$OFFLINE_WORKTREE" ] || fail "offline worktree still exists after cleanup"

"$HELPER" release 367 --session local-main-session --repo "$REPO" >/dev/null
ISSUE_WORKTREE_PR_STATE=MERGED "$HELPER" cleanup 367 --pr 997 --repo "$REPO"
[ ! -e "$LOCAL_MAIN_WORKTREE" ] || fail "local-main worktree still exists after cleanup"

# After a merged PR deletes the remote branch and fetch --prune removes the
# tracking ref, status/release/cleanup treat the branch as having no upstream.
ISSUE_WORKTREE_SKIP_GITHUB=1 "$HELPER" create 368 upstream-gone --agent "$FIRST_AGENT" --session gone-session --repo "$REPO"
GONE_WORKTREE="$REPO/.worktrees/issue-368-upstream-gone"
git -C "$GONE_WORKTREE" commit --allow-empty -m change >/dev/null
git -C "$GONE_WORKTREE" push -u origin HEAD:issue-368-upstream-gone >/dev/null 2>&1
git -C "$GONE_WORKTREE" commit --allow-empty -m unpushed >/dev/null
STATUS=$("$HELPER" status 368 --repo "$REPO" --json)
assert_eq "$(printf '%s' "$STATUS" | jq -r .upstream)" "origin/issue-368-upstream-gone"
assert_eq "$(printf '%s' "$STATUS" | jq -r .upstream_gone)" "false"
assert_eq "$(printf '%s' "$STATUS" | jq -r .ahead)" "1"
# Delete on the remote side so only fetch --prune removes the tracking ref.
git -C "$REMOTE" branch -D issue-368-upstream-gone >/dev/null
git -C "$REPO" show-ref --verify --quiet refs/remotes/origin/issue-368-upstream-gone \
  || fail "tracking ref should remain until fetch --prune"
git -C "$REPO" fetch origin --prune >/dev/null 2>&1
STATUS=$("$HELPER" status 368 --repo "$REPO" --json)
assert_eq "$(printf '%s' "$STATUS" | jq -r .upstream)" ""
assert_eq "$(printf '%s' "$STATUS" | jq -r .upstream_gone)" "true"
assert_eq "$(printf '%s' "$STATUS" | jq -r .ahead)" "0"
assert_eq "$(printf '%s' "$STATUS" | jq -r .behind)" "0"
"$HELPER" release 368 --session gone-session --repo "$REPO" >/dev/null
ISSUE_WORKTREE_PR_STATE=MERGED "$HELPER" cleanup 368 --pr 996 --repo "$REPO"
[ ! -e "$GONE_WORKTREE" ] || fail "upstream-gone worktree still exists after cleanup"

# Repository-owned settings select a non-default trunk without changing the helper.
CONFIG_REPO="$TMP_ROOT/configured repository"
CONFIG_REMOTE="$TMP_ROOT/configured-remote.git"
setup_repo "$CONFIG_REMOTE" "$CONFIG_REPO" develop
mkdir -p "$CONFIG_REPO/.ai-template"
printf '%s\n' '{"repository":{"baseBranch":"develop"}}' > "$CONFIG_REPO/.ai-template/config.json"
ISSUE_WORKTREE_SKIP_GITHUB=1 "$HELPER" create 390 configured-base --agent "$FIRST_AGENT" --session configured-session --repo "$CONFIG_REPO"
CONFIG_WORKTREE="$CONFIG_REPO/.worktrees/issue-390-configured-base"
assert_eq "$(git -C "$CONFIG_WORKTREE" rev-parse HEAD)" "$(git -C "$CONFIG_REPO" rev-parse origin/develop)"
# A colliding local branch/tag must not override the verified remote ref.
git -C "$CONFIG_REPO" checkout --orphan collision-fixture >/dev/null 2>&1
git -C "$CONFIG_REPO" commit --allow-empty -m collision-fixture >/dev/null
git -C "$CONFIG_REPO" branch origin/develop
git -C "$CONFIG_REPO" tag develop
git -C "$CONFIG_REPO" checkout develop >/dev/null 2>&1
git -C "$CONFIG_REPO" remote set-url origin "$TMP_ROOT/unavailable-configured-remote.git"
ISSUE_WORKTREE_SKIP_GITHUB=1 "$HELPER" create 391 configured-cached --agent "$FIRST_AGENT" --session configured-cache --repo "$CONFIG_REPO"
assert_eq "$(git -C "$CONFIG_REPO/.worktrees/issue-391-configured-cached" rev-parse HEAD)" "$(git -C "$CONFIG_REPO" rev-parse refs/remotes/origin/develop)"
git -C "$CONFIG_REPO" update-ref -d refs/remotes/origin/develop
ISSUE_WORKTREE_SKIP_GITHUB=1 "$HELPER" create 392 configured-local --agent "$FIRST_AGENT" --session configured-local --repo "$CONFIG_REPO"
assert_eq "$(git -C "$CONFIG_REPO/.worktrees/issue-392-configured-local" rev-parse HEAD)" "$(git -C "$CONFIG_REPO" rev-parse refs/heads/develop)"
printf '%s\n' '{"repository":{"baseBranch":"bad name"}}' > "$CONFIG_REPO/.ai-template/config.json"
OUT=$(assert_fails env ISSUE_WORKTREE_SKIP_GITHUB=1 "$HELPER" create 393 invalid-config --agent "$FIRST_AGENT" --session configured-invalid --repo "$CONFIG_REPO")
assert_contains "$OUT" "unknown or retired agent"
[ ! -e "$CONFIG_REPO/.worktrees/issue-393-invalid-config" ] || fail "invalid configuration created a worktree"

# Registered aliases are canonicalized before storing lifecycle identities.
ISSUE_WORKTREE_SKIP_GITHUB=1 "$HELPER" create 394 alias-agent --agent "$ALIAS" --session alias-session --repo "$REPO"
STATUS=$("$HELPER" status 394 --json --repo "$REPO")
assert_eq "$(printf '%s' "$STATUS" | jq -r .owner.agent)" "$ALIAS_AGENT"
OUT=$(assert_fails env ISSUE_WORKTREE_SKIP_GITHUB=1 "$HELPER" create 395 unknown-agent --agent fictional-unknown --session invalid --repo "$REPO")
assert_contains "$OUT" "unknown or retired agent"
[ ! -d "$REPO/.worktrees/issue-395-unknown-agent" ] || fail "invalid agent created worktree"

printf 'issue worktree lifecycle tests passed\n'
