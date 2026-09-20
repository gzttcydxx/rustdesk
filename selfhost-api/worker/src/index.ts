/**
 * A self-hosted, RustDesk-compatible API server for Cloudflare Workers.
 *
 * This is a port of ../rustdesk_api_server.py. It backs the same two features:
 *
 *   Address book        /api/ab, /api/ab/personal, /api/ab/peers, /api/ab/tags,
 *                       /api/ab/peer/*, /api/ab/tag/*
 *   Accessible devices  /api/device-group/accessible, /api/users, /api/peers
 *
 * Behaviour is intentionally identical to the Python server, including the
 * anonymous-session design: the Flutter client sends
 * `Authorization: Bearer <access_token>`; an empty or unknown token maps to a
 * single shared `anonymous` account rather than returning 401. That is what
 * lets the "no login required" address book / accessible devices pages work.
 *
 * Differences from the Python version, all forced by the runtime:
 *   * Storage is D1 (`env.DB`) instead of a local sqlite3 file.
 *   * Routing is an explicit fetch handler instead of http.server.
 *   * Strict auth is read from the `STRICT_AUTH` var instead of a CLI flag.
 *   * The anonymous account is created lazily on first request, because a
 *     Worker has no startup hook.
 */

const SERVER_VERSION = "0.1.0";

/** The account every request without a usable access token is mapped to. */
const ANONYMOUS_USER = "anonymous";

// --------------------------------------------------------------------------- //
// Minimal D1 typings, so this file needs no npm dependencies to run
// --------------------------------------------------------------------------- //

interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}

interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
}

export interface Env {
  DB: D1Database;
  /** "true"/"1" rejects anonymous sessions and unknown logins. */
  STRICT_AUTH?: string;
  /**
   * Shared secret that must be the first path segment of every request.
   * Set with `wrangler secret put ACCESS_TOKEN`; when unset the API is open.
   *
   * A path in the client's "API Server" option is accepted (`common.dart` only
   * checks that it starts with http/https), so this needs no client change:
   * enter `https://<host>/<ACCESS_TOKEN>`.
   */
  ACCESS_TOKEN?: string;
}

// --------------------------------------------------------------------------- //
// row shapes
// --------------------------------------------------------------------------- //

interface UserRow {
  name: string;
  display_name: string;
  avatar: string;
  email: string;
  note: string;
  is_admin: number;
  status: number;
  password_hash: string;
  created_at: number;
}

interface AbRow {
  guid: string;
  user_name: string;
  name: string;
  kind: string;
  owner: string;
  rule: number;
  created_at: number;
}

interface AbPeerRow {
  guid: string;
  id: string;
  payload: string;
  tags: string;
  updated_at: number;
}

interface AbTagRow {
  guid: string;
  name: string;
  color: number;
}

interface DeviceRow {
  user_name: string;
  id: string;
  payload: string;
  status: number;
  updated_at: number;
}

// --------------------------------------------------------------------------- //
// small helpers
// --------------------------------------------------------------------------- //

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const nowSec = (): number => Date.now() / 1000;

const newId = (): string => crypto.randomUUID().replace(/-/g, "");

/** Python's `str()` for the handful of types we care about. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

/** `dict.get(key, default)` — the default only applies when the key is absent. */
function pyGet<T>(obj: Record<string, unknown>, key: string, fallback: T): unknown {
  return key in obj ? obj[key] : fallback;
}

function strictAuth(env: Env): boolean {
  const raw = (env.STRICT_AUTH ?? "").trim().toLowerCase();
  return raw === "true" || raw === "1";
}

/** Mirrors `page_params` in the Python server. */
function pageParams(url: URL): { pageSize: number; offset: number } {
  const asInt = (key: string, fallback: number): number => {
    const value = Number.parseInt(url.searchParams.get(key) ?? "", 10);
    if (!Number.isFinite(value)) return fallback;
    return value > 0 ? value : fallback;
  };
  const pageSize = asInt("pageSize", 100);
  const current = asInt("current", 1);
  return { pageSize, offset: (current - 1) * pageSize };
}

function userPayload(row: Partial<UserRow> | null | undefined) {
  return {
    name: row?.name ?? "",
    display_name: row?.display_name ?? "",
    avatar: row?.avatar ?? "",
    email: row?.email ?? "",
    note: row?.note ?? "",
    status: row?.status ?? 1,
    is_admin: Boolean(row?.is_admin ?? 0),
  };
}

function abProfilePayload(row: Partial<AbRow> | null | undefined) {
  return {
    guid: row?.guid ?? "",
    name: row?.name ?? "",
    owner: row?.owner ?? "",
    note: null,
    rule: row?.rule ?? 0,
    info: null,
  };
}

/** Shape a stored address book peer for the client's `Peer.fromJson`. */
function peerRowPayload(row: AbPeerRow) {
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  const tags = row.tags ? (JSON.parse(row.tags) as unknown) : [];
  return {
    id: payload.id ?? row.id ?? "",
    hash: pyGet(payload, "hash", ""),
    password: pyGet(payload, "password", ""),
    username: pyGet(payload, "username", ""),
    hostname: pyGet(payload, "hostname", ""),
    platform: pyGet(payload, "platform", ""),
    alias: pyGet(payload, "alias", ""),
    tags,
    forceAlwaysRelay: pyStr(pyGet(payload, "forceAlwaysRelay", "false")),
    rdpPort: pyGet(payload, "rdpPort", ""),
    rdpUsername: pyGet(payload, "rdpUsername", ""),
    loginName: pyGet(payload, "loginName", ""),
    device_group_name: pyGet(payload, "device_group_name", ""),
    note: pyGet(payload, "note", ""),
    same_server: null,
  };
}

