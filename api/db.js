// POST /api/db — the page's small document store.
// ops:
//   ping                          -> { ok, owner }
//   get    { path }               -> { exists, data }
//   set    { path, data }         -> { ok }
//   delete { path }               -> { ok }
//   add    { collection, data }   -> { id }
//   query  { collection, field?, op?, value?, limit? } -> { docs: [{ id, data }] }
//
// Who may touch what:
//   data/users/<uid>/*   the browser whose x-bsp-uid header equals <uid>
//   qbank/*              anyone reads; only the owner writes (x-bsp-owner === OWNER_KEY)
//   reports/*            owner only
//
// Visitors are anonymous; the uid is a random id the browser generated and keeps (its "sync code").

import { readJson, send, fail, checkAccess, isOwner, clientUid } from "../lib/http.js";
import { hasDb, getDoc, setDoc, deleteDoc, listDocs } from "../lib/store.js";
import { randomBytes } from "node:crypto";

const SEG = /^[A-Za-z0-9_.-]{1,80}$/;
const MAX_DOC_BYTES = Number(process.env.MAX_DOC_BYTES || 400_000);

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed");
  if (!checkAccess(req, res)) return;
  const body = await readJson(req, 1_000_000);
  if (!body || typeof body.op !== "string") return fail(res, 400, "bad_request");
  const owner = isOwner(req);

  if (body.op === "ping") return send(res, 200, { ok: hasDb, owner });
  if (!hasDb) return fail(res, 503, "db_unavailable", "No database is configured (Supabase).");

  const uid = clientUid(req);

  try {
    switch (body.op) {
      case "get": {
        const path = checkPath(body.path); if (!path) return fail(res, 400, "invalid_argument", "Bad path.");
        if (!canRead(path, uid, owner)) return fail(res, 403, "permission_denied");
        return send(res, 200, await getDoc(path));
      }
      case "set": {
        const path = checkPath(body.path); if (!path) return fail(res, 400, "invalid_argument", "Bad path.");
        if (!canWrite(path, uid, owner)) return fail(res, 403, "permission_denied");
        const data = plainObject(body.data); if (!data) return fail(res, 400, "invalid_argument", "data must be an object.");
        if (JSON.stringify(data).length > MAX_DOC_BYTES) return fail(res, 413, "quota_exceeded");
        await setDoc(path, data);
        return send(res, 200, { ok: true });
      }
      case "delete": {
        const path = checkPath(body.path); if (!path) return fail(res, 400, "invalid_argument", "Bad path.");
        if (!canWrite(path, uid, owner)) return fail(res, 403, "permission_denied");
        await deleteDoc(path);
        return send(res, 200, { ok: true });
      }
      case "add": {
        const col = checkPath(body.collection); if (!col) return fail(res, 400, "invalid_argument", "Bad collection.");
        const id = randomBytes(10).toString("hex");
        const path = `${col}/${id}`;
        if (!canWrite(path, uid, owner)) return fail(res, 403, "permission_denied");
        const data = plainObject(body.data); if (!data) return fail(res, 400, "invalid_argument", "data must be an object.");
        if (JSON.stringify(data).length > MAX_DOC_BYTES) return fail(res, 413, "quota_exceeded");
        await setDoc(path, data);
        return send(res, 200, { id });
      }
      case "query": {
        const col = checkPath(body.collection); if (!col) return fail(res, 400, "invalid_argument", "Bad collection.");
        if (!canRead(`${col}/x`, uid, owner)) return fail(res, 403, "permission_denied");
        const limit = Math.min(Math.max(Number(body.limit) || 1000, 1), 2000);
        let docs = await listDocs(col, 5000);
        if (typeof body.field === "string" && body.field) {
          const op = typeof body.cmp === "string" ? body.cmp : "==";
          docs = docs.filter((d) => compare(d.data?.[body.field], op, body.value));
        }
        return send(res, 200, { docs: docs.slice(0, limit) });
      }
      default:
        return fail(res, 400, "bad_request", `Unknown op ${body.op}`);
    }
  } catch (e) {
    return fail(res, 502, "upstream_error", String(e?.message || e));
  }
}

function checkPath(p) {
  if (typeof p !== "string") return null;
  const segs = p.split("/");
  if (segs.length < 1 || segs.length > 6 || !segs.every((s) => SEG.test(s) && s !== "." && s !== "..")) return null;
  return segs.join("/");
}

function canRead(path, uid, owner) {
  if (owner) return true;
  if (path.startsWith("data/users/")) return Boolean(uid) && path.split("/")[2] === uid;
  if (path.startsWith("qbank/")) return true;
  return false;
}

function canWrite(path, uid, owner) {
  if (owner) return true;
  if (path.startsWith("data/users/")) return Boolean(uid) && path.split("/")[2] === uid && path.split("/").length === 4;
  return false;
}

function plainObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : null;
}

function compare(a, op, b) {
  switch (op) {
    case "==": return a === b;
    case "!=": return a !== b;
    case "<": return a < b;
    case "<=": return a <= b;
    case ">": return a > b;
    case ">=": return a >= b;
    case "in": return Array.isArray(b) && b.includes(a);
    default: return a === b;
  }
}
