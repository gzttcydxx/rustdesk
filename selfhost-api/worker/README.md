# rustdesk-selfhost-api — Cloudflare Workers + D1

A self-hosted, **RustDesk Server Pro compatible** `/api/*` backend for Cloudflare
Workers, with **D1** as the store. It answers everything the official Flutter /
Rust client actually calls, so a fork with the login gate removed *or* a client
that signs in normally is fully functional against a server you own.

**76 routes**, covering:

| Area | Endpoints |
| --- | --- |
| Identity | `/api/login`, `/api/logout`, `/api/currentUser`, `/api/login-options`, `/api/oidc/auth`, `/api/oidc/auth-query`, `GET|POST /login`, `GET|POST /register` |
| Address book | all 29 `/api/ab*` — personal, settings, shared books, peers, tags, share rules, plus the three legacy whole-document shapes (`GET\|POST /api/ab`, `POST /api/ab/get`) |
| Devices | `/api/device-group/accessible`, `/api/users`, `/api/peers`, `/api/sysinfo`, `/api/sysinfo_ver`, `/api/heartbeat`, `/api/devices/cli`, `/api/devices/deploy`, `/api/devices/disconnect`, `/api/switch-grant` |
| Audit | `/api/audit/conn`, `/api/audit/file`, `/api/audit/alarm`, `/api/audit/conn/active`, `PUT|POST /api/audit` |
| Recordings | `/api/record` |
| Admin | accounts (`/api/users`), devices, device groups, policies (`/api/strategies`), audit queries, `/api/summary`, `/api/online` |

Verified by two live suites against a local D1 — `../selftest.py` (53 client-page
checks) and `api_surface_test.py` (101 checks) — **154 checks, all green**.

Deploying this way means you don't have to keep a machine running: you get a
`https://…workers.dev` endpoint (a custom domain works too) that the client can
be pointed at directly, and TLS is handled for you.

## Why not just run the Python file on Workers?

Cloudflare's Python Workers run on Pyodide, which has no `sqlite3` module — the
storage layer has to become D1 either way, and the HTTP layer has to become a
`fetch` handler either way. So the port is TypeScript: it is smaller, and D1's
bindings are first-class there.

`../rustdesk_api_server.py` is kept as the **minimal legacy version** (the 19
client-page routes only, single file, local SQLite). This Worker is the reference
implementation and the only one that carries the full API. For those 19 shared
routes both implementations accept the same requests and return byte-identical
JSON shapes, which is what `../selftest.py` checks.

## Layout

| File | Purpose |
| --- | --- |
| `src/index.ts` | the Worker entry — schema bootstrap, routing, the secret gate, error funnel |
| `src/env.ts` | bindings, constants (schema revision, TTLs, rule levels), row shapes |
| `src/schema.ts` | `CREATE_STATEMENTS` (19 tables) and the v2 migration list |
| `src/store.ts` | every D1 query, one function per operation |
| `src/auth.ts` | session resolution, password/TOTP checks, OIDC handshake, the `/login` and `/register` pages |
| `src/util.ts` | request/response helpers, pagination, the `Ctx` type |
| `src/route.ts` | the route table and matcher (`*` segment, 405 fallback) |
| `src/payload.ts` | the JSON shapes the client deserialises into |
| `src/routes/ab.ts` | 29 `/api/ab*` routes |
| `src/routes/account.ts` | 14 identity / telemetry / device-command routes |
| `src/routes/directory.ts` | 23 accessible-view + admin routes |
| `src/routes/ops.ts` | 10 audit / recording routes |
| `wrangler.toml` | Worker config, D1 binding, `STRICT_AUTH` |
| `schema.sql` | the same DDL, for applying at deploy time |
| `api_surface_test.py` | the 115-check surface suite |
| `run-contract-test.sh` | local end-to-end test against a clean D1 |
| `test-access-control.sh` | the `ACCESS_TOKEN` gate (including that `/register` is inside it) and the OIDC handshake |
| `test-migration.sh` | proves the v2 migration upgrades an *old* database |
| `legacy-fixture.sql` | the pre-versioning schema shape, for that test |
| `package.json` | convenience scripts: `dev`, `deploy`, `test`, `typecheck` |

`src/schema.ts` is the source of truth for the schema, and `schema.sql` mirrors it
for anyone who prefers explicit migrations. The Worker applies it lazily, so
`wrangler deploy` is the whole deployment: a brand-new database just works. It
probes with a single `SELECT 1 FROM users LIMIT 1` first — see *Why the first
request used to be slow* — and versions itself through a `schema_version` row in
`_meta`, so a database created by an older build gets the v2 columns added
instead of silently missing them.

