/**
 * The address book API.
 *
 * Everything the client's `ab_model.dart` calls, plus the shared-address-book
 * management surface `res/ab.py` drives, plus the two legacy shapes so a
 * client that downgraded (or the old Sciter UI) keeps working.
 *
 * Answer shapes are not uniform, and each one is load-bearing:
 *
 *   /api/ab/settings               object, client reads `max_peer_one_ab`
 *   /api/ab/personal               object, client reads `guid`
 *   /api/ab/shared/profiles        {total, data:[AbProfile]}
 *   /api/ab/peers                  {total, data:[Peer]}
 *   /api/ab/tags/{guid}            a BARE array, no `data` wrapper
 *   every write                    **200 with an empty body** — a body of
 *                                  `null` is reported to the user as the error
 *                                  "null", see util.ts
 *   GET /api/ab                    {licensed_devices, data:"<json string>"},
 *                                  or the literal `null` when empty
 */

import type { AbPeerRow, AbRow, UserRow } from "../env";
import { RULE_FULL, RULE_READ, RULE_READ_WRITE } from "../env";
import type { Route } from "../route";
import {
  addAbRule,
  addAbTag,
  allAbPeers,
  countAbPeers,
  createAb,
  deleteAbPeers,
  deleteAbRules,
  deleteAbTags,
  deleteAbs,
  effectiveRule,
  getAb,
  getAbRule,
  getAbTagColor,
  getDevice,
  listAbPeers,
  listAbRules,
  listAbs,
  listAbTags,
  personalAb,
  renamePeerTag,
  updateAb,
  updateAbRule,
  updateAbPeer,
  upsertAbPeer,
  upsertDevice,
  type DevicePatch,
} from "../store";
import {
  type Ctx,
  asArray,
  asRecord,
  get,
  isResponse,
  likePattern,
  nowSec,
  ok,
  pageParams,
  parseJson,
  readJson,
  send,
  softFail,
  str,
  toInt,
} from "../util";

// --------------------------------------------------------------------------- //
// payload shapes the client deserialises
// --------------------------------------------------------------------------- //

/**
 * Shape a stored peer for the client's `Peer.fromJson`.
 *
 * The field names are the client's, not the database's: `forceAlwaysRelay` is a
 * *string* (`Peer.fromJson` compares it to `'true'`), `loginName`/`rdpPort`/
 * `rdpUsername` are camelCase while `device_group_name`/`same_server` are not.
 */
function peerPayload(row: AbPeerRow): Record<string, unknown> {
  const payload = parseJson<Record<string, unknown>>(row.payload, {});
  const tags = Array.isArray(payload.tags) ? payload.tags : parseJson<unknown[]>(row.tags, []);
  const relay = get(payload, "forceAlwaysRelay", "false");
  return {
    id: str(payload.id) || row.id,
    hash: get(payload, "hash", ""),
    password: get(payload, "password", ""),
    username: get(payload, "username", ""),
    hostname: get(payload, "hostname", ""),
    platform: get(payload, "platform", ""),
    alias: get(payload, "alias", ""),
    tags,
    forceAlwaysRelay:
      relay === true || relay === "true" ? "true" : "false",
    rdpPort: get(payload, "rdpPort", ""),
    rdpUsername: get(payload, "rdpUsername", ""),
    loginName: get(payload, "loginName", ""),
    device_group_name: get(payload, "device_group_name", ""),
    note: typeof payload.note === "string" ? payload.note : "",
    same_server: payload.same_server ?? null,
  };
}

function profilePayload(row: AbRow, rule: number, isPersonal = false): Record<string, unknown> {
  return {
    guid: row.guid,
    name: row.name,
    owner: row.owner || row.user_name,
    note: row.note || null,
    rule: isPersonal ? RULE_FULL : rule,
    info: parseJson<Record<string, unknown>>(row.info, {}),
  };
}

// --------------------------------------------------------------------------- //
// access helpers
// --------------------------------------------------------------------------- //

interface OpenedAb {
  ab: AbRow;
  rule: number;
}

/**
 * Open the address book a request names.
 *
 * An empty guid means "the caller's personal one", which is how the personal
 * page behaves when it has not fetched `/api/ab/personal` yet. A non-empty guid
 * that does not resolve is an error rather than a silent fallback: writing to
 * the wrong book is worse than a visible failure, and the client always has a
 * fresh guid.
 */
