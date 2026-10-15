#!/usr/bin/env bash
# Manage one guarded worktree per GitHub Issue.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/issue-worktree.sh create <issue> [slug] --agent <agent> --session <id> [--repo <path>]
  scripts/issue-worktree.sh status <issue> [--json] [--repo <path>]
  scripts/issue-worktree.sh acquire <issue> --agent <agent> --session <id> [--repo <path>]
  scripts/issue-worktree.sh handoff <issue> --agent <agent> --session <id> [--repo <path>]
  scripts/issue-worktree.sh release <issue> --session <id> [--repo <path>]
  scripts/issue-worktree.sh cleanup <issue> --pr <number> [--repo <path>]

The helper never stashes, commits, resets, cleans, or force-removes work.
EOF
}

die() {
  printf 'issue-worktree: error: %s\n' "$*" >&2
  exit 1
}

note() {
  printf 'issue-worktree: %s\n' "$*" >&2
}

is_uint() {
  case "$1" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

canonicalize() {
  local path=$1
  if [ -e "$path" ] && command -v realpath >/dev/null 2>&1; then
    realpath "$path"
  elif [ -e "$path" ]; then
    (cd "$path" && pwd -P)
  else
    case "$path" in
      /*) printf '%s\n' "$path" ;;
      *) printf '%s/%s\n' "$(pwd -P)" "$path" ;;
    esac
  fi
}

session_hash() {
  local value=$1
  printf '%s' "$value" | git hash-object --stdin | cut -c1-16
}

utc_now() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

lease_expiry() {
  printf '%s\n' "$(($(date +%s) + ${ISSUE_WORKTREE_LEASE_TTL_SEC:-3600}))"
}

COMMAND=${1:-}
ISSUE=${2:-}
if [ -z "$COMMAND" ] || [ -z "$ISSUE" ]; then
  usage >&2
  exit 2
fi
is_uint "$ISSUE" || die "Issue must be one positive integer"
shift 2

SLUG=''
AGENT=''
SESSION=''
PR=''
REPO=''
JSON=0

if [ "$COMMAND" = "create" ] && [ "$#" -gt 0 ] && [ "${1#--}" = "$1" ]; then
  SLUG=$1
  shift
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --agent) [ "$#" -ge 2 ] || die "--agent requires a value"; AGENT=$2; shift 2 ;;
    --session) [ "$#" -ge 2 ] || die "--session requires a value"; SESSION=$2; shift 2 ;;
    --pr) [ "$#" -ge 2 ] || die "--pr requires a value"; PR=$2; shift 2 ;;
    --repo) [ "$#" -ge 2 ] || die "--repo requires a value"; REPO=$2; shift 2 ;;
    --json) JSON=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

if [ -z "$REPO" ]; then
  REPO=$(git rev-parse --show-toplevel 2>/dev/null) || die "not inside a Git repository"
fi
REPO=$(canonicalize "$REPO")
COMMON=$(git -C "$REPO" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) \
  || die "cannot resolve Git common directory"
COMMON=$(canonicalize "$COMMON")
case "$COMMON" in
  */.git) PRIMARY=${COMMON%/.git} ;;
  *) die "unexpected Git common directory: $COMMON" ;;
esac

STATE_ROOT="$COMMON/issue-worktrees"
STATE_FILE="$STATE_ROOT/$ISSUE.json"
LOCK_DIR="$STATE_ROOT/$ISSUE.lock"
mkdir -p "$STATE_ROOT"

state_lock_mtime() {
  local path=$1
  if stat -f %m "$path" 2>/dev/null; then return 0; fi
  stat -c %Y "$path" 2>/dev/null
}

