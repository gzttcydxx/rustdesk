/**
 * A self-hosted, RustDesk Server Pro compatible API for Cloudflare Workers.
 *
 * Everything the official client calls, so a fork with the login gate removed
 * (or a client that signs in normally) is fully functional against a server you
 * own:
 *
 *   Identity      /api/login, /api/logout, /api/currentUser, /api/login-options,
 *                 /api/oidc/auth, /api/oidc/auth-query, plus the /login page
 *   Address book  all of /api/ab*  — personal, shared, peers, tags, share rules,
 *                 and the two legacy whole-document shapes
 *   Devices       /api/device-group/accessible, /api/users, /api/peers,
 *                 /api/sysinfo, /api/sysinfo_ver, /api/heartbeat,
 *                 /api/devices/cli, /api/devices/deploy, /api/switch-grant
 *   Audit         /api/audit/conn|file|alarm, /api/audit/conn/active, /api/audit
 *   Recordings    /api/record
 *   Admin         accounts, devices, device groups, policies, audit queries
 *
 * Two design decisions shape all of it:
 *
 *   1. **An empty bearer token is a session.** It maps to one shared
 *      `anonymous` account, which is what lets the address book and accessible
 *      devices pages work with nobody signed in.
 *   2. **The store is D1 and the schema is applied lazily.** `wrangler deploy`
 *      is the whole deployment; see `schema.ts` for the migration story.
 */

import { ANONYMOUS_USER, SCHEMA_VERSION, SERVER_NAME, SERVER_VERSION, type Env } from "./env";
import { matchRoute, type Route } from "./route";
import { CREATE_STATEMENTS, CURRENT_VERSION_STATEMENT, MIGRATIONS_V2 } from "./schema";
import { requireUser } from "./auth";
import { abRoutes } from "./routes/ab";
import { accountRoutes, loginPage } from "./routes/account";
import { directoryRoutes } from "./routes/directory";
import { opsRoutes } from "./routes/ops";
import {
  ApiError,
  CORS_HEADERS,
  type Ctx,
  fail,
  isResponse,
  send,
  toBool,
} from "./util";

export type { Env };

// --------------------------------------------------------------------------- //
// schema bootstrap
// --------------------------------------------------------------------------- //

/** Applied in chunks: one round trip per chunk instead of one per statement. */
async function applyStatements(env: Env, statements: string[]): Promise<void> {
  const CHUNK = 8;
  for (let i = 0; i < statements.length; i += CHUNK) {
    const chunk = statements.slice(i, i + CHUNK);
    try {
      await env.DB.batch(chunk.map((sql) => env.DB.prepare(sql)));
    } catch {
      // A chunk that fails as a unit (one statement in it cannot apply) is
      // retried one statement at a time, so the rest still land.
      for (const sql of chunk) {
        try {
          await env.DB.prepare(sql).run();
        } catch {
          // Already applied, or genuinely not applicable. Both are fine here.
        }
      }
    }
  }
}

