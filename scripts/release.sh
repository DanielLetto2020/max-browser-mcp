#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

APPROVED=0
DRY_RUN=0
BASE_MAJOR_MINOR="3.0"

for arg in "$@"; do
  case "$arg" in
    --approved) APPROVED=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --base=*) BASE_MAJOR_MINOR="${arg#*=}" ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [ "$APPROVED" -ne 1 ] && [ "$DRY_RUN" -ne 1 ]; then
  echo "ERROR: Releases require explicit approval from the repository owner." >&2
  echo "Run with --dry-run to preview, or pass --approved only after explicit owner sign-off." >&2
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "ERROR: Not inside a git repository." >&2
  exit 1
fi

CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != "dev" ]; then
  echo "ERROR: Releases must start from the 'dev' branch (current: '$CURRENT_BRANCH')." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Working tree on 'dev' has uncommitted changes. Commit or stash first." >&2
  exit 1
fi

BASE_TAG="v${BASE_MAJOR_MINOR}.0"
if git rev-parse -q --verify "refs/tags/$BASE_TAG" >/dev/null 2>&1; then
  COMMIT_COUNT="$(git rev-list --count "${BASE_TAG}..dev")"
else
  COMMIT_COUNT="0"
fi

NEXT_VERSION="${BASE_MAJOR_MINOR}.${COMMIT_COUNT}"
NEXT_TAG="v${NEXT_VERSION}"

echo "Release preview:"
echo "  Base tag      : $BASE_TAG"
echo "  Dev commits   : $COMMIT_COUNT"
echo "  Target version: $NEXT_VERSION ($NEXT_TAG)"

MANIFEST_VER="$(python3 -c "import json; print(json.load(open('extension/manifest.json'))['version'])")"
BRIDGE_VER="$(python3 -c "import bridge; print(bridge.VERSION)")"
INSTALL_VER="$(python3 -c "import json; print(json.load(open('INSTALL.json'))['version'])")"

echo "  Current versions -> manifest.json=$MANIFEST_VER bridge.py=$BRIDGE_VER INSTALL.json=$INSTALL_VER"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run complete. No branches, tags, or archives were modified."
  exit 0
fi

if [ "$MANIFEST_VER" != "$NEXT_VERSION" ] || [ "$BRIDGE_VER" != "$NEXT_VERSION" ] || [ "$INSTALL_VER" != "$NEXT_VERSION" ]; then
  echo "ERROR: Version mismatch! Sync manifest.json, bridge.py, INSTALL.json, extension JS/HTML, and tests to '$NEXT_VERSION' on 'dev' before releasing." >&2
  exit 1
fi

if git rev-parse -q --verify "refs/tags/$NEXT_TAG" >/dev/null 2>&1; then
  echo "ERROR: Tag '$NEXT_TAG' already exists." >&2
  exit 1
fi

./install.sh --no-hosts --test
./scripts/check_privacy.sh

mkdir -p dist
git checkout main
git merge --no-ff dev -m "release: Max Browser MCP $NEXT_TAG"
git tag -a "$NEXT_TAG" -m "Max Browser MCP $NEXT_TAG"
ZIP_OUT="dist/max-browser-mcp-${NEXT_TAG}.zip"
git archive --format=zip --prefix=max-browser-mcp/ -o "$ZIP_OUT" "$NEXT_TAG"
git checkout dev

echo "Release $NEXT_TAG prepared locally on 'main' and built $ZIP_OUT."
echo "Push with: git push origin main && git push origin $NEXT_TAG"