async function openAb(
  ctx: Ctx,
  user: UserRow,
  guid: string,
  need: number,
): Promise<OpenedAb | Response> {
  if (!guid) {
    const ab = await personalAb(ctx.env.DB, user.name);
    return { ab, rule: RULE_FULL };
  }
  const ab = await getAb(ctx.env.DB, guid);
  if (!ab) return softFail("Address book not found");
  const rule = await effectiveRule(ctx.env.DB, ab, user.name, Boolean(user.is_admin));
  if (rule < need) {
    return need >= RULE_READ_WRITE
      ? softFail("Permission denied: the address book is read-only for you")
      : softFail("Address book not found");
  }
  return { ab, rule };
}

/** Only an owner or an administrator may reshape a shared address book. */
async function ownAb(ctx: Ctx, user: UserRow, guid: string): Promise<AbRow | Response> {
  const ab = await getAb(ctx.env.DB, guid);
  if (!ab) return softFail("Address book not found");
  if (user.is_admin || ab.user_name === user.name || ab.owner === user.name) return ab;
  return softFail("Permission denied");
}

function paramIds(body: unknown): string[] {
  if (!Array.isArray(body)) return [];
  return body.map((item) => str(item)).filter(Boolean);
}

// --------------------------------------------------------------------------- //
// profiles
// --------------------------------------------------------------------------- //

const abPersonal: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const ab = await personalAb(ctx.env.DB, user.name);
  return send({ guid: ab.guid });
};

const abSettings: Route["handler"] = async (ctx) => {
  await ctx.user();
  return send({ max_peer_one_ab: toInt(ctx.env.MAX_PEER_ONE_AB, 0) });
};

const abSharedProfiles: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, rows } = await listAbs(ctx.env.DB, {
    userName: user.name,
    isAdmin: Boolean(user.is_admin),
    kind: "shared",
    nameLike: likePattern(ctx.url.searchParams.get("name")),
    limit: pageSize,
    offset,
  });
  const data = [];
  for (const row of rows) {
    const owned = row.user_name === user.name || row.owner === user.name;
    const rule = user.is_admin || owned ? RULE_FULL : Number(row.granted_rule);
    data.push(profilePayload(row, rule));
  }
  return send({ total, data });
};

const abSharedAdd: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const name = str(body.name).trim();
  if (!name) return softFail("name is required");
  const info = asRecord(body.info) ?? {};
  const ab = await createAb(ctx.env.DB, {
    userName: user.name,
    name,
    kind: "shared",
    owner: str(body.owner) || user.name,
    rule: toInt(str(body.rule), RULE_READ),
    note: str(body.note),
    info: JSON.stringify(info),
  });
  return send({ guid: ab.guid, name: ab.name, owner: ab.owner, rule: ab.rule });
};

const abSharedUpdate: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const guid = str(body.guid).trim() || str(body.ab_guid).trim();
  if (!guid) return softFail("guid is required");
  const ab = await ownAb(ctx, user, guid);
  if (isResponse(ab)) return ab;
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) patch.name = str(body.name);
  if (body.note !== undefined) patch.note = str(body.note);
  if (body.owner !== undefined) patch.owner = str(body.owner);
  if (body.rule !== undefined) patch.rule = toInt(str(body.rule), ab.rule);
  if (body.info !== undefined) patch.info = JSON.stringify(asRecord(body.info) ?? {});
  await updateAb(ctx.env.DB, guid, patch);
  return ok();
};

const abSharedDelete: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const guids = paramIds(await readJson(ctx.request));
  if (guids.length === 0) return softFail("no address book guid given");
  for (const guid of guids) {
    const ab = await ownAb(ctx, user, guid);
    if (isResponse(ab)) return ab;
  }
  await deleteAbs(ctx.env.DB, guids);
  return ok();
};

// --------------------------------------------------------------------------- //
// rules
// --------------------------------------------------------------------------- //

function rulePayload(row: {
  guid: string;
  ab_guid: string;
  target_kind: string;
  target: string;
  rule: number;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    guid: row.guid,
    ab_guid: row.ab_guid,
    rule: row.rule,
  };
  if (row.target_kind === "user") out.user = row.target;
  if (row.target_kind === "group") out.group = row.target;
  return out;
}

const abRulesList: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const guid = ctx.url.searchParams.get("ab") ?? "";
  const opened = await openAb(ctx, user, guid, RULE_READ);
  if (isResponse(opened)) return opened;
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, rows } = await listAbRules(ctx.env.DB, opened.ab.guid, pageSize, offset);
  return send({ total, data: rows.map(rulePayload) });
};