`schema.sql` is applied *before* the Worker starts, so a table missing from it
would not be caught by the suites — the Worker would create it on first request,
and the only symptom would be a `no such table` while wiping, on a fresh
database. `run-contract-test.sh` therefore compares the two table sets and fails
loudly on drift. **If you add a table, add it to both.**

### Adding a table later (the one rule that bites)

The bootstrap probe (`SELECT 1 FROM users LIMIT 1`) answers "does the schema
exist at all", not "is it current". Everything past that point is gated on
`_meta.schema_version`:

```ts
if (version >= SCHEMA_VERSION) return;   // ← no DDL runs at all
```

So on an **existing** database, a `CREATE TABLE` you add to
`CREATE_STATEMENTS` is **not** applied unless you also bump `SCHEMA_VERSION` in
`src/env.ts` and add the statement to `MIGRATIONS_V2` (or a new migration list).
Doing one without the other is the classic silent failure here. Forgetting it
locally is invisible — `run-contract-test.sh` builds a fresh database every time,
and a fresh database takes the `!initialised` branch.

A database that predates versioning has no `_meta` row at all, reads as version
`0`, and therefore receives the full `CREATE_STATEMENTS` on its first request —
which is why an old deployment picks up new tables without a manual step.

That path is covered by a test, because a fresh database cannot exercise it:
`bash test-migration.sh` lays down `legacy-fixture.sql` (the old nine-table
shape), starts the Worker on it, and asserts the columns, tables and existing
rows all came through.

> **`schema.sql` must not seed `_meta.schema_version`.** It would look like a
> harmless optimisation, but `CREATE TABLE IF NOT EXISTS` does not add columns to
> a table that already exists, so seeding the version would tell the gate above
> that an old database is current and leave those columns missing forever. An
> empty `_meta` is what makes every database take the migration path. This is
> why the `INSERT` is absent from `schema.sql`.

## Local development (no Cloudflare account needed)

```bash
npm install                     # or just use npx wrangler
npx wrangler dev                # http://127.0.0.1:8787
```

`--local` is the default: D1 is emulated on disk under `.wrangler/state`, and
nothing is sent to Cloudflare. Point the client at `http://127.0.0.1:8787` to
try it, or run both suites:

```bash
bash run-contract-test.sh
# or against an already-running dev server, with a wiped .wrangler/state:
python ../selftest.py --base-url http://127.0.0.1:8787
python api_surface_test.py --base-url http://127.0.0.1:8787
```

Types are checked separately, and the bundle can be built without an account:

```bash
npm install                     # once, for tsc (typescript is a devDependency)
npm run typecheck               # tsc --noEmit
npx wrangler deploy --dry-run   # bundle only, nothing uploaded
```

The suites assert a fresh database — the surface suite bootstraps the first
account, which is only allowed while no administrator exists — so
`run-contract-test.sh` deletes `.wrangler/test-state`, applies `schema.sql` to an
empty database there, starts `wrangler dev` on it, waits for `/health`, and runs
both suites in order (`set -e`, so the first failure stops the run). A run never
depends on what a previous one left behind; override the directory with
`PERSIST_TO=…` if you want to keep the data between runs.

`test-access-control.sh` is a third suite, for the `ACCESS_TOKEN` gate and the
OIDC handshake, run with `bash test-access-control.sh`.

> **One assertion is dev-only by design.** The OIDC check verifies the sign-in
> URL is absolute and points at `/login?code=…`, but deliberately does *not*
> compare its origin against `http://127.0.0.1:8787`: `wrangler dev` rewrites
> the `Host` header to the configured route (`rd.gzttc.qzz.io`), so the origin
> differs from the local base even though the behaviour is right. In production
> the `Host` *is* the caller's, so the URL points back at the deployment — which
> is what the client then opens in a browser.

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

The `d1 execute` step is optional — the Worker creates and migrates its tables on
first use — it just makes the first request quiet.

`wrangler deploy --dry-run` bundles without uploading — useful to sanity-check
the build before authenticating.

### This fork's deployment

| | |
| --- | --- |
| Worker | `rustdesk-selfhost-api` (account `0de1162e…`) |
| URL | `https://rd.gzttc.qzz.io` |
| D1 | `rustdesk-selfhost-api` → `5b60cd2b-85e6-4e07-91d9-4f04f1028f67` (WNAM, primary `SJC`) |
| Access node | AMS |
| `ACCESS_TOKEN` | **set** — `/api/*` needs the secret as the first path segment |
| Schema at deploy | revision 2; `users` 13 columns, 18 tables |

