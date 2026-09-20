# rustdesk-selfhost-api

A self-hosted replacement for the closed-source **RustDesk Server Pro** HTTP API,
covering exactly the two features that need a server:

| Client page | Source in the client |
| --- | --- |
| **Address book** | `flutter/lib/common/widgets/address_book.dart` + `flutter/lib/models/ab_model.dart` |
| **Accessible devices** | `flutter/lib/common/widgets/my_group.dart` + `flutter/lib/models/group_model.dart` |

It is **not** a rendezvous/relay server. Keep running the open-source
`hbbs`/`hbbr` for ID registration and relaying; this service only serves the
`/api/*` surface those two pages call.

Two implementations of the same API live here, sharing one contract test suite:

| Implementation | Runtime | Store |
| --- | --- | --- |
| [`rustdesk_api_server.py`](rustdesk_api_server.py) | Python 3.9+ stdlib | SQLite file |
| [`worker/`](worker/) | Cloudflare Workers | D1 |

## Why it exists

The two pages above are the only parts of the client that talk to an account API.
Pointing the client at this server makes them work **without signing in**: any
request without a usable access token is mapped to a shared `anonymous` account,
so the pages render and are fully writable instead of showing a login button.

## Requirements

Python 3.9+ — standard library only, no `pip install` needed.

## Run

```bash
python rustdesk_api_server.py --host 0.0.0.0 --port 21114
```

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--host` | `127.0.0.1` | bind address (`0.0.0.0` to expose on the LAN) |
| `--port` | `21114` | bind port |
| `--db` | `./data/api.db` | SQLite file (created on first run) |
| `--strict-auth` | off | reject anonymous sessions and unknown logins |
| `--quiet` | off | disable access logging |

`GET /health` returns a small JSON status document.

## Deploy on Cloudflare Workers (optional)

If you would rather not keep a machine running, the same API is available as a
Worker with D1 as the store. It needs no server: you get an HTTPS endpoint the
client can be pointed at directly.

```bash
cd worker
npx wrangler login
npx wrangler d1 create rustdesk-selfhost-api   # paste the id into wrangler.toml
npx wrangler d1 execute rustdesk-selfhost-api --remote --file=./schema.sql
npx wrangler secret put ACCESS_TOKEN           # optional, recommended
npx wrangler deploy
```

`schema.sql` is the migration step. The Worker can bootstrap a database that was
never initialised, but it probes first instead of running DDL on every cold
start. To try it locally with no Cloudflare account at all:

```bash
npx wrangler dev                     # http://127.0.0.1:8787
bash run-contract-test.sh            # same 53 checks, against a clean D1
bash test-access-control.sh          # secret gate + sign-in flow, 15 checks
```

Why the Worker is TypeScript and not the Python file running as-is: Cloudflare's
Python Workers run on Pyodide, which has no `sqlite3`, so the storage layer has
to become D1 regardless — and D1 bindings are first-class in TypeScript.
See [`worker/README.md`](worker/README.md) for the full notes and limits.

## Point the client at it

Client → **Settings → Network → API Server**, e.g. `http://192.168.1.10:21114`
(the value is stored in the `api-server` option and read by
`bind.mainGetApiServer()`).

## Accounts

* **Anonymous (default).** No token → the shared `anonymous` account. This is
  what makes the two pages work with no login.
* **Named accounts.** `POST /api/login` with `{"username": ..., "password": ...}`
  auto-creates the account on first use unless `--strict-auth` is set, and
  returns an `access_token`. Each account gets its own address book and device
  list, so a signed-in client behaves exactly as before.
* An invalid/expired token degrades to the anonymous session rather than
  returning 401, so the client never bounces the user to a login prompt.

### Signing in as a real account (Worker only)

The Worker implements the client's OIDC-style sign-in, so a password-protected
account can be created and the client can log in normally:

```bash
python -c "import hashlib;print('sha256:'+hashlib.sha256(b'YOUR_PASSWORD').hexdigest())"
npx wrangler d1 execute rustdesk-selfhost-api --remote -y --command \
  "INSERT INTO users (name, display_name, avatar, email, note, is_admin, status, password_hash, created_at) \
   VALUES ('you','you','','','',1,1,'sha256:...', strftime('%s','now')) \
   ON CONFLICT(name) DO UPDATE SET password_hash=excluded.password_hash;"
```