/** `target` follows the same convention as the admin CLI: absent means everyone. */
function ruleTarget(body: Record<string, unknown>): { kind: string; target: string } | null {
  if (body.user !== undefined && body.user !== null) {
    return { kind: "user", target: str(body.user) };
  }
  if (body.group !== undefined && body.group !== null) {
    return { kind: "group", target: str(body.group) };
  }
  if (body.everyone !== undefined) return { kind: "everyone", target: "" };
  if (body.target !== undefined) return { kind: str(body.target_kind) || "user", target: str(body.target) };
  return { kind: "everyone", target: "" };
}

const abRuleAdd: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const guid = str(body.guid).trim();
  const ab = await ownAb(ctx, user, guid);
  if (isResponse(ab)) return ab;
  const target = ruleTarget(body);
  if (!target) return softFail("a rule needs a user, a group, or everyone");
  if (target.kind !== "everyone" && !target.target) {
    return softFail(`${target.kind} is required for a ${target.kind} rule`);
  }
  const rule = toInt(str(body.rule), RULE_READ);
  if (![RULE_READ, RULE_READ_WRITE, RULE_FULL].includes(rule)) {
    return softFail("rule must be 1 (read), 2 (read-write) or 3 (full control)");
  }
  const created = await addAbRule(ctx.env.DB, {
    abGuid: ab.guid,
    targetKind: target.kind,
    target: target.target,
    rule,
  });
  return send(rulePayload(created));
};

const abRuleUpdate: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const ruleGuid = str(body.guid).trim();
  const existing = await getAbRule(ctx.env.DB, ruleGuid);
  if (!existing) return softFail("rule not found");
  const ab = await ownAb(ctx, user, existing.ab_guid);
  if (isResponse(ab)) return ab;
  const rule = toInt(str(body.rule), 0);
  if (![RULE_READ, RULE_READ_WRITE, RULE_FULL].includes(rule)) {
    return softFail("rule must be 1 (read), 2 (read-write) or 3 (full control)");
  }
  await updateAbRule(ctx.env.DB, ruleGuid, rule);
  return ok();
};

const abRuleDelete: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const guids = paramIds(await readJson(ctx.request));
  if (guids.length === 0) return softFail("no rule guid given");
  for (const guid of guids) {
    const existing = await getAbRule(ctx.env.DB, guid);
    if (!existing) continue;
    const ab = await ownAb(ctx, user, existing.ab_guid);
    if (isResponse(ab)) return ab;
  }
  await deleteAbRules(ctx.env.DB, guids);
  return ok();
};

// --------------------------------------------------------------------------- //
// peers
// --------------------------------------------------------------------------- //

const abPeers: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const guid = ctx.url.searchParams.get("ab") ?? "";
  const opened = await openAb(ctx, user, guid, RULE_READ);
  if (isResponse(opened)) return opened;
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, rows } = await listAbPeers(ctx.env.DB, opened.ab.guid, {
    limit: pageSize,
    offset,
    idLike: likePattern(ctx.url.searchParams.get("id")),
    aliasLike: likePattern(ctx.url.searchParams.get("alias")),
  });
  return send({ total, data: rows.map(peerPayload) });
};

/**
 * Mirror a peer into the device registry.
 *
 * This is what makes a peer show up under "Accessible devices": that page reads
 * `/api/peers`, which is backed by `devices`.
 *
 * It merges rather than replaces. The client also sends partial peers — a bare
 * `{id, alias}` or `{id, tags}` on every address-book edit — and writing those
 * through verbatim would blank the system information the device reported.
 */
async function registerDevice(ctx: Ctx, user: UserRow, peer: Record<string, unknown>): Promise<void> {
  const peerId = str(peer.id);
  if (!peerId) return;
  const existing = await getDevice(ctx.env.DB, peerId);
  const info = parseJson<Record<string, unknown>>(existing?.info ?? "{}", {});

  const username = str(peer.username);
  const os = str(peer.platform);
  const deviceName = str(peer.hostname);
  if (username) info.username = username;
  if (os) info.os = os;
  if (deviceName) info.device_name = deviceName;

  const patch: DevicePatch = {
    // Never steal a device from the account that already owns it.
    user_name: existing?.user_name || user.name,
    status: 1,
    info: JSON.stringify(info),
    last_online: nowSec(),
  };
  const note = str(peer.note);
  if (note) patch.note = note;
  const group = str(peer.device_group_name);
  if (group) patch.device_group_name = group;
  await upsertDevice(ctx.env.DB, peerId, patch);
}

