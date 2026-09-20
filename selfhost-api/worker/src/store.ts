/**
 * Every D1 query in one place.
 *
 * Handlers stay about HTTP; this module stays about rows. Two conventions run
 * through it:
 *
 *   * Column defaults matter. `upsert*` only writes the columns it is given, so
 *     a partial patch from the client (the address book sends a bare
 *     `{"id": ..., "alias": ...}` on every edit) never erases stored fields.
 *   * Lists always come back as `{total, rows}` because every list endpoint the
 *     client calls pages with `current`/`pageSize` and stops on `total`.
 */

import type {
  AbPeerRow,
  AbRow,
  AbRuleRow,
  AbTagRow,
  AuditConnRow,
  D1Database,
  DeviceGroupRow,
  DeviceRow,
  Env,
  StrategyRow,
  UserRow,
} from "./env";
import { AUDIT_NONCE_TTL_SECS, RULE_FULL, RULE_READ } from "./env";
import { nowSec, newId, parseJson, str } from "./util";

// --------------------------------------------------------------------------- //
// query helpers
// --------------------------------------------------------------------------- //

function prep(db: D1Database, sql: string, params: unknown[]) {
  const statement = db.prepare(sql);
  return params.length > 0 ? statement.bind(...params) : statement;
}

async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await prep(db, sql, params).all<T>();
  return results;
}

async function one<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  return await prep(db, sql, params).first<T>();
}

async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<void> {
  await prep(db, sql, params).run();
}

const placeholders = (count: number): string => new Array(count).fill("?").join(", ");

// --------------------------------------------------------------------------- //
// users
// --------------------------------------------------------------------------- //

export interface NewUser {
  name: string;
  displayName?: string;
  email?: string;
  note?: string;
  avatar?: string;
  passwordHash?: string;
  isAdmin?: boolean;
  status?: number;
  strategyName?: string;
  tfaSecret?: string;
  tfaType?: string;
}

export async function ensureUser(db: D1Database, user: NewUser): Promise<UserRow> {
  await run(
    db,
    "INSERT OR IGNORE INTO users" +
      " (name, display_name, avatar, email, note, is_admin, status, password_hash," +
      "  tfa_secret, tfa_type, strategy_name, verifier, created_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)",
    user.name,
    user.displayName ?? "",
    user.avatar ?? "",
    user.email ?? "",
    user.note ?? "",
    user.isAdmin ? 1 : 0,
    user.status ?? 1,
    user.passwordHash ?? "",
    user.tfaSecret ?? "",
    user.tfaType ?? "",
    user.strategyName ?? "",
    nowSec(),
  );
  return (await getUser(db, user.name)) as UserRow;
}

export async function getUser(db: D1Database, name: string): Promise<UserRow | null> {
  return await one<UserRow>(db, "SELECT * FROM users WHERE name = ?", name);
}

/** True when the row was created; false when the name was already taken. */
export async function createUser(db: D1Database, user: NewUser): Promise<boolean> {
  const existing = await getUser(db, user.name);
  if (existing) return false;
  await ensureUser(db, user);
  return true;
}

const USER_PATCHABLE = new Set([
  "display_name",
  "avatar",
  "email",
  "note",
  "is_admin",
  "status",
  "password_hash",
  "tfa_secret",
  "tfa_type",
  "strategy_name",
  "verifier",
]);

export async function updateUser(
  db: D1Database,
  name: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const entries = Object.entries(patch).filter(
    ([key, value]) => USER_PATCHABLE.has(key) && value !== undefined,
  );
  if (entries.length === 0) return (await getUser(db, name)) !== null;
  const sets = entries.map(([key]) => `${key} = ?`).join(", ");
  const params = entries.map(([, value]) => value);
  await run(db, `UPDATE users SET ${sets} WHERE name = ?`, ...params, name);
  return true;
}

/** Removes the account and everything it owned, so no orphans are left. */
export async function deleteUsers(db: D1Database, names: string[]): Promise<void> {
  if (names.length === 0) return;
  const marks = placeholders(names.length);
  const books = await all<{ guid: string }>(
    db,
    `SELECT guid FROM address_books WHERE user_name IN (${marks})`,
    ...names,
  );
  const guids = books.map((b) => b.guid);
  const statements = [
    db.prepare(`DELETE FROM tokens WHERE user_name IN (${marks})`).bind(...names),
    db.prepare(`DELETE FROM users WHERE name IN (${marks})`).bind(...names),
    db.prepare(`DELETE FROM devices WHERE user_name IN (${marks})`).bind(...names),
    db.prepare(`DELETE FROM device_groups WHERE user_name IN (${marks})`).bind(...names),
    db.prepare(`DELETE FROM address_books WHERE user_name IN (${marks})`).bind(...names),
  ];
  if (guids.length > 0) {
    const gmarks = placeholders(guids.length);
    statements.push(
      db.prepare(`DELETE FROM ab_peers WHERE guid IN (${gmarks})`).bind(...guids),
      db.prepare(`DELETE FROM ab_tags WHERE guid IN (${gmarks})`).bind(...guids),
      db.prepare(`DELETE FROM ab_rules WHERE ab_guid IN (${gmarks})`).bind(...guids),
    );
  }
  await db.batch(statements);
}

