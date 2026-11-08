/*
 * StarC Billing — records API (Cloudflare Worker + D1 database)
 * Receives invoices from the billing page, stores them in the D1 table "records",
 * and checks the manager / employee passwords on the server.
 *
 * Also stores discount coupons (D1 table "coupons", actions coupon_create / coupon_list / coupon_get / coupon_redeem).
 *
 * Secrets to set in Cloudflare (Worker > Settings > Variables and secrets):
 *   MANAGER_PASSWORD   EMPLOYEE_PASSWORD
 */
const TOKEN_HOURS = 12;
const COUPON_TZ = 'UTC';   // <- your cafe time zone, e.g. 'Asia/Beirut'. A coupon is valid through the end of its last day in this zone.
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
    db.prepare('CREATE TABLE IF NOT EXISTS logins (ip TEXT PRIMARY KEY, n INTEGER, until INTEGER, first INTEGER)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS acct_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT, section TEXT, category TEXT, grp TEXT, name TEXT,
      amount REAL, note TEXT, sort INTEGER, updated INTEGER)`),
    db.prepare('CREATE TABLE IF NOT EXISTS acct_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, action TEXT, detail TEXT)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS coupons (
      code TEXT PRIMARY KEY, percent INTEGER NOT NULL, holder TEXT NOT NULL, valid_until TEXT NOT NULL,
      created_at TEXT NOT NULL, created_by TEXT, used_at TEXT, used_by TEXT)`),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_coupons_created ON coupons (created_at)')
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