reclaim_stale_state_lock() {
  local owner="$LOCK_DIR/owner" pid timestamp now age mtime
  pid=''
  timestamp=''
  IFS=':' read -r pid timestamp _ < "$owner" 2>/dev/null || true
  case "$pid:$timestamp" in
    *[!0-9:]*|::*|*:)
      mtime=$(state_lock_mtime "$LOCK_DIR") || return 1
      now=$(date +%s)
      age=$((now - mtime))
      [ "$age" -ge "${ISSUE_WORKTREE_STATE_LOCK_TIMEOUT_SEC:-600}" ] || return 1
      ;;
    *)
      now=$(date +%s)
      age=$((now - timestamp))
      if kill -0 "$pid" 2>/dev/null; then
        return 1
      fi
      ;;
  esac
  rm -f "$owner"
  if rmdir "$LOCK_DIR" 2>/dev/null; then
    note "reclaimed stale lifecycle state lock for Issue #$ISSUE"
    return 0
  fi
  return 1
}

lock_state() {
  local now
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    reclaim_stale_state_lock || die "Issue #$ISSUE lifecycle state is locked by another process"
    mkdir "$LOCK_DIR" 2>/dev/null || die "Issue #$ISSUE lifecycle state is locked by another process"
  fi
  now=$(date +%s)
  LOCK_TOKEN="$$:$now"
  printf '%s\n' "$LOCK_TOKEN" > "$LOCK_DIR/owner"
  trap 'unlock_state' EXIT INT TERM
}

unlock_state() {
  local stored
  trap - EXIT INT TERM
  stored=$(cat "$LOCK_DIR/owner" 2>/dev/null || true)
  if [ "${LOCK_TOKEN:-}" = "$stored" ]; then
    rm -f "$LOCK_DIR/owner"
    rmdir "$LOCK_DIR" 2>/dev/null || true
  fi
}

require_state() {
  [ -f "$STATE_FILE" ] || die "Issue #$ISSUE has no lifecycle metadata; use issue-implementation for new work"
  jq -e '(.schema == 1 or .schema == 2) and .issue and .branch and .worktree and .owner' "$STATE_FILE" >/dev/null 2>&1 \
    || die "Issue #$ISSUE lifecycle metadata is missing or corrupt"
}

write_state() {
  local json=$1 tmp
  tmp="$STATE_ROOT/.$ISSUE.$$.tmp"
  printf '%s\n' "$json" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}


git_operation() {
  local worktree=$1 gitdir
  gitdir=$(git -C "$worktree" rev-parse --absolute-git-dir)
  for name in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG rebase-merge rebase-apply; do
    if [ -e "$gitdir/$name" ]; then
      printf '%s\n' "$name"
      return 0
    fi
  done
  printf '%s\n' "none"
}

worktree_registered() {
  local target=$1 path
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    if [ "$(canonicalize "$path")" = "$(canonicalize "$target")" ]; then
      return 0
    fi
  done < <(git -C "$PRIMARY" worktree list --porcelain | sed -n 's/^worktree //p')
  return 1
}

state_json() {
  require_state
  local worktree branch head dirty operation upstream upstream_ref upstream_gone ahead behind stash_count cwd_in_use
  worktree=$(jq -r .worktree "$STATE_FILE")
  branch=$(jq -r .branch "$STATE_FILE")
  [ -d "$worktree" ] || die "registered Issue worktree directory is missing: $worktree"
  worktree_registered "$worktree" || die "Issue worktree is not registered with Git: $worktree"
  [ "$(git -C "$worktree" branch --show-current)" = "$branch" ] \
    || die "Issue worktree does not have expected branch $branch checked out"
  head=$(git -C "$worktree" rev-parse HEAD)
  if [ -n "$(git -C "$worktree" status --porcelain)" ]; then dirty=true; else dirty=false; fi
  operation=$(git_operation "$worktree")
  # rev-parse echoes '@{upstream}' when the tracked ref was pruned, so read the
  # configured upstream and treat a missing ref as gone (no upstream).
  upstream_ref=$(git -C "$worktree" for-each-ref --format='%(upstream)' "refs/heads/$branch")
  upstream=""
  upstream_gone=false
  if [ -n "$upstream_ref" ]; then
    if git -C "$worktree" show-ref --verify --quiet "$upstream_ref"; then
      upstream=$(git -C "$worktree" for-each-ref --format='%(upstream:short)' "refs/heads/$branch")
    else
      upstream_gone=true
    fi
  fi
  ahead=0
  behind=0
  stash_count=$(git -C "$worktree" stash list | wc -l | tr -d ' ')
  cwd_in_use=false
  if command -v lsof >/dev/null 2>&1 \
     && lsof -a -d cwd +D "$worktree" -t 2>/dev/null | grep -q .; then
    cwd_in_use=true
  fi
  if [ -n "$upstream" ]; then
    ahead=$(git -C "$worktree" rev-list --count "$upstream_ref..HEAD" 2>/dev/null) \
      || { note "warning: cannot count commits ahead of $upstream; reporting 0"; ahead=0; }
    behind=$(git -C "$worktree" rev-list --count "HEAD..$upstream_ref" 2>/dev/null) \
      || { note "warning: cannot count commits behind $upstream; reporting 0"; behind=0; }
  fi
  jq -c \
    --arg head "$head" --arg operation "$operation" --arg upstream "$upstream" \
    --argjson upstream_gone "$upstream_gone" \
    --argjson dirty "$dirty" \
    --argjson ahead "$ahead" --argjson behind "$behind" --argjson stash_count "$stash_count" \
    --argjson cwd_in_use "$cwd_in_use" \
    '. + {head:$head,dirty:$dirty,git_operation:$operation,upstream:$upstream,upstream_gone:$upstream_gone,ahead:$ahead,behind:$behind,stash_count:$stash_count,cwd_in_use:$cwd_in_use}' \
    "$STATE_FILE"
}