// --------------------------------------------------------------------------- //
// storage layer — a direct translation of `class Store`
// --------------------------------------------------------------------------- //

async function ensureUser(
  db: D1Database,
  name: string,
  displayName = "",
  passwordHash = "",
  isAdmin = false,
): Promise<UserRow> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO users" +
        " (name, display_name, avatar, email, note, is_admin, status, password_hash, created_at)" +
        " VALUES (?, ?, '', '', '', ?, 1, ?, ?)",
    )
    .bind(name, displayName, isAdmin ? 1 : 0, passwordHash, nowSec())
    .run();
  const row = await db
    .prepare("SELECT * FROM users WHERE name = ?")
    .bind(name)
    .first<UserRow>();
  return row as UserRow;
}

async function getUser(db: D1Database, name: string): Promise<UserRow | null> {
  return await db.prepare("SELECT * FROM users WHERE name = ?").bind(name).first<UserRow>();
}

async function listUsers(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<{ total: number; rows: UserRow[] }> {
  const [count, rows] = await db.batch<unknown>([
    db.prepare("SELECT COUNT(*) AS c FROM users"),
    db.prepare("SELECT * FROM users ORDER BY name LIMIT ? OFFSET ?").bind(limit, offset),
  ]);
  return {
    total: Number((count.results[0] as { c: number }).c),
    rows: rows.results as UserRow[],
  };
}

async function newToken(db: D1Database, userName: string): Promise<string> {
  const token = newId();
  await db
    .prepare("INSERT INTO tokens (token, user_name, created_at) VALUES (?, ?, ?)")
    .bind(token, userName, nowSec())
    .run();
  return token;
}

async function userForToken(db: D1Database, token: string): Promise<string | null> {
  if (!token) return null;
  const row = await db
    .prepare("SELECT user_name FROM tokens WHERE token = ?")
    .bind(token)
    .first<{ user_name: string }>();
  return row ? row.user_name : null;
}

async function dropToken(db: D1Database, token: string): Promise<void> {
  if (!token) return;
  await db.prepare("DELETE FROM tokens WHERE token = ?").bind(token).run();
}

/** Return (creating if needed) the personal address book of a user. */
async function personalAb(db: D1Database, userName: string): Promise<AbRow> {
  const row = await db
    .prepare("SELECT * FROM address_books WHERE user_name = ? AND kind = 'personal'")
    .bind(userName)
    .first<AbRow>();
  if (row) return row;
  const guid = newId();
  await db
    .prepare(
      "INSERT INTO address_books (guid, user_name, name, kind, owner, rule, created_at)" +
        " VALUES (?, ?, ?, 'personal', ?, 3, ?)",
    )
    .bind(guid, userName, "My address book", userName, nowSec())
    .run();
  return {
    guid,
    user_name: userName,
    name: "My address book",
    kind: "personal",
    owner: userName,
    rule: 3,
    created_at: nowSec(),
  };
}

async function abByGuid(db: D1Database, guid: string): Promise<AbRow | null> {
  return await db
    .prepare("SELECT * FROM address_books WHERE guid = ?")
    .bind(guid)
    .first<AbRow>();
}

/**
 * Address books shared *with* this user. None are created by default; the
 * endpoint exists so the client's paging loop terminates.
 */
async function listSharedAb(
  db: D1Database,
  userName: string,
  limit: number,
  offset: number,
): Promise<{ total: number; rows: AbRow[] }> {
  const [count, rows] = await db.batch<unknown>([
    db
      .prepare("SELECT COUNT(*) AS c FROM address_books WHERE owner = ? AND kind = 'shared'")
      .bind(userName),
    db
      .prepare(
        "SELECT * FROM address_books WHERE owner = ? AND kind = 'shared'" +
          " ORDER BY name LIMIT ? OFFSET ?",
      )
      .bind(userName, limit, offset),
  ]);
  return {
    total: Number((count.results[0] as { c: number }).c),
    rows: rows.results as AbRow[],
  };
}

async function listAbPeers(
  db: D1Database,
  guid: string,
  limit: number,
  offset: number,
): Promise<{ total: number; rows: AbPeerRow[] }> {
  const [count, rows] = await db.batch<unknown>([
    db.prepare("SELECT COUNT(*) AS c FROM ab_peers WHERE guid = ?").bind(guid),
    db
      .prepare(
        "SELECT * FROM ab_peers WHERE guid = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      )
      .bind(guid, limit, offset),
  ]);
  return {
    total: Number((count.results[0] as { c: number }).c),
    rows: rows.results as AbPeerRow[],
  };
}

async function upsertAbPeer(
  db: D1Database,
  guid: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const peerId = pyStr(payload?.id ?? "");
  if (!peerId || peerId === "None") throw new ApiError(400, "peer id is required");
  const tags = Array.isArray(payload.tags) ? payload.tags : [];
  await db
    .prepare(
      "INSERT INTO ab_peers (guid, id, payload, tags, updated_at) VALUES (?, ?, ?, ?, ?)" +
        " ON CONFLICT(guid, id) DO UPDATE SET" +
        " payload = excluded.payload, tags = excluded.tags, updated_at = excluded.updated_at",
    )
    .bind(guid, peerId, JSON.stringify(payload), JSON.stringify(tags), nowSec())
    .run();
}

async function updateAbPeer(
  db: D1Database,
  guid: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const peerId = pyStr(patch?.id ?? "");
  if (!peerId || peerId === "None") return false;
  const row = await db
    .prepare("SELECT payload, tags FROM ab_peers WHERE guid = ? AND id = ?")
    .bind(guid, peerId)
    .first<{ payload: string; tags: string }>();
  if (!row) return false;

  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  let tags = JSON.parse(row.tags) as unknown;
  // The client uses `tags` for the tag editor and the remaining keys for
  // alias / note / password / device metadata.
  for (const [key, value] of Object.entries(patch)) {
    if (key === "tags") {
      tags = Array.isArray(value) ? value : [];
      payload.tags = tags;
    } else if (key !== "id") {
      payload[key] = value;
    }
  }
  await db
    .prepare(
      "UPDATE ab_peers SET payload = ?, tags = ?, updated_at = ? WHERE guid = ? AND id = ?",
    )
    .bind(JSON.stringify(payload), JSON.stringify(tags), nowSec(), guid, peerId)
    .run();
  return true;
}

async function deleteAbPeers(
  db: D1Database,
  guid: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  await db.batch(
    ids.map((id) => db.prepare("DELETE FROM ab_peers WHERE guid = ? AND id = ?").bind(guid, id)),
  );
  return ids.length;
}

async function listAbTags(db: D1Database, guid: string): Promise<AbTagRow[]> {
  const { results } = await db
    .prepare("SELECT name, color FROM ab_tags WHERE guid = ? ORDER BY name")
    .bind(guid)
    .all<AbTagRow>();
  return results;
}

async function addAbTag(
  db: D1Database,
  guid: string,
  name: string,
  color: number,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO ab_tags (guid, name, color) VALUES (?, ?, ?)" +
        " ON CONFLICT(guid, name) DO UPDATE SET color = excluded.color",
    )
    .bind(guid, name, Math.trunc(color || 0))
    .run();
}

async function renameAbTag(
  db: D1Database,
  guid: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const row = await db
    .prepare("SELECT color FROM ab_tags WHERE guid = ? AND name = ?")
    .bind(guid, oldName)
    .first<{ color: number }>();
  const color = row ? row.color : 0;

  const statements = [
    db.prepare("DELETE FROM ab_tags WHERE guid = ? AND name = ?").bind(guid, oldName),
    db
      .prepare(
        "INSERT INTO ab_tags (guid, name, color) VALUES (?, ?, ?)" +
          " ON CONFLICT(guid, name) DO UPDATE SET color = excluded.color",
      )
      .bind(guid, newName, color),
  ];

  // Rename the tag wherever a peer carries it.
  const { results: peers } = await db
    .prepare("SELECT id, tags FROM ab_peers WHERE guid = ?")
    .bind(guid)
    .all<{ id: string; tags: string }>();
  for (const peer of peers) {
    const tags = JSON.parse(peer.tags) as string[];
    if (tags.includes(oldName)) {
      const renamed = tags.map((t) => (t === oldName ? newName : t));
      statements.push(
        db
          .prepare("UPDATE ab_peers SET tags = ? WHERE guid = ? AND id = ?")
          .bind(JSON.stringify(renamed), guid, peer.id),
      );
    }
  }
  await db.batch(statements);
}

async function deleteAbTags(
  db: D1Database,
  guid: string,
  names: string[],
): Promise<void> {
  for (const name of names) {
    const statements = [
      db.prepare("DELETE FROM ab_tags WHERE guid = ? AND name = ?").bind(guid, name),
    ];
    const { results: peers } = await db
      .prepare("SELECT id, tags FROM ab_peers WHERE guid = ?")
      .bind(guid)
      .all<{ id: string; tags: string }>();
    for (const peer of peers) {
      const tags = JSON.parse(peer.tags) as string[];
      if (tags.includes(name)) {
        const kept = tags.filter((t) => t !== name);
        statements.push(
          db
            .prepare("UPDATE ab_peers SET tags = ? WHERE guid = ? AND id = ?")
            .bind(JSON.stringify(kept), guid, peer.id),
        );
      }
    }
    await db.batch(statements);
  }
}

async function listDeviceGroups(
  db: D1Database,
  userName: string,
  limit: number,
  offset: number,
): Promise<{ total: number; rows: { name: string }[] }> {
  const [count, rows] = await db.batch<unknown>([
    db.prepare("SELECT COUNT(*) AS c FROM device_groups WHERE user_name = ?").bind(userName),
    db
      .prepare("SELECT name FROM device_groups WHERE user_name = ? ORDER BY name LIMIT ? OFFSET ?")
      .bind(userName, limit, offset),
  ]);
  return {
    total: Number((count.results[0] as { c: number }).c),
    rows: rows.results as { name: string }[],
  };
}

/**
 * Insert or merge a reachable device.
 *
 * Merging matters: the client also calls this with partial payloads (a bare
 * `{"id": ..., "alias": ...}` on every address-book edit), and an empty
 * incoming field must never erase what is already stored.
 */
async function upsertDevice(
  db: D1Database,
  userName: string,
  device: Record<string, unknown>,
): Promise<void> {
  const deviceId = pyStr(device?.id ?? "");
  if (!deviceId || deviceId === "None") throw new ApiError(400, "device id is required");

  const row = await db
    .prepare("SELECT payload FROM devices WHERE user_name = ? AND id = ?")
    .bind(userName, deviceId)
    .first<{ payload: string }>();
  const merged = row
    ? (JSON.parse(row.payload) as Record<string, unknown>)
    : ({} as Record<string, unknown>);

  for (const [key, value] of Object.entries(device)) {
    const isEmpty = value === "" || value === null || value === undefined;
    const isEmptyList = Array.isArray(value) && value.length === 0;
    if (key === "info" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const info = { ...((merged.info as Record<string, unknown>) ?? {}) };
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v !== "" && v !== null && v !== undefined) info[k] = v;
      }
      merged.info = info;
    } else if (!isEmpty && !isEmptyList) {
      merged[key] = value;
    } else if (!(key in merged)) {
      merged[key] = value;
    }
  }
  merged.id = deviceId;

  const status = Number(device.status ?? merged.status ?? 1) || 1;
  await db
    .prepare(
      "INSERT INTO devices (user_name, id, payload, status, updated_at) VALUES (?, ?, ?, ?, ?)" +
        " ON CONFLICT(user_name, id) DO UPDATE SET" +
        " payload = excluded.payload, status = excluded.status," +
        " updated_at = excluded.updated_at",
    )
    .bind(userName, deviceId, JSON.stringify(merged), status, nowSec())
    .run();
}

