/**
 * Audit ingest and recording upload.
 *
 * Both are machine-to-machine: they are posted by the Rust side of a client,
 * not by the UI, and their success convention is stricter than the rest of the
 * API.
 *
 *   * `POST /api/audit/conn|file|alarm` carry **no Authorization header** and
 *     must answer **2xx with an empty body**. Anything non-empty is read as a
 *     retryable failure, so the client backs off 10s, then 30s, and gives up
 *     after 120s — which is why an accidental `null` body would turn every
 *     audit record into three failed posts.
 *   * Each audit post carries a `nonce`; the same nonce within ten minutes is
 *     the client retrying, so it must not create a second row.
 *   * `/api/record` sends raw bytes with the metadata in the query string, and
 *     answers any JSON object without an `error` key for success.
 */

import { requireAdmin, requireUser } from "../auth";
import type { Route } from "../route";
import {
  activeAuditGuid,
  deleteRecord,
  insertAuditAlarm,
  insertAuditConn,
  insertAuditFile,
  latestAuditConnGuid,
  listAuditConn,
  setAuditNote,
  touchRecord,
} from "../store";
import {
  type Ctx,
  asRecord,
  isResponse,
  likePattern,
  ok,
  pageParams,
  readBytes,
  readJson,
  send,
  softFail,
  str,
  toInt,
} from "../util";

// --------------------------------------------------------------------------- //
// ingest
// --------------------------------------------------------------------------- //

/**
 * `POST /api/audit/conn`
 *
 * Two shapes arrive here: the host reporting a connection opening or closing,
 * and a controller saving a free-text note for the session it is in.
 */
const auditConnIngest: Route["handler"] = async (ctx) => {
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const deviceId = str(body.id);
  const note = str(body.note);

  if (note && !str(body.action)) {
    const guid = (await latestAuditConnGuid(ctx.env.DB, deviceId)) ??
      (await insertAuditConn(ctx.env.DB, {
        id: deviceId,
        peerId: str(body.peer_id),
        sessionId: toInt(str(body.session_id), 0),
      }));
    await setAuditNote(ctx.env.DB, guid, note);
    return ok();
  }

  await insertAuditConn(ctx.env.DB, {
    nonce: str(body.nonce),
    id: deviceId,
    uuid: str(body.uuid),
    connId: toInt(str(body.conn_id), 0),
    sessionId: toInt(str(body.session_id), 0),
    peerId: str(body.peer_id),
    ip: str(body.ip),
    action: str(body.action),
    connType: toInt(str(body.conn_type), 0),
    connAuditRef: str(body.conn_audit_ref),
  });
  return ok();
};

const auditFileIngest: Route["handler"] = async (ctx) => {
  const body = asRecord(await readJson(ctx.request)) ?? {};
  await insertAuditFile(ctx.env.DB, {
    nonce: str(body.nonce),
    id: str(body.id),
    uuid: str(body.uuid),
    peerId: str(body.peer_id),
    connId: toInt(str(body.conn_id), 0),
    type: toInt(str(body.type), 0),
    path: str(body.path),
    isFile: body.is_file === true || body.is_file === "true",
    // The client sends `info` already stringified, by design.
    info: typeof body.info === "string" ? body.info : JSON.stringify(body.info ?? {}),
  });
  return ok();
};

const auditAlarmIngest: Route["handler"] = async (ctx) => {
  const body = asRecord(await readJson(ctx.request)) ?? {};
  await insertAuditAlarm(ctx.env.DB, {
    nonce: str(body.nonce),
    id: str(body.id),
    uuid: str(body.uuid),
    typ: toInt(str(body.typ), 0),
    info: typeof body.info === "string" ? body.info : JSON.stringify(body.info ?? {}),
    connId: toInt(str(body.conn_id), 0),
  });
  return ok();
};

/** `GET /api/audit/conn/active` — a bare JSON string: the GUID to attach a note to. */
const auditConnActive: Route["handler"] = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const guid = await activeAuditGuid(ctx.env.DB, {
    peerId: ctx.url.searchParams.get("id") ?? "",
    sessionId: toInt(ctx.url.searchParams.get("session_id"), 0),
    connType: toInt(ctx.url.searchParams.get("conn_type"), 0),
  });
  return send(guid);
};

/** `PUT /api/audit` — the client only looks at the status code. */
const auditNoteUpdate: Route["handler"] = async (ctx) => {
  const user = await requireUser(ctx);
  if (isResponse(user)) return user;
  const body = asRecord(await readJson(ctx.request)) ?? {};
  const guid = str(body.guid);
  if (!guid) return softFail("guid is required");
  await setAuditNote(ctx.env.DB, guid, str(body.note));
  return ok();
};

// --------------------------------------------------------------------------- //
// querying (admin)
// --------------------------------------------------------------------------- //

