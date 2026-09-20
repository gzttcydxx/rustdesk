/**
 * Identity, the sign-in handshake, device telemetry and device lifecycle.
 *
 * Covers every non-address-book endpoint the client calls:
 *
 *   POST /api/login                  session + optional TOTP second step
 *   POST /api/logout
 *   POST /api/currentUser            also what the client uses to validate a token
 *   GET  /api/login-options          SSO buttons
 *   POST /api/oidc/auth              start the browser handshake
 *   GET  /api/oidc/auth-query        poll it, once a second
 *   GET|POST /login                  the browser page itself (outside the gate)
 *   GET|POST /register               self-service sign-up (inside the gate)
 *   POST /api/sysinfo                client pushes its inventory
 *   POST /api/sysinfo_ver            client asks whether it should push again
 *   POST /api/heartbeat              policy / disconnect channel
 *   POST /api/switch-grant           device hand-off proof
 *   POST /api/devices/cli            provision a device (--assign)
 *   POST /api/devices/deploy         register a new device id from the CLI
 *
 * Two conventions worth remembering: `/api/sysinfo` and `/api/sysinfo_ver`
 * answer with **plain text** (`SYSINFO_UPDATED`, and a version string), and
 * `/api/oidc/auth-query` wraps its business body in `{"body": "<json>"}` while
 * the other sign-in endpoints do not.
 */

import type { AbRow, DeviceRow, Env, StrategyRow, UserRow } from "../env";
import { ANONYMOUS_USER, SERVER_VERSION, SWITCH_GRANT_SKEW_SECS } from "../env";
import { userPayload } from "../payload";
import type { Route } from "../route";
import {
  anonymous,
  completeOidcSession,
  consumeOidcSession,
  createAccount,
  createOidcCode,
  issueToken,
  loginDone,
  loginForm,
  loginOptions,
  oidcSession,
  oidcUrl,
  passwordMatches,
  registerClosed,
  registerDone,
  registerForm,
  requireUser,
  resolveSession,
  revokeToken,
  strictAuth,
  verifyTotp,
} from "../auth";
import {
  createAb,
  ensureUser,
  getDevice,
  getStrategy,
  getUser,
  hasAdmin,
  listAbs,
  personalAb,
  queueDeviceCommand,
  summary,
  takeDeviceCommands,
  upsertAbPeer,
  upsertDevice,
  type DevicePatch,
} from "../store";
import {
  type Ctx,
  asRecord,
  base64ToBytes,
  bearerToken,
  fail,
  html,
  isResponse,
  newId,
  nowSec,
  ok,
  parseJson,
  readJson,
  send,
  softFail,
  str,
  text,
} from "../util";

/** Behind Cloudflare the peer address is only in the header it injects. */
function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? request.headers.get("x-real-ip") ?? "";
}

/** The client sends `{id, uuid, deviceInfo}` on login and on /api/currentUser. */
async function registerDeviceLogin(
  env: Env,
  user: UserRow,
  body: Record<string, unknown>,
): Promise<void> {
  const id = str(body.id);
  if (!id) return;
  const info = asRecord(body.deviceInfo) ?? {};
  await upsertDevice(env.DB, id, {
    user_name: user.name,
    uuid: str(body.uuid),
    info: JSON.stringify({
      os: str(info.os),
      device_name: str(info.name),
    }),
    last_online: nowSec(),
  });
}

// --------------------------------------------------------------------------- //
// login
// --------------------------------------------------------------------------- //

