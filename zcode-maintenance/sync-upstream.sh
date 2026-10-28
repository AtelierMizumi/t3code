#!/usr/bin/env bash
# Merge the latest upstream T3 Code into the ZCode integration branch, then
# verify. Conflict resolution strategy and the seam map live in PATCHING.md.
#
# Usage: zcode-maintenance/sync-upstream.sh [--no-install]
#   1. fetch upstream, merge upstream/main into zcode-main
#   2. abort cleanly on unresolved conflicts (rerere auto-resolves known ones)
#   3. typecheck + test the affected workspaces
#   4. optionally build the AppImage and the pacman package
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
export PATH="$HOME/.cargo/bin:$REPO_ROOT/node_modules/.bin:$PATH"

if [[ "$BRANCH" != "zcode-main" ]]; then
  echo "Run this on the zcode-main branch (currently on: $BRANCH)" >&2
  exit 1
fi

echo "==> Fetching upstream..."
git fetch upstream main

BEHIND="$(git rev-list --count zcode-main..upstream/main)"
if [[ "$BEHIND" == "0" ]]; then
  echo "==> Already up to date with upstream/main."
else
  echo "==> Merging $BEHIND upstream commit(s)..."
  if ! git merge --no-edit upstream/main; then
    UNMERGED="$(git diff --name-only --diff-filter=U)"
    echo
    echo "Conflicts to resolve:" >&2
    echo "$UNMERGED" | while read -r f; do
      case "$f" in
        packages/provider-zcode/*) group="zcode package (ours; adapt if the interface moved)" ;;
        packages/contracts/src/model.ts|packages/contracts/src/settings.ts) group="contracts seam (keep both sides; see PATCHING.md)" ;;
        apps/server/src/provider/builtInDrivers.ts) group="driver registration seam (one import + one array entry)" ;;
        packages/client-runtime/src/providerClients.ts) group="client registry seam (one import + one array entry)" ;;
        *) group="upstream surface — prefer upstream unless it deleted a seam" ;;
      esac
      echo "  [${group}] $f" >&2
    done
    echo
    echo "After resolving: git add -A && git commit, then re-run this script from step 3." >&2
    exit 2
  fi
fi

echo "==> Installing dependencies (pnpm install --frozen-lockfile fallback)..."
pnpm install || pnpm install --no-frozen-lockfile

echo "==> Typechecking..."
pnpm typecheck

echo "==> Testing provider-zcode + contracts..."
pnpm --filter @t3tools/provider-zcode test
pnpm --filter @t3tools/contracts test

if [[ "${1:-}" == "--no-install" ]]; then
  echo "==> Skipping build/install (--no-install)."
  exit 0
fi

echo "==> Building AppImage..."
pnpm dist:desktop:linux

echo "==> Building pacman package..."
"$REPO_ROOT/zcode-maintenance/build-and-install.sh"

echo "==> Done. Push with:  git push origin zcode-main"
