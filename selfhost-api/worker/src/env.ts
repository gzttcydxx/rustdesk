/**
 * Runtime bindings, row shapes and tunables.
 *
 * D1 and R2 are declared structurally rather than pulled from
 * `@cloudflare/workers-types`, so this project keeps its zero-dependency
 * property and `wrangler deploy` needs no build step beyond esbuild's own.
 */

// --------------------------------------------------------------------------- //
// D1
// --------------------------------------------------------------------------- //

export interface D1Result<T = unknown> {
  results: T[];
  success: boolean;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  all<T = unknown>(): Promise<D1Result<T>>;
  run(): Promise<unknown>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<unknown>;
}

// --------------------------------------------------------------------------- //
// R2 — only used by /api/record, and only when the binding exists
// --------------------------------------------------------------------------- //

export interface R2ListResult {
  objects: { key: string }[];
  truncated: boolean;
  cursor?: string;
}

export interface R2BucketLike {
  put(key: string, value: Uint8Array | ArrayBuffer | string): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
  delete(keys: string | string[]): Promise<void>;
  list(options: { prefix: string; cursor?: string }): Promise<R2ListResult>;
}

// --------------------------------------------------------------------------- //
// Env
// --------------------------------------------------------------------------- //

export interface Env {
  DB: D1Database;
  /** Optional. Without it /api/record answers `{"error": "..."}`. */
  RECORDS?: R2BucketLike;

  /** "true"/"1" rejects every anonymous session. Defaults to off. */
  STRICT_AUTH?: string;
  /**
   * Shared secret that must be the first path segment of every request.
   * Set with `wrangler secret put ACCESS_TOKEN`; unset means the API is open.
   */
  ACCESS_TOKEN?: string;
  /** "false" makes POST /api/devices/deploy answer `NOT_ENABLED`. */
  ALLOW_DEPLOY?: string;
  /**
   * "false" closes the self-service sign-up page. Defaults to on, and the page
   * sits behind `ACCESS_TOKEN` either way, so this is a second lock rather than
   * the only one.
   */
  ALLOW_REGISTER?: string;
  /** Makes the lazily created `anonymous` account an administrator. */
  ANONYMOUS_ADMIN?: string;
  /** Comma separated SSO button names for `GET /api/login-options`. */
  OIDC_PROVIDERS?: string;
  /** Per-address-book device cap reported by `POST /api/ab/settings`. 0 = no cap. */
  MAX_PEER_ONE_AB?: string;
  /** Version string returned by `POST /api/sysinfo_ver`. */
  SYSINFO_VERSION?: string;
}

// --------------------------------------------------------------------------- //
// constants
// --------------------------------------------------------------------------- //

export const SERVER_NAME = "rustdesk-selfhost-api";
export const SERVER_VERSION = "1.0.0";

/** Schema revision, see `schema.ts`. Bump when a migration is added. */
export const SCHEMA_VERSION = 2;

/**
 * The account every request without a usable access token is mapped to.
 *
 * This is what makes the login-free address book / accessible devices pages
 * work: an empty `Authorization: Bearer ` is a session, not an error.
 */
export const ANONYMOUS_USER = "anonymous";

/** A pending sign-in link stops working after this long. */
export const OIDC_TTL_SECS = 30 * 60;

/** Access tokens are long lived; the client has no refresh flow. */
export const TOKEN_TTL_SECS = 365 * 24 * 3600;

/** `POST /api/switch-grant` accepts this much clock drift before re-signing. */
export const SWITCH_GRANT_SKEW_SECS = 300;

/** The client re-posts audit records for up to 120s; dedupe a little longer. */
export const AUDIT_NONCE_TTL_SECS = 600;

/** Share rules, mirroring `ShareRule` in the client. */
export const RULE_READ = 1;
export const RULE_READ_WRITE = 2;
export const RULE_FULL = 3;

// --------------------------------------------------------------------------- //
// row shapes
// --------------------------------------------------------------------------- //

export interface UserRow {
  name: string;
  display_name: string;
  avatar: string;
  email: string;
  note: string;
  is_admin: number;
  status: number;
  password_hash: string;
  tfa_secret: string;
  tfa_type: string;
  strategy_name: string;
  verifier: string;
  created_at: number;
}

export interface AbRow {
  guid: string;
  user_name: string;
  name: string;
  kind: string;
  owner: string;
  rule: number;
  note: string;
  info: string;
  created_at: number;
}

export interface AbPeerRow {
  guid: string;
  id: string;
  payload: string;
  tags: string;
  updated_at: number;
}

export interface AbTagRow {
  guid: string;
  name: string;
  color: number;
}

export interface AbRuleRow {
  guid: string;
  ab_guid: string;
  target_kind: string;
  target: string;
  rule: number;
  created_at: number;
}

export interface DeviceRow {
  id: string;
  user_name: string;
  device_group_name: string;
  strategy_name: string;
  note: string;
  status: number;
  info: string;
  payload: string;
  pk: string;
  uuid: string;
  ver: string;
  ip: string;
  conns: string;
  last_online: number;
  created_at: number;
  updated_at: number;
}

export interface DeviceGroupRow {
  guid: string;
  user_name: string;
  name: string;
  created_at: number;
}

export interface StrategyRow {
  name: string;
  payload: string;
  modified_at: number;
  created_at: number;
}

export interface AuditConnRow {
  guid: string;
  nonce: string;
  id: string;
  uuid: string;
  conn_id: number;
  session_id: number;
  peer_id: string;
  ip: string;
  action: string;
  conn_type: number;
  conn_audit_ref: string;
  note: string;
  created_at: number;
}

export interface OidcSessionRow {
  code: string;
  user_name: string;
  authed: number;
  created_at: number;
}
