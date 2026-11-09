#!/usr/bin/env bash
#
# Refresh the `upstream` branch with a snapshot of medusajs/dtc-starter at a
# given commit, so upstream changes can be merged into this fork with a real
# three-way diff. See docs/upstream-sync.md.
#
# dtc-starter is what `create-medusa-app` clones, and it publishes no tags, so
# the argument is a commit-ish: a SHA, or `main` for whatever is current.
#
# Usage: scripts/sync-upstream.sh 4a1d53dc434ed124a78c4e2c9f312e1f47d4e9eb
#        scripts/sync-upstream.sh main

set -euo pipefail

UPSTREAM_REPO="https://github.com/medusajs/dtc-starter.git"
BRANCH="upstream"

COMMITISH="${1:-}"

if [ -z "$COMMITISH" ]; then
  echo "usage: $0 <commit-ish>   e.g. $0 main" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
TMP="$(mktemp -d)"
WORKTREE="$TMP/worktree"
trap 'git -C "$REPO_ROOT" worktree remove --force "$WORKTREE" 2>/dev/null || true; rm -rf "$TMP"' EXIT

echo "==> fetching dtc-starter at $COMMITISH"
git init --quiet "$TMP/dtc"
git -C "$TMP/dtc" remote add origin "$UPSTREAM_REPO"
git -C "$TMP/dtc" fetch --quiet --depth 1 origin "$COMMITISH"
git -C "$TMP/dtc" checkout --quiet FETCH_HEAD
SHA="$(git -C "$TMP/dtc" rev-parse HEAD)"
rm -rf "$TMP/dtc/.git"

echo "==> updating the $BRANCH branch"
if git -C "$REPO_ROOT" show-ref --quiet "refs/heads/$BRANCH"; then
  git -C "$REPO_ROOT" worktree add --quiet "$WORKTREE" "$BRANCH"
  find "$WORKTREE" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
else
  git -C "$REPO_ROOT" worktree add --quiet --orphan -b "$BRANCH" "$WORKTREE"
fi

cp -a "$TMP/dtc/." "$WORKTREE/"
git -C "$WORKTREE" add -A

if git -C "$WORKTREE" diff --cached --quiet; then
  echo "==> $BRANCH already matches $SHA, nothing to do"
  exit 0
fi

git -C "$WORKTREE" commit --quiet -m "dtc-starter $SHA"

echo
echo "$BRANCH is now at $SHA. Merge it into your branch with:"
echo
echo "    git merge $BRANCH"
echo
