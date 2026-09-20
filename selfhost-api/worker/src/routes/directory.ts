/**
 * The directory: users, devices and device groups.
 *
 * This module serves two audiences over the same paths, which is deliberate —
 * `GET /api/users` and `GET /api/peers` are what the client's "Accessible
 * devices" page reads, and they are also the natural names for the admin list
 * endpoints.
 *
 *   * An administrator sees everything.
 *   * Anybody else sees themselves, plus what address-book sharing has granted
 *     them, and never gets an error for asking.
 *
 * The admin surface is an extension of this server rather than a reimplementation
 * of the vendor's web console: creating an account, assigning a device, defining
 * a policy. It exists so that running this server never needs hand-written SQL.
 */

import type { UserRow } from "../env";
import { userPayload, devicePayload, deviceGroupPayload, peerDevicePayload, strategyPayload } from "../payload";
import type { Route } from "../route";
import {
  createAccount,
  hashPassword,
  requireAdmin,
  setPassword,
} from "../auth";
import {
  accessibleDeviceIds,
  deleteDeviceGroups,
  deleteDevices,
  deleteStrategies,
  deleteUsers,
  getDevice,
  getOrCreateDeviceGroup,
  getStrategy,
  getUser,
  hasAdmin,
  listAbs,
  listDeviceGroups,
  listDevices,
  listStrategies,
  listUsers,
  renameDeviceGroup,
  updateUser,
  upsertDevice,
  upsertStrategy,
  type DevicePatch,
} from "../store";
import {
  type Ctx,
  asRecord,
  isResponse,
  ok,
  pageParams,
  readJson,
  send,
  softFail,
  str,
  toInt,
} from "../util";

// --------------------------------------------------------------------------- //
// visibility
// --------------------------------------------------------------------------- //

/**
 * The accounts the caller may see, or `null` for "all of them".
 *
 * Sharing an address book exposes its owner and everyone else it is shared
 * with, which is what makes the accessible-devices user tree meaningful.
 */
async function accessibleUserNames(ctx: Ctx, user: UserRow): Promise<string[] | null> {
  if (user.is_admin) return null;
  const names = new Set<string>([user.name]);
  const books = await listAbs(ctx.env.DB, { userName: user.name, isAdmin: false, limit: 1000, offset: 0 });
  for (const book of books.rows) {
    if (book.owner) names.add(book.owner);
    names.add(book.user_name);
  }
  return [...names];
}

function devicePatchFromBody(body: Record<string, unknown>): DevicePatch {
  const patch: DevicePatch = {};
  if (body.user_name !== undefined) patch.user_name = str(body.user_name);
  if (body.device_group_name !== undefined) patch.device_group_name = str(body.device_group_name);
  if (body.strategy_name !== undefined) patch.strategy_name = str(body.strategy_name);
  if (body.note !== undefined) patch.note = str(body.note);
  if (body.status !== undefined) patch.status = toInt(str(body.status), 1);
  if (body.info !== undefined) patch.info = JSON.stringify(asRecord(body.info) ?? {});
  return patch;
}

function stringList(body: unknown): string[] {
  if (Array.isArray(body)) return body.map((item) => str(item)).filter(Boolean);
  const record = asRecord(body);
  if (record) {
    const value = record.name ?? record.id ?? record.guid ?? record.names ?? record.ids;
    if (Array.isArray(value)) return value.map((item) => str(item)).filter(Boolean);
    if (value !== undefined) return [str(value)].filter(Boolean);
  }
  return [];
}

// --------------------------------------------------------------------------- //
// the client's "Accessible devices" page
// --------------------------------------------------------------------------- //

const deviceGroupsAccessible: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, rows } = await listDeviceGroups(ctx.env.DB, {
    userName: user.name,
    isAdmin: Boolean(user.is_admin),
    limit: pageSize,
    offset,
  });
  return send({ total, data: rows.map(deviceGroupPayload) });
};

const usersList: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  // `accessible` is sent as an empty value by the client, so presence is the
  // signal, not the value.
  const accessibleOnly = ctx.url.searchParams.has("accessible");
  const names = accessibleOnly || !user.is_admin ? await accessibleUserNames(ctx, user) : null;
  const statusRaw = ctx.url.searchParams.get("status");
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, rows } = await listUsers(ctx.env.DB, {
    limit: pageSize,
    offset,
    names,
    status: statusRaw ? toInt(statusRaw, 1) : null,
  });
  return send({ total, data: rows.map(userPayload) });
};

const peersList: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const accessibleOnly = ctx.url.searchParams.has("accessible");
  const ids = accessibleOnly || !user.is_admin ? await accessibleDeviceIds(ctx.env.DB, user.name, false) : null;
  const statusRaw = ctx.url.searchParams.get("status");
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, rows } = await listDevices(ctx.env.DB, {
    limit: pageSize,
    offset,
    ids,
    status: statusRaw ? toInt(statusRaw, 1) : null,
    owner: ctx.url.searchParams.get("user_name"),
    groupLike: ctx.url.searchParams.get("device_group_name")
      ? `%${ctx.url.searchParams.get("device_group_name")}%`
      : null,
  });
  return send({ total, data: rows.map(peerDevicePayload) });
};

