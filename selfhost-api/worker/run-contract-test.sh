#!/usr/bin/env bash
# Run both test suites against the Worker, locally, with a clean D1.
#
# It starts `wrangler dev` (local mode, no Cloudflare account required), waits
# for /health, then runs
#
#   ../selftest.py          the client-page contract (address book, devices)
#   api_surface_test.py     everything else: identity, OIDC, sharing, telemetry,
#                           audit, records, admin, routing
#
# The database starts from a dedicated state directory that is deleted first, so
# a run never depends on what a previous run left behind. That matters: the
# suites assert an address book starts at `total=0`, and the surface suite
# bootstraps the first account, which is only allowed while no administrator
# exists.
#
# Usage:  bash run-contract-test.sh
#
# Env:    PORT=8787  PYTHON=python3  PERSIST_TO=.wrangler/test-state
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8787}"
PYTHON="${PYTHON:-python3}"
PERSIST_TO="${PERSIST_TO:-.wrangler/test-state}"
LOG=".wrangler-dev.log"
BASE="http://127.0.0.1:${PORT}"

echo "==> checking schema.sql against src/schema.ts"
# schema.sql is applied before the Worker ever starts, so a table missing from it
# is not caught by the suites (the Worker would create it on first request) — it
# would only show up as "no such table" while wiping. Compare the two table sets
# here so drift is a loud failure instead of a rebuild mystery.
tables_in() {
  grep -oiE 'CREATE TABLE( IF NOT EXISTS)? +[a-zA-Z_]+' "$1" |
    sed -E 's/.* +([a-zA-Z_]+)$/\1/' | tr 'A-Z' 'a-z' | sort -u
}
if ! diff <(tables_in schema.sql) <(tables_in src/schema.ts) >/dev/null; then
  echo "schema.sql and src/schema.ts disagree on the table set:" >&2
  diff <(tables_in schema.sql) <(tables_in src/schema.ts) >&2
  exit 1
fi
echo "    $(tables_in schema.sql | wc -l | tr -d ' ') tables, in sync"

echo "==> starting from an empty D1 at ${PERSIST_TO}"
rm -rf "$PERSIST_TO"
npx --yes wrangler d1 execute rustdesk-selfhost-api --local -y \
  --persist-to "$PERSIST_TO" --file=./schema.sql >/dev/null

# Belt and braces: if PERSIST_TO points at a directory that was reused, clear the
# rows too. On the fresh directory above every statement here is a no-op.
npx --yes wrangler d1 execute rustdesk-selfhost-api --local -y \
  --persist-to "$PERSIST_TO" --command \
  "DELETE FROM ab_peers; DELETE FROM ab_tags; DELETE FROM ab_rules; DELETE FROM address_books; \
   DELETE FROM devices; DELETE FROM device_groups; DELETE FROM device_commands; DELETE FROM audit_notes; \
   DELETE FROM audit_conn; DELETE FROM audit_file; DELETE FROM audit_alarm; DELETE FROM records; \
   DELETE FROM strategies; DELETE FROM switch_grants; DELETE FROM tokens; DELETE FROM oidc_sessions; \
   DELETE FROM users;" >/dev/null

echo "==> starting wrangler dev on ${BASE}"
npx --yes wrangler dev --port "$PORT" --ip 127.0.0.1 --persist-to "$PERSIST_TO" >"$LOG" 2>&1 &
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

echo "==> running the client-page contract suite"
"$PYTHON" ../selftest.py --base-url "$BASE"

echo
echo "==> running the api surface suite"
"$PYTHON" api_surface_test.py --base-url "$BASE"