async function peerWriteGate(
  ctx: Ctx,
  action: (opened: OpenedAb, user: UserRow, body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> {
  const user = await ctx.user();
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const guid = str(body.ab).trim() || ctx.params.at(-1) || "";
  const opened = await openAb(ctx, user, guid, RULE_READ_WRITE);
  if (isResponse(opened)) return opened;
  // `ab` is not a peer field; drop it before it is stored.
  delete body.ab;
  return await action(opened, user, body);
}

const abPeerAdd: Route["handler"] = async (ctx) =>
  await peerWriteGate(ctx, async (opened, user, peer) => {
    const peerId = str(peer.id);
    if (!peerId) return softFail("peer id is required");
    const max = toInt(ctx.env.MAX_PEER_ONE_AB, 0);
    if (max > 0 && (await countAbPeers(ctx.env.DB, opened.ab.guid)) >= max) {
      return softFail(`exceed_max_devices`);
    }
    await upsertAbPeer(ctx.env.DB, opened.ab.guid, peer);
    await registerDevice(ctx, user, peer);
    return ok();
  });

const abPeerUpdate: Route["handler"] = async (ctx) =>
  await peerWriteGate(ctx, async (opened, user, patch) => {
    const peerId = str(patch.id);
    if (!peerId) return softFail("peer id is required");
    const updated = await updateAbPeer(ctx.env.DB, opened.ab.guid, patch);
    // The client pushes password/sync patches for peers it already knows.
    // Upserting instead of failing keeps its sync loop from erroring out.
    if (!updated) await upsertAbPeer(ctx.env.DB, opened.ab.guid, patch);
    await registerDevice(ctx, user, patch);
    return ok();
  });

const abPeerDelete: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const ids = paramIds(await readJson(ctx.request));
  const guid = ctx.params.at(-1) || "";
  const opened = await openAb(ctx, user, guid, RULE_READ_WRITE);
  if (isResponse(opened)) return opened;
  await deleteAbPeers(ctx.env.DB, opened.ab.guid, ids);
  return ok();
};

// --------------------------------------------------------------------------- //
// tags
// --------------------------------------------------------------------------- //

const abTagsList: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const guid = ctx.params.at(-1) || "";
  const opened = await openAb(ctx, user, guid, RULE_READ);
  if (isResponse(opened)) return opened;
  const rows = await listAbTags(ctx.env.DB, opened.ab.guid);
  // A bare array: `_jsonDecodeRespList` refuses anything else.
  return send(rows.map((row) => ({ name: row.name, color: row.color })));
};

const abTagAdd: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const opened = await openAb(ctx, user, ctx.params.at(-1) || "", RULE_READ_WRITE);
  if (isResponse(opened)) return opened;
  const name = str(body.name);
  if (!name) return softFail("tag name is required");
  await addAbTag(ctx.env.DB, opened.ab.guid, name, toInt(str(body.color), 0));
  return ok();
};

const abTagRename: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const opened = await openAb(ctx, user, ctx.params.at(-1) || "", RULE_READ_WRITE);
  if (isResponse(opened)) return opened;
  const oldName = str(body.old);
  const newName = str(body.new);
  if (!oldName || !newName) return softFail("old and new are required");
  const color = await getAbTagColor(ctx.env.DB, opened.ab.guid, oldName);
  await addAbTag(ctx.env.DB, opened.ab.guid, newName, color);
  await renamePeerTag(ctx.env.DB, opened.ab.guid, oldName, newName);
  await deleteAbTags(ctx.env.DB, opened.ab.guid, [oldName]);
  return ok();
};

const abTagUpdate: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const opened = await openAb(ctx, user, ctx.params.at(-1) || "", RULE_READ_WRITE);
  if (isResponse(opened)) return opened;
  const name = str(body.name);
  if (!name) return softFail("tag name is required");
  await addAbTag(ctx.env.DB, opened.ab.guid, name, toInt(str(body.color), 0));
  return ok();
};

const abTagDelete: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const names = paramIds(await readJson(ctx.request));
  const opened = await openAb(ctx, user, ctx.params.at(-1) || "", RULE_READ_WRITE);
  if (isResponse(opened)) return opened;
  await deleteAbTags(ctx.env.DB, opened.ab.guid, names);
  return ok();
};

// --------------------------------------------------------------------------- //
// legacy: the whole address book in one document
// --------------------------------------------------------------------------- //