async function listDevices(
  db: D1Database,
  userName: string,
  limit: number,
  offset: number,
): Promise<{ total: number; payloads: Record<string, unknown>[] }> {
  const [count, rows] = await db.batch<unknown>([
    db.prepare("SELECT COUNT(*) AS c FROM devices WHERE user_name = ?").bind(userName),
    db
      .prepare(
        "SELECT payload FROM devices WHERE user_name = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?",
      )
      .bind(userName, limit, offset),
  ]);
  return {
    total: Number((count.results[0] as { c: number }).c),
    payloads: (rows.results as { payload: string }[]).map((r) => JSON.parse(r.payload)),
  };
}

async function setAuditNote(db: D1Database, guid: string, note: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO audit_notes (guid, note, updated_at) VALUES (?, ?, ?)" +
        " ON CONFLICT(guid) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at",
    )
    .bind(guid, note, nowSec())
    .run();
}

// --------------------------------------------------------------------------- //
// schema bootstrap
// --------------------------------------------------------------------------- //

/**
 * Same tables as ./schema.sql. Applied lazily on the first request of each
 * isolate so that `wrangler deploy` is a complete deployment — no separate
 * migration step, and a brand-new database just works.
 *
 * schema.sql still exists for anyone who prefers explicit migrations
 * (`wrangler d1 execute --file=./schema.sql`). Both are idempotent.
 */
