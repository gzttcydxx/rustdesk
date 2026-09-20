# rustdesk-selfhost-api — Cloudflare Workers + D1

The same API as `../rustdesk_api_server.py`, ported to run on Cloudflare
Workers with **D1** as the store. Same 19 routes, same anonymous-session
behaviour, verified by the same contract suite (`../selftest.py`, 53 checks).

Deploying this way means you don't have to keep a machine running: you get a
`https://…workers.dev` endpoint (a custom domain works too) that the client can
be pointed at directly, and TLS is handled for you.

## Why not just run the Python file on Workers?

Cloudflare's Python Workers run on Pyodide, which has no `sqlite3` module — the
storage layer has to become D1 either way, and the HTTP layer has to become a
`fetch` handler either way. So the port is TypeScript: it is smaller, and D1's
bindings are first-class there.

## Layout

| File | Purpose |
| --- | --- |
| `src/index.ts` | the Worker — routes, handlers, D1 queries |
| `wrangler.toml` | Worker config, D1 binding, `STRICT_AUTH` |
| `schema.sql` | the D1 schema, same tables as the Python store |
| `run-contract-test.sh` | local end-to-end test against a clean D1 |
| `package.json` | convenience scripts |

`schema.sql` is the source of truth: applying it at deploy time is the whole
migration story. The Worker can also bootstrap a database that has never been
initialised (local `wrangler dev`, a brand-new D1), but it probes with a single
`SELECT 1 FROM users LIMIT 1` first — see *Why the first request used to be slow*.

## Local development (no Cloudflare account needed)

```bash
npm install                     # or just use npx wrangler
npx wrangler dev                # http://127.0.0.1:8787
```

`--local` is the default: D1 is emulated on disk under `.wrangler/state`, and
nothing is sent to Cloudflare. Point the client at `http://127.0.0.1:8787` to
try it, or run the contract suite:

```bash
bash run-contract-test.sh
# or against an already-running dev server, with a wiped .wrangler/state:
python ../selftest.py --base-url http://127.0.0.1:8787
```

The suite asserts an empty database, so wipe the state first (the script does).

## Deploy

```bash
npx wrangler login
npx wrangler d1 create rustdesk-selfhost-api
```

Copy the `database_id` it prints into `wrangler.toml`, then:

```bash
npx wrangler d1 execute rustdesk-selfhost-api --remote --file=./schema.sql
npx wrangler deploy
```

The Worker also creates its tables on first use (`CREATE TABLE IF NOT EXISTS`),
so the `d1 execute` step is optional — it just makes the first request quiet.

`wrangler deploy --dry-run` bundles without uploading — useful to sanity-check
the build before authenticating.

### This fork's deployment

| | |
| --- | --- |
| Worker | `rustdesk-selfhost-api` (account `0de1162e…`) |
| URL | `https://rd.gzttc.qzz.io` |
| D1 | `rustdesk-selfhost-api` → `5b60cd2b-85e6-4e07-91d9-4f04f1028f67` (WNAM) |
| Access node | AMS |

### Routing gotcha

`routes` must sit **above** the `[[d1_databases]]` table in `wrangler.toml`. In
TOML a bare key following a table header belongs to that table, so a `routes`
line placed after it is parsed as `d1_databases[0].routes` and wrangler warns
`Unexpected fields found in d1_databases[0] field: "routes"` while silently
registering no route at all.

## Access control

By default the API answers anyone who knows the hostname, so there are two
independent things to turn on.

### A shared secret in the URL (recommended, no client change)

```bash
openssl rand -hex 24                # or any 40+ character random string
npx wrangler secret put ACCESS_TOKEN
```

Every request must then carry the secret as its **first path segment**. Set the
client's API Server to `https://rd.gzttc.qzz.io/<the secret>` and nothing else
changes: the client builds every URL as `<api server>/api/...`, and its API
Server box only checks that the value starts with `http(s)://`
(`flutter/lib/common.dart`), so a path is accepted.

* `GET /health` and `GET|POST /login` stay reachable without the secret, so the
  deployment can be probed and a sign-in link can be opened in a browser.
* Everything else answers `403 forbidden`.
* With `ACCESS_TOKEN` unset (the current state) the API is open.

### Real sign-in (makes the address book yours instead of the shared `anonymous`)

Create the account first; the password is stored as `sha256:<hex>`:

```bash
python -c "import hashlib;print('sha256:'+hashlib.sha256(b'YOUR_PASSWORD').hexdigest())"
npx wrangler d1 execute rustdesk-selfhost-api --remote -y --command \
  "INSERT INTO users (name, display_name, avatar, email, note, is_admin, status, password_hash, created_at) \
   VALUES ('you','you','','','',1,1,'sha256:...', strftime('%s','now')) \
   ON CONFLICT(name) DO UPDATE SET password_hash=excluded.password_hash;"
```

The client's sign-in button now works. It calls `POST /api/oidc/auth`, opens the
returned URL in the browser, and that page is served by this Worker
(`GET|POST /login`). Enter the credentials there and the client collects its
`access_token` from `GET /api/oidc/auth-query`.

Things that matter if you edit this code — all four are easy to get wrong:

