// Stand-in for the claude.ai artifact runtime. Exposes window.claude.use("sample" | "db" | "user")
// with the same shapes the app expects, backed by /api/sample and /api/db on this site.
//
// URL switches (each is stored in this browser, then removed from the address bar):
//   ?sync=<code>    use another device's sync code so saves follow you
//   ?owner=<key>    turn on owner mode (must equal OWNER_KEY on the server)
//   ?access=<code>  store the site's access code (only if ACCESS_CODE is set on the server)
(() => {
  const LS = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { } },
    del(k) { try { localStorage.removeItem(k); } catch { } },
  };

  const qs = new URLSearchParams(location.search);
  let touched = false;
  for (const [param, key] of [["sync", "bsp:uid"], ["owner", "bsp:owner"], ["access", "bsp:access"]]) {
    const v = qs.get(param);
    if (v) { LS.set(key, v.trim()); touched = true; }
  }
  if (touched) history.replaceState(null, "", location.pathname + location.hash);

  function randomId() {
    const b = new Uint8Array(16); crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }
  function uid() {
    let u = LS.get("bsp:uid");
    if (!u || !/^[A-Za-z0-9_-]{16,64}$/.test(u)) { u = randomId(); LS.set("bsp:uid", u); }
    return u;
  }

  let accessPrompted = false;
  async function call(path, body, signal, retried = false) {
    const headers = { "content-type": "application/json", "x-bsp-uid": uid() };
    const owner = LS.get("bsp:owner"); if (owner) headers["x-bsp-owner"] = owner;
    const access = LS.get("bsp:access"); if (access) headers["x-bsp-access"] = access;
    let r;
    try {
      r = await fetch(path, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (e) {
      if (e && e.name === "AbortError") throw { code: "cancelled" };
      throw { code: "upstream_error", message: String(e && e.message || e) };
    }
    const j = await r.json().catch(() => null);
    if (r.status === 401 && j && j.code === "access_required" && !retried && !accessPrompted) {
      accessPrompted = true;
      const code = window.prompt("This site needs an access code:");
      accessPrompted = false;
      if (code && code.trim()) { LS.set("bsp:access", code.trim()); return call(path, body, signal, true); }
      throw { code: "not_granted" };
    }
    if (!r.ok) {
      const code = (j && j.code) || (r.status === 429 ? "rate_limited" : r.status === 413 ? "prompt_too_large" : "upstream_error");
      throw { code, message: j && j.message };
    }
    return j;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result).split(",")[1] || "");
      fr.onerror = () => reject({ code: "image_rejected" });
      fr.readAsDataURL(blob);
    });
  }

  async function ask(prompt, opts, mode) {
    const images = [];
    for (const b of (opts.images || [])) {
      if (!b) continue;
      images.push({ media_type: b.type || "image/jpeg", data: await blobToBase64(b) });
    }
    const r = await call("/api/sample", { prompt, images, tier: opts.modelTier === "complex" ? "complex" : "default", mode }, opts.signal);
    return r.result;
  }

  const sample = {
    async limits() { return { images: { maxCount: 5, maxBytes: 1_500_000, maxDimension: 2000 } }; },
    json(prompt, opts = {}) { return ask(prompt, opts, "json"); },
    text(prompt, opts = {}) { return ask(prompt, opts, "text"); },
  };

  const user = {
    async id() { return uid(); },
    async isOwner() {
      if (!LS.get("bsp:owner")) return false;
      try { const r = await call("/api/db", { op: "ping" }); return Boolean(r && r.owner); } catch { return false; }
    },
  };

  function doc(path) {
    return {
      id: path.split("/").pop(),
      async get() {
        const r = await call("/api/db", { op: "get", path });
        return { exists: Boolean(r.exists), id: path.split("/").pop(), data: () => r.data };
      },
      async set(data) { await call("/api/db", { op: "set", path, data }); },
      async delete() { await call("/api/db", { op: "delete", path }); },
    };
  }

  function collection(name) {
    const q = { field: null, cmp: "==", value: null, limit: 1000 };
    const c = {
      doc(id) { return doc(`${name}/${id}`); },
      async add(data) { const r = await call("/api/db", { op: "add", collection: name, data }); return { id: r.id }; },
      where(field, cmp, value) { q.field = field; q.cmp = cmp; q.value = value; return c; },
      limit(n) { q.limit = n; return c; },
      async get() {
        const r = await call("/api/db", { op: "query", collection: name, ...q });
        const docs = (r.docs || []).map((d) => ({ id: d.id, data: () => d.data }));
        return { empty: docs.length === 0, size: docs.length, docs };
      },
    };
    return c;
  }

  const db = { doc, collection };
  const dbReady = call("/api/db", { op: "ping" }).then((r) => Boolean(r && r.ok)).catch(() => false);

  window.claude = {
    async use(name) {
      if (name === "sample") return sample;
      if (name === "user") return user;
      if (name === "db") { if (!(await dbReady)) throw new Error("db_unavailable"); return db; }
      throw new Error(`capability not available: ${name}`);
    },
  };

  // Handy for the Settings page and the console.
  window.BSP = {
    syncCode: uid,
    syncLink: () => `${location.origin}${location.pathname}?sync=${uid()}`,
    ownerMode: () => Boolean(LS.get("bsp:owner")),
    leaveOwnerMode: () => LS.del("bsp:owner"),
  };
})();
