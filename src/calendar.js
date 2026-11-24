/*
 * StarC Task Calendar — API module (called from worker.js for every action that starts with "cal_").
 * Tables (created automatically): cal_people, cal_tasks, cal_done, cal_sent.
 * Owner + Manager use the manager password. Each employee has his own password (set by the manager).
 */
const TZ = 'Asia/Damascus';
const DATE = /^\d{4}-\d{2}-\d{2}$/, TIME = /^\d{2}:\d{2}$/, STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const nowDam = () => {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
};
const minusDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);

let ready = false;
async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS cal_people (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT, label TEXT, nick TEXT DEFAULT '', phone TEXT DEFAULT '', salt TEXT DEFAULT '', pw TEXT DEFAULT '')"),
    db.prepare("CREATE TABLE IF NOT EXISTS cal_tasks (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, notes TEXT, due_date TEXT, due_time TEXT, assignees TEXT, remind_at TEXT, created_by TEXT, created_at TEXT)"),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_cal_tasks_date ON cal_tasks (due_date)'),
    db.prepare('CREATE TABLE IF NOT EXISTS cal_done (task_id INTEGER, person_id INTEGER, at TEXT, PRIMARY KEY (task_id, person_id))'),
    db.prepare('CREATE TABLE IF NOT EXISTS cal_sent (task_id INTEGER, person_id INTEGER, kind TEXT, at TEXT, PRIMARY KEY (task_id, person_id, kind))')
  ]);
  const c = await db.prepare('SELECT COUNT(*) AS n FROM cal_people').first();
  if (!c.n) await db.batch([['owner', 'Owner'], ['manager', 'Manager'], ['employee', 'Employee 1'], ['employee', 'Employee 2']]
    .map(([k, l]) => db.prepare("INSERT INTO cal_people (kind, label) VALUES (?, ?)").bind(k, l)));
  ready = true;
}
const hashPw = async (h, salt, pw) => h.b64url(await h.sha256(salt + ':' + pw));

/* login: employee personal password first, otherwise the normal manager login */
async function calLogin(env, request, req, h, meta) {
  const db = env.DB, pw = h.str(req.password, 200);
  const ip = h.b64url(await h.sha256('ip:' + (request.headers.get('CF-Connecting-IP') || 'x')));
  const lock = await db.prepare('SELECT until FROM logins WHERE ip = ?').bind(ip).first();
  if (lock && lock.until > Date.now()) return { ok: false, error: 'locked' };
  if (pw.length >= 4) {
    const { results } = await db.prepare("SELECT id, salt, pw FROM cal_people WHERE kind = 'employee' AND pw != ''").all();
    for (const p of results) {
      if (await h.same(await hashPw(h, p.salt, pw), p.pw)) {
        const exp = Date.now() + 12 * 3600000, payload = 'emp' + p.id + '.' + exp, secret = await h.getSecret(db, meta);
        await db.prepare('DELETE FROM logins WHERE ip = ?').bind(ip).run();
        return { ok: true, role: 'employee', id: p.id, exp, token: payload + '.' + await h.hmac(secret + ':' + p.pw, payload) };
      }
    }
  }
  const r = await h.login(env, request, req);          // counts wrong tries and locks, same as the rest of the site
  return (r.ok && r.role !== 'manager') ? { ok: false, error: 'wrong' } : r;
}
async function who(env, h, meta, token) {
  const secret = await h.getSecret(env.DB, meta);
  if (await h.verify(env, secret, token) === 'manager') return { role: 'manager' };
  const p = String(token || '').split('.'), m = /^emp(\d+)$/.exec(p[0] || '');
  if (!m || p.length !== 3 || !(Number(p[1]) > Date.now())) return null;
  const row = await env.DB.prepare("SELECT id, pw FROM cal_people WHERE id = ? AND kind = 'employee' AND pw != ''").bind(Number(m[1])).first();
  if (!row) return null;
  return await h.same(p[2], await h.hmac(secret + ':' + row.pw, p[0] + '.' + p[1])) ? { role: 'employee', id: row.id } : null;
}

