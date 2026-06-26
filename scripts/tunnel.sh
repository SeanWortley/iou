#!/usr/bin/env bash
#
# Starts a Cloudflare quick tunnel to the local backend and prints the public
# https://….trycloudflare.com URL, plus a ready-to-paste command for dev:all.
#
# The tunnel must stay running while you use it — leave this terminal open.
# Closing it (Ctrl+C) tears the tunnel down.
#
# Usage:
#   npm run tunnel          # tunnels http://localhost:3001 (the backend)
#   npm run tunnel 4000     # tunnels a different port
#
set -euo pipefail

PORT="${1:-3001}"
LOG="$(mktemp)"

cleanup() { kill "${CF_PID:-}" 2>/dev/null || true; rm -f "$LOG"; }
trap cleanup EXIT INT TERM

if ! command -v cloudflared >/dev/null 2>&1; then
  cat >&2 <<'EOF'
✖ cloudflared is not installed.

  Arch:    sudo pacman -S cloudflared      (or the AUR `cloudflared-bin`)
  macOS:   brew install cloudflared
  Other:   https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

No account or login is needed for quick tunnels.
EOF
  exit 1
fi

echo "Starting Cloudflare tunnel → http://localhost:$PORT ..." >&2
cloudflared tunnel --url "http://localhost:$PORT" >"$LOG" 2>&1 &
CF_PID=$!

# Wait (up to ~30s) for cloudflared to print its public URL.
URL=""
for _ in $(seq 1 30); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  # If cloudflared died early, surface its output and bail.
  kill -0 "$CF_PID" 2>/dev/null || { echo "✖ cloudflared exited:" >&2; cat "$LOG" >&2; exit 1; }
  sleep 1
done

if [ -z "$URL" ]; then
  echo "✖ Timed out waiting for the tunnel URL. cloudflared output:" >&2
  cat "$LOG" >&2
  exit 1
fi

cat <<EOF

  ✓ Tunnel ready:

      $URL

  In another terminal, start the servers with this URL:

      BACKEND_URL=$URL npm run dev:all

  Leave this terminal open — closing it stops the tunnel.

EOF

# Keep the tunnel alive in the foreground until interrupted.
wait "$CF_PID"