const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     name TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '',
     avatar TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '',
     note TEXT NOT NULL DEFAULT '', is_admin INTEGER NOT NULL DEFAULT 0,
     status INTEGER NOT NULL DEFAULT 1, password_hash TEXT NOT NULL DEFAULT '',
     created_at REAL NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tokens (
     token TEXT PRIMARY KEY, user_name TEXT NOT NULL, created_at REAL NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS address_books (
     guid TEXT PRIMARY KEY, user_name TEXT NOT NULL, name TEXT NOT NULL,
     kind TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '',
     rule INTEGER NOT NULL DEFAULT 3, created_at REAL NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS ab_peers (
     guid TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
     tags TEXT NOT NULL DEFAULT '[]', updated_at REAL NOT NULL,
     PRIMARY KEY (guid, id))`,
  `CREATE TABLE IF NOT EXISTS ab_tags (
     guid TEXT NOT NULL, name TEXT NOT NULL, color INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (guid, name))`,
  `CREATE TABLE IF NOT EXISTS device_groups (
     user_name TEXT NOT NULL, name TEXT NOT NULL, created_at REAL NOT NULL,
     PRIMARY KEY (user_name, name))`,
  `CREATE TABLE IF NOT EXISTS devices (
     user_name TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
     status INTEGER NOT NULL DEFAULT 1, updated_at REAL NOT NULL,
     PRIMARY KEY (user_name, id))`,
  `CREATE TABLE IF NOT EXISTS audit_notes (
     guid TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '', updated_at REAL NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS oidc_sessions (
     code TEXT PRIMARY KEY, user_name TEXT NOT NULL DEFAULT '',
     authed INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_peers_guid ON ab_peers (guid, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_devices_user ON devices (user_name, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_address_books_user ON address_books (user_name, kind)`,
];

let schemaReady: Promise<void> | null = null;

/**
 * Create the tables, but only when they are actually missing.
 *
 * Normally the tables were created at deploy time with
 * `wrangler d1 execute --file=./schema.sql`, so the probe below is what every
 * request pays. Running the thirteen DDL statements unconditionally was paid by
 * the first request of every new isolate, and thirteen serial D1 round trips
 * are slow enough that the client's 12s timeout (`common.rs::post_request_`)
 * eventually started firing.
 */
function ensureSchema(env: Env): Promise<void> {
  if (schemaReady === null) {
    schemaReady = (async () => {
      try {
        await env.DB.prepare("SELECT 1 FROM users LIMIT 1").run();
        return;
      } catch {
        // A database that was never initialised (local `wrangler dev`, or a
        // freshly created D1): bootstrap it.
      }
      for (const statement of SCHEMA_STATEMENTS) {
        await env.DB.prepare(statement).run();
      }
    })().catch((exc) => {
      // Let the next request retry rather than caching a broken isolate.
      schemaReady = null;
      throw exc;
    });
  }
  return schemaReady;
}

// --------------------------------------------------------------------------- //
// http layer
// --------------------------------------------------------------------------- //

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

function send(payload: unknown, status = 200): Response {
  // The Python server serialises a `None` payload as the literal `null`, and
  // the client's jsonDecode relies on that.
  const body = payload === undefined || payload === null ? "null" : JSON.stringify(payload);
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

const fail = (status: number, message: string): Response => send({ error: message }, status);

interface Ctx {
  env: Env;
  request: Request;
  url: URL;
  segments: string[];
  path: string;
}

async function readJson(request: Request): Promise<unknown> {
  try {
    const raw = await request.text();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function bearerToken(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return "";
}

/**
 * Resolve the caller.
 *
 * An empty or unknown token is NOT an error: it maps to the shared anonymous
 * account, which is what lets the address book and accessible devices pages
 * work without signing in.
 */
async function currentUser(ctx: Ctx): Promise<UserRow | null> {
  const token = bearerToken(ctx.request);
  if (token) {
    const name = await userForToken(ctx.env.DB, token);
    if (name) {
      const row = await getUser(ctx.env.DB, name);
      if (row) return row;
    }
    if (strictAuth(ctx.env)) return null;
  }
  return await ensureUser(ctx.env.DB, ANONYMOUS_USER, "Anonymous");
}

/** Fall back to the caller's personal address book when the guid is missing or
 * unknown, so the page never dead-ends. */
async function resolveAbGuid(ctx: Ctx, user: UserRow, guid: string): Promise<string> {
  if (guid) {
    const ab = await abByGuid(ctx.env.DB, guid);
    if (ab && ab.user_name === user.name) return guid;
  }
  return (await personalAb(ctx.env.DB, user.name)).guid;
}

/** Keep /api/peers in sync with whatever entered the address book. */
async function registerDevice(ctx: Ctx, user: UserRow, peer: Record<string, unknown>): Promise<void> {
  const peerId = pyStr(peer?.id ?? "");
  if (!peerId || peerId === "None") return;
  await upsertDevice(ctx.env.DB, user.name, {
    id: peerId,
    info: {
      username: peer.username ?? "",
      os: peer.platform ?? "",
      device_name: peer.hostname ?? "",
    },
    status: 1,
    user: user.name,
    user_name: (peer.loginName as string) || user.name,
    device_group_name: (peer.device_group_name as string) || "",
    note: peer.note ?? "",
  });
}

type Handler = (ctx: Ctx) => Promise<Response>;

async function requireUser(ctx: Ctx): Promise<UserRow | Response> {
  const user = await currentUser(ctx);
  if (user === null) return fail(401, "Session expired");
  return user;
}

const isResponse = (value: unknown): value is Response => value instanceof Response;

// -- endpoints: identity ---------------------------------------------------- //

const health: Handler = async (ctx) =>
  send({
    server: "rustdesk-selfhost-api",
    version: SERVER_VERSION,
    anonymous_user: ANONYMOUS_USER,
    strict_auth: strictAuth(ctx.env),
  });

const login: Handler = async (ctx) => {
  const body = ((await readJson(ctx.request)) as Record<string, unknown> | null) ?? {};
  const username = String(body.username ?? "").trim();
  const password = String(body.password ?? "");
  if (!username) {
    // The client can send an empty body while probing; treat that as the
    // anonymous account instead of failing the request.
    return send({
      type: "access_token",
      access_token: "",
      user: userPayload(await ensureUser(ctx.env.DB, ANONYMOUS_USER, "Anonymous")),
    });
  }

  let row = await getUser(ctx.env.DB, username);
  if (row === null) {
    if (strictAuth(ctx.env)) return fail(401, "Invalid username or password");
    row = await ensureUser(ctx.env.DB, username, username);
  } else if (row.password_hash && !(await passwordMatches(row.password_hash, password))) {
    return fail(401, "Invalid username or password");
  }

  const token = await newToken(ctx.env.DB, username);
  return send({ type: "access_token", access_token: token, user: userPayload(row) });
};

const currentUserEndpoint: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  return send(userPayload(user));
};

const logout: Handler = async (ctx) => {
  await dropToken(ctx.env.DB, bearerToken(ctx.request));
  return send(null);
};

const loginOptions: Handler = async () => send([]);

// -- endpoints: oidc login -------------------------------------------------- //
//
// The Flutter client signs in with an OIDC-style handshake, see
// src/hbbs_http/account.rs:
//
//   1. POST /api/oidc/auth        -> {code, url}. The whole response body is
//                                    deserialised into `OidcAuthUrl`, so it is
//                                    NOT wrapped in `data`.
//   2. the user opens `url` in a browser and signs in
//   3. GET  /api/oidc/auth-query  once a second until it yields an access
//                                    token, wrapped as {"body": "<json>"}
//
// `url` points back at this Worker, so a self-hosted deployment serves the
// sign-in screen itself instead of delegating to a third party.

interface OidcSessionRow {
  code: string;
  user_name: string;
  authed: number;
  created_at: number;
}

/** A pending sign-in link stops working after this long. */
const OIDC_TTL_SECS = 30 * 60;

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS },
  });
}

function escapeHtml(value: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compare a stored password against a supplied one.
 *
 * Rows are written as `sha256:<hex>` by the snippet in README.md. A bare value
 * is still compared literally, so a database created before hashing existed
 * keeps working.
 */
async function passwordMatches(stored: string, given: string): Promise<boolean> {
  if (!stored) return false;
  if (!stored.startsWith("sha256:")) return stored === given;
  return stored === `sha256:${await sha256Hex(given)}`;
}

async function oidcSession(ctx: Ctx, code: string): Promise<OidcSessionRow | null> {
  if (!code) return null;
  const row = await ctx.env.DB.prepare("SELECT * FROM oidc_sessions WHERE code = ?")
    .bind(code)
    .first<OidcSessionRow>();
  if (!row || nowSec() - row.created_at > OIDC_TTL_SECS) return null;
  return row;
}

const oidcAuth: Handler = async (ctx) => {
  const code = newId();
  await ctx.env.DB.prepare(
    "INSERT INTO oidc_sessions (code, user_name, authed, created_at) VALUES (?, '', 0, ?)",
  )
    .bind(code, nowSec())
    .run();
  return send({ code, url: `${ctx.url.origin}/login?code=${code}` });
};

const oidcAuthQuery: Handler = async (ctx) => {
  const code = ctx.url.searchParams.get("code") ?? "";
  const row = await oidcSession(ctx, code);
  const user = row && row.authed ? await getUser(ctx.env.DB, row.user_name) : null;
  if (!user) {
    // The client keeps polling only while it sees exactly this message.
    return send({ body: JSON.stringify({ error: "No authed oidc is found" }) });
  }
  const token = await newToken(ctx.env.DB, user.name);
  await ctx.env.DB.prepare("DELETE FROM oidc_sessions WHERE code = ?").bind(code).run();
  return send({
    body: JSON.stringify({
      access_token: token,
      type: "access_token",
      tfa_type: "",
      secret: "",
      // `info` is not optional in the Rust `UserPayload`, so it is always sent.
      user: { ...userPayload(user), info: {} },
    }),
  });
};

const LOGIN_STYLE = `body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#15171c;color:#e8eaed;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{width:min(360px,90vw);padding:32px;background:#1e2128;border:1px solid #2c3038;border-radius:12px}
h1{margin:0 0 4px;font-size:20px}p{margin:0 0 20px;color:#9aa0a6;font-size:13px}
p.err{color:#f28b82}label{display:block;margin-bottom:14px;font-size:13px;color:#9aa0a6}
input{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:9px 10px;
background:#15171c;border:1px solid #3c4043;border-radius:8px;color:#e8eaed;font-size:15px}
button{width:100%;padding:10px;margin-top:6px;border:0;border-radius:8px;
background:#8ab4f8;color:#202124;font-size:15px;font-weight:600;cursor:pointer}`;

function loginForm(code: string, error: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title><style>${LOGIN_STYLE}</style></head><body><main>
<h1>Sign in</h1><p>RustDesk self-hosted API</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/login">
<input type="hidden" name="code" value="${escapeHtml(code)}">
<label>Username<input name="username" autocomplete="username" autofocus required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
<button type="submit">Sign in</button>
</form></main></body></html>`;
}

function loginDone(name: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signed in</title><style>${LOGIN_STYLE}</style></head><body><main>
<h1>Signed in</h1><p>${escapeHtml(name)}</p>
<p>You can close this tab and return to RustDesk.</p>
</main></body></html>`;
}

/**
 * Serves the sign-in screen. Reached from the browser through a one-off code,
 * so it is the one path that stays outside the secret gate.
 */
const loginPage: Handler = async (ctx) => {
  let code = ctx.url.searchParams.get("code") ?? "";
  if (ctx.request.method === "POST") {
    const form = new URLSearchParams(await ctx.request.text());
    code = form.get("code") ?? code;
    if (!(await oidcSession(ctx, code))) {
      return html(loginForm("", "This sign-in link has expired. Start again from the client."), 400);
    }
    const username = (form.get("username") ?? "").trim();
    const password = form.get("password") ?? "";
    const row = await getUser(ctx.env.DB, username);
    if (!row || !(await passwordMatches(row.password_hash, password))) {
      return html(loginForm(code, "Invalid username or password."), 401);
    }
    await ctx.env.DB.prepare("UPDATE oidc_sessions SET user_name = ?, authed = 1 WHERE code = ?")
      .bind(row.name, code)
      .run();
    return html(loginDone(row.display_name || row.name));
  }
  if (!(await oidcSession(ctx, code))) {
    return html(loginForm("", "This sign-in link has expired. Start again from the client."), 400);
  }
  return html(loginForm(code, ""));
};

const audit: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const body = ((await readJson(ctx.request)) as Record<string, unknown> | null) ?? {};
  const guid = String(body.guid ?? "");
  if (!guid) return fail(400, "guid is required");
  await setAuditNote(ctx.env.DB, guid, String(body.note ?? ""));
  return send(null);
};

// -- endpoints: address book ------------------------------------------------ //

const abPersonal: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const ab = await personalAb(ctx.env.DB, user.name);
  return send({ guid: ab.guid });
};

const abSharedProfiles: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, rows } = await listSharedAb(ctx.env.DB, user.name, pageSize, offset);
  return send({ total, data: rows.map(abProfilePayload) });
};

const abSettings: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  // 0 == no per-address-book device limit.
  return send({ max_peer_one_ab: 0 });
};

/**
 * `GET /api/ab` — the pre-shared-address-book endpoint.
 *
 * Still served so an old client (or a client that downgraded to legacy mode)
 * keeps working: the personal address book is serialised into the single `data`
 * string field the legacy format expects.
 */
const abLegacyPull: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const ab = await personalAb(ctx.env.DB, user.name);
  const { rows } = await listAbPeers(ctx.env.DB, ab.guid, 10_000, 0);
  const tags = await listAbTags(ctx.env.DB, ab.guid);
  const data = {
    tags: tags.map((t) => t.name),
    peers: rows.map((r) => JSON.parse(r.payload)),
    tag_colors: JSON.stringify(Object.fromEntries(tags.map((t) => [t.name, t.color]))),
  };
  return send({ licensed_devices: 0, data: JSON.stringify(data) });
};

const abLegacyPush: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const body = ((await readJson(ctx.request)) as Record<string, unknown> | null) ?? {};
  const raw = body.data;
  if (typeof raw === "string" && raw) {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return fail(400, "invalid data");
    }
    const ab = await personalAb(ctx.env.DB, user.name);
    const colors = (() => {
      try {
        const parsed = JSON.parse(String(data.tag_colors ?? "{}"));
        return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
      } catch {
        return {};
      }
    })();
    for (const tag of (data.tags as unknown[]) ?? []) {
      const name = String(tag);
      await addAbTag(ctx.env.DB, ab.guid, name, colors[name] ?? 0);
    }
    for (const peer of (data.peers as Record<string, unknown>[]) ?? []) {
      await upsertAbPeer(ctx.env.DB, ab.guid, peer);
    }
  }
  return send(null);
};

const abPeers: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const guid = await resolveAbGuid(ctx, user, ctx.url.searchParams.get("ab") ?? "");
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, rows } = await listAbPeers(ctx.env.DB, guid, pageSize, offset);
  return send({ total, data: rows.map(peerRowPayload) });
};