export async function listUsers(
  db: D1Database,
  options: { limit: number; offset: number; names?: string[] | null; status?: number | null },
): Promise<{ total: number; rows: UserRow[] }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.names !== undefined && options.names !== null) {
    if (options.names.length === 0) return { total: 0, rows: [] };
    clauses.push(`name IN (${placeholders(options.names.length)})`);
    params.push(...options.names);
  }
  if (options.status !== undefined && options.status !== null) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const count = await one<{ c: number }>(db, `SELECT COUNT(*) AS c FROM users${where}`, ...params);
  const rows = await all<UserRow>(
    db,
    `SELECT * FROM users${where} ORDER BY name LIMIT ? OFFSET ?`,
    ...params,
    options.limit,
    options.offset,
  );
  return { total: Number(count?.c ?? 0), rows };
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM users");
  return Number(row?.c ?? 0);
}

// --------------------------------------------------------------------------- //
// tokens
// --------------------------------------------------------------------------- //

export async function newToken(db: D1Database, userName: string, ttlSecs: number): Promise<string> {
  const token = newId() + newId();
  const now = nowSec();
  await run(
    db,
    "INSERT INTO tokens (token, user_name, created_at, expires_at) VALUES (?, ?, ?, ?)",
    token,
    userName,
    now,
    ttlSecs > 0 ? now + ttlSecs : 0,
  );
  return token;
}

export async function userForToken(db: D1Database, token: string): Promise<string | null> {
  if (!token) return null;
  const row = await one<{ user_name: string; expires_at: number }>(
    db,
    "SELECT user_name, expires_at FROM tokens WHERE token = ?",
    token,
  );
  if (!row) return null;
  if (row.expires_at > 0 && row.expires_at < nowSec()) {
    await run(db, "DELETE FROM tokens WHERE token = ?", token);
    return null;
  }
  return row.user_name;
}

export async function dropToken(db: D1Database, token: string): Promise<void> {
  if (!token) return;
  await run(db, "DELETE FROM tokens WHERE token = ?", token);
}

export async function dropUserTokens(db: D1Database, userName: string): Promise<void> {
  await run(db, "DELETE FROM tokens WHERE user_name = ?", userName);
}

// --------------------------------------------------------------------------- //
// address books
// --------------------------------------------------------------------------- //

export async function personalAb(db: D1Database, userName: string): Promise<AbRow> {
  const existing = await one<AbRow>(
    db,
    "SELECT * FROM address_books WHERE user_name = ? AND kind = 'personal'",
    userName,
  );
  if (existing) return existing;
  const guid = newId();
  const created = nowSec();
  await run(
    db,
    "INSERT INTO address_books (guid, user_name, name, kind, owner, rule, note, info, created_at)" +
      " VALUES (?, ?, 'My address book', 'personal', ?, ?, '', '{}', ?)",
    guid,
    userName,
    userName,
    RULE_FULL,
    created,
  );
  return {
    guid,
    user_name: userName,
    name: "My address book",
    kind: "personal",
    owner: userName,
    rule: RULE_FULL,
    note: "",
    info: "{}",
    created_at: created,
  };
}

export async function getAb(db: D1Database, guid: string): Promise<AbRow | null> {
  if (!guid) return null;
  return await one<AbRow>(db, "SELECT * FROM address_books WHERE guid = ?", guid);
}

export async function createAb(
  db: D1Database,
  book: {
    userName: string;
    name: string;
    kind?: string;
    owner?: string;
    rule?: number;
    note?: string;
    info?: string;
  },
): Promise<AbRow> {
  const guid = newId();
  const row: AbRow = {
    guid,
    user_name: book.userName,
    name: book.name,
    kind: book.kind ?? "shared",
    owner: book.owner ?? book.userName,
    rule: book.rule ?? RULE_READ,
    note: book.note ?? "",
    info: book.info ?? "{}",
    created_at: nowSec(),
  };
  await run(
    db,
    "INSERT INTO address_books (guid, user_name, name, kind, owner, rule, note, info, created_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    row.guid,
    row.user_name,
    row.name,
    row.kind,
    row.owner,
    row.rule,
    row.note,
    row.info,
    row.created_at,
  );
  return row;
}

const AB_PATCHABLE = new Set(["name", "owner", "rule", "note", "info", "user_name"]);

export async function updateAb(
  db: D1Database,
  guid: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const entries = Object.entries(patch).filter(
    ([key, value]) => AB_PATCHABLE.has(key) && value !== undefined,
  );
  if (entries.length === 0) return (await getAb(db, guid)) !== null;
  const sets = entries.map(([key]) => `${key} = ?`).join(", ");
  await run(
    db,
    `UPDATE address_books SET ${sets} WHERE guid = ?`,
    ...entries.map(([, value]) => value),
    guid,
  );
  return true;
}

export async function deleteAbs(db: D1Database, guids: string[]): Promise<void> {
  if (guids.length === 0) return;
  const marks = placeholders(guids.length);
  await db.batch([
    db.prepare(`DELETE FROM address_books WHERE guid IN (${marks})`).bind(...guids),
    db.prepare(`DELETE FROM ab_peers WHERE guid IN (${marks})`).bind(...guids),
    db.prepare(`DELETE FROM ab_tags WHERE guid IN (${marks})`).bind(...guids),
    db.prepare(`DELETE FROM ab_rules WHERE ab_guid IN (${marks})`).bind(...guids),
  ]);
}

