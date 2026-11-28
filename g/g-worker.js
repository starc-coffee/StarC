// g-private: a small, separate Worker that only serves the G meal calendar + shopping list.
// Storage: one KV namespace (binding G_KV). Access: a family code (secret G_CODE).

const MAX_ITEMS = 500;

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const ax = new Uint8Array(x), by = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < ax.length; i++) d |= ax[i] ^ by[i];
  return d === 0;
}

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function cleanItem(i) {
  const id = str(i && i.id, 64), name = str(i && i.name, 200), market = str(i && i.market, 40);
  if (!id || !name || !market) return null;
  return { id, name, market, done: !!(i && i.done) };
}
function cleanEdits(e) {
  const out = {};
  if (!e || typeof e !== "object" || Array.isArray(e)) return out;
  for (const [k, v] of Object.entries(e)) {
    if (DATE_RE.test(k) && typeof v === "string") out[k] = v.trim().slice(0, 500);
  }
  return out;
}

async function load(env) {
  const [shop, edits] = await Promise.all([
    env.G_KV.get("shop", "json"),
    env.G_KV.get("edits", "json"),
  ]);
  return { shop: Array.isArray(shop) ? shop : [], edits: edits && typeof edits === "object" ? edits : {} };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : (allowed[0] || ""),
      "Access-Control-Allow-Headers": "Content-Type, X-G-Code",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin",
    };
    const reply = (obj, status = 200) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors },
      });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return reply({ error: "not found" }, 404);

    const given = request.headers.get("X-G-Code") || "";
    if (!env.G_CODE || !(await safeEqual(given, env.G_CODE))) return reply({ error: "unauthorized" }, 401);

    const route = url.pathname.slice(5);

    if (request.method === "GET" && route === "state") return reply(await load(env));
    if (request.method !== "POST") return reply({ error: "method not allowed" }, 405);

    let body;
    try { body = await request.json(); } catch { return reply({ error: "bad json" }, 400); }

    const state = await load(env);

    switch (route) {
      case "shop/add": {
        const item = cleanItem(body);
        if (!item) return reply({ error: "bad item" }, 400);
        if (!state.shop.some((i) => i.id === item.id) && state.shop.length < MAX_ITEMS) state.shop.push(item);
        await env.G_KV.put("shop", JSON.stringify(state.shop));
        break;
      }
      case "shop/toggle": {
        const it = state.shop.find((i) => i.id === body.id);
        if (it) it.done = !!body.done;
        await env.G_KV.put("shop", JSON.stringify(state.shop));
        break;
      }
      case "shop/delete": {
        state.shop = state.shop.filter((i) => i.id !== body.id);
        await env.G_KV.put("shop", JSON.stringify(state.shop));
        break;
      }
      case "shop/clear": {
        state.shop = state.shop.filter((i) => !i.done);
        await env.G_KV.put("shop", JSON.stringify(state.shop));
        break;
      }
      case "meal/set": {
        if (!DATE_RE.test(body.key || "")) return reply({ error: "bad date" }, 400);
        if (body.text === null) delete state.edits[body.key];
        else state.edits[body.key] = str(body.text, 500);
        await env.G_KV.put("edits", JSON.stringify(state.edits));
        break;
      }
      case "meal/replace": {
        state.edits = cleanEdits(body.edits);
        await env.G_KV.put("edits", JSON.stringify(state.edits));
        break;
      }
      case "replace": {
        state.shop = (Array.isArray(body.shop) ? body.shop : []).map(cleanItem).filter(Boolean).slice(0, MAX_ITEMS);
        state.edits = cleanEdits(body.edits);
        await Promise.all([
          env.G_KV.put("shop", JSON.stringify(state.shop)),
          env.G_KV.put("edits", JSON.stringify(state.edits)),
        ]);
        break;
      }
      default:
        return reply({ error: "not found" }, 404);
    }

    return reply(state);
  },
};
