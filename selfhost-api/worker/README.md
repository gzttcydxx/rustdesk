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

The Worker applies the schema itself on the first request of each isolate
(`CREATE TABLE IF NOT EXISTS`), so a fresh database works with no migration
step. `schema.sql` is there for anyone who prefers explicit migrations; both are
idempotent.

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
npx wrangler deploy
```

The Worker creates its tables on first use, so there is no migration step. If
you prefer to run the schema explicitly:

```bash
npx wrangler d1 execute rustdesk-selfhost-api --remote --file=./schema.sql
```

`wrangler deploy --dry-run` bundles without uploading — useful to sanity-check
the build before authenticating.

## Point the client at it

Client → **Settings → Network → API Server**, e.g.
`https://rustdesk-selfhost-api.<your-subdomain>.workers.dev`.

Because the endpoint is HTTPS the client needs no extra flags. To use your own
domain, add a route in `wrangler.toml`:

```toml
routes = [
  { pattern = "rustdesk-api.example.com", custom_domain = true }
]
```

## Configuration

| Name | Where | Meaning |
| --- | --- | --- |
| `DB` | D1 binding | the database |
| `STRICT_AUTH` | `[vars]` | `"true"` rejects anonymous sessions and unknown logins, like `--strict-auth` on the Python server. Leave it `"false"` — anonymous sessions are the whole point. |

## Differences from the Python server

Behaviour is identical; only the runtime-specific parts differ.

| | Python | Worker |
| --- | --- | --- |
| Store | `sqlite3` file, `--db` | D1 binding `DB` |
| HTTP | `http.server` | `fetch` handler |
| Strict auth | `--strict-auth` flag | `STRICT_AUTH` var |
| Anonymous account | created at startup | created lazily per request |
| Bound address | `--host`/`--port` | Workers route |

Both implementations accept the same requests and return byte-identical JSON
shapes, which is what the shared contract suite checks.

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