const abPeerAdd: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const body = await readJson(ctx.request);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return fail(400, "invalid body");
  }
  const guid = ctx.segments[ctx.segments.length - 1] ?? "";
  const target = await resolveAbGuid(ctx, user, guid);
  await upsertAbPeer(ctx.env.DB, target, body as Record<string, unknown>);
  // Adding a peer implicitly registers it as reachable, which is what makes it
  // show up under "Accessible devices".
  await registerDevice(ctx, user, body as Record<string, unknown>);
  return send(null);
};

const abPeerUpdate: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const body = await readJson(ctx.request);
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return fail(400, "invalid body");
  }
  const guid = ctx.segments[ctx.segments.length - 1] ?? "";
  const target = await resolveAbGuid(ctx, user, guid);
  const patch = body as Record<string, unknown>;
  const updated = await updateAbPeer(ctx.env.DB, target, patch);
  if (!updated) {
    // The client pushes password/sync patches for peers it considers known.
    // Upsert instead of failing so sync never errors out.
    await upsertAbPeer(ctx.env.DB, target, patch);
  }
  await registerDevice(ctx, user, patch);
  return send(null);
};

const abPeerDelete: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const body = await readJson(ctx.request);
  const ids = Array.isArray(body) ? body.map((i) => String(i)) : [];
  const guid = ctx.segments[ctx.segments.length - 1] ?? "";
  const target = await resolveAbGuid(ctx, user, guid);
  await deleteAbPeers(ctx.env.DB, target, ids);
  return send(null);
};

