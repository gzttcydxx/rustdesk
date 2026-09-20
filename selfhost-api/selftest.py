#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Contract self-test for the self-hosted API server.

It replays the exact HTTP call sequence that the RustDesk Flutter client
issues for the two pages this server backs:

  * Address book      (models/ab_model.dart)
  * Accessible devices (models/group_model.dart)

and asserts that every response can be decoded by the client's parsers
(`Peer.fromJson`, `UserPayload.fromJson`, `AbProfile.fromJson`,
`AbTag.fromJson`, `DeviceGroupPayload.fromJson`).

That means: every key the client reads must exist, the top-level json type must
match (object vs array), and pagination must terminate.

The same suite validates both implementations, since the contract is the
contract: by default it starts the Python server in-process, and with
``--base-url`` it tests any already-running server instead — including the
Cloudflare Worker (``wrangler dev``).

The suite assumes an EMPTY database (it asserts an address book starts at
total=0). When testing the Worker locally, wipe ``worker/.wrangler/state``
first, which is what ``worker/run-contract-test.sh`` does. Against a deployed
Worker, clear the D1 tables first:

  npx wrangler d1 execute rustdesk-selfhost-api --remote \\
      --command "DELETE FROM ab_peers; DELETE FROM ab_tags; ..."

Run:  python selftest.py
      python selftest.py --base-url http://127.0.0.1:8787
      python selftest.py --base-url https://rd.gzttc.qzz.io
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import threading
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from rustdesk_api_server import build_server  # noqa: E402

FAILURES: list[str] = []
CHECKS = 0


def check(condition: bool, label: str) -> None:
    global CHECKS
    CHECKS += 1
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}")
        FAILURES.append(label)


def _decode(raw: str):
    """Parse a response body, tolerating a non-json one.

    Both servers always answer with json, but when the suite is pointed at a
    `wrangler dev` port the runtime can answer with a plain-text error page.
    That is not a contract answer: return None so the individual check fails
    with its status code instead of blowing up the whole run.
    """
    if not raw.strip():
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


# urllib's default `Python-urllib/3.x` is rejected by Cloudflare's browser
# integrity check (HTTP 403, "error code: 1010") before the request ever reaches
# a Worker and is proxied. That check is a zone setting, not part of this API,
# so send a plain descriptive agent and keep the contract test about the
# contract. The Flutter client's own `Dart/x (dart:io)` passes it too.
USER_AGENT = "rustdesk-selftest/1.0"

# Against 127.0.0.1 the whole suite finishes in well under a second per call, so
# the value only matters for `--base-url` runs. urllib opens a fresh TLS
# connection per request and a handshake to a distant Cloudflare colo has been
# measured at ~2.5s, so a tight timeout turns ordinary network jitter into a
# spurious read timeout part-way through the suite.
TIMEOUT = 30