const login: Route["handler"] = async (ctx) => {
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const username = str(body.username).trim();
  const password = str(body.password);
  const type = str(body.type) || "account";

  // An empty username is the client probing, or the login-free flow: hand back
  // the shared account with no token rather than failing the request.
  if (!username) {
    const user = await anonymous(ctx.env);
    return send({ type: "access_token", access_token: "", user: userPayload(user) });
  }

  let row = await getUser(ctx.env.DB, username);
  if (!row || row.status === 0) {
    // Off strict mode this server accepts an unknown name on first use, the
    // same way it accepts an empty one: the point of this deployment is that
    // signing in should never need an out-of-band account-creation step. The
    // account is never an administrator, and `STRICT_AUTH=true` closes it.
    if (strictAuth(ctx.env)) return fail(401, "Invalid username or password");
    row = await ensureUser(ctx.env.DB, { name: username, displayName: username });
    await personalAb(ctx.env.DB, row.name);
  }

  // Second step of a two-factor sign-in: the client resends with a code.
  if (type === "email_code" || type === "tfa_code" || type === "sms_code") {
    const code = str(body.tfaCode) || str(body.verificationCode);
    if (!row.tfa_secret) return fail(401, "Two-factor authentication is not enabled");
    if (!(await verifyTotp(row.tfa_secret, code))) return fail(401, "Invalid verification code");
  } else {
    // Only check a password when the account actually has one, so an account
    // created for anonymous-style access stays reachable.
    if (row.password_hash && !(await passwordMatches(row.password_hash, password))) {
      return fail(401, "Invalid username or password");
    }
    if (row.tfa_secret) {
      return send({
        type: "email_check",
        tfa_type: "tfa_check",
        secret: "",
        user: userPayload(row),
      });
    }
  }

  await registerDeviceLogin(ctx.env, row, body);
  const token = await issueToken(ctx.env, row.name);
  return send({ type: "access_token", access_token: token, user: userPayload(row) });
};

const logout: Route["handler"] = async (ctx) => {
  await revokeToken(ctx.env, bearerToken(ctx.request));
  return send(null);
};

const currentUser: Route["handler"] = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const body = asRecord(await readJson(ctx.request)) ?? {};
  await registerDeviceLogin(ctx.env, user, body);
  return send(userPayload(user));
};

// --------------------------------------------------------------------------- //
// OIDC-style sign-in
// --------------------------------------------------------------------------- //

const loginOptionsRoute: Route["handler"] = async (ctx) => send(loginOptions(ctx.env));

const oidcAuth: Route["handler"] = async (ctx) => {
  const code = await createOidcCode(ctx.env);
  return send({ code, url: oidcUrl(ctx, code) });
};

const oidcAuthQuery: Route["handler"] = async (ctx) => {
  const code = ctx.url.searchParams.get("code") ?? "";
  const session = await oidcSession(ctx.env, code);
  if (!session || !session.authed) {
    // Exactly this message is what the client treats as "keep polling".
    return send({ body: JSON.stringify({ error: "No authed oidc is found" }) });
  }
  const user = await getUser(ctx.env.DB, session.user_name);
  if (!user) return send({ body: JSON.stringify({ error: "No authed oidc is found" }) });
  const token = await issueToken(ctx.env, user.name);
  await consumeOidcSession(ctx.env, code);
  return send({
    body: JSON.stringify({
      access_token: token,
      type: "access_token",
      tfa_type: "",
      secret: "",
      user: userPayload(user),
    }),
  });
};

/**
 * The sign-in screen, served by this Worker so a self-hosted deployment owns
 * the whole flow. Reached through a one-off code, so it is the one path that
 * stays outside the secret gate.
 */
export async function loginPage(ctx: Ctx): Promise<Response> {
  let code = ctx.url.searchParams.get("code") ?? "";
  const expired = () =>
    html(loginForm("", "This sign-in link has expired. Start again from the client."), 400);

  if (ctx.request.method === "POST") {
    const form = new URLSearchParams(await ctx.request.text());
    code = form.get("code") ?? code;
    if (!(await oidcSession(ctx.env, code))) return expired();
    const username = (form.get("username") ?? "").trim();
    const password = form.get("password") ?? "";
    const totp = (form.get("totp") ?? "").trim();
    const row = await getUser(ctx.env.DB, username);
    if (!row || row.status === 0) return html(loginForm(code, "Invalid username or password."), 401);
    if (row.password_hash && !(await passwordMatches(row.password_hash, password))) {
      return html(loginForm(code, "Invalid username or password."), 401);
    }
    if (row.tfa_secret) {
      if (!totp) return html(loginForm(code, "", true), 200);
      if (!(await verifyTotp(row.tfa_secret, totp))) {
        return html(loginForm(code, "Invalid two-factor code.", true), 401);
      }
    }
    await completeOidcSession(ctx.env, code, row.name);
    return html(loginDone(row.display_name || row.name));
  }

  if (!(await oidcSession(ctx.env, code))) return expired();
  return html(loginForm(code, ""));
}