const abTagsList: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const guid = ctx.segments[ctx.segments.length - 1] ?? "";
  const target = await resolveAbGuid(ctx, user, guid);
  return send(await listAbTags(ctx.env.DB, target));
};

const abTagAdd: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const body = ((await readJson(ctx.request)) as Record<string, unknown> | null) ?? {};
  const guid = ctx.segments[ctx.segments.length - 1] ?? "";
  const target = await resolveAbGuid(ctx, user, guid);
  await addAbTag(
    ctx.env.DB,
    target,
    String(body.name ?? ""),
    Number(body.color ?? 0) || 0,
  );
  return send(null);
};

const abTagRename: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const body = ((await readJson(ctx.request)) as Record<string, unknown> | null) ?? {};
  const guid = ctx.segments[ctx.segments.length - 1] ?? "";
  const target = await resolveAbGuid(ctx, user, guid);
  await renameAbTag(ctx.env.DB, target, String(body.old ?? ""), String(body.new ?? ""));
  return send(null);
};

const abTagUpdate: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const body = ((await readJson(ctx.request)) as Record<string, unknown> | null) ?? {};
  const guid = ctx.segments[ctx.segments.length - 1] ?? "";
  const target = await resolveAbGuid(ctx, user, guid);
  await addAbTag(
    ctx.env.DB,
    target,
    String(body.name ?? ""),
    Number(body.color ?? 0) || 0,
  );
  return send(null);
};