// --------------------------------------------------------------------------- //
// admin: users
// --------------------------------------------------------------------------- //

/**
 * Create an account.
 *
 * The first account can be created without any credential, which is what makes
 * a fresh deployment work with no SQL at all: there is nothing to authenticate
 * against yet. As soon as one administrator exists that door closes, and the
 * endpoint is administrator-only.
 */
const adminUsersCreate: Route["handler"] = async (ctx) => {
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const bootstrap = !(await hasAdmin(ctx.env.DB));

  let admin: UserRow;
  if (bootstrap) {
    admin = await ctx.user();
  } else {
    const checked = await requireAdmin(ctx);
    if (isResponse(checked)) return checked;
    admin = checked;
  }

  const name = str(body.name).trim();
  if (!name) return softFail("name is required");
  const isAdmin = bootstrap ? body.is_admin !== false : body.is_admin === true;
  const created = await createAccount(ctx.env, {
    name,
    displayName: str(body.display_name) || name,
    email: str(body.email),
    note: str(body.note),
    password: str(body.password),
    isAdmin,
    status: body.status === undefined ? 1 : toInt(str(body.status), 1),
    strategyName: str(body.strategy_name),
    tfaSecret: str(body.tfa_secret),
    tfaType: str(body.tfa_type),
  });
  if (!created) return softFail("user already exists");
  return send({
    ...userPayload(await getUser(ctx.env.DB, name)),
    bootstrapped: bootstrap,
    created_by: admin.name,
  });
};

const adminUsersUpdate: Route["handler"] = async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const name = str(body.name).trim();
  if (!name) return softFail("name is required");
  if (!(await getUser(ctx.env.DB, name))) return softFail("user not found");

  const patch: Record<string, unknown> = {};
  if (body.display_name !== undefined) patch.display_name = str(body.display_name);
  if (body.avatar !== undefined) patch.avatar = str(body.avatar);
  if (body.email !== undefined) patch.email = str(body.email);
  if (body.note !== undefined) patch.note = str(body.note);
  if (body.strategy_name !== undefined) patch.strategy_name = str(body.strategy_name);
  if (body.tfa_secret !== undefined) patch.tfa_secret = str(body.tfa_secret);
  if (body.tfa_type !== undefined) patch.tfa_type = str(body.tfa_type);
  if (body.is_admin !== undefined) patch.is_admin = body.is_admin === true ? 1 : 0;
  if (body.status !== undefined) patch.status = toInt(str(body.status), 1);
  if (body.password_hash !== undefined) patch.password_hash = str(body.password_hash);
  await updateUser(ctx.env.DB, name, patch);
  if (body.password !== undefined) await setPassword(ctx.env, name, str(body.password));
  return ok();
};

const adminUsersDelete: Route["handler"] = async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const names = stringList(await readJson(ctx.request));
  if (names.length === 0) return softFail("no user name given");
  if (names.includes(admin.name)) return softFail("refusing to delete the calling account");
  await deleteUsers(ctx.env.DB, names);
  return ok();
};

/** A dedicated endpoint, because "reset a password" should not be a PATCH shape. */
const adminUsersPassword: Route["handler"] = async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const name = str(body.name).trim();
  if (!name) return softFail("name is required");
  if (!(await getUser(ctx.env.DB, name))) return softFail("user not found");
  await setPassword(ctx.env, name, str(body.password));
  return send({ name, password_hash: await hashPassword(str(body.password)) });
};

// --------------------------------------------------------------------------- //
// admin: devices
// --------------------------------------------------------------------------- //

const adminDevicesList: Route["handler"] = async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, rows } = await listDevices(ctx.env.DB, {
    limit: pageSize,
    offset,
    owner: ctx.url.searchParams.get("user_name"),
    groupLike: ctx.url.searchParams.get("device_group_name")
      ? `%${ctx.url.searchParams.get("device_group_name")}%`
      : null,
    status: ctx.url.searchParams.has("status")
      ? toInt(ctx.url.searchParams.get("status"), 1)
      : null,
  });
  return send({ total, data: rows.map(devicePayload) });
};

const adminDevicesUpdate: Route["handler"] = async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const id = str(body.id).trim();
  if (!id) return softFail("id is required");
  const patch = devicePatchFromBody(body);
  const owner = str(patch.user_name);
  if (owner && !(await getUser(ctx.env.DB, owner))) {
    return softFail("user not found");
  }
  const strategyName = str(patch.strategy_name);
  if (strategyName && !(await getStrategy(ctx.env.DB, strategyName))) {
    return softFail("strategy not found");
  }
  if (!(await getDevice(ctx.env.DB, id))) {
    // Assigning an unknown id registers it, which is how a device gets
    // pre-provisioned before it ever comes online.
    await upsertDevice(ctx.env.DB, id, { ...patch, status: 1 });
  } else {
    await upsertDevice(ctx.env.DB, id, patch);
  }
  return send(devicePayload((await getDevice(ctx.env.DB, id))!));
};

