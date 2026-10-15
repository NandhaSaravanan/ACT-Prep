// End-to-end smoke test with a fake Claude API and a fake Supabase. No network, no key needed.
// Usage: node scripts/smoke-test.mjs
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); if (!cond) failures++; };
const readBody = (req) => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c).toString())); });

// --- fake Claude API -------------------------------------------------------
let lastClaudeRequest = null;
const fakeClaude = http.createServer(async (req, res) => {
  const body = JSON.parse(await readBody(req));
  lastClaudeRequest = { headers: req.headers, body };
  const text = body.messages[0].content.find((b) => b.type === "text").text;
  let reply;
  if (/refuse me/i.test(text)) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ stop_reason: "refusal", content: [] })); }
  if (/garbage/i.test(text)) reply = "Sure! here is nothing useful";
  else if (/fenced/i.test(text)) reply = "```json\n{\"fenced\": true}\n```";
  else reply = `Here you go:\n{"echo": ${JSON.stringify(text.slice(0, 20))}, "images": ${body.messages[0].content.filter((b) => b.type === "image").length}, "model": ${JSON.stringify(body.model)}}`;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: reply }] }));
}).listen(0);

// --- fake Supabase (PostgREST subset) --------------------------------------
const docs = new Map(); const counters = new Map();
const fakeRedis = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");
  const raw = await readBody(req);
  const body = raw ? JSON.parse(raw) : null;
  const q = (k) => { const v = u.searchParams.get(k); return v && v.startsWith("eq.") ? v.slice(3) : null; };
  let out = null;
  if (req.headers.authorization !== "Bearer service-key") { res.statusCode = 401; return res.end(JSON.stringify({ message: "bad key" })); }
  if (u.pathname === "/rest/v1/bsp_docs") {
    if (req.method === "GET") {
      const path = q("path"), col = q("collection");
      const rows = [...docs.values()].filter((r) => (path ? r.path === path : r.collection === col));
      out = rows.map((r) => (u.searchParams.get("select") === "data" ? { data: r.data } : { id: r.id, data: r.data }));
    } else if (req.method === "POST") { docs.set(body.path, body); res.statusCode = 201; }
    else if (req.method === "DELETE") { docs.delete(q("path")); res.statusCode = 204; }
  } else if (u.pathname === "/rest/v1/rpc/bsp_bump") {
    const n = (counters.get(body.k) || 0) + 1; counters.set(body.k, n); out = n;
  } else { res.statusCode = 404; out = { message: "unknown " + u.pathname }; }
  res.setHeader("content-type", "application/json");
  res.end(out === null ? "" : JSON.stringify(out));
}).listen(0);

await new Promise((r) => setTimeout(r, 100));
const env = {
  ...process.env,
  PORT: "0",
  ANTHROPIC_API_KEY: "sk-test",
  ANTHROPIC_BASE_URL: `http://127.0.0.1:${fakeClaude.address().port}`,
  SUPABASE_URL: `http://127.0.0.1:${fakeRedis.address().port}`,
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  OWNER_KEY: "owner-secret",
  SAMPLE_PER_HOUR: "3",
};

// --- start the dev server on a random port -----------------------------------
const srv = spawn(process.execPath, [path.join(root, "scripts/dev-server.mjs")], { env, stdio: ["ignore", "pipe", "inherit"] });
const base = await new Promise((resolve) => srv.stdout.on("data", (d) => { const m = String(d).match(/http:\/\/localhost:(\d+)/); if (m) resolve(`http://127.0.0.1:${m[1]}`); }));