### Routing gotcha

`routes` must sit **above** the `[[d1_databases]]` table in `wrangler.toml`. In
TOML a bare key following a table header belongs to that table, so a `routes`
line placed after it is parsed as `d1_databases[0].routes` and wrangler warns
`Unexpected fields found in d1_databases[0] field: "routes"` while silently
registering no route at all.

## Creating the first account

**The short way: open the sign-up page.** The official client has no
registration screen — `common/widgets/login.dart` offers only SSO buttons and a
username/password form — so account creation has to come from the server. This
Worker serves one:

```
https://rd.gzttc.qzz.io/<ACCESS_TOKEN>/register      # secret configured
http://127.0.0.1:8787/register                       # no secret
```

`/register` sits **inside** the secret gate, unlike `/login`: the secret that
authorises the API is also the invitation to create an account on it. That also
means the page cannot be linked from `/login`, which is served outside the gate
and would leak the secret in its HTML. Set `ALLOW_REGISTER=false` to close it
while leaving the gate up.

Two things the page decides for you:

* It shows an **Administrator** checkbox only while no administrator exists,
  mirroring the bootstrap rule below instead of inventing a second one.
* It refuses anything the client could not send back: the name must start with a
  letter or digit and use only `A-Za-z0-9._@+-`, so an email address is fine and
  a colon is not (the stored hash format uses colons). `anonymous` is reserved,
  and the password has to be at least 8 characters and entered twice.

The form posts back to the path it was served from, so the secret prefix
survives the round trip without the page ever being told its value.

**The scripted way: bootstrap `POST /api/users`.** No SQL needed — while **no
administrator exists**, the first call is accepted without a credential:

```bash
curl -X POST http://127.0.0.1:8787/api/users \
  -H 'content-type: application/json' \
  -d '{"name":"me","password":"S3cret","is_admin":true}'
# {"name":"me", ..., "is_admin":true, "bootstrapped":true}
```

The moment an admin exists the gate closes and every later call needs one. On a
deployment with `ACCESS_TOKEN` set, put the secret in front:
`POST /<secret>/api/users`. From
then on the sign-in button in the client works: it calls `POST /api/oidc/auth`,
opens the returned URL in a browser, and that page is served by this Worker
(`GET|POST /login`). Enter the credentials there and the client collects its
`access_token` from `GET /api/oidc/auth-query`.

### Registering is not required to use the address book

`POST /api/login` still creates an account on first sight of an unknown name,
and gives it an **empty** `password_hash`. That is the login-free design: the
address book and accessible-devices pages work with nobody signed in, and a
client whose token was revoked carries on instead of having its models wiped.
The difference between the two paths is exactly one thing:

| | password_hash | who can sign in as it |
| --- | --- | --- |
| went through `/register` | `sha256:<salt>:<hex>` | only someone who knows the password |
| first seen at `/api/login` | `""` | anyone who types that name |

`STRICT_AUTH=true` closes the second path (and rejects anonymous sessions).

### How passwords are stored

`sha256:<salt-b64>:<hex>` — a salted SHA-256, not a stretched KDF. A Worker on
the free plan gets 10 ms of CPU per request, which a PBKDF2 iteration count
worth having does not fit inside, so the salt is the part that earns its keep: it
stops two users with the same password from sharing a hash, and stops a stolen
table from being swept against precomputed digests. **It does not make a weak
password strong.** The older unsalted `sha256:<hex>` and a bare literal are both
still accepted, so the hand-insert recipe below and any account created by an
older build keep working.

<details>
<summary>Or insert the account by hand (equivalent)</summary>

```bash
python -c "import hashlib;print('sha256:'+hashlib.sha256(b'YOUR_PASSWORD').hexdigest())"
npx wrangler d1 execute rustdesk-selfhost-api --remote -y --command \
  "INSERT INTO users (name, display_name, avatar, email, note, is_admin, status, password_hash, created_at) \
   VALUES ('you','you','','','',1,1,'sha256:...', strftime('%s','now')) \
   ON CONFLICT(name) DO UPDATE SET password_hash=excluded.password_hash;"
```

</details>

### Four things that are easy to get wrong

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

### Write endpoints must return an empty 200, never `null`

`_jsonDecodeActionResp` in the client treats a `200` whose body is the literal
`null` as an **error** (`"null"`), so every write that has nothing to say
answers `200` with a zero-length body. That is what the `ok()` helper in
`src/util.ts` is for and why the audit checks assert an *empty* body rather than
an empty JSON object.

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
  `GET|POST /register` does **not** — sign-up is deliberately behind the same
  secret, at `/<secret>/register`, because account creation is part of the API
  rather than a public endpoint.