export async function calendar(env, request, req, action, meta, h) {
  const db = env.DB;
  await init(db);
  if (action === 'cal_login') return calLogin(env, request, req, h, meta);
  const me = await who(env, h, meta, req.token);
  if (!me) return { ok: false, error: 'auth' };
  const mgr = me.role === 'manager';
  const people = (await db.prepare('SELECT id, kind, label, nick, phone, pw FROM cal_people ORDER BY id').all()).results;
  const allIds = people.map(p => p.id);
  const idsOf = t => { let a; try { a = JSON.parse(t.assignees); } catch (e) { a = []; } return a === 'all' ? allIds : a.filter(i => allIds.includes(i)); };
  const taskRow = id => db.prepare('SELECT * FROM cal_tasks WHERE id = ?').bind(Number(id) || 0).first();

  if (action === 'cal_people') {
    if (!mgr) return { ok: true, people: people.filter(p => p.id === me.id).map(p => ({ id: p.id, label: p.label, nick: p.nick })) };
    return { ok: true, people: people.map(p => ({ id: p.id, kind: p.kind, label: p.label, nick: p.nick, phone: p.phone, hasPw: p.kind === 'employee' ? !!p.pw : null })) };
  }

  if (action === 'cal_person_save') {
    if (!mgr) return { ok: false, error: 'manager only' };
    const p = people.find(x => x.id === Number(req.id));
    if (!p) return { ok: false, error: 'not found' };
    const nick = h.str(req.nick, 40).trim(), raw = h.str(req.phone, 30).trim(), phone = raw ? h.normPhone(raw) : '';
    if (raw && !phone) return { ok: false, error: 'phone' };
    let salt = p.salt, pw = p.pw;
    const np = h.str(req.password, 200);
    if (np) {
      if (p.kind !== 'employee') return { ok: false, error: 'no password for this person' };
      if (np.length < 4) return { ok: false, error: 'short' };
      if (env.MANAGER_PASSWORD && await h.same(np, env.MANAGER_PASSWORD)) return { ok: false, error: 'taken' };
      for (const o of people) if (o.id !== p.id && o.kind === 'employee' && o.pw && await h.same(await hashPw(h, (await db.prepare('SELECT salt FROM cal_people WHERE id = ?').bind(o.id).first()).salt, np), o.pw)) return { ok: false, error: 'taken' };
      salt = crypto.randomUUID(); pw = await hashPw(h, salt, np);
    }
    await db.prepare('UPDATE cal_people SET nick = ?, phone = ?, salt = ?, pw = ? WHERE id = ?').bind(nick, phone, salt, pw, p.id).run();
    return { ok: true, phone };
  }

  if (action === 'cal_list') {
    const from = h.str(req.from, 10), to = h.str(req.to, 10);
    if (!DATE.test(from) || !DATE.test(to)) return { ok: false, error: 'bad range' };
    const rows = (await db.prepare('SELECT * FROM cal_tasks WHERE due_date >= ? AND due_date <= ? ORDER BY due_date, due_time, id').bind(from, to).all()).results;
    const dn = (await db.prepare('SELECT task_id, person_id FROM cal_done WHERE task_id IN (SELECT id FROM cal_tasks WHERE due_date >= ? AND due_date <= ?)').bind(from, to).all()).results;
    const out = [];
    for (const t of rows) {
      const ids = idsOf(t), all = t.assignees === '"all"';
      const base = { id: t.id, title: t.title, notes: t.notes, date: t.due_date, time: t.due_time, remindAt: t.remind_at };
      if (mgr) out.push({ ...base, all, ids, done: dn.filter(d => d.task_id === t.id).map(d => d.person_id) });
      else if (ids.includes(me.id)) out.push({ ...base, all, mine: true, done: dn.some(d => d.task_id === t.id && d.person_id === me.id) });
    }
    return { ok: true, tasks: out };
  }

  if (action === 'cal_done') {
    const pid = mgr ? Number(req.personId) : me.id, t = await taskRow(req.taskId);
    if (!t || !idsOf(t).includes(pid)) return { ok: false, error: 'not found' };
    await db.prepare(req.done ? 'INSERT OR REPLACE INTO cal_done (task_id, person_id, at) VALUES (?, ?, ?)' : 'DELETE FROM cal_done WHERE task_id = ? AND person_id = ? AND ? IS NOT NULL')
      .bind(t.id, pid, new Date().toISOString()).run();
    return { ok: true };
  }

  if (!mgr) return { ok: false, error: 'manager only' };

  if (action === 'cal_task_save') {
    const title = h.str(req.title, 200).trim(), notes = h.str(req.notes, 1000), date = h.str(req.date, 10), time = h.str(req.time, 5), rem = h.str(req.remindAt, 16);
    let as = req.assignees;
    if (as !== 'all') as = Array.isArray(as) ? [...new Set(as.map(Number))].filter(i => allIds.includes(i)) : [];
    if (!title || !DATE.test(date) || (time && !TIME.test(time)) || (rem && !STAMP.test(rem)) || (as !== 'all' && !as.length)) return { ok: false, error: 'invalid' };
    const a = JSON.stringify(as), id = Number(req.id) || 0;
    if (id) {
      const before = await taskRow(id);
      if (!before) return { ok: false, error: 'not found' };
      const stmts = [db.prepare('UPDATE cal_tasks SET title=?, notes=?, due_date=?, due_time=?, assignees=?, remind_at=? WHERE id=?').bind(title, notes, date, time, a, rem, id)];
      if (before.remind_at !== rem) stmts.push(db.prepare("DELETE FROM cal_sent WHERE task_id = ? AND kind = 'remind'").bind(id));   // new reminder time -> can be sent again
      await db.batch(stmts);
      return { ok: true, id };
    }
    const r = await db.prepare('INSERT INTO cal_tasks (title, notes, due_date, due_time, assignees, remind_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(title, notes, date, time, a, rem, 'manager', new Date().toISOString()).run();
    return { ok: true, id: r.meta.last_row_id };
  }

  if (action === 'cal_task_del') {
    const id = Number(req.id) || 0;
    await db.batch([db.prepare('DELETE FROM cal_tasks WHERE id = ?').bind(id), db.prepare('DELETE FROM cal_done WHERE task_id = ?').bind(id), db.prepare('DELETE FROM cal_sent WHERE task_id = ?').bind(id)]);
    return { ok: true };
  }

  if (action === 'cal_sent') {
    const kind = req.kind === 'new' ? 'new' : 'remind';
    await db.prepare('INSERT OR REPLACE INTO cal_sent (task_id, person_id, kind, at) VALUES (?, ?, ?, ?)').bind(Number(req.taskId) || 0, Number(req.personId) || 0, kind, new Date().toISOString()).run();
    return { ok: true };
  }

  if (action === 'cal_pending') {            // reminders whose time has come (Damascus time) and were not sent yet
    const now = nowDam();
    const rows = (await db.prepare("SELECT * FROM cal_tasks WHERE remind_at != '' AND remind_at <= ? AND due_date >= ? ORDER BY remind_at").bind(now, minusDays(now.slice(0, 10), 7)).all()).results;
    const dn = (await db.prepare('SELECT task_id, person_id FROM cal_done').all()).results;
    const sent = (await db.prepare("SELECT task_id, person_id FROM cal_sent WHERE kind = 'remind'").all()).results;
    const items = [];
    for (const t of rows) for (const pid of idsOf(t)) {
      if (dn.some(d => d.task_id === t.id && d.person_id === pid) || sent.some(s => s.task_id === t.id && s.person_id === pid)) continue;
      const p = people.find(x => x.id === pid);
      items.push({ taskId: t.id, personId: pid, label: p.label, nick: p.nick, phone: p.phone, title: t.title, notes: t.notes, date: t.due_date, time: t.due_time });
    }
    return { ok: true, items };
  }
  return { ok: false, error: 'unknown action' };
}