`POST /api/oidc/auth` hands the client a URL, the browser opens it, the Worker
serves the form at `/login`, and the client collects its token from
`GET /api/oidc/auth-query`. Passwords are stored as `sha256:<hex>`; a bare value
is still compared literally, so older databases keep working.

There is also an optional gate: with `ACCESS_TOKEN` set, **every** request must
carry that secret as its first path segment, so the client's API Server becomes
`https://host/<secret>`. `/health` and `/login` stay reachable without it. See
[`worker/README.md`](worker/README.md) → *Access control*.

## API implemented

### Identity

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/login` | → `{type:"access_token", access_token, user}` |
| POST | `/api/currentUser` | Bearer token → user payload |
| POST | `/api/logout` | drops the token |
| GET | `/api/login-options` | → `[]`; only the client's TLS probe reads it |
| POST | `/api/oidc/auth` | Worker only — starts a browser sign-in, → `{code, url}` |
| GET | `/api/oidc/auth-query` | Worker only — polls a sign-in, → `{"body": "<json>"}` |
| PUT | `/api/audit` | `{guid, note}` — connection-end note |

### Address book

| Method | Path | Notes |
| --- | --- | --- |
| POST | `/api/ab/personal` | → `{"guid": ...}`, created on demand |
| POST | `/api/ab/shared/profiles?current&pageSize` | shared-with-me list (empty by default) |
| POST | `/api/ab/settings` | → `{"max_peer_one_ab": 0}` (no cap) |
| GET | `/api/ab` | legacy pull, `{licensed_devices, data}` |
| POST | `/api/ab` | legacy push |
| POST | `/api/ab/peers?current&pageSize&ab=<guid>` | paged peers |
| POST | `/api/ab/tags/<guid>` | → JSON **array** of `{name,color}` |
| POST | `/api/ab/peer/add/<guid>` | body = peer json |
| PUT | `/api/ab/peer/update/<guid>` | `{id, alias\|note\|tags\|hash\|password\|...}` |
| DELETE | `/api/ab/peer/<guid>` | body = `["id", ...]` |
| POST | `/api/ab/tag/add/<guid>` | `{name,color}` |
| PUT | `/api/ab/tag/rename/<guid>` | `{old,new}` (also rewrites peer tags) |
| PUT | `/api/ab/tag/update/<guid>` | `{name,color}` |
| DELETE | `/api/ab/tag/<guid>` | body = `["tag", ...]` |

### Accessible devices

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/device-group/accessible?current&pageSize` | → `{total, data:[{name}]}` |
| GET | `/api/users?current&pageSize&accessible&status` | → `{total, data:[user]}` |
| GET | `/api/peers?current&pageSize&accessible&status` | → `{total, data:[peer]}` |

`/api/peers` is kept in sync automatically: any device added to the address book
(via `/api/ab/peer/add`, or an edit that references a new id) is registered as a
reachable device, which is what the *Accessible devices* page lists.

## Test

```bash
python selftest.py                                    # the Python server
python selftest.py --base-url http://127.0.0.1:8787   # any running server (wrangler dev)
```

Starts the server in-process on an ephemeral port, replays the exact call
sequence the Flutter models issue, and asserts every response is decodable by
the client's parsers (`Peer.fromJson`, `UserPayload.fromJson`,
`AbProfile.fromJson`, `AbTag.fromJson`, `DeviceGroupPayload.fromJson`), that
pagination terminates, and that accounts don't leak data into each other.
Currently 53 checks.

The same suite is the contract between the two implementations: both the Python
server and the Worker pass all 53. It expects an empty database, so clear the
tables before pointing it at a live deployment.

`worker/test-access-control.sh` covers what the shared suite cannot — the
`ACCESS_TOKEN` gate and the sign-in handshake (15 checks, local only, no
Cloudflare account needed).

## Limitations

* `shared/profiles` always returns an empty list — there is no sharing/ACL model
  (the client tolerates it, the address-book dropdown just shows the personal
  book).
* `/api/audit` stores notes locally; nothing surfaces them back to the client.
* Single-file SQLite store, one process. Fine for a self-hosted deployment; not
  a clustered service.
* Device liveness (`status`) is not probed — devices added to the address book
  report `status: 1`. The client's own rendezvous connection determines whether
  a peer is actually reachable.
