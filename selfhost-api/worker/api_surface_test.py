#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""End-to-end checks for the parts of the API the contract suite does not cover.

``../selftest.py`` replays what the two client *pages* do (address book and
accessible devices). This one drives everything else the client talks to, plus
the operator-facing admin surface:

    identity      login with a password, currentUser, login-options, logout
    OIDC          the browser handshake, including the served sign-in page
    shared books  sharing an address book with a user and with everyone, and the
                  read / read-write / full-control rules gating writes
    telemetry     sysinfo, sysinfo_ver, heartbeat (policy + disconnect)
    provisioning  devices/deploy, devices/cli, switch-grant
    audit         the three ingest endpoints, nonce de-duplication, the empty-body
                  success convention, notes, and the admin query views
    records       that an unconfigured deployment says so rather than hanging
    admin         accounts, devices, device groups, policies, summary
    routing       the secret gate, 404, 405, and /login staying outside the gate

Usage:  python api_surface_test.py --base-url http://127.0.0.1:8787
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

FAILURES: list[str] = []
CHECKS = 0
USER_AGENT = "rustdesk-selfhost-api-test/1.0"

USER_PAYLOAD_KEYS = {
    "name",
    "display_name",
    "avatar",
    "email",
    "note",
    "status",
    "is_admin",
    "verifier",
}


def check(condition: bool, label: str) -> None:
    global CHECKS
    CHECKS += 1
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}")
        FAILURES.append(label)


def call(
    base: str,
    method: str,
    path: str,
    body=None,
    token: str | None = None,
    form: bool = False,
    raw: bytes | None = None,
):
    """Returns (status, text, headers). Never raises on an HTTP error status."""
    url = base + path
    headers = {"User-Agent": USER_AGENT}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    data = None
    if form:
        data = urllib.parse.urlencode(body or {}).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    elif raw is not None:
        data = raw
    elif body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read().decode("utf-8", "replace"), dict(response.headers)
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8", "replace"), dict(exc.headers)
    except Exception as exc:  # noqa: BLE001 - reported as a failed check
        return 0, f"<{exc}>", {}


