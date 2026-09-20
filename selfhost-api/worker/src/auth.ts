/**
 * Sessions, passwords, TOTP and the browser sign-in page.
 *
 * The one rule that everything else bends around: **an empty or unusable bearer
 * token is a session, not an error.** It maps to the shared `anonymous`
 * account, which is what lets the address book and accessible devices pages
 * work without anybody signing in — and what lets a client whose token was
 * revoked carry on instead of having its models wiped by a 401. `STRICT_AUTH`
 * is the switch that turns that behaviour off.
 */

import type { Env, OidcSessionRow, UserRow } from "./env";
import { ANONYMOUS_USER, OIDC_TTL_SECS, TOKEN_TTL_SECS } from "./env";
import {
  createUser,
  dropToken,
  dropUserTokens,
  ensureUser,
  getUser,
  newToken,
  personalAb,
  updateUser,
  userForToken,
} from "./store";import {
  type Ctx,
  bearerToken,
  bytesToBase64,
  constantTimeEquals,
  escapeHtml,
  fail,
  isResponse,
  newId,
  nowSec,
  requestOrigin,
  sha256Hex,
  toBool,
} from "./util";

export const strictAuth = (env: Env): boolean => toBool(env.STRICT_AUTH, false);

export const anonymousIsAdmin = (env: Env): boolean => toBool(env.ANONYMOUS_ADMIN, false);

// --------------------------------------------------------------------------- //
// passwords
// --------------------------------------------------------------------------- //

/** Bytes of per-account salt mixed into every stored password hash. */
const PASSWORD_SALT_BYTES = 16;

/**
 * `sha256:<salt-b64>:<hex>`, or the older unsalted `sha256:<hex>`, or a bare
 * value compared literally — each still verifiable, so no account is locked out
 * by a change here.
 *
 * Deliberately a fast hash rather than a stretched one. A Worker on the free
 * plan gets 10 ms of CPU per request, which a KDF heavy enough to matter does
 * not fit inside, so the salt is the part that earns its keep: it stops two
 * users with the same password from sharing a hash and stops a stolen table
 * from being swept against precomputed digests. It does **not** make a weak
 * password strong, and the stored format says as much — see `README.md`.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = bytesToBase64(crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES)));
  return `sha256:${salt}:${await sha256Hex(`${salt}:${password}`)}`;
}

export async function passwordMatches(stored: string, given: string): Promise<boolean> {
  if (!stored) return false;
  const [scheme, ...rest] = stored.split(":");
  if (scheme !== "sha256") return stored === given;
  if (rest.length === 2) {
    const digest = `sha256:${rest[0]}:${await sha256Hex(`${rest[0]}:${given}`)}`;
    return constantTimeEquals(stored, digest);
  }
  if (rest.length === 1) return constantTimeEquals(stored, `sha256:${await sha256Hex(given)}`);
  return false;
}

// --------------------------------------------------------------------------- //
// TOTP (RFC 6238), so two-factor sign-in works without an email provider
// --------------------------------------------------------------------------- //

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Uint8Array | null {
  const clean = input.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = B32.indexOf(char);
    if (index < 0) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out.length > 0 ? new Uint8Array(out) : null;
}

async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const message = new Uint8Array(8);
  let value = counter;
  for (let i = 7; i >= 0; i -= 1) {
    message[i] = value & 0xff;
    value = Math.floor(value / 256);
  }
  const key = await crypto.subtle.importKey(
    "raw",
    secret,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    ((mac[offset + 1] & 0xff) << 16) |
    ((mac[offset + 2] & 0xff) << 8) |
    (mac[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

/** Accepts the current step and one either side, to tolerate clock drift. */
export async function verifyTotp(secretBase32: string, code: string): Promise<boolean> {
  const secret = base32Decode(secretBase32);
  if (!secret) return false;
  const given = code.trim();
  if (!/^\d{6}$/.test(given)) return false;
  const step = Math.floor(nowSec() / 30);
  for (const drift of [-1, 0, 1]) {
    if ((await hotp(secret, step + drift)) === given) return true;
  }
  return false;
}

// --------------------------------------------------------------------------- //
// session resolution
// --------------------------------------------------------------------------- //

export interface Session {
  user: UserRow | null;
  /** Why there is no user, for the 401 body. */
  reason: string;
}

/**
 * Resolve the caller.
 *
 * Any token that does not name a live session — absent, empty, or stale —
 * degrades to the shared `anonymous` account. That is deliberate and is the
 * behaviour the contract suite pins: the client clears a dead token and then
 * keeps working, instead of having its models wiped by a 401 from a request
 * that was already in flight. `STRICT_AUTH` turns it into a real 401.
 *
 * Never throws and never inspects the request method: the caller turns a null
 * user into a 401.
 */
