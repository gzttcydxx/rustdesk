#!/usr/bin/env bash
# Verify the two access-control layers against a local dev server:
#
#   * the ACCESS_TOKEN path-prefix gate
#   * the OIDC sign-in handshake the Flutter client drives
#
# Nothing here is sent to Cloudflare: `wrangler dev` runs locally and D1 is
# emulated on disk.
#
# Usage:  bash test-access-control.sh
#
# Env:    PORT=8788  PYTHON=python3  SECRET=<fixed value>
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8788}"
PYTHON="${PYTHON:-python3}"
SECRET="${SECRET:-0123456789abcdef0123456789abcdef01234567}"
LOG=".wrangler-dev-acl.log"
BASE="http://127.0.0.1:${PORT}"
USER_NAME="acl-test"
PASSWORD="hunter2"

echo "==> creating the tables and one password-protected account"
npx --yes wrangler d1 execute rustdesk-selfhost-api --local -y --file=./schema.sql >/dev/null
HASH=$("$PYTHON" -c \
  "import hashlib,sys;print('sha256:'+hashlib.sha256(sys.argv[1].encode()).hexdigest())" "$PASSWORD")
# Keep this SQL on one line: `d1 execute --command` truncates at a newline.
# The upsert means the script can be re-run against the same local state.
npx --yes wrangler d1 execute rustdesk-selfhost-api --local -y --command \
  "INSERT INTO users (name, display_name, avatar, email, note, is_admin, status, password_hash, created_at) VALUES ('${USER_NAME}','${USER_NAME}','','','',1,1,'${HASH}', strftime('%s','now')) ON CONFLICT(name) DO UPDATE SET password_hash=excluded.password_hash;" >/dev/null

echo "==> starting wrangler dev with ACCESS_TOKEN set"
npx --yes wrangler dev --port "$PORT" --ip 127.0.0.1 --var "ACCESS_TOKEN:${SECRET}" \
  >"$LOG" 2>&1 &
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

echo "==> running the checks"
"$PYTHON" - "$BASE" "$SECRET" "$USER_NAME" "$PASSWORD" <<'PY'
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

base, secret, user, password = sys.argv[1:5]
UA = "rustdesk-selftest/1.0"

checked = 0
failed = 0


def call(method, path, body=None, token="", form=None):
    headers = {"User-Agent": UA}
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace")


def ok(cond, label):
    global checked, failed
    checked += 1
    if cond:
        print(f"  ok   {label}")
    else:
        failed += 1
        print(f"  FAIL {label}")


print("[1] shared-secret gate")
status, _ = call("GET", "/health")
ok(status == 200, "GET /health is reachable without the secret")
status, _ = call("POST", "/api/ab/personal", {})
ok(status == 403, "a request without the secret is refused (403)")
status, _ = call("POST", "/nope/api/ab/personal", {})
ok(status == 403, "a wrong secret is refused (403)")
status, body = call("POST", f"/{secret}/api/ab/personal", {})
guid = (json.loads(body).get("guid") or "") if status == 200 else ""
ok(status == 200 and bool(guid), "the secret as first path segment passes the gate")

print()
print("[2] oidc sign-in handshake")
status, body = call(
    "POST",
    f"/{secret}/api/oidc/auth",
    {"op": "login", "id": "1", "uuid": "u", "deviceInfo": {}, "apiDomain": base},
)
auth = json.loads(body) if status == 200 else {}
ok(status == 200 and "code" in auth and "url" in auth,
   "POST /api/oidc/auth returns code+url at the top level (no data wrapper)")
code = auth.get("code", "")
ok(auth.get("url", "").endswith(f"/login?code={code}"),
   "the url points back at this worker's sign-in page")

status, page = call("GET", f"/login?code={code}")
ok(status == 200 and "<form" in page, "GET /login serves the sign-in form")

status, body = call("GET", f"/{secret}/api/oidc/auth-query?code={code}&id=1&uuid=u")
inner = json.loads(json.loads(body)["body"]) if status == 200 else {}
ok(inner.get("error") == "No authed oidc is found",
   "an unauthenticated poll returns the exact message the client waits on")

status, _ = call("POST", "/login", form={"code": code, "username": user, "password": "wrong"})
ok(status == 401, "a wrong password is rejected")
status, _ = call("POST", "/login", form={"code": code, "username": user, "password": password})
ok(status == 200, "the right password is accepted")

status, body = call("GET", f"/{secret}/api/oidc/auth-query?code={code}&id=1&uuid=u")
inner = json.loads(json.loads(body)["body"]) if status == 200 else {}
token = inner.get("access_token", "")
payload = inner.get("user") or {}
ok(inner.get("type") == "access_token" and bool(token), "the poll then yields an access_token")
ok("info" in payload, "the user payload carries `info` (not optional in Rust)")
ok(payload.get("name") == user, f"the token belongs to {user}")

status, body = call("POST", f"/{secret}/api/currentUser", {"id": "1", "uuid": "u"}, token=token)
ok(status == 200 and json.loads(body).get("name") == user,
   "the token resolves through /api/currentUser")

status, body = call("GET", f"/{secret}/api/oidc/auth-query?code={code}&id=1&uuid=u")
inner = json.loads(json.loads(body)["body"]) if status == 200 else {}
ok(inner.get("error") == "No authed oidc is found", "a used sign-in link cannot be replayed")

print()
print(f"{checked - failed}/{checked} access-control checks passed")
sys.exit(1 if failed else 0)
PY