/**
 * Address books of a given kind that the caller may see.
 *
 * A row is visible when the caller owns it, is an administrator, or when an
 * `ab_rules` row grants it to them or to `everyone`. Rules that target a group
 * are only honoured for administrators: this server has no group membership
 * model, so a group rule can only be interpreted as "nobody in particular".
 */
export async function listAbs(
  db: D1Database,
  options: {
    userName: string;
    isAdmin: boolean;
    kind?: string;
    nameLike?: string | null;
    limit: number;
    offset: number;
  },
): Promise<{ total: number; rows: (AbRow & { granted_rule: number })[] }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.kind) {
    clauses.push("ab.kind = ?");
    params.push(options.kind);
  }
  if (options.nameLike) {
    clauses.push("ab.name LIKE ?");
    params.push(options.nameLike);
  }
  if (!options.isAdmin) {
    clauses.push(
      "(ab.user_name = ? OR ab.guid IN (" +
        "SELECT ab_guid FROM ab_rules WHERE target_kind = 'everyone'" +
        " OR (target_kind = 'user' AND target = ?)))",
    );
    params.push(options.userName, options.userName);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const granted =
    "(SELECT COALESCE(MAX(r.rule), 0) FROM ab_rules r WHERE r.ab_guid = ab.guid" +
    " AND (r.target_kind = 'everyone' OR (r.target_kind = 'user' AND r.target = ?)))";
  const select =
    `SELECT ab.*, ${granted} AS granted_rule FROM address_books ab${where}`;
  const count = await one<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c FROM address_books ab${where}`,
    ...params,
  );
  const rows = await all<AbRow & { granted_rule: number }>(
    db,
    `${select} ORDER BY ab.name LIMIT ? OFFSET ?`,
    options.userName,
    ...params,
    options.limit,
    options.offset,
  );
  return { total: Number(count?.c ?? 0), rows };
}

/** The caller's effective share rule on one address book. 0 means no access. */
export async function effectiveRule(
  db: D1Database,
  ab: AbRow,
  userName: string,
  isAdmin: boolean,
): Promise<number> {
  if (isAdmin || ab.user_name === userName || ab.owner === userName) return RULE_FULL;
  const row = await one<{ r: number | null }>(
    db,
    "SELECT MAX(rule) AS r FROM ab_rules WHERE ab_guid = ?" +
      " AND (target_kind = 'everyone' OR (target_kind = 'user' AND target = ?))",
    ab.guid,
    userName,
  );
  return Number(row?.r ?? 0);
}

export async function listAbRules(
  db: D1Database,
  abGuid: string,
  limit: number,
  offset: number,
): Promise<{ total: number; rows: AbRuleRow[] }> {
  const count = await one<{ c: number }>(
    db,
    "SELECT COUNT(*) AS c FROM ab_rules WHERE ab_guid = ?",
    abGuid,
  );
  const rows = await all<AbRuleRow>(
    db,
    "SELECT * FROM ab_rules WHERE ab_guid = ? ORDER BY created_at LIMIT ? OFFSET ?",
    abGuid,
    limit,
    offset,
  );
  return { total: Number(count?.c ?? 0), rows };
}

export async function addAbRule(
  db: D1Database,
  rule: { abGuid: string; targetKind: string; target: string; rule: number },
): Promise<AbRuleRow> {
  const existing = await one<AbRuleRow>(
    db,
    "SELECT * FROM ab_rules WHERE ab_guid = ? AND target_kind = ? AND target = ?",
    rule.abGuid,
    rule.targetKind,
    rule.target,
  );
  if (existing) {
    await run(db, "UPDATE ab_rules SET rule = ? WHERE guid = ?", rule.rule, existing.guid);
    return { ...existing, rule: rule.rule };
  }
  const guid = newId();
  const created = nowSec();
  await run(
    db,
    "INSERT INTO ab_rules (guid, ab_guid, target_kind, target, rule, created_at)" +
      " VALUES (?, ?, ?, ?, ?, ?)",
    guid,
    rule.abGuid,
    rule.targetKind,
    rule.target,
    rule.rule,
    created,
  );
  return { guid, ab_guid: rule.abGuid, target_kind: rule.targetKind, target: rule.target, rule: rule.rule, created_at: created };
}

export async function getAbRule(db: D1Database, guid: string): Promise<AbRuleRow | null> {
  return await one<AbRuleRow>(db, "SELECT * FROM ab_rules WHERE guid = ?", guid);
}

export async function updateAbRule(
  db: D1Database,
  guid: string,
  rule: number,
): Promise<boolean> {
  const existing = await getAbRule(db, guid);
  if (!existing) return false;
  await run(db, "UPDATE ab_rules SET rule = ? WHERE guid = ?", rule, guid);
  return true;
}

export async function deleteAbRules(db: D1Database, guids: string[]): Promise<void> {
  if (guids.length === 0) return;
  await run(db, `DELETE FROM ab_rules WHERE guid IN (${placeholders(guids.length)})`, ...guids);
}

// --------------------------------------------------------------------------- //
// address book peers
// --------------------------------------------------------------------------- //

export async function listAbPeers(
  db: D1Database,
  guid: string,
  options: {
    limit: number;
    offset: number;
    idLike?: string | null;
    aliasLike?: string | null;
  },
): Promise<{ total: number; rows: AbPeerRow[] }> {
  const clauses = ["guid = ?"];
  const params: unknown[] = [guid];
  if (options.idLike) {
    clauses.push("id LIKE ?");
    params.push(options.idLike);
  }
  if (options.aliasLike) {
    // `alias` lives inside the peer json, so this is a payload substring match.
    clauses.push("payload LIKE ?");
    params.push(options.aliasLike);
  }
  const where = clauses.join(" AND ");
  const count = await one<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c FROM ab_peers WHERE ${where}`,
    ...params,
  );
  const rows = await all<AbPeerRow>(
    db,
    `SELECT * FROM ab_peers WHERE ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    ...params,
    options.limit,
    options.offset,
  );
  return { total: Number(count?.c ?? 0), rows };
}

export async function allAbPeers(db: D1Database, guid: string): Promise<AbPeerRow[]> {
  return await all<AbPeerRow>(
    db,
    "SELECT * FROM ab_peers WHERE guid = ? ORDER BY updated_at DESC",
    guid,
  );
}

export async function countAbPeers(db: D1Database, guid: string): Promise<number> {
  const row = await one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM ab_peers WHERE guid = ?", guid);
  return Number(row?.c ?? 0);
}

export async function upsertAbPeer(
  db: D1Database,
  guid: string,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const peerId = str(payload.id);
  if (!peerId) return false;
  const tags = Array.isArray(payload.tags) ? payload.tags : [];
  const body = { ...payload, id: peerId, tags };
  await run(
    db,
    "INSERT INTO ab_peers (guid, id, payload, tags, updated_at) VALUES (?, ?, ?, ?, ?)" +
      " ON CONFLICT(guid, id) DO UPDATE SET payload = excluded.payload," +
      " tags = excluded.tags, updated_at = excluded.updated_at",
    guid,
    peerId,
    JSON.stringify(body),
    JSON.stringify(tags),
    nowSec(),
  );
  return true;
}

export async function updateAbPeer(
  db: D1Database,
  guid: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const peerId = str(patch.id);
  if (!peerId) return false;
  const row = await one<{ payload: string; tags: string }>(
    db,
    "SELECT payload, tags FROM ab_peers WHERE guid = ? AND id = ?",
    guid,
    peerId,
  );
  if (!row) return false;

  const payload = parseJson<Record<string, unknown>>(row.payload, {});
  let tags: unknown = parseJson<unknown>(row.tags, []);
  for (const [key, value] of Object.entries(patch)) {
    if (key === "tags") {
      tags = Array.isArray(value) ? value : [];
      payload.tags = tags;
    } else if (key !== "id") {
      payload[key] = value;
    }
  }
  await run(
    db,
    "UPDATE ab_peers SET payload = ?, tags = ?, updated_at = ? WHERE guid = ? AND id = ?",
    JSON.stringify(payload),
    JSON.stringify(tags),
    nowSec(),
    guid,
    peerId,
  );
  return true;
}

export async function deleteAbPeers(
  db: D1Database,
  guid: string,
  ids: string[],
): Promise<number> {
  if (ids.length === 0) return 0;
  await run(
    db,
    `DELETE FROM ab_peers WHERE guid = ? AND id IN (${placeholders(ids.length)})`,
    guid,
    ...ids,
  );
  return ids.length;
}

/**
 * Rewrite the tags of every peer in an address book.
 *
 * Both copies have to be written: the `tags` column, and `payload.tags` inside
 * the stored json. `peerPayload` reads the json and `GET /api/ab` hands the
 * stored payload straight to the client, so updating only the column leaves
 * every reader looking at the old list.
 */
async function rewritePeerTags(
  db: D1Database,
  guid: string,
  mutate: (tags: string[]) => string[] | null,
): Promise<void> {
  const rows = await all<{ id: string; tags: string; payload: string }>(
    db,
    "SELECT id, tags, payload FROM ab_peers WHERE guid = ?",
    guid,
  );
  const statements = [];
  for (const row of rows) {
    const payload = parseJson<Record<string, unknown>>(row.payload, {});
    const current = Array.isArray(payload.tags) ? (payload.tags as string[]) : parseJson<string[]>(row.tags, []);
    const next = mutate(current);
    if (next === null) continue;
    payload.tags = next;
    statements.push(
      db
        .prepare("UPDATE ab_peers SET payload = ?, tags = ? WHERE guid = ? AND id = ?")
        .bind(JSON.stringify(payload), JSON.stringify(next), guid, row.id),
    );
  }
  if (statements.length > 0) await db.batch(statements);
}

export async function renamePeerTag(
  db: D1Database,
  guid: string,
  oldName: string,
  newName: string,
): Promise<void> {
  await rewritePeerTags(db, guid, (tags) =>
    tags.includes(oldName)
      ? [...new Set(tags.map((tag) => (tag === oldName ? newName : tag)))]
      : null,
  );
}

export async function dropPeerTag(db: D1Database, guid: string, name: string): Promise<void> {
  await rewritePeerTags(db, guid, (tags) =>
    tags.includes(name) ? tags.filter((tag) => tag !== name) : null,
  );
}

// --------------------------------------------------------------------------- //
// address book tags
// --------------------------------------------------------------------------- //

export async function listAbTags(db: D1Database, guid: string): Promise<AbTagRow[]> {
  return await all<AbTagRow>(
    db,
    "SELECT name, color FROM ab_tags WHERE guid = ? ORDER BY name",
    guid,
  );
}

export async function getAbTagColor(db: D1Database, guid: string, name: string): Promise<number> {
  const row = await one<{ color: number }>(
    db,
    "SELECT color FROM ab_tags WHERE guid = ? AND name = ?",
    guid,
    name,
  );
  return Number(row?.color ?? 0);
}

export async function addAbTag(
  db: D1Database,
  guid: string,
  name: string,
  color: number,
): Promise<boolean> {
  if (!name) return false;
  await run(
    db,
    "INSERT INTO ab_tags (guid, name, color) VALUES (?, ?, ?)" +
      " ON CONFLICT(guid, name) DO UPDATE SET color = excluded.color",
    guid,
    name,
    Math.trunc(color || 0),
  );
  return true;
}

export async function deleteAbTags(
  db: D1Database,
  guid: string,
  names: string[],
): Promise<void> {
  if (names.length === 0) return;
  await run(
    db,
    `DELETE FROM ab_tags WHERE guid = ? AND name IN (${placeholders(names.length)})`,
    guid,
    ...names,
  );
  for (const name of names) await dropPeerTag(db, guid, name);
}

// --------------------------------------------------------------------------- //
// devices
// --------------------------------------------------------------------------- //

const DEVICE_COLUMNS = [
  "user_name",
  "device_group_name",
  "strategy_name",
  "note",
  "status",
  "info",
  "payload",
  "pk",
  "uuid",
  "ver",
  "ip",
  "conns",
  "last_online",
] as const;

/** Columns `upsertDevice` will write. Anything else is ignored. */
export type DevicePatch = Partial<Record<(typeof DEVICE_COLUMNS)[number], unknown>>;

export async function getDevice(db: D1Database, id: string): Promise<DeviceRow | null> {
  if (!id) return null;
  return await one<DeviceRow>(db, "SELECT * FROM devices WHERE id = ?", id);
}

/**
 * Insert a device, or merge the given columns into the existing row.
 *
 * Only the supplied columns are written, so a heartbeat that carries three
 * fields cannot wipe the sysinfo the device reported earlier.
 */
export async function upsertDevice(
  db: D1Database,
  id: string,
  patch: DevicePatch,
): Promise<void> {
  const entries = Object.entries(patch).filter(
    ([key, value]) => (DEVICE_COLUMNS as readonly string[]).includes(key) && value !== undefined,
  );
  const keys = entries.map(([key]) => key);
  const values = entries.map(([, value]) => value);
  const now = nowSec();
  const updates = keys.map((key) => `${key} = excluded.${key}`).join(", ");
  const suffix = updates ? `${updates}, updated_at = excluded.updated_at` : "updated_at = excluded.updated_at";
  await run(
    db,
    `INSERT INTO devices (id, created_at, updated_at${keys.length ? ", " + keys.join(", ") : ""})` +
      ` VALUES (?, ?, ?${keys.length ? ", " + placeholders(keys.length) : ""})` +
      ` ON CONFLICT(id) DO UPDATE SET ${suffix}`,
    id,
    now,
    now,
    ...values,
  );
}

export async function listDevices(
  db: D1Database,
  options: {
    limit: number;
    offset: number;
    ids?: string[] | null;
    owner?: string | null;
    groupLike?: string | null;
    status?: number | null;
  },
): Promise<{ total: number; rows: DeviceRow[] }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.ids) {
    if (options.ids.length === 0) return { total: 0, rows: [] };
    clauses.push(`id IN (${placeholders(options.ids.length)})`);
    params.push(...options.ids);
  }
  if (options.owner) {
    clauses.push("user_name = ?");
    params.push(options.owner);
  }
  if (options.groupLike) {
    clauses.push("device_group_name LIKE ?");
    params.push(options.groupLike);
  }
  if (options.status !== undefined && options.status !== null) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const count = await one<{ c: number }>(db, `SELECT COUNT(*) AS c FROM devices${where}`, ...params);
  const rows = await all<DeviceRow>(
    db,
    `SELECT * FROM devices${where} ORDER BY last_online DESC, id LIMIT ? OFFSET ?`,
    ...params,
    options.limit,
    options.offset,
  );
  return { total: Number(count?.c ?? 0), rows };
}

export async function deleteDevices(db: D1Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await run(db, `DELETE FROM devices WHERE id IN (${placeholders(ids.length)})`, ...ids);
}

export async function countDevices(db: D1Database): Promise<number> {
  const row = await one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM devices");
  return Number(row?.c ?? 0);
}

/**
 * The device ids the caller may see, or `null` for "everything" (admins).
 *
 * A device is reachable when the caller owns it or when it is a peer of an
 * address book the caller can read. That mirrors what the client's
 * "Accessible devices" page is meant to show.
 */
export async function accessibleDeviceIds(
  db: D1Database,
  userName: string,
  isAdmin: boolean,
): Promise<string[] | null> {
  if (isAdmin) return null;
  const ids = new Set<string>();
  const owned = await all<{ id: string }>(db, "SELECT id FROM devices WHERE user_name = ?", userName);
  for (const row of owned) ids.add(row.id);

  const books = await listAbs(db, {
    userName,
    isAdmin: false,
    limit: 1000,
    offset: 0,
  });
  for (const book of books.rows) {
    const peers = await all<{ id: string }>(db, "SELECT id FROM ab_peers WHERE guid = ?", book.guid);
    for (const peer of peers) ids.add(peer.id);
  }
  return [...ids];
}

// --------------------------------------------------------------------------- //
// device groups
// --------------------------------------------------------------------------- //

export async function listDeviceGroups(
  db: D1Database,
  options: { userName: string; isAdmin: boolean; limit: number; offset: number },
): Promise<{ total: number; rows: DeviceGroupRow[] }> {
  const where = options.isAdmin ? "" : " WHERE user_name = ?";
  const params = options.isAdmin ? [] : [options.userName];
  const count = await one<{ c: number }>(
    db,
    `SELECT COUNT(*) AS c FROM device_groups${where}`,
    ...params,
  );
  const rows = await all<DeviceGroupRow>(
    db,
    `SELECT * FROM device_groups${where} ORDER BY user_name, name LIMIT ? OFFSET ?`,
    ...params,
    options.limit,
    options.offset,
  );
  return { total: Number(count?.c ?? 0), rows };
}

export async function getOrCreateDeviceGroup(
  db: D1Database,
  userName: string,
  name: string,
): Promise<DeviceGroupRow> {
  const existing = await one<DeviceGroupRow>(
    db,
    "SELECT * FROM device_groups WHERE user_name = ? AND name = ?",
    userName,
    name,
  );
  if (existing) return existing;
  const guid = newId();
  const created = nowSec();
  await run(
    db,
    "INSERT OR IGNORE INTO device_groups (guid, user_name, name, created_at) VALUES (?, ?, ?, ?)",
    guid,
    userName,
    name,
    created,
  );
  return { guid, user_name: userName, name, created_at: created };
}

export async function renameDeviceGroup(
  db: D1Database,
  userName: string,
  oldName: string,
  newName: string,
): Promise<boolean> {
  const existing = await one<DeviceGroupRow>(
    db,
    "SELECT * FROM device_groups WHERE user_name = ? AND name = ?",
    userName,
    oldName,
  );
  if (!existing) return false;
  await db.batch([
    db
      .prepare("INSERT OR IGNORE INTO device_groups (guid, user_name, name, created_at) VALUES (?, ?, ?, ?)")
      .bind(existing.guid, userName, newName, existing.created_at),
    db.prepare("DELETE FROM device_groups WHERE user_name = ? AND name = ?").bind(userName, oldName),
    db
      .prepare("UPDATE devices SET device_group_name = ? WHERE user_name = ? AND device_group_name = ?")
      .bind(newName, userName, oldName),
  ]);
  return true;
}

export async function deleteDeviceGroups(
  db: D1Database,
  names: string[],
  userName?: string,
): Promise<void> {
  if (names.length === 0) return;
  const marks = placeholders(names.length);
  const statements = [];
  if (userName) {
    statements.push(
      db.prepare(`DELETE FROM device_groups WHERE user_name = ? AND name IN (${marks})`).bind(userName, ...names),
      db.prepare(`UPDATE devices SET device_group_name = '' WHERE user_name = ? AND device_group_name IN (${marks})`).bind(userName, ...names),
    );
  } else {
    statements.push(
      db.prepare(`DELETE FROM device_groups WHERE name IN (${marks})`).bind(...names),
      db.prepare(`UPDATE devices SET device_group_name = '' WHERE device_group_name IN (${marks})`).bind(...names),
    );
  }
  await db.batch(statements);
}

// --------------------------------------------------------------------------- //
// strategies
// --------------------------------------------------------------------------- //

export async function getStrategy(db: D1Database, name: string): Promise<StrategyRow | null> {
  if (!name) return null;
  return await one<StrategyRow>(db, "SELECT * FROM strategies WHERE name = ?", name);
}

export async function listStrategies(
  db: D1Database,
  limit: number,
  offset: number,
): Promise<{ total: number; rows: StrategyRow[] }> {
  const count = await one<{ c: number }>(db, "SELECT COUNT(*) AS c FROM strategies");
  const rows = await all<StrategyRow>(
    db,
    "SELECT * FROM strategies ORDER BY name LIMIT ? OFFSET ?",
    limit,
    offset,
  );
  return { total: Number(count?.c ?? 0), rows };
}

export async function upsertStrategy(
  db: D1Database,
  name: string,
  payload: Record<string, unknown>,
): Promise<number> {
  const now = nowSec();
  const existing = await getStrategy(db, name);
  if (existing) {
    await run(
      db,
      "UPDATE strategies SET payload = ?, modified_at = ? WHERE name = ?",
      JSON.stringify(payload),
      now,
      name,
    );
  } else {
    await run(
      db,
      "INSERT INTO strategies (name, payload, modified_at, created_at) VALUES (?, ?, ?, ?)",
      name,
      JSON.stringify(payload),
      now,
      now,
    );
  }
  return now;
}

export async function deleteStrategies(db: D1Database, names: string[]): Promise<void> {
  if (names.length === 0) return;
  await run(db, `DELETE FROM strategies WHERE name IN (${placeholders(names.length)})`, ...names);
}

// --------------------------------------------------------------------------- //
// device commands
// --------------------------------------------------------------------------- //

export async function queueDeviceCommand(
  db: D1Database,
  deviceId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await run(
    db,
    "INSERT INTO device_commands (device_id, kind, payload, created_at) VALUES (?, ?, ?, ?)",
    deviceId,
    kind,
    JSON.stringify(payload),
    nowSec(),
  );
}

/** Commands are handed to the device once, then dropped. */
export async function takeDeviceCommands(
  db: D1Database,
  deviceId: string,
): Promise<{ kind: string; payload: Record<string, unknown>; created_at: number }[]> {
  const rows = await all<{ kind: string; payload: string; created_at: number }>(
    db,
    "SELECT kind, payload, created_at FROM device_commands WHERE device_id = ? ORDER BY created_at",
    deviceId,
  );
  if (rows.length === 0) return [];
  await run(db, "DELETE FROM device_commands WHERE device_id = ?", deviceId);
  return rows.map((row) => ({
    kind: row.kind,
    payload: parseJson<Record<string, unknown>>(row.payload, {}),
    created_at: row.created_at,
  }));
}

// --------------------------------------------------------------------------- //
// audit
// --------------------------------------------------------------------------- //

interface AuditInput {
  nonce?: string;
  id?: string;
  uuid?: string;
  connId?: number;
  sessionId?: number;
  peerId?: string;
  ip?: string;
  action?: string;
  connType?: number;
  connAuditRef?: string;
}

export async function insertAuditConn(db: D1Database, input: AuditInput): Promise<string> {
  if (input.nonce) {
    const seen = await one<{ guid: string }>(
      db,
      "SELECT guid FROM audit_conn WHERE nonce = ? AND created_at > ?",
      input.nonce,
      nowSec() - AUDIT_NONCE_TTL_SECS,
    );
    if (seen) return seen.guid;
  }
  const guid = newId();
  await run(
    db,
    "INSERT INTO audit_conn (guid, nonce, id, uuid, conn_id, session_id, peer_id, ip, action," +
      " conn_type, conn_audit_ref, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)",
    guid,
    input.nonce ?? "",
    input.id ?? "",
    input.uuid ?? "",
    input.connId ?? 0,
    input.sessionId ?? 0,
    input.peerId ?? "",
    input.ip ?? "",
    input.action ?? "",
    input.connType ?? 0,
    input.connAuditRef ?? "",
    nowSec(),
  );
  return guid;
}

export async function insertAuditFile(
  db: D1Database,
  input: AuditInput & { type: number; path: string; isFile: boolean; info: string },
): Promise<string> {
  if (input.nonce) {
    const seen = await one<{ guid: string }>(
      db,
      "SELECT guid FROM audit_file WHERE nonce = ? AND created_at > ?",
      input.nonce,
      nowSec() - AUDIT_NONCE_TTL_SECS,
    );
    if (seen) return seen.guid;
  }
  const guid = newId();
  await run(
    db,
    "INSERT INTO audit_file (guid, nonce, id, uuid, peer_id, conn_id, type, path, is_file, info, created_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    guid,
    input.nonce ?? "",
    input.id ?? "",
    input.uuid ?? "",
    input.peerId ?? "",
    input.connId ?? 0,
    input.type,
    input.path,
    input.isFile ? 1 : 0,
    input.info,
    nowSec(),
  );
  return guid;
}

export async function insertAuditAlarm(
  db: D1Database,
  input: AuditInput & { typ: number; info: string },
): Promise<string> {
  if (input.nonce) {
    const seen = await one<{ guid: string }>(
      db,
      "SELECT guid FROM audit_alarm WHERE nonce = ? AND created_at > ?",
      input.nonce,
      nowSec() - AUDIT_NONCE_TTL_SECS,
    );
    if (seen) return seen.guid;
  }
  const guid = newId();
  await run(
    db,
    "INSERT INTO audit_alarm (guid, nonce, id, uuid, typ, info, conn_id, created_at)" +
      " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    guid,
    input.nonce ?? "",
    input.id ?? "",
    input.uuid ?? "",
    input.typ,
    input.info,
    input.connId ?? 0,
    nowSec(),
  );
  return guid;
}

export async function setAuditNote(db: D1Database, guid: string, note: string): Promise<void> {
  await run(
    db,
    "INSERT INTO audit_notes (guid, note, updated_at) VALUES (?, ?, ?)" +
      " ON CONFLICT(guid) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at",
    guid,
    note,
    nowSec(),
  );
  await run(db, "UPDATE audit_conn SET note = ? WHERE guid = ?", note, guid);
}

export async function getAuditNote(db: D1Database, guid: string): Promise<string> {
  const row = await one<{ note: string }>(db, "SELECT note FROM audit_notes WHERE guid = ?", guid);
  return row?.note ?? "";
}

/** The newest connection record a reporting device has written. */
export async function latestAuditConnGuid(
  db: D1Database,
  deviceId: string,
): Promise<string | null> {
  const row = await one<{ guid: string }>(
    db,
    "SELECT guid FROM audit_conn WHERE id = ? ORDER BY created_at DESC LIMIT 1",
    deviceId,
  );
  return row?.guid ?? null;
}

/**
 * The connection-audit record a controller should attach its note to.
 *
 * The controller knows the peer it is controlling and its own session id, while
 * the host is the side that posts `/api/audit/conn`. There is no shared key, so
 * this matches on the peer id from the query and otherwise opens a fresh row —
 * which keeps "add a note to the session I am in" working.
 */
export async function activeAuditGuid(
  db: D1Database,
  input: { peerId: string; sessionId: number; connType: number },
): Promise<string> {
  const recent = await one<{ guid: string }>(
    db,
    "SELECT guid FROM audit_conn WHERE peer_id = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1",
    input.peerId,
    nowSec() - 12 * 3600,
  );
  if (recent) return recent.guid;
  return await insertAuditConn(db, {
    peerId: input.peerId,
    sessionId: input.sessionId,
    connType: input.connType,
    action: "active",
  });
}

export async function listAuditConn(
  db: D1Database,
  options: { limit: number; offset: number; idLike?: string | null; ipLike?: string | null; action?: string | null },
): Promise<{ total: number; rows: AuditConnRow[] }> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.idLike) {
    clauses.push("(id LIKE ? OR peer_id LIKE ?)");
    params.push(options.idLike, options.idLike);
  }
  if (options.ipLike) {
    clauses.push("ip LIKE ?");
    params.push(options.ipLike);
  }
  if (options.action) {
    clauses.push("action = ?");
    params.push(options.action);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const count = await one<{ c: number }>(db, `SELECT COUNT(*) AS c FROM audit_conn${where}`, ...params);
  const rows = await all<AuditConnRow>(
    db,
    `SELECT * FROM audit_conn${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ...params,
    options.limit,
    options.offset,
  );
  return { total: Number(count?.c ?? 0), rows };
}

