#!/usr/bin/env bash
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_BIN="$(command -v python3 || true)"
if [ -z "$PYTHON_BIN" ]; then
  echo "Ошибка: не найден python3." >&2
  exit 1
fi

RUN_TEST=0
SYNC_BUNDLE=0
INSTALL_HOSTS=1

for arg in "$@"; do
  case "$arg" in
    --test) RUN_TEST=1 ;;
    --sync-bundle) SYNC_BUNDLE=1 ;;
    --no-hosts) INSTALL_HOSTS=0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 1 ;;
  esac
done

chmod +x "$DIR/bridge.py" "$DIR/native-host" "$DIR/install.sh" 2>/dev/null || true

if [ "$INSTALL_HOSTS" -eq 1 ]; then
  EXT_ID="pokochlnfaddpcmnlilacfhfdhfplndi"
  MANIFEST_NAME="local.max.browser.json"
  OS_NAME="$(uname -s)"
  TARGETS=()
  if [ "$OS_NAME" = "Darwin" ]; then
    TARGETS+=(
      "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
      "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
    )
  else
    TARGETS+=("$HOME/.config/google-chrome/NativeMessagingHosts")
    for browser_dir in "$HOME/.config/chromium" "$HOME/.config/BraveSoftware/Brave-Browser" "$HOME/.config/yandex-browser"; do
      if [ -d "$browser_dir" ]; then
        TARGETS+=("$browser_dir/NativeMessagingHosts")
      fi
    done
  fi

  MANIFEST_JSON=$(cat <<EOF
{
  "name": "local.max.browser",
  "description": "Max Browser local bridge",
  "path": "$DIR/native-host",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF
)
  for target in "${TARGETS[@]}"; do
    mkdir -p "$target"
    printf '%s\n' "$MANIFEST_JSON" > "$target/$MANIFEST_NAME"
    echo "Установлен Native Messaging Host: $target/$MANIFEST_NAME"
  done
fi

if [ "$RUN_TEST" -eq 1 ]; then
  echo "Running syntax checks and unit tests..."
  (
    cd "$DIR"
    "$PYTHON_BIN" -m py_compile bridge.py test/test_bridge.py test/live_smoke.py
    "$PYTHON_BIN" -c "import json; [json.load(open(f)) for f in ('extension/manifest.json','INSTALL.json')]"
    for js in extension/background.js extension/advanced.js extension/dom.js extension/fast-dom.js extension/features.js extension/v3.js extension/about.js extension/popup.js extension/recorder.js extension/visual-indicator.js extension/cursor-motion.js; do
      node --check "$js"
    done
    "$PYTHON_BIN" -m unittest discover -s test -p 'test_*.py' -v
    node --test test/browser.test.js test/dom.test.js
  )
fi

if [ "$SYNC_BUNDLE" -eq 1 ]; then
  BUNDLE_ROOT="${MAX_BROWSER_BUNDLE_DIR:-$DIR/dist/max-browser-bundle}"
  PLAYGROUND_SRC="${MAX_BROWSER_PLAYGROUND_DIR:-}"
  ZIP_PATH="${MAX_BROWSER_ZIP_PATH:-$DIR/dist/max-browser-mcp.zip}"
  MCP_DST="$BUNDLE_ROOT/max-browser-mcp"
  mkdir -p "$MCP_DST/extension" "$MCP_DST/test" "$(dirname "$ZIP_PATH")"
  rsync -a --delete --exclude '.git/' --exclude 'dist/' --exclude '__pycache__/' --exclude '*.pyc' --exclude 'run/' "$DIR/" "$MCP_DST/"
  cp -f "$DIR/README.md" "$BUNDLE_ROOT/README.md"
  if [ -n "$PLAYGROUND_SRC" ] && [ -d "$PLAYGROUND_SRC" ]; then
    mkdir -p "$BUNDLE_ROOT/playground"
    rsync -a --delete --exclude '.git/' --exclude '__pycache__/' --exclude '*.pyc' "$PLAYGROUND_SRC/" "$BUNDLE_ROOT/playground/"
  fi
  if command -v zip >/dev/null 2>&1; then
    (cd "$BUNDLE_ROOT" && rm -f "$ZIP_PATH" && zip -rq "$ZIP_PATH" max-browser-mcp -x "*/.git/*" "*/dist/*" "*/__pycache__/*" "*.pyc" "*/run/*")
    echo "Synced bundle and rebuilt $(basename "$ZIP_PATH")"
  else
    echo "Synced bundle (zip command not found, skipped zip rebuild)"
  fi
fi