* `POST /api/oidc/auth` returns `{code, url}` as the **top-level** body; the Rust
  side deserialises the whole body into `OidcAuthUrl`, it is not wrapped in
  `data`.
* `GET /api/oidc/auth-query` returns `{"body": "<json string>"}`. Before anyone
  signs in, the inner JSON must be exactly
  `{"error":"No authed oidc is found"}` — that string is what the client treats
  as "keep polling".
* The inner `user` object must contain `info`; `UserPayload.info` is not an
  `Option` in `src/hbbs_http/account.rs`.
* A sign-in link is valid for 30 minutes and is deleted the moment it is used.

## Point the client at it

Client → **Settings → Network → API Server**, e.g.
`https://rd.gzttc.qzz.io`. This is stored as the `api-server` option and can
also be seeded with the `--api-server` CLI flag.

Because the endpoint is HTTPS the client needs no extra flags. To use your own
domain, add a route in `wrangler.toml` (above the D1 table, see above):

```toml
routes = [
  { pattern = "rustdesk-api.example.com", custom_domain = true }
]
```

`custom_domain = true` makes Cloudflare create the DNS record and issue the
certificate, so no CNAME has to be added by hand.

## Why the first request used to be slow

`ensureSchema` originally ran all thirteen `CREATE TABLE` / `CREATE INDEX`
statements on the first request of every new isolate. Thirteen serial D1 round
trips put the first response at 1–3s and, when D1 was slow, past the client's
12-second request timeout (`src/common.rs::post_request_`), which surfaced as:

```
Failed to parse response.
reqwest::Error kind: Request, url: "https://…/api/ab/personal", source: TimedOut
```

It now probes with one `SELECT 1 FROM users LIMIT 1` and only falls back to the
DDL when that fails — i.e. for a database that has never been initialised.

## Cloudflare edge gotchas

**Browser integrity check blocks `Python-urllib`.** `selftest.py` sends
`rustdesk-selftest/1.0` because the urllib default is rejected by the zone with

```
HTTP/1.1 403 Forbidden
Content-Type: text/plain
error code: 1010
```

That answer comes from Cloudflare's edge, not from this Worker (`src/index.ts`
contains no User-Agent logic at all) — the request never reaches it. Measured
against `rd.gzttc.qzz.io`:

| User-Agent | Result |
| --- | --- |
| `Python-urllib/3.13` | 403 (`error code: 1010`) |
| `python-requests/2.32.3` | 200 |
| `Dart/3.9 (dart:io)` | 200 |
| `Mozilla/5.0`, `curl/8.0` | 200 |

The Flutter client sends a `Dart/…` agent, so it is unaffected. If you add
another machine client, give it a non-`urllib` agent — or exempt the hostname
from Bot Fight Mode.

**The suite is sensitive to database state.** It asserts an address book starts
at `total=0`, so clear the tables before a run against a deployment:

```bash
npx wrangler d1 execute rustdesk-selfhost-api --remote -y --command \
  "DELETE FROM ab_peers; DELETE FROM ab_tags; DELETE FROM address_books; \
   DELETE FROM devices; DELETE FROM device_groups; DELETE FROM audit_notes; \
   DELETE FROM tokens; DELETE FROM users;"
python ../selftest.py --base-url https://rd.gzttc.qzz.io
```

## Configuration

| Name | Where | Meaning |
| --- | --- | --- |
| `DB` | D1 binding | the database |
| `STRICT_AUTH` | `[vars]` | `"true"` rejects anonymous sessions and unknown logins, like `--strict-auth` on the Python server. Leave it `"false"` — anonymous sessions are what makes the login-free pages work. |
| `ACCESS_TOKEN` | secret | shared secret that must be the first path segment of every request. Unset = open. See *Access control*. |

## Differences from the Python server

Behaviour is identical; only the runtime-specific parts differ.

| | Python | Worker |
| --- | --- | --- |
| Store | `sqlite3` file, `--db` | D1 binding `DB` |
| HTTP | `http.server` | `fetch` handler |
| Strict auth | `--strict-auth` flag | `STRICT_AUTH` var |
| Anonymous account | created at startup | created lazily per request |
| Bound address | `--host`/`--port` | Workers route |
| Access gate | — | `ACCESS_TOKEN` path prefix |
| Sign-in (OIDC) | — | `POST /api/oidc/auth`, `GET /login` |

For the 19 shared routes both implementations accept the same requests and return
byte-identical JSON shapes, which is what the shared contract suite checks
(`../selftest.py`, 53 checks, green on both). The access gate and the sign-in
endpoints are Worker-only.

## Limits worth knowing

* **D1 free tier** has daily read/write quotas. This API is tiny — a few queries
  per page load — but a fleet of clients polling `GET /api/peers` will add up.
* **Workers CPU limits** are irrelevant here: every handler is a handful of
  small SQL queries.
* **Anonymous is shared.** Every client pointed at this Worker *without* signing
  in sees the same address book. See the note in `../README.md`; give each
  client its own Worker (or a named account) if you need isolation.
* A custom domain is strongly recommended over `workers.dev` if the client
  fleet is not all on one machine — `workers.dev` is on public suffix lists and
  has been used for abuse, and some networks block it.
