#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A self-hosted, RustDesk-compatible API server.

It replaces the closed-source "RustDesk Server Pro" HTTP API for the two
features that need one:

  * Address book      (/api/ab, /api/ab/personal, /api/ab/peers, /api/ab/tags,
                       /api/ab/peer/*, /api/ab/tag/*)
  * Accessible devices (/api/device-group/accessible, /api/users, /api/peers)

Design notes
------------
* Zero third-party dependencies: stdlib http.server + sqlite3 only.
* Anonymous sessions are first class. The Flutter client sends
  ``Authorization: Bearer <access_token>``; when the token is empty (user never
  signed in) every request is mapped to a single shared **anonymous** account.
  That is what makes the "no login required" address book / accessible devices
  pages work.
* Login is still supported, so a signed-in client keeps a per-user address
  book. Accounts are auto-created on first login unless the server is started
  with ``--strict-auth``.

Run
---
    python rustdesk_api_server.py --host 0.0.0.0 --port 21114

Then point the client at it (Settings -> Network -> API Server), e.g.
    http://192.168.1.10:21114
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

SERVER_VERSION = "0.1.0"

# The account every request without a usable access token is mapped to.
ANONYMOUS_USER = "anonymous"


# --------------------------------------------------------------------------- #
# storage
# --------------------------------------------------------------------------- #


class Store:
    """Tiny SQLite backed store. One lock, one connection, WAL mode."""

    def __init__(self, path: str) -> None:
        self._path = path
        self._lock = threading.RLock()
        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS users (
                    name          TEXT PRIMARY KEY,
                    display_name  TEXT NOT NULL DEFAULT '',
                    avatar        TEXT NOT NULL DEFAULT '',
                    email         TEXT NOT NULL DEFAULT '',
                    note          TEXT NOT NULL DEFAULT '',
                    is_admin      INTEGER NOT NULL DEFAULT 0,
                    status        INTEGER NOT NULL DEFAULT 1,
                    password_hash TEXT NOT NULL DEFAULT '',
                    created_at    REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS tokens (
                    token      TEXT PRIMARY KEY,
                    user_name  TEXT NOT NULL,
                    created_at REAL NOT NULL
                );

                -- An address book. `kind` is 'personal' or 'shared'.
                CREATE TABLE IF NOT EXISTS address_books (
                    guid       TEXT PRIMARY KEY,
                    user_name  TEXT NOT NULL,
                    name       TEXT NOT NULL,
                    kind       TEXT NOT NULL,
                    owner      TEXT NOT NULL DEFAULT '',
                    rule       INTEGER NOT NULL DEFAULT 3,
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS ab_peers (
                    guid        TEXT NOT NULL,
                    id          TEXT NOT NULL,
                    payload     TEXT NOT NULL,   -- full peer json
                    tags        TEXT NOT NULL DEFAULT '[]',
                    updated_at  REAL NOT NULL,
                    PRIMARY KEY (guid, id)
                );

                CREATE TABLE IF NOT EXISTS ab_tags (
                    guid   TEXT NOT NULL,
                    name   TEXT NOT NULL,
                    color  INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (guid, name)
                );

                -- Accessible devices: device groups owned by a user.
                CREATE TABLE IF NOT EXISTS device_groups (
                    user_name  TEXT NOT NULL,
                    name       TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    PRIMARY KEY (user_name, name)
                );

                -- Devices a user can reach, i.e. what /api/peers returns.
                CREATE TABLE IF NOT EXISTS devices (
                    user_name  TEXT NOT NULL,
                    id         TEXT NOT NULL,
                    payload    TEXT NOT NULL,   -- rustdesk peer_info style json
                    status     INTEGER NOT NULL DEFAULT 1,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY (user_name, id)
                );

                CREATE TABLE IF NOT EXISTS audit_notes (
                    guid       TEXT PRIMARY KEY,
                    note       TEXT NOT NULL DEFAULT '',
                    updated_at REAL NOT NULL
                );
                """
            )
            self._conn.commit()

    # -- users -------------------------------------------------------------- #

    def ensure_user(
        self,
        name: str,
        display_name: str = "",
        password_hash: str = "",
        is_admin: bool = False,
    ) -> dict:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM users WHERE name = ?", (name,)
            ).fetchone()
            if row is None:
                self._conn.execute(
                    "INSERT INTO users"
                    " (name, display_name, avatar, email, note, is_admin,"
                    "  status, password_hash, created_at)"
                    " VALUES (?, ?, '', '', '', ?, 1, ?, ?)",
                    (
                        name,
                        display_name,
                        1 if is_admin else 0,
                        password_hash,
                        time.time(),
                    ),
                )
                self._conn.commit()
                row = self._conn.execute(
                    "SELECT * FROM users WHERE name = ?", (name,)
                ).fetchone()
            return dict(row)

    def get_user(self, name: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM users WHERE name = ?", (name,)
            ).fetchone()
            return dict(row) if row else None

    def list_users(self, limit: int, offset: int) -> tuple[int, list[dict]]:
        with self._lock:
            total = self._conn.execute("SELECT COUNT(*) AS c FROM users").fetchone()[
                "c"
            ]
            rows = self._conn.execute(
                "SELECT * FROM users ORDER BY name LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
            return total, [dict(r) for r in rows]

    # -- tokens ------------------------------------------------------------- #

    def new_token(self, user_name: str) -> str:
        token = uuid.uuid4().hex
        with self._lock:
            self._conn.execute(
                "INSERT INTO tokens (token, user_name, created_at) VALUES (?, ?, ?)",
                (token, user_name, time.time()),
            )
            self._conn.commit()
        return token

    def user_for_token(self, token: str) -> str | None:
        if not token:
            return None
        with self._lock:
            row = self._conn.execute(
                "SELECT user_name FROM tokens WHERE token = ?", (token,)
            ).fetchone()
            return row["user_name"] if row else None

    def drop_token(self, token: str) -> None:
        if not token:
            return
        with self._lock:
            self._conn.execute("DELETE FROM tokens WHERE token = ?", (token,))
            self._conn.commit()

    # -- address books ------------------------------------------------------ #

    def personal_ab(self, user_name: str) -> dict:
        """Return (creating if needed) the personal address book of a user."""
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM address_books WHERE user_name = ? AND kind = 'personal'",
                (user_name,),
            ).fetchone()
            if row is not None:
                return dict(row)
            guid = uuid.uuid4().hex
            self._conn.execute(
                "INSERT INTO address_books"
                " (guid, user_name, name, kind, owner, rule, created_at)"
                " VALUES (?, ?, ?, 'personal', ?, 3, ?)",
                (guid, user_name, "My address book", user_name, time.time()),
            )
            self._conn.commit()
            return {
                "guid": guid,
                "user_name": user_name,
                "name": "My address book",
                "kind": "personal",
                "owner": user_name,
                "rule": 3,
            }

    def ab_by_guid(self, guid: str) -> dict | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM address_books WHERE guid = ?", (guid,)
            ).fetchone()
            return dict(row) if row else None

    def list_shared_ab(self, user_name: str, limit: int, offset: int):
        """Address books shared *with* this user. None are created by default;
        the endpoint exists so the client's paging loop terminates."""
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM address_books WHERE owner = ? AND kind = 'shared'"
                " ORDER BY name LIMIT ? OFFSET ?",
                (user_name, limit, offset),
            ).fetchall()
            total = self._conn.execute(
                "SELECT COUNT(*) AS c FROM address_books WHERE owner = ?"
                " AND kind = 'shared'",
                (user_name,),
            ).fetchone()["c"]
            return total, [dict(r) for r in rows]

    # -- ab peers ----------------------------------------------------------- #

    def list_ab_peers(self, guid: str, limit: int, offset: int):
        with self._lock:
            total = self._conn.execute(
                "SELECT COUNT(*) AS c FROM ab_peers WHERE guid = ?", (guid,)
            ).fetchone()["c"]
            rows = self._conn.execute(
                "SELECT * FROM ab_peers WHERE guid = ? ORDER BY updated_at DESC"
                " LIMIT ? OFFSET ?",
                (guid, limit, offset),
            ).fetchall()
            return total, [dict(r) for r in rows]

    def upsert_ab_peer(self, guid: str, payload: dict) -> None:
        peer_id = str(payload.get("id", ""))
        if not peer_id:
            raise ValueError("peer id is required")
        tags = payload.get("tags") or []
        with self._lock:
            self._conn.execute(
                "INSERT INTO ab_peers (guid, id, payload, tags, updated_at)"
                " VALUES (?, ?, ?, ?, ?)"
                " ON CONFLICT(guid, id) DO UPDATE SET"
                " payload = excluded.payload, tags = excluded.tags,"
                " updated_at = excluded.updated_at",
                (
                    guid,
                    peer_id,
                    json.dumps(payload),
                    json.dumps(tags),
                    time.time(),
                ),
            )
            self._conn.commit()

    def update_ab_peer(self, guid: str, patch: dict) -> bool:
        peer_id = str(patch.get("id", ""))
        if not peer_id:
            return False
        with self._lock:
            row = self._conn.execute(
                "SELECT payload, tags FROM ab_peers WHERE guid = ? AND id = ?",
                (guid, peer_id),
            ).fetchone()
            if row is None:
                return False
            payload = json.loads(row["payload"])
            tags = json.loads(row["tags"])
            # The client uses `tags` for the tag editor and the remaining keys
            # for alias / note / password / device metadata.
            for key, value in patch.items():
                if key == "tags":
                    tags = value if isinstance(value, list) else []
                    payload["tags"] = tags
                elif key != "id":
                    payload[key] = value
            self._conn.execute(
                "UPDATE ab_peers SET payload = ?, tags = ?, updated_at = ?"
                " WHERE guid = ? AND id = ?",
                (json.dumps(payload), json.dumps(tags), time.time(), guid, peer_id),
            )
            self._conn.commit()
            return True

    def delete_ab_peers(self, guid: str, ids: list[str]) -> int:
        with self._lock:
            cur = self._conn.executemany(
                "DELETE FROM ab_peers WHERE guid = ? AND id = ?",
                [(guid, str(i)) for i in ids],
            )
            self._conn.commit()
            return cur.rowcount

    # -- ab tags ------------------------------------------------------------ #

    def list_ab_tags(self, guid: str) -> list[dict]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT name, color FROM ab_tags WHERE guid = ? ORDER BY name",
                (guid,),
            ).fetchall()
            return [dict(r) for r in rows]

    def add_ab_tag(self, guid: str, name: str, color: int) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO ab_tags (guid, name, color) VALUES (?, ?, ?)"
                " ON CONFLICT(guid, name) DO UPDATE SET color = excluded.color",
                (guid, name, int(color or 0)),
            )
            self._conn.commit()

    def rename_ab_tag(self, guid: str, old: str, new: str) -> None:
        with self._lock:
            row = self._conn.execute(
                "SELECT color FROM ab_tags WHERE guid = ? AND name = ?",
                (guid, old),
            ).fetchone()
            color = row["color"] if row else 0
            self._conn.execute(
                "DELETE FROM ab_tags WHERE guid = ? AND name = ?", (guid, old)
            )
            self._conn.execute(
                "INSERT INTO ab_tags (guid, name, color) VALUES (?, ?, ?)"
                " ON CONFLICT(guid, name) DO UPDATE SET color = excluded.color",
                (guid, new, color),
            )
            peers = self._conn.execute(
                "SELECT id, payload, tags FROM ab_peers WHERE guid = ?", (guid,)
            ).fetchall()
            for peer in peers:
                tags = json.loads(peer["tags"])
                if old in tags:
                    tags = [new if t == old else t for t in tags]
                    self._conn.execute(
                        "UPDATE ab_peers SET tags = ? WHERE guid = ? AND id = ?",
                        (json.dumps(tags), guid, peer["id"]),
                    )
            self._conn.commit()

    def delete_ab_tags(self, guid: str, names: list[str]) -> None:
        with self._lock:
            for name in names:
                self._conn.execute(
                    "DELETE FROM ab_tags WHERE guid = ? AND name = ?", (guid, name)
                )
                peers = self._conn.execute(
                    "SELECT id, tags FROM ab_peers WHERE guid = ?", (guid,)
                ).fetchall()
                for peer in peers:
                    tags = json.loads(peer["tags"])
                    if name in tags:
                        tags = [t for t in tags if t != name]
                        self._conn.execute(
                            "UPDATE ab_peers SET tags = ? WHERE guid = ? AND id = ?",
                            (json.dumps(tags), guid, peer["id"]),
                        )
            self._conn.commit()

    # -- accessible devices ------------------------------------------------- #

    def ensure_device_group(self, user_name: str, name: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT OR IGNORE INTO device_groups (user_name, name, created_at)"
                " VALUES (?, ?, ?)",
                (user_name, name, time.time()),
            )
            self._conn.commit()

    def list_device_groups(self, user_name: str, limit: int, offset: int):
        with self._lock:
            total = self._conn.execute(
                "SELECT COUNT(*) AS c FROM device_groups WHERE user_name = ?",
                (user_name,),
            ).fetchone()["c"]
            rows = self._conn.execute(
                "SELECT name FROM device_groups WHERE user_name = ?"
                " ORDER BY name LIMIT ? OFFSET ?",
                (user_name, limit, offset),
            ).fetchall()
            return total, [dict(r) for r in rows]

    def upsert_device(self, user_name: str, device: dict) -> None:
        """Insert or merge a reachable device.

        Merging matters: the client also calls this with partial payloads (a
        bare ``{"id": ..., "alias": ...}`` on every address-book edit), and an
        empty incoming field must never erase what is already stored.
        """
        device_id = str(device.get("id", ""))
        if not device_id:
            raise ValueError("device id is required")
        with self._lock:
            row = self._conn.execute(
                "SELECT payload FROM devices WHERE user_name = ? AND id = ?",
                (user_name, device_id),
            ).fetchone()
            merged = json.loads(row["payload"]) if row else {}
            for key, value in device.items():
                if key == "info" and isinstance(value, dict):
                    info = dict(merged.get("info") or {})
                    info.update({k: v for k, v in value.items() if v not in ("", None)})
                    merged["info"] = info
                elif value not in ("", None, []):
                    merged[key] = value
                elif key not in merged:
                    merged[key] = value
            merged["id"] = device_id
            self._conn.execute(
                "INSERT INTO devices (user_name, id, payload, status, updated_at)"
                " VALUES (?, ?, ?, ?, ?)"
                " ON CONFLICT(user_name, id) DO UPDATE SET"
                " payload = excluded.payload, status = excluded.status,"
                " updated_at = excluded.updated_at",
                (
                    user_name,
                    device_id,
                    json.dumps(merged),
                    int(device.get("status", merged.get("status", 1)) or 1),
                    time.time(),
                ),
            )
            self._conn.commit()

    def list_devices(self, user_name: str, limit: int, offset: int):
        with self._lock:
            total = self._conn.execute(
                "SELECT COUNT(*) AS c FROM devices WHERE user_name = ?",
                (user_name,),
            ).fetchone()["c"]
            rows = self._conn.execute(
                "SELECT payload FROM devices WHERE user_name = ?"
                " ORDER BY updated_at DESC LIMIT ? OFFSET ?",
                (user_name, limit, offset),
            ).fetchall()
            return total, [json.loads(r["payload"]) for r in rows]

    # -- audit notes -------------------------------------------------------- #

    def set_audit_note(self, guid: str, note: str) -> None:
        with self._lock:
            self._conn.execute(
                "INSERT INTO audit_notes (guid, note, updated_at) VALUES (?, ?, ?)"
                " ON CONFLICT(guid) DO UPDATE SET note = excluded.note,"
                " updated_at = excluded.updated_at",
                (guid, note, time.time()),
            )
            self._conn.commit()


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #


def page_params(query: dict) -> tuple[int, int]:
    def as_int(key: str, default: int) -> int:
        try:
            value = int(query.get(key, [default])[0])
        except (TypeError, ValueError):
            return default
        return value if value > 0 else default

    page_size = as_int("pageSize", 100)
    current = as_int("current", 1)
    return page_size, (current - 1) * page_size


def user_payload(row: dict) -> dict:
    """Shape /api/currentUser and /api/users must return (UserPayload)."""
    return {
        "name": row.get("name", ""),
        "display_name": row.get("display_name", ""),
        "avatar": row.get("avatar", ""),
        "email": row.get("email", ""),
        "note": row.get("note", ""),
        "status": row.get("status", 1),
        "is_admin": bool(row.get("is_admin", 0)),
    }


def ab_profile_payload(row: dict) -> dict:
    return {
        "guid": row.get("guid", ""),
        "name": row.get("name", ""),
        "owner": row.get("owner", ""),
        "note": None,
        "rule": row.get("rule", 0),
        "info": None,
    }


def peer_row_payload(row: dict) -> dict:
    """Shape a stored ab peer for `Peer.fromJson`."""
    payload = json.loads(row["payload"])
    out = {
        "id": payload.get("id", row.get("id", "")),
        "hash": payload.get("hash", ""),
        "password": payload.get("password", ""),
        "username": payload.get("username", ""),
        "hostname": payload.get("hostname", ""),
        "platform": payload.get("platform", ""),
        "alias": payload.get("alias", ""),
        "tags": json.loads(row["tags"]) if row.get("tags") else [],
        "forceAlwaysRelay": str(payload.get("forceAlwaysRelay", "false")),
        "rdpPort": payload.get("rdpPort", ""),
        "rdpUsername": payload.get("rdpUsername", ""),
        "loginName": payload.get("loginName", ""),
        "device_group_name": payload.get("device_group_name", ""),
        "note": payload.get("note", ""),
        "same_server": None,
    }
    return out


# --------------------------------------------------------------------------- #
# http layer
# --------------------------------------------------------------------------- #


class ApiHandler(BaseHTTPRequestHandler):
    server_version = f"RustDeskSelfHostApi/{SERVER_VERSION}"
    protocol_version = "HTTP/1.1"

    store: Store  # injected on the server instance; see `store` property
    strict_auth = False

    # -- plumbing ----------------------------------------------------------- #

    @property
    def store(self) -> Store:  # type: ignore[override]
        return self.server.store  # type: ignore[attr-defined]

    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        quiet = getattr(self.server, "quiet", False)  # type: ignore[attr-defined]
        if not quiet:
            sys.stderr.write(
                "%s - %s\n" % (self.address_string(), fmt % args)
            )

    def _read_body(self) -> bytes:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        return self.rfile.read(length) if length > 0 else b""

    def _json_body(self):
        raw = self._read_body()
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _send(self, status: int, payload, raw: bool = False) -> None:
        if raw:
            body = payload
        elif payload is None:
            body = b"null"
        else:
            body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _error(self, status: int, message: str) -> None:
        self._send(status, {"error": message})

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._send(204, None)

    # -- identity ----------------------------------------------------------- #

    def _token(self) -> str:
        header = self.headers.get("Authorization") or ""
        if header.lower().startswith("bearer "):
            return header[7:].strip()
        return ""

    def _current_user(self) -> dict | None:
        """Resolve the caller.

        An empty or unknown token is NOT an error: it maps to the shared
        anonymous account, which is what lets the address book and accessible
        devices pages work without signing in.
        """
        token = self._token()
        if token:
            name = self.store.user_for_token(token)
            if name:
                row = self.store.get_user(name)
                if row:
                    return row
            if self.strict_auth:
                return None
        return self.store.ensure_user(ANONYMOUS_USER, "Anonymous")

    # -- routing ------------------------------------------------------------ #

    def do_GET(self) -> None:  # noqa: N802
        self._dispatch("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._dispatch("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._dispatch("PUT")

    def do_DELETE(self) -> None:  # noqa: N802
        self._dispatch("DELETE")

    def _dispatch(self, method: str) -> None:
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/") or "/"
        query = parse_qs(parsed.query)
        segments = [unquote(s) for s in path.split("/") if s]

        try:
            handler = self._resolve(method, segments)
            if handler is None:
                self._error(404, f"not found: {method} {path}")
                return
            handler(query, segments)
        except Exception as exc:  # noqa: BLE001 - never take the server down
            if not getattr(self.server, "quiet", False):  # type: ignore[attr-defined]
                import traceback

                traceback.print_exc()
            self._error(500, str(exc))

    def _resolve(self, method: str, segments: list[str]):
        if segments[:1] != ["api"]:
            # Unauthenticated health probes for the operator.
            if segments in ([], ["health"]) and method == "GET":
                return self._health
            return None

        route = tuple(segments[1:])

        simple = {
            ("POST", ("login",)): self._login,
            ("POST", ("currentUser",)): self._current_user_endpoint,
            ("POST", ("logout",)): self._logout,
            ("GET", ("login-options",)): self._login_options,
            ("PUT", ("audit",)): self._audit,
            ("POST", ("ab", "personal")): self._ab_personal,
            ("POST", ("ab", "shared", "profiles")): self._ab_shared_profiles,
            ("POST", ("ab", "settings")): self._ab_settings,
            ("GET", ("ab",)): self._ab_legacy_pull,
            ("POST", ("ab",)): self._ab_legacy_push,
            ("POST", ("ab", "peers")): self._ab_peers,
            ("GET", ("device-group", "accessible")): self._device_groups,
            ("GET", ("users",)): self._users,
            ("GET", ("peers",)): self._peers,
            ("GET", ("devices",)): self._peers,
        }

        # Routes whose trailing segment is the address book guid:
        #   /api/ab/peers/<guid>        (also served as /api/ab/peers?ab=<guid>)
        #   /api/ab/tags/<guid>
        #   /api/ab/peer/{add,update}/<guid>, /api/ab/peer/<guid>
        #   /api/ab/tag/{add,rename,update}/<guid>, /api/ab/tag/<guid>
        if len(route) >= 3 and route[0] == "ab":
            guid = route[-1]
            head = route[1:-1]
            with_guid = {
                ("peers",): self._ab_peers,
                ("tags",): self._ab_tags_list,
                ("peer", "add"): self._ab_peer_add,
                ("peer", "update"): self._ab_peer_update,
                ("peer",): self._ab_peer_delete,
                ("tag", "add"): self._ab_tag_add,
                ("tag", "rename"): self._ab_tag_rename,
                ("tag", "update"): self._ab_tag_update,
                ("tag",): self._ab_tag_delete,
            }
            target = with_guid.get(head)
            if target is not None:
                return lambda q, s, _fn=target, _g=guid: _fn(q, _g)

        return simple.get((method, route))

    # -- endpoints: identity ------------------------------------------------ #

    def _health(self, _query, _segments) -> None:
        self._send(
            200,
            {
                "server": "rustdesk-selfhost-api",
                "version": SERVER_VERSION,
                "anonymous_user": ANONYMOUS_USER,
                "strict_auth": self.strict_auth,
            },
        )

    def _login(self, _query, _segments) -> None:
        body = self._json_body() or {}
        username = (body.get("username") or "").strip()
        password = body.get("password") or ""
        if not username:
            # The client can send an empty body while probing; treat that as the
            # anonymous account instead of failing the request.
            self._send(
                200,
                {
                    "type": "access_token",
                    "access_token": "",
                    "user": user_payload(self.store.ensure_user(ANONYMOUS_USER, "Anonymous")),
                },
            )
            return

        row = self.store.get_user(username)
        if row is None:
            if self.strict_auth:
                self._error(401, "Invalid username or password")
                return
            row = self.store.ensure_user(username, username)
        elif row.get("password_hash") and row["password_hash"] != password:
            self._error(401, "Invalid username or password")
            return

        token = self.store.new_token(username)
        self._send(
            200,
            {"type": "access_token", "access_token": token, "user": user_payload(row)},
        )

    def _current_user_endpoint(self, _query, _segments) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        self._send(200, user_payload(user))

    def _logout(self, _query, _segments) -> None:
        self.store.drop_token(self._token())
        self._send(200, None)

    def _login_options(self, _query, _segments) -> None:
        self._send(200, [])

    def _audit(self, _query, _segments) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        body = self._json_body() or {}
        guid = str(body.get("guid") or "")
        if not guid:
            self._error(400, "guid is required")
            return
        self.store.set_audit_note(guid, str(body.get("note") or ""))
        self._send(200, None)

    # -- endpoints: address book ------------------------------------------- #

    def _ab_personal(self, _query, _segments) -> None:
        if not self._current_user():
            self._error(401, "Session expired")
            return
        user = self._current_user()
        ab = self.store.personal_ab(user["name"])
        self._send(200, {"guid": ab["guid"]})

    def _ab_shared_profiles(self, query, _segments) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        page_size, offset = page_params(query)
        total, rows = self.store.list_shared_ab(user["name"], page_size, offset)
        self._send(
            200,
            {"total": total, "data": [ab_profile_payload(r) for r in rows]},
        )

    def _ab_settings(self, _query, _segments) -> None:
        if not self._current_user():
            self._error(401, "Session expired")
            return
        # 0 == no per-address-book device limit.
        self._send(200, {"max_peer_one_ab": 0})

    def _ab_legacy_pull(self, _query, _segments) -> None:
        """`GET /api/ab` — the pre-shared-address-book endpoint.

        Still served so an old client (or a client that downgraded to legacy
        mode) keeps working: the personal address book is serialised into the
        single `data` string field the legacy format expects.
        """
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        ab = self.store.personal_ab(user["name"])
        _, peer_rows = self.store.list_ab_peers(ab["guid"], 10_000, 0)
        tags = self.store.list_ab_tags(ab["guid"])
        data = {
            "tags": [t["name"] for t in tags],
            "peers": [json.loads(r["payload"]) for r in peer_rows],
            "tag_colors": json.dumps({t["name"]: t["color"] for t in tags}),
        }
        self._send(
            200, {"licensed_devices": 0, "data": json.dumps(data)}
        )

    def _ab_legacy_push(self, _query, _segments) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        body = self._json_body() or {}
        raw = body.get("data")
        if isinstance(raw, str) and raw:
            try:
                data = json.loads(raw)
            except json.JSONDecodeError:
                self._error(400, "invalid data")
                return
            ab = self.store.personal_ab(user["name"])
            for tag in data.get("tags") or []:
                color = 0
                try:
                    colors = json.loads(data.get("tag_colors") or "{}")
                    color = colors.get(tag, 0)
                except (json.JSONDecodeError, AttributeError):
                    pass
                self.store.add_ab_tag(ab["guid"], str(tag), color)
            for peer in data.get("peers") or []:
                self.store.upsert_ab_peer(ab["guid"], peer)
        self._send(200, None)

    def _resolve_ab_guid(self, user: dict, guid: str) -> str:
        """Fall back to the caller's personal address book when the guid is
        missing or unknown, so the page never dead-ends."""
        if guid:
            ab = self.store.ab_by_guid(guid)
            if ab is not None and ab["user_name"] == user["name"]:
                return guid
        return self.store.personal_ab(user["name"])["guid"]

    def _ab_peers(self, query, _segments) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        guid = self._resolve_ab_guid(user, (query.get("ab") or [""])[0])
        page_size, offset = page_params(query)
        total, rows = self.store.list_ab_peers(guid, page_size, offset)
        self._send(200, {"total": total, "data": [peer_row_payload(r) for r in rows]})

    def _ab_peer_add(self, _query, guid: str) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        body = self._json_body()
        if not isinstance(body, dict):
            self._error(400, "invalid body")
            return
        target = self._resolve_ab_guid(user, guid)
        try:
            self.store.upsert_ab_peer(target, body)
        except ValueError as exc:
            self._error(400, str(exc))
            return
        # Adding a peer implicitly registers it as reachable, which is what
        # makes it show up under "Accessible devices".
        self._register_device(user, body)
        self._send(200, None)

    def _ab_peer_update(self, _query, guid: str) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        body = self._json_body()
        if not isinstance(body, dict):
            self._error(400, "invalid body")
            return
        target = self._resolve_ab_guid(user, guid)
        if not self.store.update_ab_peer(target, body):
            # The client pushes password/sync patches for peers it considers
            # known. Upsert instead of failing so sync never errors out.
            self.store.upsert_ab_peer(target, body)
        self._register_device(user, body)
        self._send(200, None)

    def _ab_peer_delete(self, _query, guid: str) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        body = self._json_body()
        ids = body if isinstance(body, list) else []
        target = self._resolve_ab_guid(user, guid)
        self.store.delete_ab_peers(target, [str(i) for i in ids])
        self._send(200, None)

    def _ab_tags_list(self, _query, guid: str) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        target = self._resolve_ab_guid(user, guid)
        self._send(200, self.store.list_ab_tags(target))

    def _ab_tag_add(self, _query, guid: str) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        body = self._json_body() or {}
        target = self._resolve_ab_guid(user, guid)
        self.store.add_ab_tag(
            target, str(body.get("name") or ""), int(body.get("color") or 0)
        )
        self._send(200, None)

    def _ab_tag_rename(self, _query, guid: str) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        body = self._json_body() or {}
        target = self._resolve_ab_guid(user, guid)
        self.store.rename_ab_tag(
            target, str(body.get("old") or ""), str(body.get("new") or "")
        )
        self._send(200, None)

    def _ab_tag_update(self, _query, guid: str) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        body = self._json_body() or {}
        target = self._resolve_ab_guid(user, guid)
        self.store.add_ab_tag(
            target, str(body.get("name") or ""), int(body.get("color") or 0)
        )
        self._send(200, None)

    def _ab_tag_delete(self, _query, guid: str) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        body = self._json_body()
        names = body if isinstance(body, list) else []
        target = self._resolve_ab_guid(user, guid)
        self.store.delete_ab_tags(target, [str(n) for n in names])
        self._send(200, None)

    # -- endpoints: accessible devices -------------------------------------- #

    def _register_device(self, user: dict, peer: dict) -> None:
        """Keep /api/peers in sync with whatever entered the address book."""
        peer_id = str(peer.get("id") or "")
        if not peer_id:
            return
        self.store.upsert_device(
            user["name"],
            {
                "id": peer_id,
                "info": {
                    "username": peer.get("username", ""),
                    "os": peer.get("platform", ""),
                    "device_name": peer.get("hostname", ""),
                },
                "status": 1,
                "user": user["name"],
                "user_name": peer.get("loginName", "") or user["name"],
                "device_group_name": peer.get("device_group_name", "") or "",
                "note": peer.get("note", ""),
            },
        )

    def _device_groups(self, query, _segments) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        page_size, offset = page_params(query)
        total, rows = self.store.list_device_groups(user["name"], page_size, offset)
        self._send(200, {"total": total, "data": rows})

    def _users(self, query, _segments) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        page_size, offset = page_params(query)
        total, rows = self.store.list_users(page_size, offset)
        self._send(200, {"total": total, "data": [user_payload(r) for r in rows]})

    def _peers(self, query, _segments) -> None:
        user = self._current_user()
        if user is None:
            self._error(401, "Session expired")
            return
        page_size, offset = page_params(query)
        total, payloads = self.store.list_devices(user["name"], page_size, offset)
        data = []
        for payload in payloads:
            info = payload.get("info") or {}
            data.append(
                {
                    "id": payload.get("id", ""),
                    "info": {
                        "username": info.get("username", ""),
                        "os": info.get("os", ""),
                        "device_name": info.get("device_name", ""),
                    },
                    "status": payload.get("status", 1),
                    "user": payload.get("user", ""),
                    "user_name": payload.get("user_name", ""),
                    "device_group_name": payload.get("device_group_name", ""),
                    "note": payload.get("note", ""),
                }
            )
        self._send(200, {"total": total, "data": data})


# --------------------------------------------------------------------------- #
# entrypoint
# --------------------------------------------------------------------------- #


class ApiServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, store: Store, quiet: bool = False) -> None:
        super().__init__(addr, handler)
        self.store = store
        self.quiet = quiet


def build_server(host: str, port: int, db: str, strict_auth: bool, quiet: bool):
    store = Store(db)
    store.ensure_user(ANONYMOUS_USER, "Anonymous")
    handler = type(
        "BoundApiHandler",
        (ApiHandler,),
        {"strict_auth": strict_auth},
    )
    return ApiServer((host, port), handler, store, quiet)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Self-hosted RustDesk-compatible API server "
        "(address book + accessible devices)."
    )
    parser.add_argument("--host", default="127.0.0.1", help="bind address")
    parser.add_argument("--port", type=int, default=21114, help="bind port")
    parser.add_argument(
        "--db",
        default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "api.db"),
        help="sqlite database path",
    )
    parser.add_argument(
        "--strict-auth",
        action="store_true",
        help="reject anonymous sessions and unknown logins (default: off)",
    )
    parser.add_argument("--quiet", action="store_true", help="disable access logs")
    args = parser.parse_args(argv)

    server = build_server(args.host, args.port, args.db, args.strict_auth, args.quiet)
    mode = "strict" if args.strict_auth else "anonymous-allowed"
    print(
        f"rustdesk-selfhost-api {SERVER_VERSION} listening on "
        f"http://{args.host}:{args.port}  (auth: {mode})",
        flush=True,
    )
    print(f"database: {os.path.abspath(args.db)}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
