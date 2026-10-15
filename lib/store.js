// Document store on Supabase (Postgres via the PostgREST API; no SDK needed).
// Works with the Vercel "Supabase" integration (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY).
// Tables live in supabase/schema.sql. When not configured, hasDb is false and the app falls
// back to browser-only saves.

const BASE = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export const hasDb = Boolean(BASE && KEY);

async function rest(path, { method = "GET", body, headers = {} } = {}) {
  if (!hasDb) throw new Error("db_not_configured");
  const r = await fetch(`${BASE}/rest/v1/${path}`, {
    method,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j = null;
  try { j = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!r.ok) throw new Error(j?.message || `supabase ${r.status}`);
  return j;
}

const eq = (v) => `eq.${encodeURIComponent(v)}`;

export function splitPath(path) {
  const segs = path.split("/");
  return { collection: segs.slice(0, -1).join("/"), id: segs[segs.length - 1] };
}

export async function getDoc(path) {
  const rows = await rest(`bsp_docs?path=${eq(path)}&select=data`);
  if (!rows?.length) return { exists: false, data: null };
  return { exists: true, data: rows[0].data };
}

export async function setDoc(path, data) {
  const { collection, id } = splitPath(path);
  await rest("bsp_docs?on_conflict=path", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: { path, collection, id, data, updated_at: new Date().toISOString() },
  });
}

export async function deleteDoc(path) {
  await rest(`bsp_docs?path=${eq(path)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
}

export async function listDocs(collection, limit = 1000) {
  const rows = await rest(`bsp_docs?collection=${eq(collection)}&select=id,data&limit=${limit}`);
  return (rows || []).map((r) => ({ id: r.id, data: r.data }));
}

// Fixed-window counter: returns the count after incrementing.
export async function bump(key, windowSeconds) {
  return Number(await rest("rpc/bsp_bump", { method: "POST", body: { k: key, win: windowSeconds } }));
}