const UID_A = "a".repeat(32), UID_B = "b".repeat(32);
async function api(p, body, extra = {}) {
  const r = await fetch(base + p, { method: "POST", headers: { "content-type": "application/json", "x-bsp-uid": UID_A, ...extra }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

try {
  // static
  const page = await fetch(base + "/");
  const html = await page.text();
  ok(page.status === 200 && html.includes('<script src="/runtime.js"></script>'), "index.html served with shim injected");
  ok((await fetch(base + "/runtime.js")).status === 200, "runtime.js served");

  // sample
  let r = await api("/api/sample", { prompt: "hello world", tier: "default", images: [{ media_type: "image/jpeg", data: "AAAA" }] });
  ok(r.status === 200 && r.json.result.echo === "hello world" && r.json.result.images === 1, "sample: JSON extracted from prose, image forwarded");
  ok(r.json.result.model === "claude-sonnet-5-5", "sample: default tier -> sonnet");
  ok(lastClaudeRequest.headers["x-api-key"] === "sk-test" && lastClaudeRequest.headers["anthropic-version"], "sample: key + version headers sent");
  r = await api("/api/sample", { prompt: "fenced", tier: "complex" });
  ok(r.status === 200 && r.json.result.fenced === true && r.json.result.model === undefined, "sample: code-fenced JSON parsed");
  ok(lastClaudeRequest.body.model === "claude-opus-5-5", "sample: complex tier -> opus");
  r = await api("/api/sample", { prompt: "garbage" });
  ok(r.status === 502 && r.json.code === "invalid_json", "sample: non-JSON reply -> invalid_json");
  r = await api("/api/sample", { prompt: "refuse me" });
  ok(r.status === 429 && r.json.code === "rate_limited", "sample: 4th call in the hour is rate limited (SAMPLE_PER_HOUR=3)");
  r = await api("/api/sample", { prompt: "x", images: [{ media_type: "text/html", data: "x" }] }, { "x-forwarded-for": "9.9.9.9" });
  ok(r.status === 400 && r.json.code === "image_rejected", "sample: bad image type rejected");
  r = await api("/api/sample", { prompt: "refuse me" }, { "x-forwarded-for": "9.9.9.8" });
  ok(r.status === 400 && r.json.code === "refused", "sample: refusal surfaced as refused");

  // db
  r = await api("/api/db", { op: "ping" });
  ok(r.status === 200 && r.json.ok === true && r.json.owner === false, "db: ping ok, not owner");
  r = await api("/api/db", { op: "ping" }, { "x-bsp-owner": "owner-secret" });
  ok(r.json.owner === true, "db: owner key recognized");
  r = await api("/api/db", { op: "get", path: `data/users/${UID_A}/profile` });
  ok(r.status === 200 && r.json.exists === false, "db: missing doc -> exists false");
  r = await api("/api/db", { op: "set", path: `data/users/${UID_A}/profile`, data: { name: "N", accom: 1 } });
  ok(r.status === 200, "db: set own profile");
  r = await api("/api/db", { op: "get", path: `data/users/${UID_A}/profile` });
  ok(r.json.exists === true && r.json.data.name === "N", "db: get own profile back");
  r = await api("/api/db", { op: "get", path: `data/users/${UID_A}/profile` }, { "x-bsp-uid": UID_B });
  ok(r.status === 403, "db: another uid cannot read it");
  r = await api("/api/db", { op: "set", path: "qbank/q1", data: { section: "english", stem: "x" } });
  ok(r.status === 403, "db: visitor cannot write qbank");
  r = await api("/api/db", { op: "set", path: "qbank/q1", data: { section: "english", stem: "x" } }, { "x-bsp-owner": "owner-secret" });
  ok(r.status === 200, "db: owner writes qbank");
  await api("/api/db", { op: "set", path: "qbank/q2", data: { section: "math", stem: "y" } }, { "x-bsp-owner": "owner-secret" });
  r = await api("/api/db", { op: "query", collection: "qbank", field: "section", cmp: "==", value: "english", limit: 1000 });
  ok(r.status === 200 && r.json.docs.length === 1 && r.json.docs[0].id === "q1", "db: visitor queries qbank filtered by section");
  r = await api("/api/db", { op: "add", collection: "reports", data: { note: "hm" } });
  ok(r.status === 403, "db: visitor cannot add reports");
  r = await api("/api/db", { op: "add", collection: "reports", data: { note: "hm" } }, { "x-bsp-owner": "owner-secret" });
  ok(r.status === 200 && typeof r.json.id === "string", "db: owner adds a report");
  r = await api("/api/db", { op: "set", path: "../etc", data: {} }, { "x-bsp-owner": "owner-secret" });
  ok(r.status === 400, "db: bad path rejected");

  // access code gate
  srv.kill();
  const srv2 = spawn(process.execPath, [path.join(root, "scripts/dev-server.mjs")], { env: { ...env, ACCESS_CODE: "letmein" }, stdio: ["ignore", "pipe", "inherit"] });
  const base2 = await new Promise((resolve) => srv2.stdout.on("data", (d) => { const m = String(d).match(/http:\/\/localhost:(\d+)/); if (m) resolve(`http://127.0.0.1:${m[1]}`); }));
  let r2 = await fetch(base2 + "/api/db", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "ping" }) });
  ok(r2.status === 401 && (await r2.json()).code === "access_required", "access: blocked without code");
  r2 = await fetch(base2 + "/api/db", { method: "POST", headers: { "content-type": "application/json", "x-bsp-access": "letmein" }, body: JSON.stringify({ op: "ping" }) });
  ok(r2.status === 200, "access: allowed with code");
  srv2.kill();
} finally {
  srv.kill(); fakeClaude.close(); fakeRedis.close();
}
console.log(failures ? `\n${failures} failure(s)` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