export async function resolveSession(ctx: Ctx): Promise<Session> {
  const token = bearerToken(ctx.request);
  if (!token) {
    if (strictAuth(ctx.env)) return { user: null, reason: "Invalid token" };
    return { user: await anonymous(ctx.env), reason: "" };
  }

  const name = await userForToken(ctx.env.DB, token);
  if (!name) {
    if (strictAuth(ctx.env)) return { user: null, reason: "Invalid token" };
    return { user: await anonymous(ctx.env), reason: "" };
  }
  const row = await getUser(ctx.env.DB, name);
  if (!row) return { user: null, reason: "Invalid token" };
  if (row.status === 0) return { user: null, reason: "User is disabled" };
  return { user: row, reason: "" };
}

export async function anonymous(env: Env): Promise<UserRow> {
  const existing = await getUser(env.DB, ANONYMOUS_USER);
  if (existing) return existing;
  const user = await ensureUser(env.DB, {
    name: ANONYMOUS_USER,
    displayName: "Anonymous",
    isAdmin: anonymousIsAdmin(env),
  });
  // Give the shared account its address book immediately, so the first page
  // load does not have to create it mid-request.
  await personalAb(env.DB, user.name);
  return user;
}

/** Returns the row, or the 401 response to send instead. */
export async function requireUser(ctx: Ctx): Promise<UserRow | Response> {
  const session = await resolveSession(ctx);
  if (session.user === null) return fail(401, session.reason || "Invalid token");
  return session.user;
}

export async function requireAdmin(ctx: Ctx): Promise<UserRow | Response> {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  if (!user.is_admin) return fail(403, "Admin required");
  return user;
}

/** Convenience for the `if (isResponse(x)) return x;` pattern. */
export function deny(response: Response): Response {
  return response;
}

// --------------------------------------------------------------------------- //
// tokens
// --------------------------------------------------------------------------- //

export async function issueToken(env: Env, userName: string): Promise<string> {
  return await newToken(env.DB, userName, TOKEN_TTL_SECS);
}

export async function revokeToken(env: Env, token: string): Promise<void> {
  await dropToken(env.DB, token);
}

export async function revokeUserTokens(env: Env, userName: string): Promise<void> {
  await dropUserTokens(env.DB, userName);
}

// --------------------------------------------------------------------------- //
// account administration (used by the admin routes)
// --------------------------------------------------------------------------- //

export interface CreateAccountInput {
  name: string;
  displayName?: string;
  email?: string;
  note?: string;
  password?: string;
  isAdmin?: boolean;
  status?: number;
  strategyName?: string;
  tfaSecret?: string;
  tfaType?: string;
}

export async function createAccount(env: Env, input: CreateAccountInput): Promise<boolean> {
  const created = await createUser(env.DB, {
    name: input.name,
    displayName: input.displayName ?? input.name,
    email: input.email ?? "",
    note: input.note ?? "",
    passwordHash: input.password ? await hashPassword(input.password) : "",
    isAdmin: input.isAdmin,
    status: input.status,
    strategyName: input.strategyName,
    tfaSecret: input.tfaSecret,
    tfaType: input.tfaType,
  });
  if (created) await personalAb(env.DB, input.name);
  return created;
}

export async function setPassword(env: Env, name: string, password: string): Promise<boolean> {
  const hash = password ? await hashPassword(password) : "";
  const done = await updateUser(env.DB, name, { password_hash: hash });
  // A password change invalidates every existing session.
  await revokeUserTokens(env, name);
  return done;
}

// --------------------------------------------------------------------------- //
// OIDC-style sign-in
// --------------------------------------------------------------------------- //
//
// The client drives three steps (see src/hbbs_http/account.rs):
//
//   1. POST /api/oidc/auth       -> {code, url}. The whole body is
//                                   deserialised into `OidcAuthUrl`, so it is
//                                   NOT wrapped in `data`.
//   2. the user opens `url` in a browser and signs in
//   3. GET  /api/oidc/auth-query -> {"body": "<json>"} once a second, until it
//                                   yields an access token
//
// `url` points back at this Worker, so a self-hosted deployment serves the
// sign-in screen itself instead of delegating to a third party.

export async function createOidcCode(env: Env): Promise<string> {
  const code = newId();
  await env.DB.prepare(
    "INSERT INTO oidc_sessions (code, user_name, authed, created_at) VALUES (?, '', 0, ?)",
  )
    .bind(code, nowSec())
    .run();
  return code;
}

export async function oidcSession(env: Env, code: string): Promise<OidcSessionRow | null> {
  if (!code) return null;
  const row = await env.DB.prepare("SELECT * FROM oidc_sessions WHERE code = ?")
    .bind(code)
    .first<OidcSessionRow>();
  if (!row) return null;
  if (nowSec() - row.created_at > OIDC_TTL_SECS) {
    await env.DB.prepare("DELETE FROM oidc_sessions WHERE code = ?").bind(code).run();
    return null;
  }
  return row;
}

export async function completeOidcSession(
  env: Env,
  code: string,
  userName: string,
): Promise<void> {
  await env.DB.prepare("UPDATE oidc_sessions SET user_name = ?, authed = 1 WHERE code = ?")
    .bind(userName, code)
    .run();
}

export async function consumeOidcSession(env: Env, code: string): Promise<void> {
  await env.DB.prepare("DELETE FROM oidc_sessions WHERE code = ?").bind(code).run();
}

