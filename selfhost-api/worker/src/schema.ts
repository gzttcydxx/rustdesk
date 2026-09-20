/**
 * The D1 schema, applied lazily on the first request of each isolate.
 *
 * Keeping it here (as well as in `../schema.sql`) means `wrangler deploy` is a
 * complete deployment: a brand-new database just works, with no separate
 * migration step. `schema.sql` stays for anyone who prefers explicit
 * migrations; both are idempotent.
 *
 * Migrations
 * ----------
 * `_meta.schema_version` records the revision. A database that has no version
 * row is treated as pre-versioning, which is why the v2 step below may drop
 * tables: `devices` and `device_groups` were projections rebuilt from the
 * address book, so losing them costs nothing. Tables that hold user data
 * (`users`, `address_books`, `ab_peers`, `ab_tags`, `tokens`, `audit_notes`)
 * are only ever altered, never dropped.
 */

import { SCHEMA_VERSION } from "./env";

export const CREATE_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS _meta (
     key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '')`,

  // -- accounts ------------------------------------------------------------ //
  `CREATE TABLE IF NOT EXISTS users (
     name          TEXT PRIMARY KEY,
     display_name  TEXT NOT NULL DEFAULT '',
     avatar        TEXT NOT NULL DEFAULT '',
     email         TEXT NOT NULL DEFAULT '',
     note          TEXT NOT NULL DEFAULT '',
     is_admin      INTEGER NOT NULL DEFAULT 0,
     status        INTEGER NOT NULL DEFAULT 1,
     password_hash TEXT NOT NULL DEFAULT '',
     tfa_secret    TEXT NOT NULL DEFAULT '',
     tfa_type      TEXT NOT NULL DEFAULT '',
     strategy_name TEXT NOT NULL DEFAULT '',
     verifier      TEXT NOT NULL DEFAULT '',
     created_at    REAL NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS tokens (
     token      TEXT PRIMARY KEY,
     user_name  TEXT NOT NULL,
     created_at REAL NOT NULL,
     expires_at REAL NOT NULL DEFAULT 0)`,

  // -- address books ------------------------------------------------------- //
  `CREATE TABLE IF NOT EXISTS address_books (
     guid       TEXT PRIMARY KEY,
     user_name  TEXT NOT NULL,
     name       TEXT NOT NULL,
     kind       TEXT NOT NULL,
     owner      TEXT NOT NULL DEFAULT '',
     rule       INTEGER NOT NULL DEFAULT 3,
     note       TEXT NOT NULL DEFAULT '',
     info       TEXT NOT NULL DEFAULT '{}',
     created_at REAL NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS ab_peers (
     guid       TEXT NOT NULL,
     id         TEXT NOT NULL,
     payload    TEXT NOT NULL,
     tags       TEXT NOT NULL DEFAULT '[]',
     updated_at REAL NOT NULL,
     PRIMARY KEY (guid, id))`,

  `CREATE TABLE IF NOT EXISTS ab_tags (
     guid  TEXT NOT NULL,
     name  TEXT NOT NULL,
     color INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (guid, name))`,

  // Who an address book is shared with. `target_kind` is user | group | everyone.
  `CREATE TABLE IF NOT EXISTS ab_rules (
     guid        TEXT PRIMARY KEY,
     ab_guid     TEXT NOT NULL,
     target_kind TEXT NOT NULL,
     target      TEXT NOT NULL DEFAULT '',
     rule        INTEGER NOT NULL DEFAULT 1,
     created_at  REAL NOT NULL)`,

  // -- devices ------------------------------------------------------------- //
  `CREATE TABLE IF NOT EXISTS devices (
     id                TEXT PRIMARY KEY,
     user_name         TEXT NOT NULL DEFAULT '',
     device_group_name TEXT NOT NULL DEFAULT '',
     strategy_name     TEXT NOT NULL DEFAULT '',
     note              TEXT NOT NULL DEFAULT '',
     status            INTEGER NOT NULL DEFAULT 1,
     info              TEXT NOT NULL DEFAULT '{}',
     payload           TEXT NOT NULL DEFAULT '{}',
     pk                TEXT NOT NULL DEFAULT '',
     uuid              TEXT NOT NULL DEFAULT '',
     ver               TEXT NOT NULL DEFAULT '',
     ip                TEXT NOT NULL DEFAULT '',
     conns             TEXT NOT NULL DEFAULT '[]',
     last_online       REAL NOT NULL DEFAULT 0,
     created_at        REAL NOT NULL,
     updated_at        REAL NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS device_groups (
     guid       TEXT NOT NULL DEFAULT '',
     user_name  TEXT NOT NULL,
     name       TEXT NOT NULL,
     created_at REAL NOT NULL,
     PRIMARY KEY (user_name, name))`,

  // Connection ids the operator asked to drop; drained by /api/heartbeat.
  `CREATE TABLE IF NOT EXISTS device_commands (
     device_id  TEXT NOT NULL,
     kind       TEXT NOT NULL,
     payload    TEXT NOT NULL DEFAULT '{}',
     created_at REAL NOT NULL)`,

  // -- strategy / policy --------------------------------------------------- //
  `CREATE TABLE IF NOT EXISTS strategies (
     name        TEXT PRIMARY KEY,
     payload     TEXT NOT NULL DEFAULT '{}',
     modified_at REAL NOT NULL,
     created_at  REAL NOT NULL)`,

  // -- audit --------------------------------------------------------------- //
  `CREATE TABLE IF NOT EXISTS audit_conn (
     guid           TEXT PRIMARY KEY,
     nonce          TEXT NOT NULL DEFAULT '',
     id             TEXT NOT NULL DEFAULT '',
     uuid           TEXT NOT NULL DEFAULT '',
     conn_id        INTEGER NOT NULL DEFAULT 0,
     session_id     INTEGER NOT NULL DEFAULT 0,
     peer_id        TEXT NOT NULL DEFAULT '',
     ip             TEXT NOT NULL DEFAULT '',
     action         TEXT NOT NULL DEFAULT '',
     conn_type      INTEGER NOT NULL DEFAULT 0,
     conn_audit_ref TEXT NOT NULL DEFAULT '',
     note           TEXT NOT NULL DEFAULT '',
     created_at     REAL NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS audit_file (
     guid       TEXT PRIMARY KEY,
     nonce      TEXT NOT NULL DEFAULT '',
     id         TEXT NOT NULL DEFAULT '',
     uuid       TEXT NOT NULL DEFAULT '',
     peer_id    TEXT NOT NULL DEFAULT '',
     conn_id    INTEGER NOT NULL DEFAULT 0,
     type       INTEGER NOT NULL DEFAULT 0,
     path       TEXT NOT NULL DEFAULT '',
     is_file    INTEGER NOT NULL DEFAULT 0,
     info       TEXT NOT NULL DEFAULT '{}',
     created_at REAL NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS audit_alarm (
     guid       TEXT PRIMARY KEY,
     nonce      TEXT NOT NULL DEFAULT '',
     id         TEXT NOT NULL DEFAULT '',
     uuid       TEXT NOT NULL DEFAULT '',
     typ        INTEGER NOT NULL DEFAULT 0,
     info       TEXT NOT NULL DEFAULT '{}',
     conn_id    INTEGER NOT NULL DEFAULT 0,
     created_at REAL NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS audit_notes (
     guid       TEXT PRIMARY KEY,
     note       TEXT NOT NULL DEFAULT '',
     updated_at REAL NOT NULL)`,

  // -- recordings ---------------------------------------------------------- //
  `CREATE TABLE IF NOT EXISTS records (
     file       TEXT PRIMARY KEY,
     size       INTEGER NOT NULL DEFAULT 0,
     chunks     INTEGER NOT NULL DEFAULT 0,
     state      TEXT NOT NULL DEFAULT 'open',
     created_at REAL NOT NULL,
     updated_at REAL NOT NULL)`,

  // -- misc ---------------------------------------------------------------- //
  `CREATE TABLE IF NOT EXISTS oidc_sessions (
     code       TEXT PRIMARY KEY,
     user_name  TEXT NOT NULL DEFAULT '',
     authed     INTEGER NOT NULL DEFAULT 0,
     created_at REAL NOT NULL)`,

  `CREATE TABLE IF NOT EXISTS switch_grants (
     id         TEXT PRIMARY KEY,
     verifier   TEXT NOT NULL DEFAULT '',
     signature  TEXT NOT NULL DEFAULT '',
     verified   INTEGER NOT NULL DEFAULT 0,
     created_at REAL NOT NULL)`,

  // -- indexes ------------------------------------------------------------- //
  `CREATE INDEX IF NOT EXISTS idx_ab_peers_guid ON ab_peers (guid, updated_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ab_rules_ab ON ab_rules (ab_guid)`,
  `CREATE INDEX IF NOT EXISTS idx_address_books_user ON address_books (user_name, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_devices_user ON devices (user_name, last_online DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_conn_created ON audit_conn (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_file_created ON audit_file (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_alarm_created ON audit_alarm (created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_records_updated ON records (updated_at DESC)`,
];

/**
 * Applied once, when `schema_version` is missing or older than 2.
 *
 * The `ALTER` statements are allowed to fail: SQLite answers "duplicate column
 * name" on a database that already has them, which is exactly the case for a
 * table created fresh from `CREATE_STATEMENTS`.
 */
export const MIGRATIONS_V2: string[] = [
  // Derived projections, rebuilt from the address book on the next request.
  `DROP TABLE IF EXISTS devices`,
  `DROP TABLE IF EXISTS device_groups`,
  `ALTER TABLE users ADD COLUMN tfa_secret TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN tfa_type TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN strategy_name TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE users ADD COLUMN verifier TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE tokens ADD COLUMN expires_at REAL NOT NULL DEFAULT 0`,
  `ALTER TABLE address_books ADD COLUMN note TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE address_books ADD COLUMN info TEXT NOT NULL DEFAULT '{}'`,
];

export function versionStatement(version: number): string {
  return (
    `INSERT INTO _meta (key, value) VALUES ('schema_version', '${version}')` +
    ` ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  );
}

export const CURRENT_VERSION_STATEMENT = versionStatement(SCHEMA_VERSION);
