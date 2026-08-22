#!/bin/sh
set -e
cd /app

# Launch a persistent headless Chromium with CDP on :9222 so the
# browser-use 3.0 daemon (BU_CDP_URL=http://127.0.0.1:9222) can attach.
# Only start for the default app command — skip for `approve` / one-off cmds.
should_launch_chrome() {
  [ -z "$1" ] && return 0
  [ "$1" = "start" ] && return 0
  return 1
}

find_chrome_bin() {
  if [ -n "${CHROME_BIN:-}" ] && [ -x "${CHROME_BIN}" ]; then
    printf '%s\n' "${CHROME_BIN}"
    return 0
  fi
  if command -v chromium >/dev/null 2>&1; then
    command -v chromium
    return 0
  fi
  if command -v chromium-browser >/dev/null 2>&1; then
    command -v chromium-browser
    return 0
  fi
  if command -v google-chrome >/dev/null 2>&1; then
    command -v google-chrome
    return 0
  fi
  find /root/.cache/ms-playwright -path '*/chrome-linux/chrome' -type f -perm -111 2>/dev/null | sort | tail -n 1
}

if should_launch_chrome "$1"; then
  mkdir -p /tmp/chrome-data /tmp/bh-runtime
  CHROME_BIN="$(find_chrome_bin)"
  if [ -z "${CHROME_BIN}" ]; then
    echo "tabyAgent: Chromium binary not found; browser-use will fail until Chrome is installed." >&2
  else
    "$CHROME_BIN" \
      --headless=new \
      --no-sandbox \
      --disable-gpu \
      --disable-dev-shm-usage \
      --remote-debugging-port=9222 \
      --remote-debugging-address=127.0.0.1 \
      --user-data-dir=/tmp/chrome-data \
      --window-size=1280,900 \
      --no-first-run \
      --no-default-browser-check \
      --disable-features=Translate,OptimizationHints \
      >/tmp/chromium.log 2>&1 &
    # Wait for the DevTools endpoint to come up before the app uses it.
    # No curl/wget in the slim base image; python3 is always installed.
    python3 - <<'PYEOF'
import sys, time, urllib.request
for _ in range(30):
    try:
        urllib.request.urlopen("http://127.0.0.1:9222/json/version", timeout=1).close()
        sys.exit(0)
    except OSError:
        time.sleep(0.3)
sys.exit(0)
PYEOF
  fi
fi

case "$1" in
  approve)
    shift
    exec node codes/cli.js approve "$@"
    ;;
  start|"")
    exec node codes/index.js
    ;;
  *)
    exec "$@"
    ;;
esac
