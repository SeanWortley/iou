#!/usr/bin/env bash
#
# One command to run the whole stack against a public URL.
#
# Starts a Cloudflare quick tunnel to the local backend, grabs the public
# https://….trycloudflare.com URL, and then launches `npm run dev:all` with
# BACKEND_URL already set to that URL — no copy/paste between terminals.
#
# The tunnel stays alive for as long as the dev servers run. Ctrl+C stops both.
#
# Usage:
#   npm run tunnel              # tunnel :3001 (the backend) + start dev:all
#   npm run tunnel 4000         # tunnel a different port + start dev:all
#   TUNNEL_ONLY=1 npm run tunnel   # just the tunnel; print the URL and wait
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

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

echo >&2
echo "  ✓ Tunnel ready: $URL" >&2

# TUNNEL_ONLY=1 keeps the old behaviour: just expose the tunnel and wait.
if [ -n "${TUNNEL_ONLY:-}" ]; then
  cat >&2 <<EOF

  Tunnel-only mode. In another terminal:

      BACKEND_URL=$URL npm run dev:all

  Leave this terminal open — closing it stops the tunnel.

EOF
  wait "$CF_PID"
  exit 0
fi

echo "  → Starting dev:all with BACKEND_URL=$URL" >&2
echo >&2

# Run the full stack with the tunnel URL wired in. When dev:all exits (Ctrl+C),
# the EXIT trap tears the tunnel down.
cd "$REPO_ROOT"
BACKEND_URL="$URL" npm run dev:all