const auditConnList: Route["handler"] = async (ctx) => {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const { pageSize, offset } = pageParams(ctx.url);
  const { total, rows } = await listAuditConn(ctx.env.DB, {
    limit: pageSize,
    offset,
    idLike: likePattern(ctx.url.searchParams.get("id")),
    ipLike: likePattern(ctx.url.searchParams.get("ip")),
    action: ctx.url.searchParams.get("action"),
  });
  return send({
    total,
    data: rows.map((row) => ({
      guid: row.guid,
      id: row.id,
      uuid: row.uuid,
      conn_id: row.conn_id,
      session_id: row.session_id,
      peer_id: row.peer_id,
      ip: row.ip,
      action: row.action,
      conn_type: row.conn_type,
      conn_audit_ref: row.conn_audit_ref,
      note: row.note,
      created_at: row.created_at,
    })),
  });
};

async function listSimpleAudit(ctx: Ctx, table: "audit_file" | "audit_alarm"): Promise<Response> {
  const admin = await requireAdmin(ctx);
  if (isResponse(admin)) return admin;
  const { pageSize, offset } = pageParams(ctx.url);
  const count = await ctx.env.DB.prepare(`SELECT COUNT(*) AS c FROM ${table}`).first<{ c: number }>();
  const { results } = await ctx.env.DB.prepare(
    `SELECT * FROM ${table} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
  )
    .bind(pageSize, offset)
    .all<Record<string, unknown>>();
  const data = results.map((row) => {
    for (const key of ["info"]) {
      const raw = row[key];
      if (typeof raw === "string") {
        try {
          row[key] = JSON.parse(raw);
        } catch {
          // Leave anything that is not JSON as it came in.
        }
      }
    }
    return row;
  });
  return send({ total: Number(count?.c ?? 0), data });
}

const auditFileList: Route["handler"] = async (ctx) => await listSimpleAudit(ctx, "audit_file");
const auditAlarmList: Route["handler"] = async (ctx) => await listSimpleAudit(ctx, "audit_alarm");

// --------------------------------------------------------------------------- //
// recording upload
// --------------------------------------------------------------------------- //
//
// Chunks are stored as separate R2 objects under a per-file prefix rather than
// an R2 multipart upload: the client streams `type=part` at arbitrary offsets,
// and a prefix keeps `type=remove` a single listing. Anything reading the
// recording back has to sort the parts — there is no concat in R2. Without the
// `RECORDS` binding the endpoint answers an error, which the client surfaces
// and retries, rather than silently discarding a recording.

const RECORD_ROOT = "records";

function partKey(file: string, offset: number): string {
  return `${RECORD_ROOT}/${file}/part-${String(offset).padStart(14, "0")}`;
}

async function dropRecordObjects(ctx: Ctx, file: string): Promise<void> {
  const bucket = ctx.env.RECORDS;
  if (!bucket) return;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `${RECORD_ROOT}/${file}/`, cursor });
    if (page.objects.length > 0) await bucket.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

const recordUpload: Route["handler"] = async (ctx) => {
  const bucket = ctx.env.RECORDS;
  if (!bucket) return softFail("recording storage is not configured");

  const type = ctx.url.searchParams.get("type") ?? "";
  const file = ctx.url.searchParams.get("file") ?? "";
  if (!file) return softFail("file is required");
  const offset = toInt(ctx.url.searchParams.get("offset"), 0);

  switch (type) {
    case "new": {
      await touchRecord(ctx.env.DB, file, { chunks: 0, state: "open" });
      await bucket.put(`${RECORD_ROOT}/${file}/manifest`, JSON.stringify({ file, created_at: Date.now() }));
      return ok();
    }
    case "part": {
      const bytes = await readBytes(ctx.request);
      await bucket.put(partKey(file, offset), bytes);
      await touchRecord(ctx.env.DB, file, { size: offset + bytes.byteLength, chunks: 1 });
      return ok();
    }
    case "tail": {
      const bytes = await readBytes(ctx.request);
      await bucket.put(`${RECORD_ROOT}/${file}/header`, bytes);
      return ok();
    }
    case "remove": {
      await dropRecordObjects(ctx, file);
      await deleteRecord(ctx.env.DB, file);
      return ok();
    }
    default:
      return softFail(`unknown record type: ${type}`);
  }
};

// --------------------------------------------------------------------------- //

export const opsRoutes: Route[] = [
  { method: "POST", path: "api/audit/conn", handler: auditConnIngest },
  { method: "POST", path: "api/audit/file", handler: auditFileIngest },
  { method: "POST", path: "api/audit/alarm", handler: auditAlarmIngest },
  { method: "GET", path: "api/audit/conn/active", handler: auditConnActive },
  { method: "PUT", path: "api/audit", handler: auditNoteUpdate },
  { method: "POST", path: "api/audit", handler: auditNoteUpdate },
  { method: "GET", path: "api/audit/conn", handler: auditConnList },
  { method: "GET", path: "api/audit/file", handler: auditFileList },
  { method: "GET", path: "api/audit/alarm", handler: auditAlarmList },
  { method: "POST", path: "api/record", handler: recordUpload },
];