async function readSchemaVersion(env: Env): Promise<number> {
  try {
    const row = await env.DB.prepare("SELECT value FROM _meta WHERE key = 'schema_version'")
      .first<{ value: string }>();
    const parsed = Number.parseInt(row?.value ?? "", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    // No `_meta` table at all: this database predates versioning.
    return 0;
  }
}

/**
 * Create the tables, but only when they are actually missing.
 *
 * Normally the tables already exist, so the probe below is what every request
 * pays. Running thirty DDL statements unconditionally was paid by the first
 * request of every new isolate, and enough serial D1 round trips are slow
 * enough that the client's 12s timeout (`common.rs::post_request_`) starts
 * firing.
 */
async function bootstrap(env: Env): Promise<void> {
  let initialised = true;
  try {
    await env.DB.prepare("SELECT 1 FROM users LIMIT 1").first();
  } catch {
    initialised = false;
  }

  if (!initialised) {
    await applyStatements(env, CREATE_STATEMENTS);
    await env.DB.prepare(CURRENT_VERSION_STATEMENT).run();
    return;
  }

  const version = await readSchemaVersion(env);
  if (version >= SCHEMA_VERSION) return;

  if (version < 2) {
    // Everything below is written to be safe to repeat: the `DROP`s only touch
    // projections, and a duplicate-column `ALTER` is expected and ignored.
    await applyStatements(env, MIGRATIONS_V2);
  }
  await applyStatements(env, CREATE_STATEMENTS);
  await env.DB.prepare(CURRENT_VERSION_STATEMENT).run();
}

let schemaReady: Promise<void> | null = null;

function ensureSchema(env: Env): Promise<void> {
  if (schemaReady === null) {
    schemaReady = bootstrap(env).catch((exc) => {
      // Let the next request retry rather than caching a broken isolate.
      schemaReady = null;
      throw exc;
    });
  }
  return schemaReady;
}

// --------------------------------------------------------------------------- //
// routing
// --------------------------------------------------------------------------- //

const ROUTES: Route[] = [...accountRoutes, ...abRoutes, ...directoryRoutes, ...opsRoutes];

const health = (env: Env): Response =>
  send({
    server: SERVER_NAME,
    version: SERVER_VERSION,
    schema_version: SCHEMA_VERSION,
    anonymous_user: ANONYMOUS_USER,
    strict_auth: toBool(env.STRICT_AUTH, false),
    record_storage: Boolean(env.RECORDS),
    endpoints: ROUTES.map((route) => `${route.method} /${route.path}`),
  });

/**
 * Enforce the shared secret carried in the first path segment.
 *
 * The client's "API Server" option accepts a path, so the secret rides there
 * with no client change: `https://<host>/<ACCESS_TOKEN>`. `/health` stays open
 * so the deployment can be probed, and `/login` is handled before this so a
 * sign-in link keeps working in a browser.
 */
function gatePath(env: Env, segments: string[]): string[] | Response {
  const secret = (env.ACCESS_TOKEN ?? "").trim();
  if (!secret) return segments;
  if (segments[0] === secret) return segments.slice(1);
  if (segments.length === 0 || segments[0] === "health") return segments;
  return new Response("forbidden", {
    status: 403,
    headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function makeCtx(env: Env, request: Request, url: URL, segments: string[], path: string, params: string[]): Ctx {
  const ctx: Ctx = {
    env,
    request,
    url,
    segments,
    path,
    params,
    user: async () => {
      throw new Error("ctx.user() called before the context was wired up");
    },
  };
  // A missing session surfaces as a thrown Response, which the fetch handler
  // sends, so a handler can write `return send(userPayload(await ctx.user()))`.
  ctx.user = async () => {
    const user = await requireUser(ctx);
    if (isResponse(user)) throw user;
    return user;
  };
  return ctx;
}

function decodeSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    let segments = decodeSegments(url.pathname);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // The sign-in screen is opened from a browser through a one-off code, so it
    // is the only endpoint outside the secret gate.
    if (segments[0] === "login") {
      return await loginPage(makeCtx(env, request, url, segments, path, []));
    }

    const gated = gatePath(env, segments);
    if (isResponse(gated)) return gated;
    segments = gated;

    try {
      if (request.method === "GET" && (segments.length === 0 || segments[0] === "health")) {
        return health(env);
      }

      await ensureSchema(env);

      const matched = matchRoute(ROUTES, request.method, segments);
      if (!matched) return fail(404, `not found: ${request.method} ${path}`);
      if (matched.route.method !== request.method) {
        return fail(405, `method not allowed: ${matched.route.method} ${path}`);
      }
      const ctx = makeCtx(env, request, url, segments, path, matched.params);
      return await matched.route.handler(ctx);
    } catch (exc) {
      // A thrown Response is a deliberate early return from `ctx.user()`.
      if (exc instanceof Response) return exc;
      if (exc instanceof ApiError) return fail(exc.status, exc.message);
      return fail(500, exc instanceof Error ? exc.message : String(exc));
    }
  },
};
