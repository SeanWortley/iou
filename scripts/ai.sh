#!/usr/bin/env bash
#
# Starts the Python "AI layer" (the genAI text interpreter) on port 8000.
#
# This is run automatically as part of `npm run dev:all`, but you can also run
# it on its own with `npm run ai`.
#
# It uses the project-local virtual environment at
# backend/src/Interpreter/.venv so it never depends on whatever `python` happens
# to be on your PATH. If that venv (or its dependencies) is missing, it is
# created and `requirements.txt` is installed automatically on first run.
set -euo pipefail

# Resolve paths relative to this script so it works from any CWD.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INTERP_DIR="$SCRIPT_DIR/../backend/src/Interpreter"
VENV_DIR="$INTERP_DIR/.venv"
PY="$VENV_DIR/bin/python"

cd "$INTERP_DIR"

# Pick a base interpreter to create the venv with, if needed.
pick_base_python() {
  for c in python3 python; do
    if command -v "$c" >/dev/null 2>&1; then echo "$c"; return 0; fi
  done
  echo "✖ No python3/python found on PATH — install Python 3 to run the AI layer." >&2
  exit 1
}

# Create the venv on first run.
if [ ! -x "$PY" ]; then
  BASE_PY="$(pick_base_python)"
  echo "→ Creating Python venv at $VENV_DIR ..." >&2
  "$BASE_PY" -m venv "$VENV_DIR"
fi

# Make sure dependencies are present. Cheap import check; install only if needed.
if ! "$PY" -c "import fastapi, uvicorn" >/dev/null 2>&1; then
  echo "→ Installing AI layer dependencies (requirements.txt) ..." >&2
  "$PY" -m pip install --quiet --upgrade pip
  "$PY" -m pip install --quiet -r requirements.txt
fi

# Load environment from backend/.env so the parser sees GEMINI_API_KEY (and any
# other shared config) without a separate copy. We parse it safely rather than
# `source`-ing it: strip a possible UTF-8 BOM, skip comments/blank lines, and
# trim surrounding quotes — so a stray BOM or quoted value can't break startup.
ENV_FILE="$SCRIPT_DIR/../backend/.env"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line#$'\xEF\xBB\xBF'}"                 # strip BOM if present
    line="${line%$'\r'}"                           # strip trailing CR (CRLF files)
    case "$line" in ''|'#'*) continue ;; esac      # skip blanks/comments
    case "$line" in *=*) ;; *) continue ;; esac    # need a KEY=VALUE
    key="${line%%=*}"
    val="${line#*=}"
    val="${val%\"}"; val="${val#\"}"               # strip wrapping double quotes
    val="${val%\'}"; val="${val#\'}"               # strip wrapping single quotes
    export "$key=$val"
  done < "$ENV_FILE"
fi

# Fail fast with a useful message instead of letting genai.Client() throw a 500
# on every /parse request.
if [ -z "${GEMINI_API_KEY:-}" ] && [ -z "${GOOGLE_API_KEY:-}" ]; then
  cat >&2 <<EOF
✖ No Gemini API key found — the AI parser cannot start usefully.

  Add this line to backend/.env:

      GEMINI_API_KEY=your-key-here

  Get a free key at https://ai.google.dev/gemini-api/docs/api-key
EOF
  exit 1
fi

exec "$PY" -m uvicorn parser:app --reload --port 8000