export async function countAudit(db: D1Database): Promise<{
  conn: number;
  file: number;
  alarm: number;
}> {
  const [conn, file, alarm] = await db.batch<{ c: number }>([
    db.prepare("SELECT COUNT(*) AS c FROM audit_conn"),
    db.prepare("SELECT COUNT(*) AS c FROM audit_file"),
    db.prepare("SELECT COUNT(*) AS c FROM audit_alarm"),
  ]);
  return {
    conn: Number(conn.results[0]?.c ?? 0),
    file: Number(file.results[0]?.c ?? 0),
    alarm: Number(alarm.results[0]?.c ?? 0),
  };
}

// --------------------------------------------------------------------------- //
// recordings
// --------------------------------------------------------------------------- //

export interface RecordRow {
  file: string;
  size: number;
  chunks: number;
  state: string;
  created_at: number;
  updated_at: number;
}

export async function getRecord(db: D1Database, file: string): Promise<RecordRow | null> {
  return await one<RecordRow>(db, "SELECT * FROM records WHERE file = ?", file);
}

/** Merges a chunk into the manifest; `size` is the high-water mark. */
export async function touchRecord(
  db: D1Database,
  file: string,
  patch: { size?: number; chunks?: number; state?: string },
): Promise<RecordRow> {
  const now = nowSec();
  const existing = await getRecord(db, file);
  const size = Math.max(patch.size ?? 0, existing?.size ?? 0);
  const chunks = (existing?.chunks ?? 0) + (patch.chunks ?? 0);
  const state = patch.state ?? existing?.state ?? "open";
  if (existing) {
    await run(
      db,
      "UPDATE records SET size = ?, chunks = ?, state = ?, updated_at = ? WHERE file = ?",
      size,
      chunks,
      state,
      now,
      file,
    );
  } else {
    await run(
      db,
      "INSERT INTO records (file, size, chunks, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      file,
      size,
      chunks,
      state,
      now,
      now,
    );
  }
  return { file, size, chunks, state, created_at: existing?.created_at ?? now, updated_at: now };
}

export async function deleteRecord(db: D1Database, file: string): Promise<void> {
  await run(db, "DELETE FROM records WHERE file = ?", file);
}

// --------------------------------------------------------------------------- //
// summary
// --------------------------------------------------------------------------- //

export async function summary(db: D1Database): Promise<Record<string, number>> {
  const audit = await countAudit(db);
  const [users, devices, books, peers] = await db.batch<{ c: number }>([
    db.prepare("SELECT COUNT(*) AS c FROM users"),
    db.prepare("SELECT COUNT(*) AS c FROM devices"),
    db.prepare("SELECT COUNT(*) AS c FROM address_books"),
    db.prepare("SELECT COUNT(*) AS c FROM ab_peers"),
  ]);
  return {
    users: Number(users.results[0]?.c ?? 0),
    devices: Number(devices.results[0]?.c ?? 0),
    address_books: Number(books.results[0]?.c ?? 0),
    address_book_peers: Number(peers.results[0]?.c ?? 0),
    audit_conn: audit.conn,
    audit_file: audit.file,
    audit_alarm: audit.alarm,
  };
}

export type { Env };
