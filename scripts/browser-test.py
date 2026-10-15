#!/usr/bin/env python3
"""Boot the page in headless Chromium against the dev server (fake Claude + fake Redis from smoke-test)
and check that the shim takes the app into cloud mode, the settings sync panel renders, and a
sample call round-trips through /api/sample. Run: python3 -I scripts/browser-test.py"""
import http.server, json, os, re, subprocess, sys, threading, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent

class FakeClaude(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        text = next(b["text"] for b in body["messages"][0]["content"] if b["type"] == "text")
        n_img = sum(1 for b in body["messages"][0]["content"] if b["type"] == "image")
        reply = json.dumps({"ok": True, "images": n_img, "len": len(text)})
        out = json.dumps({"stop_reason": "end_turn", "content": [{"type": "text", "text": reply}]}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(out))); self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass

KV, SETS = {}, {}
class FakeRedis(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        cmd, *args = json.loads(self.rfile.read(int(self.headers["content-length"])))
        res = None
        if cmd == "GET": res = KV.get(args[0])
        elif cmd == "SET": KV[args[0]] = args[1]; res = "OK"
        elif cmd == "DEL": res = 1 if KV.pop(args[0], None) is not None else 0
        elif cmd == "MGET": res = [KV.get(k) for k in args]
        elif cmd == "SADD": s = SETS.setdefault(args[0], set()); res = 0 if args[1] in s else 1; s.add(args[1])
        elif cmd == "SREM": res = 1 if args[1] in SETS.get(args[0], set()) else 0; SETS.get(args[0], set()).discard(args[1])
        elif cmd == "SMEMBERS": res = sorted(SETS.get(args[0], set()))
        elif cmd == "INCR": KV[args[0]] = str(int(KV.get(args[0], 0)) + 1); res = int(KV[args[0]])
        elif cmd == "EXPIRE": res = 1
        out = json.dumps({"result": res}).encode()
        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(out))); self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass

claude_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeClaude)
redis_srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), FakeRedis)
for s in (claude_srv, redis_srv): threading.Thread(target=s.serve_forever, daemon=True).start()

env = dict(os.environ, PORT="0", ANTHROPIC_API_KEY="sk-test",
           ANTHROPIC_BASE_URL=f"http://127.0.0.1:{claude_srv.server_port}",
           UPSTASH_REDIS_REST_URL=f"http://127.0.0.1:{redis_srv.server_port}", UPSTASH_REDIS_REST_TOKEN="t",
           OWNER_KEY="owner-secret")
proc = subprocess.Popen(["node", str(ROOT / "scripts/dev-server.mjs")], env=env, stdout=subprocess.PIPE, text=True)
line = proc.stdout.readline()
base = "http://127.0.0.1:" + re.search(r":(\d+)", line).group(1)

failures = 0
def ok(cond, msg):
    global failures
    print(("PASS  " if cond else "FAIL  ") + msg)
    if not cond: failures += 1

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "fonts.g" not in m.text and "net::ERR" not in m.text else None)
        page.goto(base + "/", wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        ok(page.title() == "Bubble Sheet", f"title is 'Bubble Sheet' (got {page.title()!r})")
        ok(page.evaluate("typeof window.claude?.use === 'function'"), "window.claude.use is defined by the shim")
        who = page.text_content("#who")
        ok(who == "Saving to the cloud", f"header shows cloud mode (got {who!r})")
        uid = page.evaluate("window.BSP.syncCode()")
        ok(re.fullmatch(r"[0-9a-f]{32}", uid or ""), "sync code generated")
        ok(f"bsp:doc:data/users/{uid}/profile" in KV, "profile was written to the store under the uid")

        # settings page renders the sync panel
        page.evaluate("go('settings')")
        page.wait_for_timeout(300)
        ok("Use this on another device" in page.text_content("#main"), "settings shows sync panel")
        ok(uid in page.input_value("#main input[readonly]"), "sync link contains the sync code")

        # a sample call round-trips with an image blob
        res = page.evaluate("""async () => {
            const s = await claude.use('sample');
            const c = document.createElement('canvas'); c.width = 40; c.height = 40;
            const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
            return await s.json('count these', { images: [blob], modelTier: 'default' });
        }""")
        ok(res and res.get("ok") and res.get("images") == 1, f"sample.json round-trip with one image (got {res})")

        # owner mode via ?owner=
        page.goto(base + "/?owner=owner-secret", wait_until="domcontentloaded")
        page.wait_for_timeout(1200)
        ok(page.url.rstrip("/") == base.rstrip("/") or page.url == base + "/", f"?owner= stripped from URL (got {page.url})")
        is_owner = page.evaluate("(async () => (await claude.use('user')).isOwner())()")
        ok(is_owner is True, "owner mode recognized by the server")

        # sync code carries over to a fresh browser context
        ctx2 = browser.new_context(); p2 = ctx2.new_page()
        p2.goto(base + f"/?sync={uid}", wait_until="domcontentloaded"); p2.wait_for_timeout(1200)
        ok(p2.evaluate("window.BSP.syncCode()") == uid, "?sync= adopts the code in a new browser")
        ok(p2.text_content("#who") == "Saving to the cloud", "second browser is in cloud mode too")

        real_errors = [e for e in errors if "runtime.js" in e or "TypeError" in e or "ReferenceError" in e]
        ok(not real_errors, "no JS errors on load" + (f": {real_errors[:3]}" if real_errors else ""))
        browser.close()
finally:
    proc.kill(); claude_srv.shutdown(); redis_srv.shutdown()

print("\nAll checks passed" if not failures else f"\n{failures} failure(s)")
sys.exit(1 if failures else 0)