def request(base: str, method: str, path: str, body=None, token: str = ""):
    """Mirror the Flutter client's http usage: Content-Type json, Bearer token."""
    data = None
    headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(base + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.status, _decode(resp.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as exc:
        return exc.code, _decode(exc.read().decode("utf-8", "replace"))


# ---- client-side parsers, mirrored from the Dart models ------------------- #

PEER_FROM_JSON_KEYS = {
    "id",
    "hash",
    "password",
    "username",
    "hostname",
    "platform",
    "alias",
    "tags",
    "forceAlwaysRelay",
    "rdpPort",
    "rdpUsername",
    "loginName",
    "device_group_name",
    "note",
    "same_server",
}
USER_PAYLOAD_KEYS = {"name", "display_name", "avatar", "email", "note", "status", "is_admin"}
AB_PROFILE_KEYS = {"guid", "name", "owner", "note", "rule", "info"}


def peer_from_json_ok(payload: dict) -> bool:
    """`Peer.fromJson` reads these keys; `tags` must be a list or it throws."""
    if not isinstance(payload, dict):
        return False
    if not isinstance(payload.get("tags", []), list):
        return False
    return True


def run(base: str) -> None:
    print("\n[1] address book bootstrap (anonymous, no token)")
    status, personal = request(base, "POST", "/api/ab/personal")
    check(status == 200, f"POST /api/ab/personal -> {status}")
    check(
        isinstance(personal, dict) and isinstance(personal.get("guid"), str) and personal["guid"],
        "personal address book guid is a non-empty string",
    )
    guid = personal.get("guid", "")

    status, profiles = request(base, "POST", "/api/ab/shared/profiles?current=1&pageSize=100")
    check(status == 200 and profiles.get("total") == 0, "shared profiles page terminates with total=0")
    check(isinstance(profiles.get("data"), list), "shared profiles data is a list")

    status, settings = request(base, "POST", "/api/ab/settings")
    check(status == 200 and settings.get("max_peer_one_ab") == 0, "ab settings reports no device cap")

    print("\n[2] address book read (empty)")
    status, page = request(base, "POST", f"/api/ab/peers?current=1&pageSize=100&ab={guid}")
    check(status == 200 and page.get("total") == 0, "empty address book page -> total=0")
    check(isinstance(page.get("data"), list), "address book data is a list")

    status, tags = request(base, "POST", f"/api/ab/tags/{guid}")
    check(status == 200 and isinstance(tags, list), "tags endpoint returns a json ARRAY")

    print("\n[3] address book write: add peer (payload shape sent by toCustomJson)")
    peer = {
        "id": "123456789",
        "username": "pc-user",
        "hostname": "DESKTOP-TEST",
        "platform": "Windows",
        "alias": "",
        "tags": [],
        "hash": "deadbeef",
    }
    status, out = request(base, "POST", f"/api/ab/peer/add/{guid}", peer)
    check(status == 200 and out is None, f"peer/add -> {status} null")

    status, page = request(base, "POST", f"/api/ab/peers?current=1&pageSize=100&ab={guid}")
    check(page.get("total") == 1, "address book now has 1 peer")
    stored = (page.get("data") or [{}])[0]
    missing = PEER_FROM_JSON_KEYS - set(stored)
    check(not missing, f"peer json carries every key Peer.fromJson reads (missing: {sorted(missing)})")
    check(peer_from_json_ok(stored), "peer json is parseable by Peer.fromJson")
    check(stored.get("id") == "123456789" and stored.get("hostname") == "DESKTOP-TEST",
          "peer round-trips id/hostname")
    check(stored.get("hash") == "deadbeef", "personal ab keeps the hash password")

    print("\n[4] address book write: alias / note / tags / password")
    for label, patch in (
        ("alias", {"id": "123456789", "alias": "lab-box"}),
        ("note", {"id": "123456789", "note": "third floor"}),
        ("password", {"id": "123456789", "password": "s3cret"}),
    ):
        status, out = request(base, "PUT", f"/api/ab/peer/update/{guid}", patch)
        check(status == 200 and out is None, f"peer/update {label} -> {status} null")

    status, page = request(base, "POST", f"/api/ab/peers?current=1&pageSize=100&ab={guid}")
    stored = (page.get("data") or [{}])[0]
    check(stored.get("alias") == "lab-box", "alias persisted")
    check(stored.get("note") == "third floor", "note persisted")
    check(stored.get("password") == "s3cret", "password persisted")

    status, out = request(
        base, "PUT", f"/api/ab/peer/update/{guid}", {"id": "123456789", "tags": ["lab", "prod"]}
    )
    check(status == 200, "peer/update tags -> 200")
    status, tags = request(base, "POST", f"/api/ab/tags/{guid}")
    for name in ("lab", "prod"):
        status, out = request(base, "POST", f"/api/ab/tag/add/{guid}", {"name": name, "color": 4283215696})
        check(status == 200 and out is None, f"tag/add {name} -> {status} null")

    status, tags = request(base, "POST", f"/api/ab/tags/{guid}")
    names = sorted(t["name"] for t in tags)
    check(names == ["lab", "prod"], f"tags listed back: {names}")
    check(all({"name", "color"} <= set(t) for t in tags), "each tag has name+color")

    status, out = request(base, "PUT", f"/api/ab/tag/rename/{guid}", {"old": "prod", "new": "production"})
    check(status == 200, "tag/rename -> 200")
    status, tags = request(base, "POST", f"/api/ab/tags/{guid}")
    check(sorted(t["name"] for t in tags) == ["lab", "production"], "tag renamed")
    status, page = request(base, "POST", f"/api/ab/peers?current=1&pageSize=100&ab={guid}")
    check("production" in (page["data"][0].get("tags") or []),
          "renaming a tag also renames it on the peers carrying it")

    status, out = request(base, "PUT", f"/api/ab/tag/update/{guid}", {"name": "lab", "color": 12345})
    check(status == 200, "tag/update -> 200")
    status, tags = request(base, "POST", f"/api/ab/tags/{guid}")
    check(any(t["name"] == "lab" and t["color"] == 12345 for t in tags), "tag color updated")

    status, out = request(base, "DELETE", f"/api/ab/tag/{guid}", ["lab"])
    check(status == 200, "tag delete -> 200")
    status, tags = request(base, "POST", f"/api/ab/tags/{guid}")
    check([t["name"] for t in tags] == ["production"], "tag deleted")
    status, page = request(base, "POST", f"/api/ab/peers?current=1&pageSize=100&ab={guid}")
    check("lab" not in (page["data"][0].get("tags") or []), "deleted tag removed from peers")

    print("\n[5] legacy address book endpoints (/api/ab)")
    status, legacy = request(base, "GET", "/api/ab")
    check(status == 200 and "data" in legacy and "licensed_devices" in legacy,
          "GET /api/ab returns the legacy envelope")
    check(isinstance(json.loads(legacy["data"]), dict), "legacy data field is a json-encoded object")
    status, out = request(base, "POST", "/api/ab", {"data": json.dumps({"tags": [], "peers": [], "tag_colors": "{}"})})
    check(status == 200 and out is None, "POST /api/ab (legacy push) -> 200 null")

    print("\n[6] accessible devices")
    status, groups = request(base, "GET", "/api/device-group/accessible?current=1&pageSize=100")
    check(status == 200 and isinstance(groups.get("data"), list), "device groups page is an object+list")
    check(groups.get("total") == len(groups.get("data") or []), "device groups total matches page")

    status, users = request(base, "GET", "/api/users?current=1&pageSize=100&accessible=&status=1")
    check(status == 200 and users.get("total", 0) >= 1, "users page is non-empty (anonymous account)")
    user = (users.get("data") or [{}])[0]
    missing = USER_PAYLOAD_KEYS - set(user)
    check(not missing, f"user json carries every key UserPayload.fromJson reads (missing: {sorted(missing)})")

    status, peers = request(base, "GET", "/api/peers?current=1&pageSize=100&accessible=&status=1")
    check(status == 200 and peers.get("total", 0) >= 1, "peers page is non-empty")
    dev = (peers.get("data") or [{}])[0]
    check(set(dev) >= {"id", "info", "status", "user", "user_name", "device_group_name", "note"},
          "peer payload carries every key PeerPayload.fromJson reads")
    check(dev["info"].get("device_name") == "DESKTOP-TEST", "device info.device_name mapped from hostname")
    check(dev["info"].get("os") == "Windows", "device info.os mapped from platform")

    print("\n[7] address book / device group isolation between accounts")
    status, login = request(base, "POST", "/api/login",
                            {"username": "alice", "password": "pw", "id": "1", "uuid": "u"})
    check(status == 200 and login.get("type") == "access_token" and login.get("access_token"),
          "POST /api/login issues an access_token")
    check(set(login.get("user") or {}) >= USER_PAYLOAD_KEYS, "login returns a full user payload")
    token = login["access_token"]

    status, me = request(base, "POST", "/api/currentUser", {"id": "1", "uuid": "u"}, token=token)
    check(status == 200 and me.get("name") == "alice", "POST /api/currentUser resolves the token")

    status, alice_ab = request(base, "POST", "/api/ab/personal", token=token)
    check(alice_ab.get("guid") != guid, "a signed-in user gets a different address book guid")
    status, page = request(base, "POST", f"/api/ab/peers?current=1&pageSize=100&ab={alice_ab['guid']}",
                           token=token)
    check(page.get("total") == 0, "signed-in user's address book starts empty (no leakage)")

    print("\n[8] failure paths")
    status, out = request(base, "POST", "/api/logout", {"id": "1", "uuid": "u"}, token=token)
    check(status == 200, "POST /api/logout -> 200")
    status, me = request(base, "POST", "/api/currentUser", {"id": "1", "uuid": "u"}, token=token)
    check(status == 200 and me.get("name") == "anonymous",
          "a dropped token degrades to the anonymous session, it does not 401")

    status, out = request(base, "GET", "/api/does-not-exist")
    check(status == 404, "unknown route -> 404")

    status, out = request(base, "GET", "/health")
    check(status == 200 and out.get("server") == "rustdesk-selfhost-api", "GET /health -> 200")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Contract self-test for the RustDesk self-hosted API.")
    parser.add_argument(
        "--base-url",
        default="",
        help="test an already-running server instead of the in-process Python one, "
        "e.g. http://127.0.0.1:8787 for `wrangler dev`",
    )
    args = parser.parse_args(argv)

    if args.base_url:
        base = args.base_url.rstrip("/")
        print(f"testing external server on {base} (database must be empty)")
        run(base)
    else:
        tmp = tempfile.mkdtemp(prefix="rd-api-selftest-")
        db = os.path.join(tmp, "api.db")
        server = build_server("127.0.0.1", 0, db, strict_auth=False, quiet=True)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{port}"
        print(f"server up on {base} (db={db})")
        try:
            run(base)
        finally:
            server.shutdown()
            server.server_close()

    print("\n" + "=" * 62)
    if FAILURES:
        print(f"FAILED {len(FAILURES)}/{CHECKS} checks:")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print(f"PASSED all {CHECKS} contract checks")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