case "$COMMAND" in
  create)
    [ -n "$AGENT" ] || die "create requires --agent"
    [ -n "$SESSION" ] || die "create requires --session"
    [ -n "$SLUG" ] || die "create requires a short slug"
    case "$SLUG" in *[!a-z0-9-]*|'') die "slug must use lowercase letters, digits, and hyphens" ;; esac
    if [ "${ISSUE_WORKTREE_SKIP_GITHUB:-0}" != "1" ]; then
      (cd "$PRIMARY" && gh issue view "$ISSUE" >/dev/null 2>&1) \
        || die "GitHub Issue #$ISSUE does not exist or cannot be read"
    fi
    lock_state
    [ ! -f "$STATE_FILE" ] || die "Issue #$ISSUE already has a worktree; use handoff-issue"
    BRANCH="issue-$ISSUE-$SLUG"
    WORKTREE="$PRIMARY/.worktrees/$BRANCH"
    EXISTING_BRANCH=$(git -C "$PRIMARY" for-each-ref --format='%(refname:short)' "refs/heads/issue-$ISSUE-*" | head -n 1)
    if [ -n "$EXISTING_BRANCH" ]; then
      die "partial state: branch $EXISTING_BRANCH exists without lifecycle metadata"
    fi
    if worktree_registered "$WORKTREE" || [ -e "$WORKTREE" ]; then
      die "partial state: worktree path already exists without lifecycle metadata: $WORKTREE"
    fi
    if ! git -C "$PRIMARY" fetch origin; then
      note "fetch origin failed; checking existing local base refs"
    fi
    if git -C "$PRIMARY" rev-parse --verify origin/develop >/dev/null 2>&1; then
      BASE_REF=origin/develop
    elif git -C "$PRIMARY" rev-parse --verify develop >/dev/null 2>&1; then
      BASE_REF=develop
      note "origin/develop is unavailable; using local develop as the worktree base"
    else
      die "neither origin/develop nor local develop is available"
    fi
    mkdir -p "$PRIMARY/.worktrees"
    git -C "$PRIMARY" worktree add -b "$BRANCH" "$WORKTREE" "$BASE_REF"
    NOW=$(utc_now)
    HASH=$(session_hash "$SESSION")
    HOST=$(hostname 2>/dev/null || printf unknown)
    EXPIRES=$(lease_expiry)
    HEAD=$(git -C "$WORKTREE" rev-parse HEAD)
    JSON_VALUE=$(jq -n -c \
      --argjson issue "$ISSUE" --arg slug "$SLUG" --arg branch "$BRANCH" --arg worktree "$WORKTREE" \
      --arg agent "$AGENT" --arg session_hash "$HASH" --arg now "$NOW" --arg host "$HOST" --arg head "$HEAD" \
      --argjson owner_pid "$PPID" --argjson expires_at_epoch "$EXPIRES" \
      '{schema:2,issue:$issue,slug:$slug,branch:$branch,worktree:$worktree,status:"active",owner:{agent:$agent,session_hash:$session_hash,active:true,generation:1,host:$host,pid:$owner_pid,expires_at_epoch:$expires_at_epoch,updated_at:$now},handoff_epoch:1,history:[{event:"create",epoch:1,agent:$agent,session_hash:$session_hash,head:$head,at:$now}] }')
    write_state "$JSON_VALUE"
    unlock_state
    printf '%s\n' "$WORKTREE"
    ;;

  status)
    VALUE=$(state_json)
    if [ "$JSON" = "1" ]; then
      printf '%s\n' "$VALUE" | jq '{issue,slug,branch,worktree,status,owner,handoff_epoch,head,dirty,git_operation,upstream,upstream_gone,ahead,behind,stash_count,cwd_in_use}'
    else
      printf '%s\n' "$VALUE" | jq -r '"Issue #\(.issue)  branch=\(.branch)  epoch=\(.handoff_epoch)  owner=\(.owner.agent)  dirty=\(.dirty)\nworktree=\(.worktree)\nHEAD=\(.head) upstream=\(.upstream) upstream_gone=\(.upstream_gone) ahead=\(.ahead) behind=\(.behind) operation=\(.git_operation)"'
    fi
    ;;

  acquire)
    [ -n "$AGENT" ] || die "acquire requires --agent"
    [ -n "$SESSION" ] || die "acquire requires --session"
    lock_state
    require_state
    HASH=$(session_hash "$SESSION")
    OLD_HASH=$(jq -r .owner.session_hash "$STATE_FILE")
    if [ "$OLD_HASH" != "$HASH" ]; then
      die "lease belongs to another session; use handoff so the epoch is reset"
    fi
    NOW=$(utc_now)
    HOST=$(hostname 2>/dev/null || printf unknown)
    EXPIRES=$(lease_expiry)
    VALUE=$(jq -c --arg agent "$AGENT" --arg hash "$HASH" --arg now "$NOW" --arg host "$HOST" \
      --argjson pid "$PPID" --argjson expires "$EXPIRES" \
      '.owner.agent=$agent | .owner.session_hash=$hash | .owner.active=true | .owner.host=$host | .owner.pid=$pid | .owner.expires_at_epoch=$expires | .owner.updated_at=$now' "$STATE_FILE")
    write_state "$VALUE"
    unlock_state
    ;;

  handoff)
    [ -n "$AGENT" ] || die "handoff requires --agent"
    [ -n "$SESSION" ] || die "handoff requires --session"
    lock_state
    require_state
    WORKTREE=$(jq -r .worktree "$STATE_FILE")
    [ -d "$WORKTREE" ] || die "Issue worktree directory is missing: $WORKTREE"
    OPERATION=$(git_operation "$WORKTREE")
    [ "$OPERATION" = "none" ] || die "Git operation is in progress ($OPERATION); resolve it before handoff"
    HASH=$(session_hash "$SESSION")
    OLD_HASH=$(jq -r .owner.session_hash "$STATE_FILE")
    if [ "$HASH" = "$OLD_HASH" ]; then
      note "same session already owns Issue #$ISSUE; keeping epoch $(jq -r .handoff_epoch "$STATE_FILE")"
      unlock_state
      exit 0
    fi
    OLD_ACTIVE=$(jq -r .owner.active "$STATE_FILE")
    OLD_HOST=$(jq -r '.owner.host // "unknown"' "$STATE_FILE")
    OLD_PID=$(jq -r '.owner.pid // 0' "$STATE_FILE")
    HOST=$(hostname 2>/dev/null || printf unknown)
    if [ "$OLD_ACTIVE" = "true" ] && [ "$OLD_HOST" = "$HOST" ] \
       && [ "$OLD_PID" -gt 0 ] && kill -0 "$OLD_PID" 2>/dev/null; then
      die "active lease owner process is still running (pid=$OLD_PID); handoff refused"
    fi
    NOW=$(utc_now)
    HEAD=$(git -C "$WORKTREE" rev-parse HEAD)
    EXPIRES=$(lease_expiry)
    VALUE=$(jq -c --arg agent "$AGENT" --arg hash "$HASH" --arg now "$NOW" --arg head "$HEAD" --arg host "$HOST" \
      --argjson pid "$PPID" --argjson expires "$EXPIRES" \
      '.handoff_epoch += 1
       | .owner.agent=$agent | .owner.session_hash=$hash | .owner.active=true
       | .owner.generation += 1 | .owner.host=$host | .owner.pid=$pid | .owner.expires_at_epoch=$expires | .owner.updated_at=$now
       | del(.review)
       | .history += [{event:"handoff",epoch:.handoff_epoch,agent:$agent,session_hash:$hash,head:$head,at:$now}]' "$STATE_FILE")
    write_state "$VALUE"
    unlock_state
    ;;

  release)
    [ -n "$SESSION" ] || die "release requires --session"
    lock_state
    require_state
    HASH=$(session_hash "$SESSION")
    [ "$(jq -r .owner.session_hash "$STATE_FILE")" = "$HASH" ] || die "session does not own Issue #$ISSUE"
    NOW=$(utc_now)
    VALUE=$(jq -c --arg now "$NOW" '.owner.active=false | .owner.updated_at=$now' "$STATE_FILE")
    write_state "$VALUE"
    unlock_state
    ;;

  cleanup)
    [ -n "$PR" ] || die "cleanup requires --pr"
    is_uint "$PR" || die "PR must be one positive integer"
    lock_state
    VALUE=$(state_json)
    WORKTREE=$(printf '%s' "$VALUE" | jq -r .worktree)
    BRANCH=$(printf '%s' "$VALUE" | jq -r .branch)
    [ "$(printf '%s' "$VALUE" | jq -r .owner.active)" = "false" ] || die "active lease must be released before cleanup"
    [ "$(printf '%s' "$VALUE" | jq -r .dirty)" = "false" ] || die "worktree is dirty; cleanup refused"
    [ "$(printf '%s' "$VALUE" | jq -r .git_operation)" = "none" ] || die "Git operation is in progress; cleanup refused"
    [ "$(printf '%s' "$VALUE" | jq -r .cwd_in_use)" = "false" ] || die "worktree is the cwd of a running process; cleanup refused"
    if [ -n "${ISSUE_WORKTREE_PR_STATE:-}" ]; then
      PR_STATE=$ISSUE_WORKTREE_PR_STATE
    else
      PR_JSON=$(gh pr view "$PR" --json state,headRefName,headRefOid 2>/dev/null) || die "cannot verify PR #$PR"
      PR_STATE=$(printf '%s' "$PR_JSON" | jq -r .state)
      [ "$(printf '%s' "$PR_JSON" | jq -r .headRefName)" = "$BRANCH" ] || die "PR #$PR does not belong to $BRANCH"
      [ "$(printf '%s' "$PR_JSON" | jq -r .headRefOid)" = "$(git -C "$WORKTREE" rev-parse HEAD)" ] \
        || die "worktree HEAD differs from PR head; unpushed commits may exist"
    fi
    [ "$PR_STATE" = "MERGED" ] || die "PR #$PR is not MERGED (state=$PR_STATE)"
    NOW=$(utc_now)
    VALUE=$(printf '%s' "$VALUE" | jq -c --arg now "$NOW" --argjson pr "$PR" '.status="cleaning" | .cleanup={pr:$pr,started_at:$now}')
    write_state "$VALUE"
    git -C "$PRIMARY" worktree remove "$WORKTREE"
    git -C "$PRIMARY" worktree prune
    git -C "$PRIMARY" branch -D "$BRANCH"
    git -C "$PRIMARY" fetch origin --prune >/dev/null 2>&1 || note "warning: fetch --prune failed"
    VALUE=$(jq -c --arg now "$(utc_now)" '.status="cleaned" | .owner.active=false | .cleanup.completed_at=$now' "$STATE_FILE")
    write_state "$VALUE"
    unlock_state
    ;;

  *) usage >&2; exit 2 ;;
esac