/** The SSO buttons the client shows on its sign-in screen. */
export function loginOptions(env: Env): string[] {
  const raw = env.OIDC_PROVIDERS;
  const names = (raw ?? "selfhost")
    .split(",")
    .map((n) => n.trim())
    .filter(Boolean);
  return names.map((name) => `oidc/${name}`);
}

export function oidcUrl(ctx: Ctx, code: string): string {
  return `${requestOrigin(ctx)}/login?code=${code}`;
}

// --------------------------------------------------------------------------- //
// the sign-in page
// --------------------------------------------------------------------------- //

const LOGIN_STYLE = `body{margin:0;min-height:100vh;display:grid;place-items:center;
background:#15171c;color:#e8eaed;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{width:min(360px,90vw);padding:32px;background:#1e2128;border:1px solid #2c3038;border-radius:12px}
h1{margin:0 0 4px;font-size:20px}p{margin:0 0 20px;color:#9aa0a6;font-size:13px}
p.err{color:#f28b82}label{display:block;margin-bottom:14px;font-size:13px;color:#9aa0a6}
input{display:block;width:100%;box-sizing:border-box;margin-top:6px;padding:9px 10px;
background:#15171c;border:1px solid #3c4043;border-radius:8px;color:#e8eaed;font-size:15px}
button{width:100%;padding:10px;margin-top:6px;border:0;border-radius:8px;
background:#8ab4f8;color:#202124;font-size:15px;font-weight:600;cursor:pointer}`;

export function loginForm(code: string, error: string, needsTotp = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title><style>${LOGIN_STYLE}</style></head><body><main>
<h1>Sign in</h1><p>RustDesk self-hosted API</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ""}
<form method="post" action="/login">
<input type="hidden" name="code" value="${escapeHtml(code)}">
<label>Username<input name="username" autocomplete="username" autofocus required></label>
<label>Password<input name="password" type="password" autocomplete="current-password" required></label>
${
  needsTotp
    ? `<label>Two-factor code<input name="totp" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" required></label>`
    : ""
}
<button type="submit">Sign in</button>
</form></main></body></html>`;
}

export function loginDone(name: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Signed in</title><style>${LOGIN_STYLE}</style></head><body><main>
<h1>Signed in</h1><p>${escapeHtml(name)}</p>
<p>You can close this tab and return to RustDesk.</p>
</main></body></html>`;
}

// --------------------------------------------------------------------------- //
// the sign-up page
// --------------------------------------------------------------------------- //
//
// The client has no registration screen — `common/widgets/login.dart` only
// offers SSO buttons and a username/password form — so account creation has to
// come from the server side. This page is it, and it deliberately sits *inside*
// the `ACCESS_TOKEN` gate: the same secret that authorises the API authorises
// creating an account on it. Note that it therefore cannot be linked from
// `/login`, which is served outside the gate and would leak the secret.

export interface RegisterView {
  error: string;
  username: string;
  email: string;
  /** Only while no administrator exists: the first account may claim it. */
  offerAdmin: boolean;
  adminChecked: boolean;
}

export function registerForm(view: RegisterView): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Create account</title><style>${LOGIN_STYLE}
label.cb{display:flex;align-items:center;gap:8px;color:#e8eaed}
label.cb input{width:auto;margin:0}</style></head><body><main>
<h1>Create account</h1><p>RustDesk self-hosted API</p>
${view.error ? `<p class="err">${escapeHtml(view.error)}</p>` : ""}
<!-- No action attribute: the form posts back to the URL it was served from,
     which is what carries the secret prefix. Naming that URL here would spell
     the secret out in the markup for no gain, since the page already sits
     inside the gate. -->
<form method="post">
<label>Username<input name="username" autocomplete="username" value="${escapeHtml(view.username)}" autofocus required></label>
<label>Email (optional)<input name="email" type="email" autocomplete="email" value="${escapeHtml(view.email)}"></label>
<label>Password<input name="password" type="password" autocomplete="new-password" required></label>
<label>Repeat password<input name="password2" type="password" autocomplete="new-password" required></label>
${
  view.offerAdmin
    ? `<label class="cb"><input type="checkbox" name="admin" value="1"${
        view.adminChecked ? " checked" : ""
      }>Administrator (no admin exists yet)</label>`
    : ""
}
<button type="submit">Create account</button>
</form>
<p>Then sign in from RustDesk: Settings &rarr; Account &rarr; Login.</p>
</main></body></html>`;
}

export function registerDone(name: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Account created</title><style>${LOGIN_STYLE}</style></head><body><main>
<h1>Account created</h1><p>${escapeHtml(name)}</p>
<p>You can now sign in from RustDesk: Settings &rarr; Account &rarr; Login, with
the username and password you just chose.</p>
</main></body></html>`;
}

export function registerClosed(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Registration closed</title><style>${LOGIN_STYLE}</style></head><body><main>
<h1>Registration is closed</h1><p>This server does not accept self-service sign-ups.</p>
</main></body></html>`;
}
