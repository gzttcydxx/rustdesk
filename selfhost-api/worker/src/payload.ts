/**
 * Response payloads shared by more than one route module.
 *
 * Field names here are the *client's*, and several of them are surprising:
 * `forceAlwaysRelay` is a string, `loginName` is camelCase while
 * `device_group_name` is not, and `UserPayload.info` is not optional on the
 * Rust side even though Flutter ignores it.
 */

import type { DeviceRow, UserRow } from "./env";
import { parseJson, str } from "./util";

/** `UserPayload` — read by `UserPayload.fromJson` (Flutter) and `account.rs`. */
export function userPayload(row: Partial<UserRow> | null | undefined): Record<string, unknown> {
  return {
    name: row?.name ?? "",
    display_name: row?.display_name ?? "",
    avatar: row?.avatar ?? "",
    email: row?.email ?? "",
    note: row?.note ?? "",
    verifier: row?.verifier ?? "",
    // 1 = normal, 0 = disabled, -1 = unverified.
    status: row?.status ?? 1,
    is_admin: Boolean(row?.is_admin ?? 0),
    third_auth_type: null,
    // Required by `AuthBody`'s `UserPayload`; not optional in Rust.
    info: {},
  };
}

/** `PeerPayload` — read by `PeerPayload.fromJson` in `group_model.dart`. */
export function peerDevicePayload(row: DeviceRow): Record<string, unknown> {
  const info = parseJson<Record<string, unknown>>(row.info, {});
  return {
    id: row.id,
    info: {
      username: str(info.username),
      os: str(info.os),
      device_name: str(info.device_name),
    },
    status: row.status,
    user: row.user_name,
    user_name: row.user_name,
    device_group_name: row.device_group_name,
    note: row.note,
  };
}

/** The admin view of a device: everything the row holds, parsed. */
export function devicePayload(row: DeviceRow): Record<string, unknown> {
  return {
    id: row.id,
    user_name: row.user_name,
    device_group_name: row.device_group_name,
    strategy_name: row.strategy_name,
    note: row.note,
    status: row.status,
    info: parseJson<Record<string, unknown>>(row.info, {}),
    pk: row.pk,
    uuid: row.uuid,
    ver: row.ver,
    ip: row.ip,
    conns: parseJson<number[]>(row.conns, []),
    last_online: row.last_online,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function deviceGroupPayload(row: { guid: string; user_name: string; name: string }): Record<string, unknown> {
  return { guid: row.guid, user_name: row.user_name, name: row.name };
}

export function strategyPayload(row: {
  name: string;
  payload: string;
  modified_at: number;
  created_at: number;
}): Record<string, unknown> {
  const body = parseJson<Record<string, unknown>>(row.payload, {});
  return {
    name: row.name,
    modified_at: row.modified_at,
    created_at: row.created_at,
    config_options: body.config_options ?? {},
    extra: body.extra ?? {},
  };
}
