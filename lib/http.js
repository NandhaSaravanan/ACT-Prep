// Small helpers shared by the API functions.

export async function readJson(req, maxBytes = 4_500_000) {
  if (req.body !== undefined) {
    if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return null; } }
    return req.body;
  }
  return new Promise((resolve) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > maxBytes) { resolve({ __tooLarge: true }); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { resolve(null); } });
    req.on("error", () => resolve(null));
  });
}

export function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
}

export function fail(res, status, code, message) {
  return send(res, status, { code, message: message || code });
}

export function header(req, name) {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : (v || "");
}

export function clientIp(req) {
  const xf = header(req, "x-forwarded-for");
  return (xf.split(",")[0] || req.socket?.remoteAddress || "unknown").trim();
}

// Optional site-wide access code. When ACCESS_CODE is set, every API call must carry it.
export function checkAccess(req, res) {
  const want = process.env.ACCESS_CODE;
  if (!want) return true;
  if (header(req, "x-bsp-access") === want) return true;
  fail(res, 401, "access_required", "This site needs an access code.");
  return false;
}

export function isOwner(req) {
  const key = process.env.OWNER_KEY;
  return Boolean(key && header(req, "x-bsp-owner") === key);
}

const UID_RE = /^[A-Za-z0-9_-]{16,64}$/;
export function clientUid(req) {
  const u = header(req, "x-bsp-uid");
  return UID_RE.test(u) ? u : "";
}