async function legacyDocument(ctx: Ctx, user: UserRow): Promise<Record<string, unknown>> {
  const ab = await personalAb(ctx.env.DB, user.name);
  const [peers, tags] = await Promise.all([
    allAbPeers(ctx.env.DB, ab.guid),
    listAbTags(ctx.env.DB, ab.guid),
  ]);
  return {
    tags: tags.map((t) => t.name),
    peers: peers.map((p) => parseJson<Record<string, unknown>>(p.payload, {})),
    tag_colors: JSON.stringify(Object.fromEntries(tags.map((t) => [t.name, t.color]))),
  };
}

const abLegacyPull: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const document = await legacyDocument(ctx, user);
  const peers = asArray(document.peers);
  const tags = asArray(document.tags);
  if (peers.length === 0 && tags.length === 0) {
    // The client clears its local copy when the body is the literal `null`.
    return send(null);
  }
  return send({ licensed_devices: 0, data: JSON.stringify(document) });
};

const abLegacyPush: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const raw = body.data;
  if (typeof raw !== "string" || !raw) return ok();
  const document = parseJson<Record<string, unknown> | null>(raw, null);
  if (!document) return softFail("invalid data");
  const ab = await personalAb(ctx.env.DB, user.name);
  const colors = parseJson<Record<string, number>>(str(document.tag_colors) || "{}", {});
  for (const tag of Array.isArray(document.tags) ? document.tags : []) {
    const name = str(tag);
    if (name) await addAbTag(ctx.env.DB, ab.guid, name, Number(colors[name] ?? 0) || 0);
  }
  for (const peer of Array.isArray(document.peers) ? document.peers : []) {
    const record = asRecord(peer);
    if (record) await upsertAbPeer(ctx.env.DB, ab.guid, record);
  }
  return send(null);
};

/** The Sciter UI's reader, which also reports when the document last changed. */
const abLegacyGet: Route["handler"] = async (ctx) => {
  const user = await ctx.user();
  const document = await legacyDocument(ctx, user);
  const ab = await personalAb(ctx.env.DB, user.name);
  const rows = await allAbPeers(ctx.env.DB, ab.guid);
  const updatedAt = rows.reduce((max, row) => Math.max(max, row.updated_at), ab.created_at);
  return send({ updated_at: updatedAt, data: JSON.stringify(document) });
};

// --------------------------------------------------------------------------- //

export const abRoutes: Route[] = [
  { method: "GET", path: "api/ab", handler: abLegacyPull },
  { method: "POST", path: "api/ab", handler: abLegacyPush },
  { method: "POST", path: "api/ab/get", handler: abLegacyGet },
  { method: "GET", path: "api/ab/personal", handler: abPersonal },
  { method: "POST", path: "api/ab/personal", handler: abPersonal },
  { method: "GET", path: "api/ab/settings", handler: abSettings },
  { method: "POST", path: "api/ab/settings", handler: abSettings },
  { method: "GET", path: "api/ab/shared/profiles", handler: abSharedProfiles },
  { method: "POST", path: "api/ab/shared/profiles", handler: abSharedProfiles },
  { method: "POST", path: "api/ab/shared/add", handler: abSharedAdd },
  { method: "PUT", path: "api/ab/shared/update/profile", handler: abSharedUpdate },
  { method: "POST", path: "api/ab/shared/update/profile", handler: abSharedUpdate },
  { method: "DELETE", path: "api/ab/shared", handler: abSharedDelete },
  { method: "GET", path: "api/ab/rules", handler: abRulesList },
  { method: "POST", path: "api/ab/rule", handler: abRuleAdd },
  { method: "PATCH", path: "api/ab/rule", handler: abRuleUpdate },
  { method: "PUT", path: "api/ab/rule", handler: abRuleUpdate },
  { method: "DELETE", path: "api/ab/rules", handler: abRuleDelete },
  { method: "POST", path: "api/ab/peers", handler: abPeers },
  { method: "GET", path: "api/ab/peers", handler: abPeers },
  { method: "POST", path: "api/ab/tags/*", handler: abTagsList },
  { method: "GET", path: "api/ab/tags/*", handler: abTagsList },
  { method: "POST", path: "api/ab/peer/add/*", handler: abPeerAdd },
  { method: "PUT", path: "api/ab/peer/update/*", handler: abPeerUpdate },
  { method: "DELETE", path: "api/ab/peer/*", handler: abPeerDelete },
  { method: "POST", path: "api/ab/tag/add/*", handler: abTagAdd },
  { method: "PUT", path: "api/ab/tag/rename/*", handler: abTagRename },
  { method: "PUT", path: "api/ab/tag/update/*", handler: abTagUpdate },
  { method: "DELETE", path: "api/ab/tag/*", handler: abTagDelete },
];