const abTagDelete: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const body = await readJson(ctx.request);
  const names = Array.isArray(body) ? body.map((n) => String(n)) : [];
  const guid = ctx.segments[ctx.segments.length - 1] ?? "";
  const target = await resolveAbGuid(ctx, user, guid);
  await deleteAbTags(ctx.env.DB, target, names);
  return send(null);
};

// -- endpoints: accessible devices ------------------------------------------ //

const deviceGroups: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, rows } = await listDeviceGroups(ctx.env.DB, user.name, pageSize, offset);
  return send({ total, data: rows });
};

const users: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, rows } = await listUsers(ctx.env.DB, pageSize, offset);
  return send({ total, data: rows.map(userPayload) });
};

const peers: Handler = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, payloads } = await listDevices(ctx.env.DB, user.name, pageSize, offset);
  const data = payloads.map((payload) => {
    const info = (payload.info as Record<string, unknown>) ?? {};
    return {
      id: payload.id ?? "",
      info: {
        username: info.username ?? "",
        os: info.os ?? "",
        device_name: info.device_name ?? "",
      },
      status: payload.status ?? 1,
      user: payload.user ?? "",
      user_name: payload.user_name ?? "",
      device_group_name: payload.device_group_name ?? "",
      note: payload.note ?? "",
    };
  });
  return send({ total, data });
};

