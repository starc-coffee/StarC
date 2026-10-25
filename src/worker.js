/*
 * StarC Billing — records API (Cloudflare Worker + D1 database)
 * Receives invoices from the billing page, stores them in the D1 table "records",
 * and checks the manager / employee passwords on the server.
 *
 * Secrets to set in Cloudflare (Worker > Settings > Variables and secrets):
 *   MANAGER_PASSWORD   EMPLOYEE_PASSWORD
 */
const TOKEN_HOURS = 12;
const enc = new TextEncoder();

/* ---------- small helpers ---------- */
const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
});
const str = (v, n) => String(v == null ? '' : v).slice(0, n);
const num = v => { const x = Number(v); return Number.isFinite(x) ? x : 0; };
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function sha256(s) { return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function same(a, b) {                       // constant-time comparison of two strings
  const x = await sha256(String(a)), y = await sha256(String(b));
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

/* ---------- database ---------- */
let ready = false;
async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, inv TEXT, tbl TEXT, date TEXT, staff TEXT,
      item_id REAL, en TEXT, ar TEXT, price REAL, qty REAL, total REAL)`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_records_inv ON records (inv)'),
    db.prepare('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)'),
    db.prepare('CREATE TABLE IF NOT EXISTS ops (op_id TEXT PRIMARY KEY, t INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS logins (ip TEXT PRIMARY KEY, n INTEGER, until INTEGER, first INTEGER)')
  ]);
  ready = true;
}
async function metaAll(db) {
  const { results } = await db.prepare('SELECT k, v FROM meta').all();
  const m = {}; for (const r of results) m[r.k] = r.v; return m;
}
async function getSecret(db, m) {
  if (m.secret) return m.secret;
  const s = crypto.randomUUID() + crypto.randomUUID();
  await db.prepare('INSERT OR IGNORE INTO meta (k, v) VALUES (?, ?)').bind('secret', s).run();
  const r = await db.prepare('SELECT v FROM meta WHERE k = ?').bind('secret').first();
  return r.v;
}
const rolePassword = (env, role) => String(role === 'manager' ? env.MANAGER_PASSWORD : role === 'employee' ? env.EMPLOYEE_PASSWORD : '' || '');
const configured = pw => typeof pw === 'string' && pw.length >= 4;

/* ---------- login & tokens ---------- */
async function login(env, request, req) {
  const db = env.DB;
  const ip = b64url(await sha256('ip:' + (request.headers.get('CF-Connecting-IP') || 'x')));
  const now = Date.now();
  const row = await db.prepare('SELECT n, until, first FROM logins WHERE ip = ?').bind(ip).first();
  if (row && row.until > now) return { ok: false, error: 'locked' };
  const pw = str(req.password, 200);
  let role = null;
  if (configured(env.MANAGER_PASSWORD) && await same(pw, env.MANAGER_PASSWORD)) role = 'manager';
  else if (configured(env.EMPLOYEE_PASSWORD) && await same(pw, env.EMPLOYEE_PASSWORD)) role = 'employee';
  if (!role) {
    let n = (row && row.first > now - 900000 ? row.n : 0) + 1, until = 0;
    if (n >= 8) { until = now + 900000; n = 0; }            // 8 wrong tries -> 15 minutes pause
    await db.prepare('INSERT INTO logins (ip, n, until, first) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(ip) DO UPDATE SET n = ?2, until = ?3, first = CASE WHEN first > ?5 THEN first ELSE ?4 END')
      .bind(ip, n, until, now, now - 900000).run();
    await new Promise(r => setTimeout(r, 800));
    return { ok: false, error: until ? 'locked' : 'wrong' };
  }
  if (row) await db.prepare('DELETE FROM logins WHERE ip = ?').bind(ip).run();
  const secret = await getSecret(db, await metaAll(db));
  const exp = now + TOKEN_HOURS * 3600000;
  const payload = role + '.' + exp;
  // the signing key includes the password, so changing a password logs that role out
  return { ok: true, role, exp, token: payload + '.' + await hmac(secret + ':' + rolePassword(env, role), payload) };
}
async function verify(env, secret, token) {
  const p = String(token || '').split('.');
  if (p.length !== 3) return null;
  const role = p[0], exp = Number(p[1]);
  if ((role !== 'manager' && role !== 'employee') || !(exp > Date.now())) return null;
  const pw = rolePassword(env, role);
  if (!configured(pw)) return null;
  return await same(p[2], await hmac(secret + ':' + pw, role + '.' + exp)) ? role : null;
}

/* ---------- actions ---------- */
const cleanRow = r => {
  r = r || {};
  return { ts: str(r.ts, 25), inv: str(r.inv, 40), tbl: str(r.table, 40), date: str(r.date, 10), staff: str(r.staff, 80),
           item_id: num(r.itemId), en: str(r.en, 200), ar: str(r.ar, 200), price: num(r.price), qty: num(r.qty), total: num(r.total) };
};
const toObj = r => ({ id: r.id, ts: r.ts, inv: r.inv, table: r.tbl, date: r.date, staff: r.staff, itemId: r.item_id,
                      en: r.en, ar: r.ar, price: r.price, qty: r.qty, total: r.total });
const parseMenu = v => { try { const m = JSON.parse(v); return Array.isArray(m) ? m : null; } catch (e) { return null; } };
const cleanMenu = m => (Array.isArray(m) && m.length <= 500)
  ? m.filter(x => x && typeof x === 'object').map(x => ({ id: num(x.id), en: str(x.en, 200), ar: str(x.ar, 200), price: num(x.price) })) : null;

async function handle(env, action, req, role, meta) {
  const db = env.DB;
  const epoch = Number(meta.epoch || 1);

  if (action === 'pull') {
    const full = Number(req.epoch) !== epoch;
    const since = full ? 0 : (Number(req.since) || 0);
    const { results } = await db.prepare('SELECT * FROM records WHERE id > ? ORDER BY id').bind(since).all();
    const seqRow = await db.prepare("SELECT COALESCE(seq, 0) AS s FROM sqlite_sequence WHERE name = 'records'").first();
    return { ok: true, epoch, seq: seqRow ? seqRow.s : 0, full, records: results.map(toObj), menu: parseMenu(meta.menu), role };
  }

  const opId = str(req.opId, 64);
  if (!opId) return { ok: false, error: 'opId required' };
  const seen = await db.prepare('SELECT 1 AS x FROM ops WHERE op_id = ?').bind(opId).first();
  const seqNow = async () => { const r = await db.prepare("SELECT COALESCE(seq, 0) AS s FROM sqlite_sequence WHERE name = 'records'").first(); return r ? r.s : 0; };
  if (seen) return { ok: true, dup: true, epoch, seq: await seqNow() };
  const markOp = db.prepare('INSERT INTO ops (op_id, t) VALUES (?, ?)').bind(opId, Date.now());
  const trim = db.prepare('DELETE FROM ops WHERE t < ?').bind(Date.now() - 30 * 86400000);
  const setMeta = (k, v) => db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').bind(k, String(v));
  let newEpoch = epoch;

  if (action === 'add') {
    const rows = req.rows;
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 1000) return { ok: false, error: 'bad rows' };
    const insert = db.prepare(`INSERT INTO records (ts, inv, tbl, date, staff, item_id, en, ar, price, qty, total)
      SELECT json_extract(value,'$.ts'), json_extract(value,'$.inv'), json_extract(value,'$.tbl'), json_extract(value,'$.date'),
             json_extract(value,'$.staff'), json_extract(value,'$.item_id'), json_extract(value,'$.en'), json_extract(value,'$.ar'),
             json_extract(value,'$.price'), json_extract(value,'$.qty'), json_extract(value,'$.total')
      FROM json_each(?) ORDER BY CAST(key AS INTEGER)`).bind(JSON.stringify(rows.map(cleanRow)));
    await db.batch([insert, markOp, trim]);

  } else if (action === 'delete') {
    if (role !== 'manager') return { ok: false, error: 'manager only' };
    const inv = str(req.inv, 40);
    if (!inv) return { ok: false, error: 'inv required' };
    newEpoch = epoch + 1;
    await db.batch([db.prepare('DELETE FROM records WHERE inv = ?').bind(inv), setMeta('epoch', newEpoch), markOp, trim]);

  } else if (action === 'replace') {
    if (role !== 'manager') return { ok: false, error: 'manager only' };
    newEpoch = epoch + 1;
    const stmts = [db.prepare('DELETE FROM records'), setMeta('epoch', newEpoch)];
    const m = cleanMenu(req.menu);
    if (m) stmts.push(setMeta('menu', JSON.stringify(m)));
    await db.batch([...stmts, markOp, trim]);

  } else if (action === 'menu') {
    const m = cleanMenu(req.menu);
    if (!m) return { ok: false, error: 'bad menu' };
    const existing = parseMenu(meta.menu);
    // employees may not change prices: their request is accepted but dropped (they only seed an empty menu)
    if (role !== 'manager' && existing) await db.batch([markOp, trim]);
    else await db.batch([setMeta('menu', JSON.stringify(m)), markOp, trim]);

  } else {
    return { ok: false, error: 'unknown action' };
  }
  return { ok: true, epoch: newEpoch, seq: await seqNow() };
}

/* ---------- entry point ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/sync') {
      return url.pathname.startsWith('/api/') ? json({ ok: false, error: 'not found' }, 404) : env.ASSETS.fetch(request);
    }
       if (request.method === 'GET') return json({ ok: true, service: 'starc-billing',   // quick health check
      manager: configured(env.MANAGER_PASSWORD), employee: configured(env.EMPLOYEE_PASSWORD) });
    //*--if (request.method === 'GET') return json({ ok: true, service: 'starc-billing' });   // quick health check--*/
    if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
    try {
      const text = await request.text();
      if (text.length > 3 * 1024 * 1024) return json({ ok: false, error: 'request too large' }, 413);
      let req; try { req = JSON.parse(text); } catch (e) { return json({ ok: false, error: 'invalid' }, 400); }
      const action = str(req.action, 20);
      await init(env.DB);
      if (action === 'login') return json(await login(env, request, req));
      const meta = await metaAll(env.DB);
      const role = await verify(env, await getSecret(env.DB, meta), req.token);
      if (!role) return json({ ok: false, error: 'auth' });
      return json(await handle(env, action, req, role, meta));
    } catch (err) {
      return json({ ok: false, error: 'server: ' + String(err && err.message || err) }, 500);
    }
  }
};