const adminDevicesDelete: Route["handler"] = async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const ids = stringList(await readJson(ctx.request));
  if (ids.length === 0) return softFail("no device id given");
  await deleteDevices(ctx.env.DB, ids);
  return ok();
};

// --------------------------------------------------------------------------- //
// admin: device groups
// --------------------------------------------------------------------------- //

const adminGroupsList: Route["handler"] = async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, rows } = await listDeviceGroups(ctx.env.DB, {
    userName: str(admin.name),
    isAdmin: true,
    limit: pageSize,
    offset,
  });
  return send({ total, data: rows.map(deviceGroupPayload) });
};

const adminGroupsUpsert: Route["handler"] = async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const name = str(body.name).trim();
  if (!name) return softFail("name is required");
  const owner = str(body.user_name) || admin.name;
  if (!(await getUser(ctx.env.DB, owner))) return softFail("user not found");
  const rename = str(body.new_name).trim();
  if (rename) {
    if (!(await renameDeviceGroup(ctx.env.DB, owner, name, rename))) {
      return softFail("device group not found");
    }
  } else {
    await getOrCreateDeviceGroup(ctx.env.DB, owner, name);
  }
  return ok();
};

const adminGroupsDelete: Route["handler"] = async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const names = stringList(body);
  if (names.length === 0) return softFail("no device group name given");
  await deleteDeviceGroups(ctx.env.DB, names, str(body.user_name) || admin.name);
  return ok();
};

// --------------------------------------------------------------------------- //
// admin: strategies
// --------------------------------------------------------------------------- //

const adminStrategiesList: Route["handler"] = async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, rows } = await listStrategies(ctx.env.DB, pageSize, offset);
  return send({ total, data: rows.map(strategyPayload) });
};

const adminStrategiesUpsert: Route["handler"] = async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const name = str(body.name).trim();
  if (!name) return softFail("name is required");
  const modifiedAt = await upsertStrategy(ctx.env.DB, name, {
    config_options: asRecord(body.config_options) ?? {},
    extra: asRecord(body.extra) ?? {},
  });
  return send({ name, modified_at: modifiedAt });
};

const adminStrategiesDelete: Route["handler"] = async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const names = stringList(await readJson(ctx.request));
  if (names.length === 0) return softFail("no strategy name given");
  await deleteStrategies(ctx.env.DB, names);
  return ok();
};

/** Which devices currently hold a session — enough for a dashboard. */
const adminOnline: Route["handler"] = async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const { total, rows } = await listDevices(ctx.env.DB, { limit: 1000, offset: 0 });
  const online = rows.filter((row) => row.conns !== "[]" && row.conns !== "");
  return send({
    total,
    online: online.length,
    data: online.map((row) => ({ id: row.id, user_name: row.user_name, conns: row.conns })),
  });
};

// --------------------------------------------------------------------------- //

export const directoryRoutes: Route[] = [
  { method: "GET", path: "api/device-group/accessible", handler: deviceGroupsAccessible },
  { method: "GET", path: "api/users", handler: usersList },
  { method: "GET", path: "api/peers", handler: peersList },

  { method: "POST", path: "api/users", handler: adminUsersCreate },
  { method: "PUT", path: "api/users", handler: adminUsersUpdate },
  { method: "PATCH", path: "api/users", handler: adminUsersUpdate },
  { method: "DELETE", path: "api/users", handler: adminUsersDelete },
  { method: "POST", path: "api/users/password", handler: adminUsersPassword },
  { method: "PUT", path: "api/users/password", handler: adminUsersPassword },

  { method: "GET", path: "api/devices", handler: adminDevicesList },
  { method: "POST", path: "api/devices", handler: adminDevicesUpdate },
  { method: "PUT", path: "api/devices", handler: adminDevicesUpdate },
  { method: "PATCH", path: "api/devices", handler: adminDevicesUpdate },
  { method: "DELETE", path: "api/devices", handler: adminDevicesDelete },

  { method: "GET", path: "api/device-group", handler: adminGroupsList },
  { method: "POST", path: "api/device-group", handler: adminGroupsUpsert },
  { method: "PUT", path: "api/device-group", handler: adminGroupsUpsert },
  { method: "DELETE", path: "api/device-group", handler: adminGroupsDelete },

  { method: "GET", path: "api/strategies", handler: adminStrategiesList },
  { method: "POST", path: "api/strategies", handler: adminStrategiesUpsert },
  { method: "PUT", path: "api/strategies", handler: adminStrategiesUpsert },
  { method: "DELETE", path: "api/strategies", handler: adminStrategiesDelete },

  { method: "GET", path: "api/online", handler: adminOnline },
];
