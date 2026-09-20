-- A faithful copy of the shape the DEPLOYED database has today (pre-versioning):
-- nine tables, `users` with nine columns, `tokens` without `expires_at`,
-- `address_books` without `note`/`info`, and no `_meta`.
--
-- Used to prove the v2 migration actually adds the columns on an existing
-- database, which is the operation about to run against production. A fresh
-- database cannot test this: it takes the `!initialised` branch instead.

CREATE TABLE users (name TEXT PRIMARY KEY, display_name TEXT NOT NULL DEFAULT '', avatar TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', is_admin INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 1, password_hash TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL);
CREATE TABLE tokens (token TEXT PRIMARY KEY, user_name TEXT NOT NULL, created_at REAL NOT NULL);
CREATE TABLE address_books (guid TEXT PRIMARY KEY, user_name TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, owner TEXT NOT NULL DEFAULT '', rule INTEGER NOT NULL DEFAULT 3, created_at REAL NOT NULL);
CREATE TABLE ab_peers (guid TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', updated_at REAL NOT NULL, PRIMARY KEY (guid, id));
CREATE TABLE ab_tags (guid TEXT NOT NULL, name TEXT NOT NULL, color INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (guid, name));
CREATE TABLE device_groups (guid TEXT NOT NULL DEFAULT '', user_name TEXT NOT NULL, name TEXT NOT NULL, created_at REAL NOT NULL, PRIMARY KEY (user_name, name));
CREATE TABLE devices (id TEXT PRIMARY KEY, user_name TEXT NOT NULL DEFAULT '', info TEXT NOT NULL DEFAULT '{}', created_at REAL NOT NULL, updated_at REAL NOT NULL);
CREATE TABLE audit_notes (guid TEXT PRIMARY KEY, note TEXT NOT NULL DEFAULT '', updated_at REAL NOT NULL);
CREATE TABLE oidc_sessions (code TEXT PRIMARY KEY, user_name TEXT NOT NULL DEFAULT '', authed INTEGER NOT NULL DEFAULT 0, created_at REAL NOT NULL);

-- Real data, so the migration can be shown not to lose it.
INSERT INTO users (name, display_name, is_admin, status, password_hash, created_at) VALUES ('legacy-admin', 'legacy-admin', 1, 1, 'sha256:deadbeef', strftime('%s','now'));
INSERT INTO tokens (token, user_name, created_at) VALUES ('legacy-token-abc', 'legacy-admin', strftime('%s','now'));
INSERT INTO address_books (guid, user_name, name, kind, created_at) VALUES ('legacy-ab-guid', 'legacy-admin', 'Personal', 'personal', strftime('%s','now'));
INSERT INTO ab_peers (guid, id, payload, tags, updated_at) VALUES ('legacy-ab-guid', '123456789', '{"id":"123456789","info":{"device_name":"legacy-pc"}}', '[]', strftime('%s','now'));
