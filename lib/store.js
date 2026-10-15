// Key-value store on Upstash Redis (REST). Works with the Vercel "Upstash for Redis"
// marketplace integration (UPSTASH_REDIS_REST_*) or the older Vercel KV variables (KV_REST_API_*).
// When neither is configured, hasRedis is false and the app falls back to browser-only saves.

const REST_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || "";
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || "";

export const hasRedis = Boolean(REST_URL && REST_TOKEN);

export async function redis(...command) {
  if (!hasRedis) throw new Error("redis_not_configured");
  const r = await fetch(REST_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REST_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(command),
  });
  const j = await r.json().catch(() => ({ error: `bad response ${r.status}` }));
  if (j.error) throw new Error(j.error);
  return j.result;
}

// Document helpers. A doc path like "qbank/abc" or "data/users/<uid>/profile" is stored at
// bsp:doc:<path>, and its id is registered in a set for its parent collection so queries can list it.
const DOC = (path) => `bsp:doc:${path}`;
const COL = (col) => `bsp:col:${col}`;

export function splitPath(path) {
  const segs = path.split("/");
  return { collection: segs.slice(0, -1).join("/"), id: segs[segs.length - 1] };
}

export async function getDoc(path) {
  const raw = await redis("GET", DOC(path));
  if (raw == null) return { exists: false, data: null };
  try { return { exists: true, data: JSON.parse(raw) }; } catch { return { exists: false, data: null }; }
}

export async function setDoc(path, data) {
  const { collection, id } = splitPath(path);
  await redis("SET", DOC(path), JSON.stringify(data));
  if (collection) await redis("SADD", COL(collection), id);
}

export async function deleteDoc(path) {
  const { collection, id } = splitPath(path);
  await redis("DEL", DOC(path));
  if (collection) await redis("SREM", COL(collection), id);
}

export async function listDocs(collection, limit = 1000) {
  const ids = (await redis("SMEMBERS", COL(collection))) || [];
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const raws = await redis("MGET", ...batch.map((id) => DOC(`${collection}/${id}`)));
    batch.forEach((id, k) => {
      if (raws[k] == null) return;
      try { out.push({ id, data: JSON.parse(raws[k]) }); } catch { }
    });
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

// Simple fixed-window counter: returns the count after incrementing.
export async function bump(key, windowSeconds) {
  const n = await redis("INCR", key);
  if (n === 1) await redis("EXPIRE", key, windowSeconds);
  return n;
}
