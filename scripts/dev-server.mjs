// Local dev server: serves public/ and mounts api/*.js the way Vercel does.
// Usage: ANTHROPIC_API_KEY=... node scripts/dev-server.mjs   (reads .env if present)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".css": "text/css", ".json": "application/json" };
const handlers = {};
for (const f of fs.readdirSync(path.join(root, "api"))) {
  if (!f.endsWith(".js")) continue;
  handlers["/api/" + f.slice(0, -3)] = (await import(pathToFileURL(path.join(root, "api", f)))).default;
}

const port = Number(process.env.PORT || 3000);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const h = handlers[url.pathname];
  if (h) {
    try { await h(req, res); } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ code: "crash", message: String(e?.stack || e) })); }
    return;
  }
  let file = path.join(root, "public", url.pathname === "/" ? "index.html" : url.pathname);
  if (!file.startsWith(path.join(root, "public"))) { res.statusCode = 403; return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end("not found"); }
  res.setHeader("content-type", MIME[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
});
server.listen(port, () => console.log(`Bubble Sheet dev server: http://localhost:${server.address().port}`));