def parsed(text: str):
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def run(base: str) -> None:
    # ---------------------------------------------------------------- identity
    print("\n[1] identity")
    status, text, _ = call(base, "GET", "/api/login-options")
    options = parsed(text)
    check(status == 200 and isinstance(options, list), "GET /api/login-options -> a json array")
    check(any(isinstance(o, str) and o.startswith("oidc/") for o in (options or [])),
          "login-options offers at least one oidc provider")

    # The first account is created without a credential: a fresh deployment has
    # nothing to authenticate against yet.
    status, text, _ = call(base, "POST", "/api/users", {"name": "root", "password": "root-pw", "is_admin": True})
    root = parsed(text)
    check(status == 200 and root and root.get("name") == "root", "bootstrap creates the first account")
    check(bool(root and root.get("is_admin")), "the bootstrapped account is an administrator")
    check(bool(root and root.get("bootstrapped")), "the response says it was the bootstrap")
    missing = USER_PAYLOAD_KEYS - set(root or {})
    check(not missing, f"created account carries every UserPayload key (missing: {sorted(missing)})")

    status, _, _ = call(base, "POST", "/api/users", {"name": "sneaky"})
    check(status == 403, "an unauthenticated account creation is refused once an admin exists")

    status, text, _ = call(base, "POST", "/api/login", {"username": "root", "password": "wrong"})
    check(status == 401, "login with the wrong password -> 401")

    status, text, _ = call(base, "POST", "/api/login", {"username": "root", "password": "root-pw"})
    signed_in = parsed(text)
    check(status == 200 and signed_in and signed_in.get("type") == "access_token",
          "login with the right password issues an access_token")
    root_token = (signed_in or {}).get("access_token") or ""
    check(bool(root_token), "the access token is non-empty")

    status, text, _ = call(base, "POST", "/api/currentUser", {"id": "root-dev", "uuid": "u-root"}, token=root_token)
    me = parsed(text)
    check(status == 200 and (me or {}).get("name") == "root", "currentUser resolves the token")

    # alice is the non-admin used by the sharing and permission checks below.
    status, text, _ = call(base, "POST", "/api/login", {"username": "alice", "password": "", "id": "1", "uuid": "u"})
    alice = parsed(text)
    check(status == 200 and (alice or {}).get("type") == "access_token",
          "an unknown name is accepted on first use when not in strict mode")
    alice_token = (alice or {}).get("access_token") or ""
    check(not (alice or {}).get("user", {}).get("is_admin"), "the auto-created account is not an administrator")

    # ------------------------------------------------------------------- OIDC
    print("\n[2] oidc sign-in handshake")
    status, text, _ = call(base, "POST", "/api/oidc/auth", {"op": "oidc/selfhost", "id": "1", "uuid": "u"})
    started = parsed(text)
    check(status == 200 and isinstance(started, dict) and "code" in started and "url" in started,
          "POST /api/oidc/auth returns {code, url} at the top level")
    code = (started or {}).get("code", "")
    check(bool(code) and code in (started or {}).get("url", ""), "the url carries the code")
    # The client opens this url in a browser, so it must be absolute and point at the
    # sign-in page on this deployment. We deliberately do NOT compare it against `base`:
    # under `wrangler dev` the Host header is rewritten to the configured route
    # (rd.gzttc.qzz.io), so the origin differs from 127.0.0.1 even though the behaviour is
    # correct. Comparing against `base` would only pass when running without a route.
    url = (started or {}).get("url", "")
    check(url.startswith(("http://", "https://")) and "/login?code=" in url,
          "the url is absolute and points at the sign-in page on this deployment")

    status, text, _ = call(base, "GET", f"/api/oidc/auth-query?code={code}&id=1&uuid=u")
    pending = parsed(text)
    check(status == 200 and isinstance(pending, dict) and "body" in pending,
          "GET /api/oidc/auth-query wraps its answer in {body}")
    check("No authed oidc is found" in (pending or {}).get("body", ""),
          "an unauthenticated poll says exactly what the client keeps polling on")

    status, text, _ = call(base, "GET", f"/login?code={code}")
    check(status == 200 and "<form" in text and 'name="username"' in text,
          "GET /login serves the sign-in form outside the secret gate")

    status, text, _ = call(base, "POST", "/login", {"code": code, "username": "root", "password": "root-pw"}, form=True)
    check(status == 200 and "Signed in" in text, "Posting valid credentials completes the sign-in page")

    status, text, _ = call(base, "GET", f"/api/oidc/auth-query?code={code}&id=1&uuid=u")
    collected = parsed(text)
    body = parsed((collected or {}).get("body", "")) or {}
    check(isinstance(body, dict) and body.get("type") == "access_token" and body.get("access_token"),
          "the poll then yields an access token")
    check(isinstance(body.get("user", {}).get("info"), dict),
          "the token payload carries user.info, which Rust requires")
    check(bool(body.get("access_token")) and parsed(
        call(base, "POST", "/api/currentUser", {}, token=body.get("access_token"))[1] or "null"
    ), "the OIDC-issued token works on currentUser")

    status, text, _ = call(base, "GET", f"/api/oidc/auth-query?code={code}&id=1&uuid=u")
    again = parsed(text)
    check("No authed oidc is found" in (again or {}).get("body", ""),
          "a code is single use: the next poll goes back to pending")

    # ------------------------------------------------- shared address books
    print("\n[3] shared address books and share rules")
    status, text, _ = call(base, "POST", "/api/ab/shared/add", {"name": "team", "note": "shared"},
                           token=root_token)
    book = parsed(text)
    check(status == 200 and (book or {}).get("guid"), "POST /api/ab/shared/add returns a guid")
    book_guid = (book or {}).get("guid", "")

    status, text, _ = call(base, "POST", f"/api/ab/peer/add/{book_guid}",
                           {"id": "shared-peer", "hostname": "SHARED-BOX", "platform": "Linux"}, token=root_token)
    check(status == 200, "a peer can be added to a shared address book")

    def alice_profiles():
        status, text, _ = call(base, "POST", "/api/ab/shared/profiles?current=1&pageSize=100", token=alice_token)
        rows = (parsed(text) or {}).get("data") or []
        return status, [row for row in rows if row.get("guid") == book_guid]

    status, mine = alice_profiles()
    check(status == 200 and mine == [], "an unshared address book is invisible to another user")

    status, text, _ = call(base, "PUT", f"/api/ab/peer/update/{book_guid}",
                           {"id": "shared-peer", "alias": "nope"}, token=alice_token)
    check(status == 200 and (parsed(text) or {}).get("error"),
          "writing to an unshared address book is refused with an error")

    status, text, _ = call(base, "POST", "/api/ab/rule", {"guid": book_guid, "user": "alice", "rule": 1},
                           token=root_token)
    rule = parsed(text)
    check(status == 200 and (rule or {}).get("guid") and (rule or {}).get("user") == "alice",
          "POST /api/ab/rule grants a user access and returns the rule")
    rule_guid = (rule or {}).get("guid", "")

    status, mine = alice_profiles()
    check(status == 200 and len(mine) == 1, "the shared address book is now visible to alice")
    check(mine and mine[0].get("rule") == 1, "it is reported with alice's read-only rule")

    status, text, _ = call(base, "POST", f"/api/ab/peers?current=1&pageSize=100&ab={book_guid}", token=alice_token)
    shared_peers = parsed(text)
    check(status == 200 and shared_peers.get("total") == 1, "alice can read the peers of the shared book")

    status, text, _ = call(base, "PUT", f"/api/ab/peer/update/{book_guid}",
                           {"id": "shared-peer", "alias": "read-only"}, token=alice_token)
    check((parsed(text) or {}).get("error"), "read-only still refuses a write after sharing")

    status, text, _ = call(base, "PATCH", "/api/ab/rule", {"guid": rule_guid, "rule": 3}, token=root_token)
    check(status == 200, "PATCH /api/ab/rule changes the permission")
    status, text, _ = call(base, "PUT", f"/api/ab/peer/update/{book_guid}",
                           {"id": "shared-peer", "alias": "full-control"}, token=alice_token)
    check(status == 200 and not (parsed(text) or {}).get("error"),
          "full control allows the write")
    status, text, _ = call(base, "POST", f"/api/ab/peers?current=1&pageSize=100&ab={book_guid}", token=alice_token)
    check(parsed(text)["data"][0].get("alias") == "full-control", "the write landed")

    status, text, _ = call(base, "GET", f"/api/ab/rules?ab={book_guid}&current=1&pageSize=100", token=root_token)
    rules = parsed(text)
    check(status == 200 and rules.get("total") == 1, "GET /api/ab/rules lists the rule")

    status, text, _ = call(base, "POST", "/api/ab/rule", {"guid": book_guid, "everyone": True, "rule": 1},
                           token=root_token)
    everyone_rule = parsed(text)
    check(status == 200, "an everyone rule can be added")
    status, text, _ = call(base, "POST", "/api/ab/shared/profiles?current=1&pageSize=100")
    visible = [row for row in ((parsed(text) or {}).get("data") or []) if row.get("guid") == book_guid]
    check(len(visible) == 1, "an everyone rule makes the book visible to the anonymous session too")

    status, text, _ = call(base, "PUT", "/api/ab/shared/update/profile",
                           {"guid": book_guid, "name": "team-renamed"}, token=root_token)
    check(status == 200, "PUT /api/ab/shared/update/profile -> 200")
    status, text, _ = call(base, "POST", f"/api/ab/peers?current=1&pageSize=100&ab={book_guid}", token=root_token)
    check(status == 200, "the renamed book is still addressable by guid")

    # Both rules have to go: while the everyone rule stands it keeps alice in.
    status, text, _ = call(base, "DELETE", f"/api/ab/rules", [rule_guid], token=root_token)
    check(status == 200, "DELETE /api/ab/rules -> 200")
    status, mine = alice_profiles()
    check(len(mine) == 1, "the everyone rule still grants access after her own rule is removed")
    call(base, "DELETE", "/api/ab/rules", [(everyone_rule or {}).get("guid", "")], token=root_token)
    status, mine = alice_profiles()
    check(mine == [], "alice loses visibility once every rule is gone")

    # ------------------------------------------------------------- telemetry
    print("\n[4] telemetry: sysinfo, heartbeat, policy")
    status, text, _ = call(base, "POST", "/api/sysinfo", {
        "id": "test-dev-1", "uuid": "uuid-1", "version": "1.5.0",
        "os": "Windows", "hostname": "TELEMETRY-BOX", "username": "pc-user",
        "cpu": "8/16 cores", "memory": "32GB",
    })
    check(status == 200 and text.strip() == "SYSINFO_UPDATED",
          "POST /api/sysinfo answers SYSINFO_UPDATED as plain text")

    status, text, _ = call(base, "POST", "/api/sysinfo_ver", raw=b"")
    check(status == 200 and text.strip(), "POST /api/sysinfo_ver answers a version string")

    status, text, _ = call(base, "POST", "/api/heartbeat",
                           {"id": "test-dev-1", "uuid": "uuid-1", "ver": "150", "conns": [3], "modified_at": 0})
    beat = parsed(text)
    check(status == 200 and isinstance(beat, dict), "POST /api/heartbeat -> a json object")
    check("modified_at" in beat, "the heartbeat reports a policy timestamp")
    check("sysinfo" not in beat, "a device that has already reported is not asked for sysinfo again")

    status, text, _ = call(base, "POST", "/api/heartbeat", {"id": "test-dev-2", "uuid": "uuid-2", "ver": "150"})
    check("sysinfo" in parsed(text), "a device that never reported is asked for sysinfo")

    status, text, _ = call(base, "POST", "/api/strategies",
                           {"name": "night-shift", "config_options": {"deny-lan": "Y"}}, token=root_token)
    check(status == 200 and parsed(text).get("modified_at"), "POST /api/strategies -> a modified_at")
    status, text, _ = call(base, "PUT", "/api/devices",
                           {"id": "test-dev-1", "strategy_name": "night-shift"}, token=root_token)
    check(status == 200, "a policy can be assigned to a device")
    status, text, _ = call(base, "POST", "/api/heartbeat", {"id": "test-dev-1", "uuid": "uuid-1", "ver": "150"})
    beat = parsed(text)
    check(beat.get("strategy", {}).get("config_options", {}).get("deny-lan") == "Y",
          "the heartbeat delivers the assigned policy")

    status, text, _ = call(base, "POST", "/api/devices/disconnect", {"id": "test-dev-1", "conns": [11]},
                           token=root_token)
    check(status == 200, "POST /api/devices/disconnect is accepted for an admin")
    status, text, _ = call(base, "POST", "/api/heartbeat", {"id": "test-dev-1", "uuid": "uuid-1", "ver": "150"})
    check(parsed(text).get("disconnect") == [11], "the queued disconnect reaches the device")
    status, text, _ = call(base, "POST", "/api/heartbeat", {"id": "test-dev-1", "uuid": "uuid-1", "ver": "150"})
    check("disconnect" not in parsed(text), "a disconnect is delivered once, not repeatedly")

    # ---------------------------------------------------------- provisioning
    print("\n[5] device provisioning")
    pk = base64.b64encode(bytes(32)).decode()
    status, text, _ = call(base, "POST", "/api/devices/deploy", {"id": "deploy-dev", "uuid": "du", "pk": pk},
                           token=root_token)
    check(parsed(text).get("result") == "OK", "POST /api/devices/deploy -> OK")

    status, text, _ = call(base, "POST", "/api/devices/deploy", {"id": "deploy-dev", "uuid": "other", "pk": pk},
                           token=root_token)
    check(parsed(text).get("result") == "ID_TAKEN", "deploying the same id from another uuid -> ID_TAKEN")

    status, text, _ = call(base, "POST", "/api/devices/deploy", {"id": "bad id!", "uuid": "x", "pk": pk},
                           token=root_token)
    check(parsed(text).get("result") == "INVALID_INPUT", "an unusable device id -> INVALID_INPUT")

    status, text, _ = call(base, "POST", "/api/devices/deploy", {"id": "another", "uuid": "x", "pk": "short"},
                           token=root_token)
    check(parsed(text).get("result") == "INVALID_INPUT", "a public key that is not 32 bytes -> INVALID_INPUT")

    status, text, _ = call(base, "POST", "/api/devices/cli", {
        "id": "cli-dev", "uuid": "cu", "user_name": "alice", "device_group_name": "floor-3",
        "note": "provisioned", "address_book_name": "cli-book", "address_book_alias": "box",
    }, token=root_token)
    check(status == 200 and text == "", "POST /api/devices/cli answers empty text on success")

    status, text, _ = call(base, "POST", "/api/devices/cli", {"id": "x", "uuid": "x", "user_name": "ghost"},
                           token=root_token)
    check(text.strip() != "", "devices/cli reports an unknown user as non-empty text")

    status, text, _ = call(base, "GET", "/api/devices?current=1&pageSize=100", token=root_token)
    devices = {row["id"]: row for row in (parsed(text) or {}).get("data", [])}
    check("cli-dev" in devices and devices["cli-dev"]["user_name"] == "alice",
          "devices/cli assigned the device to alice")
    check(devices.get("cli-dev", {}).get("device_group_name") == "floor-3",
          "devices/cli created and attached the device group")

    now = int(time.time())
    status, text, _ = call(base, "POST", "/api/switch-grant",
                           {"id": "test-dev-1", "switch_code_verifier": "v", "timestamp": str(now - 9999),
                            "signature": "AAAA"})
    grant = parsed(text)
    check(grant.get("accepted") is False and isinstance(grant.get("server_time"), int),
          "a stale switch-grant is rejected with the server clock")
    status, text, _ = call(base, "POST", "/api/switch-grant",
                           {"id": "test-dev-1", "switch_code_verifier": "v",
                            "timestamp": str(grant.get("server_time")), "signature": "AAAA"})
    check(parsed(text).get("accepted") is True, "re-signing with the server clock is accepted")

    # ----------------------------------------------------------------- audit
    print("\n[6] audit")
    for path, payload in (
        ("/api/audit/conn", {"id": "test-dev-1", "uuid": "uuid-1", "conn_id": 5, "session_id": 9,
                             "ip": "10.0.0.9", "action": "new", "nonce": "nonce-1"}),
        ("/api/audit/file", {"id": "test-dev-1", "peer_id": "shared-peer", "conn_id": 5, "type": 0,
                             "path": "/tmp/x", "is_file": True, "info": "{}", "nonce": "nonce-2"}),
        ("/api/audit/alarm", {"id": "test-dev-1", "typ": 1, "info": "{}", "conn_id": 5, "nonce": "nonce-3"}),
    ):
        status, text, _ = call(base, "POST", path, payload)
        check(status == 200 and text == "", f"POST {path} -> 200 with an EMPTY body")

    status, text, _ = call(base, "POST", "/api/audit/conn",
                           {"id": "test-dev-1", "session_id": 9, "nonce": "nonce-1"})
    check(status == 200 and text == "", "a retried audit post is accepted again")

    status, text, _ = call(base, "GET", "/api/audit/conn?current=1&pageSize=100", token=root_token)
    conn_rows = (parsed(text) or {}).get("data") or []
    matching = [row for row in conn_rows if row.get("conn_id") == 5 and row.get("session_id") == 9]
    check(len(matching) == 1, "a repeated nonce did not create a second audit row")

    status, text, _ = call(base, "GET", "/api/audit/conn/active?id=shared-peer&session_id=9&conn_type=0",
                           token=root_token)
    guid = parsed(text)
    check(status == 200 and isinstance(guid, str) and guid, "GET /api/audit/conn/active -> a bare json string")

    status, text, _ = call(base, "PUT", "/api/audit", {"guid": guid, "note": "reviewed"}, token=root_token)
    check(status == 200, "PUT /api/audit -> 200")
    status, text, _ = call(base, "GET", "/api/audit/conn?current=1&pageSize=100", token=root_token)
    noted = [row for row in ((parsed(text) or {}).get("data") or []) if row.get("guid") == guid]
    check(noted and noted[0].get("note") == "reviewed", "the note is visible on the audit record")

    for path in ("/api/audit/file", "/api/audit/alarm"):
        status, text, _ = call(base, "GET", f"{path}?current=1&pageSize=100", token=root_token)
        check(status == 200 and (parsed(text) or {}).get("total", 0) >= 1, f"GET {path} lists its records")

    status, text, _ = call(base, "GET", "/api/audit/conn?current=1&pageSize=100")
    check(status == 403, "the audit query views are administrator-only")

    # --------------------------------------------------------------- records
    print("\n[7] recordings")
    status, text, _ = call(base, "POST", "/api/record?type=new&file=demo.zip", raw=b"")
    answer = parsed(text)
    check(isinstance(answer, dict) and answer.get("error"),
          "an unconfigured record endpoint says so instead of failing silently")

    # ----------------------------------------------------------------- admin
    print("\n[8] admin: users, devices, groups, summary")
    status, text, _ = call(base, "GET", "/api/summary", token=root_token)
    totals = parsed(text)
    check(status == 200 and totals.get("users", 0) >= 2, "GET /api/summary counts accounts")
    check(totals.get("audit_conn", 0) >= 1, "GET /api/summary counts audit records")
    status, _, _ = call(base, "GET", "/api/summary", token=alice_token)
    check(status == 403, "GET /api/summary is administrator-only")

    status, text, _ = call(base, "GET", "/api/users?current=1&pageSize=100", token=root_token)
    users = parsed(text)
    check(status == 200 and users.get("total", 0) >= 2, "GET /api/users lists every account for an admin")
    status, text, _ = call(base, "GET", "/api/users?current=1&pageSize=100&accessible=&status=1", token=alice_token)
    check(status == 200 and parsed(text).get("total", 0) >= 1,
          "the accessible view never errors for a non-admin")

    status, text, _ = call(base, "POST", "/api/users/password", {"name": "alice", "password": "alice-pw"},
                           token=root_token)
    check(status == 200, "POST /api/users/password -> 200")
    status, _, _ = call(base, "POST", "/api/login", {"username": "alice", "password": ""})
    check(status == 401, "a password-protected account no longer accepts an empty password")
    status, text, _ = call(base, "POST", "/api/login", {"username": "alice", "password": "alice-pw"})
    check(status == 200, "the new password works")
    alice_token = (parsed(text) or {}).get("access_token") or alice_token

    status, text, _ = call(base, "POST", "/api/device-group", {"name": "grp", "user_name": "root"},
                           token=root_token)
    check(status == 200, "POST /api/device-group -> 200")
    status, text, _ = call(base, "GET", "/api/device-group?current=1&pageSize=100", token=root_token)
    check(any(row.get("name") == "grp" for row in (parsed(text) or {}).get("data", [])),
          "the device group is listed")
    status, text, _ = call(base, "PUT", "/api/device-group",
                           {"name": "grp", "new_name": "grp-renamed", "user_name": "root"}, token=root_token)
    check(status == 200, "a device group can be renamed")
    status, text, _ = call(base, "DELETE", "/api/device-group", {"names": ["grp-renamed"], "user_name": "root"},
                           token=root_token)
    check(status == 200, "a device group can be deleted")

    status, text, _ = call(base, "GET", "/api/strategies?current=1&pageSize=100", token=root_token)
    check(any(row.get("name") == "night-shift" for row in (parsed(text) or {}).get("data", [])),
          "the policy is listed with its options")
    status, text, _ = call(base, "DELETE", "/api/strategies", ["night-shift"], token=root_token)
    check(status == 200, "a policy can be deleted")

    status, text, _ = call(base, "POST", "/api/users",
                           {"name": "temp", "password": "x", "is_admin": False}, token=root_token)
    check(status == 200, "an admin can create an account")
    status, text, _ = call(base, "DELETE", "/api/users", ["temp"], token=root_token)
    check(status == 200, "an account can be deleted")
    status, text, _ = call(base, "DELETE", "/api/users", ["root"], token=root_token)
    check(bool((parsed(text) or {}).get("error")), "deleting your own account is refused")

    # --------------------------------------------------------------- routing
    print("\n[9] routing")
    status, _, _ = call(base, "GET", "/api/nope")
    check(status == 404, "an unknown path -> 404")
    status, _, _ = call(base, "GET", "/api/currentUser")
    check(status == 405, "a known path with the wrong method -> 405")
    status, text, _ = call(base, "GET", "/health")
    health = parsed(text)
    check(status == 200 and isinstance(health.get("endpoints"), list) and len(health["endpoints"]) > 40,
          "/health lists the full route table")
    check(health.get("schema_version", 0) >= 2, "/health reports the schema revision")

    status, text, _ = call(base, "POST", "/api/logout", {}, token=root_token)
    check(status == 200, "POST /api/logout -> 200")
    status, text, _ = call(base, "POST", "/api/currentUser", {}, token=root_token)
    check(status == 200 and (parsed(text) or {}).get("name") == "anonymous",
          "a revoked token degrades to anonymous rather than 401")

    # Clean up so a rerun starts from the same place.
    call(base, "DELETE", "/api/ab/shared", [book_guid])


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8787")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    print(f"api surface test against {base}")
    run(base)
    print("\n" + "=" * 62)
    if FAILURES:
        print(f"FAILED {len(FAILURES)} of {CHECKS} checks")
        for label in FAILURES:
            print(f"  - {label}")
        return 1
    print(f"PASSED all {CHECKS} api-surface checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