* Everything else answers `403 forbidden` — including unknown paths, so the gate
  is answered before routing reveals anything about the route table.
* With `ACCESS_TOKEN` unset the API is open. **The deployed Worker at
  `rd.gzttc.qzz.io` has it set**, so every `/api/*` call there needs the secret
  as its first path segment.

### The gate runs before the schema bootstrap

`gatePath` is checked before `ensureSchema`, so a `403` short-circuits ahead of
the migration. On a gated deployment the schema is therefore not brought up to
date until the first request that actually carries the secret. If you apply a
schema change to a database behind the gate, either run the migration
explicitly — `npx wrangler d1 execute … --remote --file=./schema.sql`, plus the
`MIGRATIONS_V2` statements — or make one authenticated call and check the result.
`/health` will not do it: it answers before `ensureSchema` too, and reports
`SCHEMA_VERSION` from the source, not from the database.

### `STRICT_AUTH` — turn off anonymous sessions

With `STRICT_AUTH = "true"` an empty/unknown bearer token is rejected with `401`
and an unknown name can no longer log in. **Leave it `"false"`** — the shared
anonymous session is exactly what makes the login-free address book and
accessible-devices pages work.

## Point the client at it

Client → **Settings → Network → API Server**, e.g.
`https://rd.gzttc.qzz.io/<ACCESS_TOKEN>`. This is stored as the `api-server`
option and can also be seeded with the `--api-server` CLI flag. It is the
address *and* the secret in one box: the client appends `/api/...` to whatever
is in there.

**Signing in** is a different box: **Settings → Account → Login** (unlabelled
when signed out, `Logout (<name>)` once in). It calls `POST /api/oidc/auth`,
opens the returned URL in a browser, and that page is served by this Worker.
Accounts have to exist before that works — see *Creating the first account*.

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
DDL when that fails — i.e. for a database that has never been initialised. The
result is memoised in a module-level promise, so one isolate pays it once.

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

**The suites are sensitive to database state.** They assert an address book
starts at `total=0` and that the first account can be bootstrapped, so clear the
tables before a run against a deployment:

```bash
npx wrangler d1 execute rustdesk-selfhost-api --remote -y --command \
  "DELETE FROM ab_peers; DELETE FROM ab_tags; DELETE FROM ab_rules; \
   DELETE FROM address_books; DELETE FROM devices; DELETE FROM device_groups; \
   DELETE FROM device_commands; DELETE FROM strategies; DELETE FROM switch_grants; \
   DELETE FROM audit_conn; DELETE FROM audit_file; DELETE FROM audit_alarm; \
   DELETE FROM audit_notes; DELETE FROM records; DELETE FROM tokens; \
   DELETE FROM oidc_sessions; DELETE FROM users;"
python ../selftest.py --base-url https://rd.gzttc.qzz.io
python api_surface_test.py --base-url https://rd.gzttc.qzz.io
```

## Configuration

| Name | Where | Meaning |
| --- | --- | --- |
| `DB` | D1 binding | the database |
| `STRICT_AUTH` | `[vars]` | `"true"` rejects anonymous sessions and unknown logins, like `--strict-auth` on the Python server. Leave it `"false"`. |
| `ACCESS_TOKEN` | secret | shared secret that must be the first path segment of every request. Unset = open. **Set on the deployed Worker.** See *Access control*. |
| `ALLOW_REGISTER` | `[vars]` | `"false"` closes the `/register` page (it answers `403`). Defaults to on. The page is behind `ACCESS_TOKEN` either way. |
| `RECORDS` | R2 binding | optional; enables real recording upload at `/api/record`. Unset, that endpoint answers an explanatory error instead of failing silently. |

## Limits worth knowing

* **D1 free tier** has daily read/write quotas. This API is tiny — a few queries
  per page load — but a fleet of clients polling `GET /api/peers` will add up.
* **Workers CPU limits** are irrelevant here: every handler is a handful of
  small SQL queries.
* **Recordings need R2.** Without a `RECORDS` bucket the `/api/record` route
  stays inert; bind one to store uploads.
* **The Python server does not have the full surface.** It is the legacy minimal
  implementation (19 routes). Use this Worker for anything beyond the two
  client pages.
* **Anonymous is shared.** Every client pointed at this Worker *without* signing
  in sees the same address book. See the note in `../README.md`; give each
  client its own Worker (or a named account) if you need isolation.
* A custom domain is strongly recommended over `workers.dev` if the client
  fleet is not all on one machine — `workers.dev` is on public suffix lists and
  has been used for abuse, and some networks block it.