/* ---------- accounting (manager only) ---------- */
const SECTIONS = ['fixed', 'current', 'deferred', 'liabilities', 'equity'];
const CATS = ['rent_contracts', 'decor', 'furniture', 'sanitary', 'equipment', 'supplies_marketing', 'operating', 'other'];
const cleanEntry = e => {
  e = e || {};
  const section = str(e.section, 20), category = str(e.category, 30);
  if (!SECTIONS.includes(section) || !CATS.includes(category)) return null;
  const name = str(e.name, 200).trim(), amount = num(e.amount);
  if (!name || amount < 0) return null;
  return { section, category, grp: str(e.grp, 200).trim(), name, amount, note: str(e.note, 300), sort: Math.trunc(num(e.sort)) };
};
const ENTRY_COLS = 'id, section, category, grp, name, amount, note, sort';
async function acct(env, action, req) {
  const db = env.DB;
  if (action === 'acct_get') {
    const { results } = await db.prepare(`SELECT ${ENTRY_COLS} FROM acct_entries ORDER BY sort, id`).all();
    const out = { ok: true, entries: results };
    if (req.audit) out.audit = (await db.prepare('SELECT id, t, action, detail FROM acct_audit ORDER BY id DESC LIMIT 200').all()).results;
    return out;
  }
  const opId = str(req.opId, 64);
  if (!opId) return { ok: false, error: 'opId required' };
  if (await db.prepare('SELECT 1 AS x FROM ops WHERE op_id = ?').bind(opId).first()) return { ok: true, dup: true };
  const markOp = db.prepare('INSERT INTO ops (op_id, t) VALUES (?, ?)').bind(opId, Date.now());
  const audit = (act, detail) => db.prepare('INSERT INTO acct_audit (t, action, detail) VALUES (?, ?, ?)').bind(Date.now(), act, JSON.stringify(detail).slice(0, 4000));
  const now = Date.now();

  if (action === 'acct_put') {
    const e = cleanEntry(req.entry);
    if (!e) return { ok: false, error: 'bad entry' };
    const id = Number(req.entry && req.entry.id) || 0;
    if (id) {
      const before = await db.prepare(`SELECT ${ENTRY_COLS} FROM acct_entries WHERE id = ?`).bind(id).first();
      if (!before) return { ok: false, error: 'not found' };
      await db.batch([
        db.prepare('UPDATE acct_entries SET section=?, category=?, grp=?, name=?, amount=?, note=?, updated=? WHERE id=?')
          .bind(e.section, e.category, e.grp, e.name, e.amount, e.note, now, id),
        audit('edit', { id, before, after: e }), markOp]);
      return { ok: true, id };
    }
    const mx = await db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM acct_entries').first();
    const sort = e.sort > 0 ? e.sort : Math.max(1000, (mx ? mx.m : 0) + 10);
    const res = await db.batch([
      db.prepare('INSERT INTO acct_entries (section, category, grp, name, amount, note, sort, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(e.section, e.category, e.grp, e.name, e.amount, e.note, sort, now),
      audit('add', { after: e }), markOp]);
    return { ok: true, id: res[0].meta.last_row_id };
  }

  if (action === 'acct_del') {
    const id = Number(req.id) || 0;
    const before = await db.prepare(`SELECT ${ENTRY_COLS} FROM acct_entries WHERE id = ?`).bind(id).first();
    if (!before) return { ok: true, gone: true };
    await db.batch([db.prepare('DELETE FROM acct_entries WHERE id = ?').bind(id), audit('delete', { id, before }), markOp]);
    return { ok: true };
  }

  if (action === 'acct_replace') {                       // restore / first-time load: replaces ALL entries
    const list = req.entries;
    if (!Array.isArray(list) || list.length > 2000) return { ok: false, error: 'bad entries' };
    const clean = [];
    for (let i = 0; i < list.length; i++) {
      const e = cleanEntry(list[i]);
      if (!e) return { ok: false, error: 'bad entry at row ' + (i + 1) };
      e.sort = e.sort > 0 ? e.sort : (i + 1) * 10;
      clean.push(e);
    }
    const assets = clean.filter(e => e.section === 'fixed' || e.section === 'current' || e.section === 'deferred').reduce((s, e) => s + e.amount, 0);
    const stmts = [db.prepare('DELETE FROM acct_entries')];
    if (clean.length) stmts.push(db.prepare(`INSERT INTO acct_entries (section, category, grp, name, amount, note, sort, updated)
      SELECT json_extract(value,'$.section'), json_extract(value,'$.category'), json_extract(value,'$.grp'), json_extract(value,'$.name'),
             json_extract(value,'$.amount'), json_extract(value,'$.note'), json_extract(value,'$.sort'), ?
      FROM json_each(?) ORDER BY CAST(key AS INTEGER)`).bind(now, JSON.stringify(clean)));
    await db.batch([...stmts, audit('replace', { count: clean.length, assets }), markOp]);
    return { ok: true, count: clean.length };
  }
  return { ok: false, error: 'unknown action' };
}

/* ---------- discount coupons ---------- */
// create / list: manager only.  get / redeem: manager or employee.  Redeem is one atomic statement,
// so a coupon can never be used twice, and an expired coupon can never be redeemed.
const COUPON_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const couponToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: COUPON_TZ }).format(new Date());   // YYYY-MM-DD
const couponCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
const couponView = r => ({
  code: r.code, percent: r.percent, holder: r.holder, validUntil: r.valid_until, createdAt: r.created_at,
  usedAt: r.used_at || '', usedBy: r.used_by || '',
  status: r.used_at ? 'used' : (couponToday() > r.valid_until ? 'expired' : 'valid')
});
async function coupons(env, action, req, role) {
  const db = env.DB;
  if (action === 'coupon_create') {
    if (role !== 'manager') return { ok: false, error: 'manager only' };
    const percent = Math.round(num(req.percent)), holder = str(req.holder, 60).trim(), validUntil = str(req.validUntil, 10);
    if (!(percent >= 1 && percent <= 100) || !holder || !/^\d{4}-\d{2}-\d{2}$/.test(validUntil) || validUntil < couponToday())
      return { ok: false, error: 'invalid' };
    for (let i = 0; i < 5; i++) {
      const code = Array.from(crypto.getRandomValues(new Uint8Array(10)), x => COUPON_ALPHABET[x % COUPON_ALPHABET.length]).join('');
      const created = new Date().toISOString();
      try {
        await db.prepare('INSERT INTO coupons (code, percent, holder, valid_until, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(code, percent, holder, validUntil, created, role).run();
        return { ok: true, coupon: couponView({ code, percent, holder, valid_until: validUntil, created_at: created }) };
      } catch (e) { /* the code already exists: try another one */ }
    }
    return { ok: false, error: 'could not create' };
  }
  if (action === 'coupon_list') {
    if (role !== 'manager') return { ok: false, error: 'manager only' };
    const { results } = await db.prepare('SELECT * FROM coupons ORDER BY created_at DESC LIMIT 200').all();
    return { ok: true, coupons: results.map(couponView) };
  }
  const code = couponCode(req.code);
  if (!code) return { ok: false, error: 'not found' };
  const row = () => db.prepare('SELECT * FROM coupons WHERE code = ?').bind(code).first();
  if (action === 'coupon_get') {
    const r = await row();
    return r ? { ok: true, coupon: couponView(r) } : { ok: false, error: 'not found' };
  }
  if (action === 'coupon_redeem') {
    const res = await db.prepare('UPDATE coupons SET used_at = ?, used_by = ? WHERE code = ? AND used_at IS NULL AND valid_until >= ?')
      .bind(new Date().toISOString(), role, code, couponToday()).run();
    const r = await row();
    if (!r) return { ok: false, error: 'not found' };
    if (res.meta && res.meta.changes >= 1) return { ok: true, coupon: couponView(r) };
    return { ok: false, error: couponView(r).status, coupon: couponView(r) };      // 'used' or 'expired'
  }
  return { ok: false, error: 'unknown action' };
}

/* ---------- entry point ---------- */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/sync') {
      return url.pathname.startsWith('/api/') ? json({ ok: false, error: 'not found' }, 404) : env.ASSETS.fetch(request);
    }
    if (request.method !== 'GET' && request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
    try {
      await init(env.DB);
      const meta = await metaAll(env.DB);
      // Passwords: Cloudflare secrets first; if they are not set, the values stored in the database table "meta"
      env = { ...env,
        MANAGER_PASSWORD: env.MANAGER_PASSWORD || meta.manager_password || '',
        EMPLOYEE_PASSWORD: env.EMPLOYEE_PASSWORD || meta.employee_password || '' };
      if (request.method === 'GET') return json({ ok: true, service: 'starc-billing',   // quick health check
        manager: configured(env.MANAGER_PASSWORD), employee: configured(env.EMPLOYEE_PASSWORD) });
      const text = await request.text();
      if (text.length > 3 * 1024 * 1024) return json({ ok: false, error: 'request too large' }, 413);
      let req; try { req = JSON.parse(text); } catch (e) { return json({ ok: false, error: 'invalid' }, 400); }
      const action = str(req.action, 20);
      if (action === 'login') return json(await login(env, request, req));
      const role = await verify(env, await getSecret(env.DB, meta), req.token);
      if (!role) return json({ ok: false, error: 'auth' });
      if (action.startsWith('acct_')) {                       // accounting data: manager only, enforced here on the server
        if (role !== 'manager') return json({ ok: false, error: 'manager only' });
        return json(await acct(env, action, req));
      }
      if (action.startsWith('coupon_')) return json(await coupons(env, action, req, role));   // discount coupons
      return json(await handle(env, action, req, role, meta));
    } catch (err) {
      return json({ ok: false, error: 'server: ' + String(err && err.message || err) }, 500);
    }
  }
};