// --------------------------------------------------------------------------- //
// self-service sign-up
// --------------------------------------------------------------------------- //

/**
 * Usernames are what the client sends in `POST /api/login`, and they end up as
 * the account's address-book owner, so the set is kept to what is unambiguous
 * in a URL, a JSON body and a login form: no spaces, no colons (the password
 * hash format uses them), and a leading alphanumeric so nothing has to be
 * escaped. Email addresses fit, which matters because that is what most people
 * type here.
 */
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@+-]{0,63}$/;
const MIN_PASSWORD_LENGTH = 8;

function registrationOpen(env: Env): boolean {
  const flag = (env.ALLOW_REGISTER ?? "true").trim().toLowerCase();
  return !(flag === "false" || flag === "0" || flag === "no");
}

/**
 * The sign-up page. Reached at `/register`, or `/<ACCESS_TOKEN>/register` when
 * the deployment sets a secret — `index.ts` handles it after the gate, so the
 * secret doubles as the invitation.
 *
 * The form posts back to the path it was served from, so the secret prefix
 * survives the round trip without the page ever having to know its value.
 */
export async function registerPage(ctx: Ctx): Promise<Response> {
  if (!registrationOpen(ctx.env)) return html(registerClosed(), 403);

  // Only a server with no administrator yet can hand one out, which mirrors the
  // bootstrap rule on `POST /api/users` rather than inventing a second one.
  const offerAdmin = !(await hasAdmin(ctx.env.DB));

  if (ctx.request.method === "POST") {
    const form = new URLSearchParams(await ctx.request.text());
    const username = (form.get("username") ?? "").trim();
    const email = (form.get("email") ?? "").trim();
    const password = form.get("password") ?? "";
    const repeated = form.get("password2") ?? "";
    const wantsAdmin = form.get("admin") !== null;
    const view = {
      action: ctx.path,
      username,
      email,
      offerAdmin,
      adminChecked: wantsAdmin,
    };
    const reject = (error: string, status: number) => html(registerForm({ ...view, error }), status);

    if (!USERNAME_PATTERN.test(username)) {
      return reject(
        "Username must be 1-64 characters, start with a letter or digit, and use only letters, digits, . _ @ + -",
        400,
      );
    }
    if (username.toLowerCase() === ANONYMOUS_USER) return reject("That username is reserved.", 400);
    if (password.length < MIN_PASSWORD_LENGTH) {
      return reject(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`, 400);
    }
    if (password !== repeated) return reject("The two passwords do not match.", 400);
    // Checked before the insert so "taken" is a clear message rather than a
    // silent no-op: `createAccount` reports it, but it cannot say which field.
    if (await getUser(ctx.env.DB, username)) return reject("That username is taken.", 409);

    const created = await createAccount(ctx.env, {
      name: username,
      displayName: username,
      email,
      password,
      isAdmin: offerAdmin && wantsAdmin,
    });
    if (!created) return reject("That username is taken.", 409);
    return html(registerDone(username));
  }

  return html(
    registerForm({
      action: ctx.path,
      error: "",
      username: "",
      email: "",
      offerAdmin,
      adminChecked: offerAdmin,
    }),
  );
}

// --------------------------------------------------------------------------- //
// telemetry
// --------------------------------------------------------------------------- //

/** `POST /api/sysinfo` — plain text, and `SYSINFO_UPDATED` is the success value. */
const sysinfo: Route["handler"] = async (ctx) => {
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const id = str(body.id);
  if (!id) return text("ID_NOT_FOUND");

  const existing = await getDevice(ctx.env.DB, id);
  // Devices are registered on first contact rather than refused with
  // ID_NOT_FOUND: that answer makes the client re-push sysinfo on every
  // heartbeat until it is accepted, which never ends on a fresh server.
  const preset = str(body["preset-username"]) || str(body.username);
  const owner = existing?.user_name || (preset && (await getUser(ctx.env.DB, preset)) ? preset : "");

  await upsertDevice(ctx.env.DB, id, {
    user_name: owner,
    ver: str(body.version),
    uuid: str(body.uuid),
    ip: clientIp(ctx.request),
    payload: JSON.stringify(body),
    info: JSON.stringify({
      cpu: str(body.cpu),
      memory: str(body.memory),
      os: str(body.os),
      hostname: str(body.hostname),
      username: str(body.username),
      device_name: str(body.hostname),
    }),
    last_online: nowSec(),
  });
  return text("SYSINFO_UPDATED");
};

/**
 * `POST /api/sysinfo_ver` — the client compares this to the version it last
 * uploaded with and skips the push when they match, so a constant is correct:
 * it uploads once, then only when a heartbeat asks for it.
 */
const sysinfoVer: Route["handler"] = async (ctx) =>
  text(ctx.env.SYSINFO_VERSION || SERVER_VERSION);

async function strategyFor(env: Env, device: DeviceRow | null): Promise<StrategyRow | null> {
  const named = device?.strategy_name ?? "";
  if (named) return await getStrategy(env.DB, named);
  if (device?.user_name) {
    const owner = await getUser(env.DB, device.user_name);
    if (owner?.strategy_name) return await getStrategy(env.DB, owner.strategy_name);
  }
  return null;
}

/**
 * `POST /api/heartbeat` — every field in the response is optional and is only
 * acted on when present, so anything not needed is left out entirely.
 */
const heartbeat: Route["handler"] = async (ctx) => {
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const id = str(body.id);
  if (!id) return send({});

  const existing = await getDevice(ctx.env.DB, id);
  await upsertDevice(ctx.env.DB, id, {
    uuid: str(body.uuid) || existing?.uuid,
    ver: str(body.ver),
    ip: clientIp(ctx.request),
    conns: JSON.stringify(Array.isArray(body.conns) ? body.conns : []),
    last_online: nowSec(),
  });
  const device = await getDevice(ctx.env.DB, id);

  const response: Record<string, unknown> = {};
  const strategy = await strategyFor(ctx.env, device);
  const serverModifiedAt = strategy ? strategy.modified_at : 0;
  response.modified_at = serverModifiedAt;
  if (strategy) {
    const payload = parseJson<Record<string, unknown>>(strategy.payload, {});
    response.strategy = {
      config_options: payload.config_options ?? {},
      extra: payload.extra ?? {},
    };
  }
  // An empty payload means this device has never reported its inventory. The
  // client forces a re-push whenever the `sysinfo` key is present at all.
  const reported = parseJson<Record<string, unknown>>(device?.payload ?? "{}", {});
  if (Object.keys(reported).length === 0) response.sysinfo = 1;
  const commands = await takeDeviceCommands(ctx.env.DB, id);
  const disconnect = commands
    .filter((command) => command.kind === "disconnect")
    .flatMap((command) => (Array.isArray(command.payload.conns) ? command.payload.conns : []));
  if (disconnect.length > 0) response.disconnect = disconnect;

  return send(response);
};

// --------------------------------------------------------------------------- //
// switch grant
// --------------------------------------------------------------------------- //

/**
 * Verify an Ed25519 signature when WebCrypto supports it.
 *
 * The outcome is recorded on the row but not enforced: the exact byte layout
 * the client signs is not observable from this repository, so a mismatch could
 * as easily be this server's mistake as a forgery — and the endpoint already
 * sits behind the API's shared secret.
 */
async function verifyEd25519(
  pkBase64: string,
  signatureBase64: string,
  message: Uint8Array,
): Promise<boolean> {
  const pk = base64ToBytes(pkBase64);
  const signature = base64ToBytes(signatureBase64);
  if (!pk || !signature || pk.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      pk,
      { name: "Ed25519" } as unknown as AlgorithmIdentifier,
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519" as unknown as AlgorithmIdentifier,
      key,
      signature,
      message,
    );
  } catch {
    return false;
  }
}

const switchGrant: Route["handler"] = async (ctx) => {
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const id = str(body.id);
  const verifier = str(body.switch_code_verifier);
  const timestamp = str(body.timestamp);
  const signature = str(body.signature);
  const now = nowSec();

  const parsed = Number.parseInt(timestamp, 10);
  if (!id || !verifier || !Number.isFinite(parsed)) {
    return send({ accepted: false, server_time: now });
  }

  const device = await getDevice(ctx.env.DB, id);
  if (!device) return send({ accepted: false, server_time: now });

  // Rejecting with the server's clock is what makes the client re-sign and
  // retry once, which is the whole point of the endpoint.
  if (Math.abs(now - parsed) > SWITCH_GRANT_SKEW_SECS) {
    return send({ accepted: false, server_time: now });
  }

  const verified = device.pk
    ? await verifyEd25519(
        device.pk,
        signature,
        new TextEncoder().encode(`switch-grant\0${id}\0${verifier}\0${timestamp}`),
      )
    : false;
  await ctx.env.DB.prepare(
    "INSERT INTO switch_grants (id, verifier, signature, verified, created_at) VALUES (?, ?, ?, ?, ?)" +
      " ON CONFLICT(id) DO UPDATE SET verifier = excluded.verifier," +
      " signature = excluded.signature, verified = excluded.verified," +
      " created_at = excluded.created_at",
  )
    .bind(id, verifier, signature, verified ? 1 : 0, now)
    .run();

  return send({ accepted: true, server_time: now });
};

// --------------------------------------------------------------------------- //
// device provisioning
// --------------------------------------------------------------------------- //

/** Plain text: an empty body means success, anything else is the message. */
const devicesCli: Route["handler"] = async (ctx) => {
  const session = await resolveSession(ctx);
  if (!session.user) return text(session.reason || "Invalid token");
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const id = str(body.id);
  if (!id) return text("id is required");

  const wanted = str(body.user_name);
  if (wanted && !session.user.is_admin && wanted !== session.user.name) {
    return text("Admin required to assign a device to another user");
  }
  const owner = wanted || session.user.name;
  if (!(await getUser(ctx.env.DB, owner))) return text(`user not found: ${owner}`);

  const patch: DevicePatch = { user_name: owner, uuid: str(body.uuid) };
  const strategyName = str(body.strategy_name);
  if (strategyName) {
    if (!(await getStrategy(ctx.env.DB, strategyName))) {
      return text(`strategy not found: ${strategyName}`);
    }
    patch.strategy_name = strategyName;
  }
  const groupName = str(body.device_group_name);
  if (groupName) {
    patch.device_group_name = groupName;
    await ctx.env.DB.prepare(
      "INSERT OR IGNORE INTO device_groups (guid, user_name, name, created_at) VALUES (?, ?, ?, ?)",
    )
      .bind(newId(), owner, groupName, nowSec())
      .run();
  }
  if (body.note !== undefined) patch.note = str(body.note);

  const info: Record<string, unknown> = {};
  if (body.device_username !== undefined) info.username = str(body.device_username);
  if (body.device_name !== undefined) info.device_name = str(body.device_name);
  if (Object.keys(info).length > 0) {
    const existing = await getDevice(ctx.env.DB, id);
    const merged = { ...parseJson<Record<string, unknown>>(existing?.info ?? "{}", {}), ...info };
    patch.info = JSON.stringify(merged);
  }
  await upsertDevice(ctx.env.DB, id, patch);

  const bookName = str(body.address_book_name);
  if (bookName) {
    const books = await listAbs(ctx.env.DB, {
      userName: owner,
      isAdmin: false,
      kind: "shared",
      nameLike: bookName,
      limit: 100,
      offset: 0,
    });
    let book: AbRow | undefined = books.rows.find((row) => row.name === bookName);
    if (!book) {
      book = await createAb(ctx.env.DB, { userName: owner, name: bookName, kind: "shared" });
    }
    const tags = str(body.address_book_tag);
    await upsertAbPeer(ctx.env.DB, book.guid, {
      id,
      alias: str(body.address_book_alias),
      note: str(body.address_book_note),
      password: str(body.address_book_password),
      tags: tags ? tags.split(",").map((t) => t.trim()).filter(Boolean) : [],
    });
  }
  return text("");
};

function validDeviceId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(id);
}

const devicesDeploy: Route["handler"] = async (ctx) => {
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const id = str(body.id).trim();
  const uuid = str(body.uuid).trim();
  const pk = str(body.pk).trim();

  if (!(await sessionIsUsable(ctx))) return send({ result: "NOT_ENABLED" });
  if (!validDeviceId(id) || !uuid) return send({ result: "INVALID_INPUT" });
  const pkBytes = base64ToBytes(pk);
  if (!pkBytes || pkBytes.length !== 32) return send({ result: "INVALID_INPUT" });

  const existing = await getDevice(ctx.env.DB, id);
  if (existing && existing.uuid && existing.uuid !== uuid) {
    return send({ result: "ID_TAKEN" });
  }
  const session = await resolveSession(ctx);
  await upsertDevice(ctx.env.DB, id, {
    user_name: existing?.user_name || session.user?.name || "",
    uuid,
    pk,
    last_online: nowSec(),
  });
  return send({ result: "OK" });
};

/** Deployment is refused when the feature is switched off or the caller is unknown. */
async function sessionIsUsable(ctx: Ctx): Promise<boolean> {
  const flag = (ctx.env.ALLOW_DEPLOY ?? "true").trim().toLowerCase();
  if (flag === "false" || flag === "0" || flag === "no") return false;
  return bearerToken(ctx.request).length > 0 || !strictAuth(ctx.env);
}

// --------------------------------------------------------------------------- //
// operator conveniences
// --------------------------------------------------------------------------- //

/** `POST /api/devices/disconnect` — queued, then delivered by the next heartbeat. */
const devicesDisconnect: Route["handler"] = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  if (!user.is_admin) return fail(403, "Admin required");
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const id = str(body.id);
  if (!id) return softFail("id is required");
  const conns = Array.isArray(body.conns) ? body.conns : [];
  await queueDeviceCommand(ctx.env.DB, id, "disconnect", { conns });
  return ok();
};

const deviceSummary: Route["handler"] = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  if (!user.is_admin) return fail(403, "Admin required");
  return send({ ...(await summary(ctx.env.DB)), server_version: SERVER_VERSION });
};

// --------------------------------------------------------------------------- //

export const accountRoutes: Route[] = [
  { method: "POST", path: "api/login", handler: login },
  { method: "POST", path: "api/logout", handler: logout },
  { method: "POST", path: "api/currentUser", handler: currentUser },
  { method: "GET", path: "api/login-options", handler: loginOptionsRoute },
  { method: "POST", path: "api/oidc/auth", handler: oidcAuth },
  { method: "GET", path: "api/oidc/auth-query", handler: oidcAuthQuery },
  { method: "POST", path: "api/sysinfo", handler: sysinfo },
  { method: "POST", path: "api/sysinfo_ver", handler: sysinfoVer },
  { method: "POST", path: "api/heartbeat", handler: heartbeat },
  { method: "POST", path: "api/switch-grant", handler: switchGrant },
  { method: "POST", path: "api/devices/cli", handler: devicesCli },
  { method: "POST", path: "api/devices/deploy", handler: devicesDeploy },
  { method: "POST", path: "api/devices/disconnect", handler: devicesDisconnect },
  { method: "GET", path: "api/summary", handler: deviceSummary },
];