// -- routing ---------------------------------------------------------------- //

const SIMPLE_ROUTES: Record<string, Handler> = {
  "POST login": login,
  "POST currentUser": currentUserEndpoint,
  "POST logout": logout,
  "GET login-options": loginOptions,
  "POST oidc/auth": oidcAuth,
  "GET oidc/auth-query": oidcAuthQuery,
  "PUT audit": audit,
  "POST ab/personal": abPersonal,
  "POST ab/shared/profiles": abSharedProfiles,
  "POST ab/settings": abSettings,
  "GET ab": abLegacyPull,
  "POST ab": abLegacyPush,
  "POST ab/peers": abPeers,
  "GET device-group/accessible": deviceGroups,
  "GET users": users,
  "GET peers": peers,
  "GET devices": peers,
};

/** Routes whose trailing segment is the address book guid. */
const GUID_ROUTES: Record<string, Handler> = {
  peers: abPeers,
  tags: abTagsList,
  "peer/add": abPeerAdd,
  "peer/update": abPeerUpdate,
  peer: abPeerDelete,
  "tag/add": abTagAdd,
  "tag/rename": abTagRename,
  "tag/update": abTagUpdate,
  tag: abTagDelete,
};

function resolveHandler(ctx: Ctx): Handler | null {
  const { segments } = ctx;
  if (segments[0] !== "api") {
    // Unauthenticated health probes for the operator.
    if (ctx.request.method === "GET" && (segments.length === 0 || segments[0] === "health")) {
      return health;
    }
    return null;
  }
  const route = segments.slice(1);
  if (route.length >= 3 && route[0] === "ab") {
    const head = route.slice(1, -1).join("/");
    const target = GUID_ROUTES[head];
    if (target) return target;
  }
  return SIMPLE_ROUTES[`${ctx.request.method} ${route.join("/")}`] ?? null;
}

/**
 * Enforce the shared secret carried in the first path segment.
 *
 * The client's "API Server" option accepts a path, so the secret rides there
 * with no client change: `https://<host>/<ACCESS_TOKEN>`. Returns the path with
 * the secret removed, or the response to send instead. `/health` stays open so
 * the deployment can be probed.
 */
function gatePath(env: Env, segments: string[]): string[] | Response {
  const secret = (env.ACCESS_TOKEN ?? "").trim();
  if (!secret) return segments;
  if (segments[0] === secret) return segments.slice(1);
  if (segments.length === 0 || segments[0] === "health") return segments;
  return new Response("forbidden", {
    status: 403,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    let segments = url.pathname
      .split("/")
      .filter(Boolean)
      .map((s) => decodeURIComponent(s));

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // The sign-in screen is opened from a browser via a one-off code, so it is
    // the only endpoint outside the secret gate.
    if (segments[0] === "login") {
      return loginPage({ env, request, url, segments, path });
    }

    const gated = gatePath(env, segments);
    if (gated instanceof Response) return gated;
    segments = gated;

    const ctx: Ctx = { env, request, url, segments, path };
    try {
      await ensureSchema(env);
      const handler = resolveHandler(ctx);
      if (!handler) return fail(404, `not found: ${request.method} ${path}`);
      return await handler(ctx);
    } catch (exc) {
      if (exc instanceof ApiError) return fail(exc.status, exc.message);
      return fail(500, exc instanceof Error ? exc.message : String(exc));
    }
  },
};
