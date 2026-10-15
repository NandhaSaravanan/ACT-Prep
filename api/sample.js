// POST /api/sample  — the page's "ask Claude" endpoint.
// Body: { prompt: string, images?: [{ media_type, data(base64) }], tier?: "default"|"complex", mode?: "json"|"text" }
// Reply: { result } where result is parsed JSON (mode json) or a string (mode text).
// Errors: { code, message } with codes the page already knows how to show.

import { readJson, send, fail, checkAccess, clientIp } from "../lib/http.js";
import { hasRedis, bump } from "../lib/store.js";

const MODELS = {
  default: process.env.MODEL_DEFAULT || "claude-sonnet-5-5",
  complex: process.env.MODEL_COMPLEX || "claude-opus-5-5",
};
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 8192);
const PER_HOUR = Number(process.env.SAMPLE_PER_HOUR || 150);
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export default async function handler(req, res) {
  if (req.method !== "POST") return fail(res, 405, "method_not_allowed");
  if (!checkAccess(req, res)) return;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return fail(res, 503, "sampling_disabled", "ANTHROPIC_API_KEY is not set on the server.");

  const body = await readJson(req);
  if (!body) return fail(res, 400, "bad_request", "Body must be JSON.");
  if (body.__tooLarge) return fail(res, 413, "prompt_too_large");

  const prompt = typeof body.prompt === "string" ? body.prompt : "";
  if (!prompt.trim()) return fail(res, 400, "bad_request", "prompt is required.");
  if (prompt.length > 400_000) return fail(res, 413, "prompt_too_large");

  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length > 8) return fail(res, 413, "prompt_too_large", "Too many images.");
  let bytes = 0;
  for (const im of images) {
    if (!im || typeof im.data !== "string" || !IMAGE_TYPES.has(im.media_type)) return fail(res, 400, "image_rejected");
    bytes += im.data.length;
  }
  if (bytes > 6_000_000) return fail(res, 413, "prompt_too_large", "Images too large.");

  if (hasRedis && PER_HOUR > 0) {
    try {
      const hour = Math.floor(Date.now() / 3_600_000);
      const n = await bump(`bsp:rl:${clientIp(req)}:${hour}`, 3700);
      if (n > PER_HOUR) return fail(res, 429, "rate_limited");
    } catch { /* rate limiting is best effort */ }
  }

  const mode = body.mode === "text" ? "text" : "json";
  const model = MODELS[body.tier === "complex" ? "complex" : "default"];
  const content = images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.media_type, data: im.data } }));
  content.push({ type: "text", text: prompt });

  const system = mode === "json"
    ? "You are the engine behind an ACT practice app. Follow the user's instructions exactly. When asked for JSON, reply with only the JSON value and no prose, no code fences."
    : "You are the engine behind an ACT practice app. Follow the user's instructions exactly.";

  let upstream;
  try {
    upstream = await fetch((process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com") + "/v1/messages", {
      method: "POST",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: MAX_TOKENS, system, messages: [{ role: "user", content }] }),
    });
  } catch (e) {
    return fail(res, 502, "upstream_error", String(e?.message || e));
  }

  const data = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const msg = data?.error?.message || `HTTP ${upstream.status}`;
    if (upstream.status === 429 || upstream.status === 529) return fail(res, 429, "rate_limited", msg);
    if (upstream.status === 401 || upstream.status === 403) return fail(res, 503, "sampling_disabled", msg);
    if (/too long|too large|exceed/i.test(msg)) return fail(res, 413, "prompt_too_large", msg);
    return fail(res, 502, "upstream_error", msg);
  }

  if (data?.stop_reason === "refusal") return fail(res, 400, "refused");
  const text = (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) return fail(res, 502, "empty_completion");
  if (mode === "text") return send(res, 200, { result: text });

  const parsed = extractJson(text);
  if (parsed === undefined) return fail(res, 502, "invalid_json", "Claude did not return JSON.");
  return send(res, 200, { result: parsed });
}

function extractJson(text) {
  let t = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try { return JSON.parse(t); } catch { }
  const starts = [t.indexOf("{"), t.indexOf("[")].filter((i) => i >= 0);
  if (!starts.length) return undefined;
  const s = Math.min(...starts);
  const e = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (e <= s) return undefined;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return undefined; }
}
