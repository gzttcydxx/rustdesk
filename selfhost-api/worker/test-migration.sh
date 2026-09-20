#!/usr/bin/env bash
# Verify that the schema migration adds the v2 columns to a database that was
# created by an older build.
#
# Why this test exists
# --------------------
# `CREATE TABLE IF NOT EXISTS` is a no-op when the table already exists, so a
# `users` table from an older build keeps its old column set no matter what
# `CREATE_STATEMENTS` says. The only thing that adds the columns is
# `MIGRATIONS_V2`, and it only runs when `_meta.schema_version` is below
# SCHEMA_VERSION — see the gate in src/index.ts:
#
#     if (version >= SCHEMA_VERSION) return;   // <- nothing runs
#
# A fresh database cannot catch a mistake here: it takes the `!initialised`
# branch and gets a complete schema either way. So the only way to test the
# migration is to start from the old shape, which is what
# `legacy-fixture.sql` is.
#
# The failure mode this guards against is nasty: seeding `_meta.schema_version`
# from schema.sql (or forgetting to bump the version when adding a column)
# leaves the columns missing forever, and it surfaces later as
# "no such column" on a live database.
#
# Usage:  bash test-migration.sh
#
# Env:    PORT=8796  PYTHON=python3  PERSIST_TO=.wrangler/migrate-test
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8796}"
PYTHON="${PYTHON:-python3}"
PERSIST_TO="${PERSIST_TO:-.wrangler/migrate-test}"
LOG=".wrangler-dev-migrate.log"
BASE="http://127.0.0.1:${PORT}"

# Columns that only exist from v2 onwards.
V2_USER_COLUMNS=(tfa_secret tfa_type strategy_name verifier)

checked=0
failed=0

query() {
  npx --yes wrangler d1 execute rustdesk-selfhost-api --local -y \
    --persist-to "$PERSIST_TO" --json --command "$1" 2>/dev/null |
    "$PYTHON" -c '
import json, sys
data = json.load(sys.stdin)
out = []
for block in data:
    for row in block.get("results", []):
        out.extend(row.values())
print(" ".join(str(v) for v in out))
'
}

check() {
  local cond="$1" label="$2"
  checked=$((checked + 1))
  if [ "$cond" = "1" ]; then
    echo "  ok   ${label}"
  else
    failed=$((failed + 1))
    echo "  FAIL ${label}"
  fi
}

column_count() {
  query "SELECT COUNT(*) FROM pragma_table_info('$1')"
}

has_column() {
  local cols
  cols=$(query "SELECT name FROM pragma_table_info('$1')")
  case " ${cols} " in *" $2 "*) echo 1 ;; *) echo 0 ;; esac
}

echo "==> laying down the pre-migration schema from legacy-fixture.sql"
# Drop rather than delete the state directory: the environment blocks bulk
# filesystem deletes at 50 files and a D1 state directory holds ~60, so the
# cleanup would fail on the second run. `DROP TABLE` is just a query, and it
# leaves the directory in a known-empty state. The names come from schema.ts
# because it is the superset — it still lists every legacy table.
drops=""
while read -r table; do
  [ -n "$table" ] && drops="${drops}DROP TABLE IF EXISTS ${table}; "
done < <(sed -E '/^[[:space:]]*(\/\/|\*|\/\*)/d' src/schema.ts |
  grep -oiE 'CREATE TABLE( IF NOT EXISTS)? +[a-zA-Z_]+ *\(' |
  sed -E 's/.* +([a-zA-Z_]+) *\($/\1/' | tr 'A-Z' 'a-z' | sort -u)

npx --yes wrangler d1 execute rustdesk-selfhost-api --local -y \
  --persist-to "$PERSIST_TO" --command "$drops" >/dev/null
npx --yes wrangler d1 execute rustdesk-selfhost-api --local -y \
  --persist-to "$PERSIST_TO" --file=./legacy-fixture.sql >/dev/null

echo
echo "[1] the fixture really is the old shape"
check "$([ "$(column_count users)" = "9" ] && echo 1 || echo 0)" "users starts with 9 columns"
check "$([ "$(query "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_meta'")" = "0" ] && echo 1 || echo 0)" \
  "there is no _meta table, so the version reads as 0"
check "$([ "$(has_column tokens expires_at)" = "0" ] && echo 1 || echo 0)" "tokens has no expires_at yet"
check "$([ "$(has_column address_books note)" = "0" ] && echo 1 || echo 0)" "address_books has no note yet"

echo
echo "==> starting wrangler dev on ${BASE} to trigger the migration"
npx --yes wrangler dev --port "$PORT" --ip 127.0.0.1 --persist-to "$PERSIST_TO" >"$LOG" 2>&1 &
DEV_PID=$!
trap 'kill "$DEV_PID" 2>/dev/null || true' EXIT

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

# /health answers before ensureSchema runs, so a real endpoint has to be hit.
curl -fsS "${BASE}/api/login-options" >/dev/null
sleep 1
kill "$DEV_PID" 2>/dev/null || true
trap - EXIT
wait "$DEV_PID" 2>/dev/null || true

echo
echo "[2] the migration brought the database up to date"
check "$([ "$(query "SELECT value FROM _meta WHERE key='schema_version'")" = "2" ] && echo 1 || echo 0)" \
  "schema_version was recorded as 2"
check "$([ "$(column_count users)" = "13" ] && echo 1 || echo 0)" "users now has 13 columns"
for col in "${V2_USER_COLUMNS[@]}"; do
  check "$(has_column users "$col")" "users gained ${col}"
done
check "$(has_column tokens expires_at)" "tokens gained expires_at"
check "$(has_column address_books note)" "address_books gained note"
check "$(has_column address_books info)" "address_books gained info"

tables=$(query "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%'")
check "$([ "$tables" = "18" ] && echo 1 || echo 0)" "all 18 tables exist (got ${tables})"
check "$([ "$(query "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ab_rules'")" = "1" ] && echo 1 || echo 0)" \
  "the new ab_rules table was created"

echo
echo "[3] existing data survived"
check "$([ "$(query "SELECT COUNT(*) FROM users WHERE name='legacy-admin'")" = "1" ] && echo 1 || echo 0)" \
  "the pre-existing account is still there"
check "$([ "$(query "SELECT password_hash FROM users WHERE name='legacy-admin'")" = "sha256:deadbeef" ] && echo 1 || echo 0)" \
  "its password hash is untouched"
check "$([ "$(query "SELECT COUNT(*) FROM ab_peers WHERE id='123456789'")" = "1" ] && echo 1 || echo 0)" \
  "the pre-existing address book peer is still there"

echo
echo "${checked} checks, ${failed} failed"
[ "$failed" -eq 0 ] || exit 1
echo "PASSED all ${checked} migration checks"
