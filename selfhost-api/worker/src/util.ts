/**
 * Small helpers and the HTTP response vocabulary.
 *
 * The client distinguishes four answer shapes, and getting them wrong is
 * silent — the page just shows an error toast. They are:
 *
 *   send(x)          application/json, `null` for a null payload.
 *   ok()             **200 with a zero-length body** — the only thing the
 *                    client's `_jsonDecodeActionResp` accepts as success.
 *                    A body of `null` is *not* accepted: it falls through to
 *                    `errMsg += resp.body`, so a successful write is reported
 *                    to the user as the error "null".
 *   fail(4xx, msg)   status code + `{"error": msg}`.
 *   softFail(msg)    200 + `{"error": msg}` — a handler-level failure, which
 *                    is how the client models business errors.
 */

import type { Env, UserRow } from "./env";

export type Handler = (ctx: Ctx) => Promise<Response>;

export interface Ctx {
  env: Env;
  request: Request;
  url: URL;
  /** Path segments, secret prefix already removed. */
  segments: string[];
  path: string;
  /** Captured `*` segments of the matched route, in order. */
  params: string[];
  /**
   * The authenticated caller, or the shared anonymous account.
   *
   * Resolves to a `Response` (thrown, not returned) when there is no session,
   * so a handler can simply `return await ctx.user()` style through. The fetch
   * entry point catches a thrown Response and sends it.
   */
  user(): Promise<UserRow>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// --------------------------------------------------------------------------- //
// primitives
// --------------------------------------------------------------------------- //

export const nowSec = (): number => Math.floor(Date.now() / 1000);

export const newId = (): string => crypto.randomUUID().replace(/-/g, "");

/** `str()` for the handful of JSON types that reach a DB column. */
export function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** `dict.get(key, default)` — the default only applies when the key is absent. */
export function get<T>(obj: Record<string, unknown>, key: string, fallback: T): unknown {
  return key in obj ? obj[key] : fallback;
}

export function toBool(raw: string | null | undefined, fallback = false): boolean {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return fallback;
  return value === "true" || value === "1" || value === "yes";
}

/** Accepts what `URLSearchParams.get` and `str()` produce, which is nullable. */
export function toInt(raw: string | null | undefined, fallback: number): number {
  const value = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(value) ? value : fallback;
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Narrows an untyped JSON value to a keyed object. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Narrows an untyped JSON value to an array, or gives back an empty one. */
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function parseJson<T>(raw: string, fallback: T): T {
  try {
    const parsed = JSON.parse(raw) as T;
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

// --------------------------------------------------------------------------- //
// hashing / encoding
// --------------------------------------------------------------------------- //

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

export function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Length-independent comparison, so a token cannot be guessed byte by byte. */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// --------------------------------------------------------------------------- //
// request parsing
// --------------------------------------------------------------------------- //

export async function readJson(request: Request): Promise<unknown> {
  try {
    const raw = await request.text();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function readBytes(request: Request): Promise<Uint8Array> {
  return new Uint8Array(await request.arrayBuffer());
}

export function bearerToken(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  if (header.toLowerCase().startsWith("bearer ")) return header.slice(7).trim();
  return "";
}

/** The client's paging loops ask for `current` (1-based) and `pageSize`. */
export function pageParams(url: URL, defaultSize = 100): { pageSize: number; offset: number } {
  const positive = (key: string, fallback: number): number => {
    const value = Number.parseInt(url.searchParams.get(key) ?? "", 10);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const pageSize = Math.min(positive("pageSize", defaultSize), 1000);
  const current = positive("current", 1);
  return { pageSize, offset: (current - 1) * pageSize };
}

/**
 * A `LIKE` pattern for the optional filters `res/ab.py` sends.
 *
 * It passes `%` itself when it wants one, so a value that already carries a
 * wildcard is used verbatim.
 */
export function likePattern(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value || value === "-") return null;
  if (value.includes("%") || value.includes("_")) return value;
  return `%${value}%`;
}

// --------------------------------------------------------------------------- //
// responses
// --------------------------------------------------------------------------- //

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
};

const JSON_HEADERS: Record<string, string> = {
  ...CORS_HEADERS,
  "Content-Type": "application/json; charset=utf-8",
};

/** A JSON answer. A null payload serialises as the literal `null`. */
export function send(payload: unknown, status = 200): Response {
  const body = payload === undefined || payload === null ? "null" : JSON.stringify(payload);
  return new Response(body, { status, headers: JSON_HEADERS });
}

/** The success answer for every write endpoint: 200 and no body at all. */
export function ok(): Response {
  return new Response(null, { status: 200, headers: CORS_HEADERS });
}

/** A transport-level failure: a status code the client reacts to, plus `error`. */
export function fail(status: number, message: string): Response {
  return send({ error: message }, status);
}

/** A handler-level failure: 200 + `error`, which is how the client models them. */
export function softFail(message: string): Response {
  return send({ error: message });
}

export function text(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

// --------------------------------------------------------------------------- //
// misc
// --------------------------------------------------------------------------- //

export function escapeHtml(value: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (c) => map[c] ?? c);
}

export const isResponse = (value: unknown): value is Response => value instanceof Response;

/** Narrow a `T | Response` union, mirroring the early-return style in auth.ts. */
export function unwrap<T>(value: T | Response): T {
  if (isResponse(value)) throw value;
  return value;
}

/**
 * The origin the caller actually reached.
 *
 * `request.url` cannot be trusted on its own: `wrangler dev` rewrites its host
 * to the worker's configured route, so a locally generated sign-in link comes
 * out pointing at the production domain. The `Host` header always names the
 * authority that was contacted; the scheme comes from `X-Forwarded-Proto` when
 * a proxy set it, and otherwise from the request URL.
 */
export function requestOrigin(ctx: Ctx): string {
  const host = (ctx.request.headers.get("Host") ?? "").trim();
  if (!host) return ctx.url.origin;
  const forwarded = (ctx.request.headers.get("X-Forwarded-Proto") ?? "").trim();
  const scheme = forwarded || ctx.url.protocol.replace(/:$/, "") || "https";
  return `${scheme}://${host}`;
}
