#!/usr/bin/env bash
# Run the contract suite against the Worker, locally, with a clean D1.
#
# It starts `wrangler dev` (local mode, no Cloudflare account required), waits
# for /health, then runs the same ../selftest.py the Python server passes. The
# local D1 is wiped first because the suite asserts an empty address book.
#
# Usage:  bash run-contract-test.sh
#
# Env:    PORT=8787  PYTHON=python3
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8787}"
PYTHON="${PYTHON:-python3}"
LOG=".wrangler-dev.log"
BASE="http://127.0.0.1:${PORT}"

echo "==> wiping local D1 state"
rm -rf .wrangler/state

echo "==> starting wrangler dev on ${BASE}"
npx --yes wrangler dev --port "$PORT" --ip 127.0.0.1 >"$LOG" 2>&1 &
DEV_PID=$!
trap 'kill "$DEV_PID" 2>/dev/null || true' EXIT

echo "==> waiting for the worker to answer"
ready=""
for _ in $(seq 1 90); do
  if curl -fsS "${BASE}/health" >/dev/null 2>&1; then
    ready=yes
    break
  fi
  sleep 1
done
if [ -z "$ready" ]; then
  echo "worker never came up; last log lines:" >&2
  tail -40 "$LOG" >&2
  exit 1
fi

echo "==> running the contract suite"
"$PYTHON" ../selftest.py --base-url "$BASE"
