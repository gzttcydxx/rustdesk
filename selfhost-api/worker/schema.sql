-- D1 schema for the RustDesk self-hosted API.
-- Mirrors the tables created by ../rustdesk_api_server.py (class Store).
--
-- Apply locally:   npx wrangler d1 execute rustdesk-selfhost-api --local --file=./schema.sql
-- Apply remotely:  npx wrangler d1 execute rustdesk-selfhost-api --remote --file=./schema.sql

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

CREATE INDEX IF NOT EXISTS idx_ab_peers_guid ON ab_peers (guid, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices (user_name, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_address_books_user ON address_books (user_name, kind);
