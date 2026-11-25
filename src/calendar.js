/*
 * StarC Task Calendar — API module (called from worker.js for every action that starts with "cal_").
 * Tables (created automatically): cal_people, cal_tasks (with repeat), cal_done_occ, cal_sent_occ.
 * Owner + Manager use the manager password. Each employee has his own password (set by the manager); that password
 * also works in the site's Management login (see login() in worker.js), so he is never asked twice.
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

const addD = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const REPS = ['daily', 'weekly', 'monthly', 'yearly'];
// the dates (inside [from, to]) on which task t happens; monthly/yearly use the last day of a shorter month (31st -> 30th/28th)
function occurrences(t, from, to) {
  const start = t.due_date, rp = t.rep || '', until = t.rep_until || '9999-12-31', end = to < until ? to : until, out = [];
  if (!rp) return start >= from && start <= to ? [start] : out;
  if (end < start) return out;
  if (rp === 'daily' || rp === 'weekly') {
    const step = rp === 'daily' ? 1 : 7;
    for (let d = addD(start, Math.max(0, Math.ceil(daysBetween(start, from) / step)) * step); d <= end && out.length < 400; d = addD(d, step)) out.push(d);
  } else {
    const [y, m, day] = start.split('-').map(Number), sm = rp === 'monthly' ? 1 : 12;
    let n = Math.max(0, Math.floor(((Number(from.slice(0, 4)) - y) * 12 + Number(from.slice(5, 7)) - m) / sm) - 1);
    for (let i = 0; i < 1200; i++, n++) {
      const idx = (m - 1) + n * sm, yy = y + Math.floor(idx / 12), mm = idx % 12;
      const dim = new Date(Date.UTC(yy, mm + 1, 0)).getUTCDate();
      const d = yy + '-' + String(mm + 1).padStart(2, '0') + '-' + String(Math.min(day, dim)).padStart(2, '0');
      if (d > end) break;
      if (d >= from) out.push(d);
    }
  }
  return out;
}
// the reminder moves with the task: same number of days before it, same time of day
const remindFor = (t, d) => t.remind_at ? addD(d, -daysBetween(t.remind_at.slice(0, 10), t.due_date)) + t.remind_at.slice(10) : '';

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
  for (const c of ["rep TEXT DEFAULT ''", "rep_until TEXT DEFAULT ''"]) try { await db.prepare('ALTER TABLE cal_tasks ADD COLUMN ' + c).run(); } catch (e) { /* already there */ }
  // done / sent marks are kept per day of a repeating task (older marks are copied over once)
  const had = await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'cal_done_occ'").first();
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS cal_done_occ (task_id INTEGER, person_id INTEGER, occ TEXT, at TEXT, PRIMARY KEY (task_id, person_id, occ))'),
    db.prepare('CREATE TABLE IF NOT EXISTS cal_sent_occ (task_id INTEGER, person_id INTEGER, kind TEXT, occ TEXT, at TEXT, PRIMARY KEY (task_id, person_id, kind, occ))')
  ]);
  if (!had) await db.batch([
    db.prepare('INSERT OR IGNORE INTO cal_done_occ SELECT d.task_id, d.person_id, t.due_date, d.at FROM cal_done d JOIN cal_tasks t ON t.id = d.task_id'),
    db.prepare('INSERT OR IGNORE INTO cal_sent_occ SELECT s.task_id, s.person_id, s.kind, t.due_date, s.at FROM cal_sent s JOIN cal_tasks t ON t.id = s.task_id')
  ]);
  const c = await db.prepare('SELECT COUNT(*) AS n FROM cal_people').first();
  if (!c.n) await db.batch([['owner', 'Owner'], ['manager', 'Manager'], ['employee', 'Employee 1'], ['employee', 'Employee 2']]
    .map(([k, l]) => db.prepare("INSERT INTO cal_people (kind, label) VALUES (?, ?)").bind(k, l)));
  ready = true;
}
const hashPw = async (h, salt, pw) => h.b64url(await h.sha256(salt + ':' + pw));

/* login: the normal site login already knows personal employee passwords; the calendar only needs a personal or manager token */
async function calLogin(env, request, req, h) {
  const r = await h.login(env, request, req);
  if (r.ok && r.role === 'employee' && !String(r.token).startsWith('employee:')) return { ok: false, error: 'wrong' };   // shared employee password: not for the calendar
  return r;
}
async function who(env, h, meta, token) {
  const role = await h.verify(env, await h.getSecret(env.DB, meta), token);
  if (role === 'manager') return { role: 'manager' };
  const m = /^employee:(\d+)\./.exec(String(token || ''));
  return role === 'employee' && m ? { role: 'employee', id: Number(m[1]) } : null;
}

export async function calendar(env, request, req, action, meta, h) {
  const db = env.DB;
  await init(db);
  if (action === 'cal_login') return calLogin(env, request, req, h);
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
      if ((env.MANAGER_PASSWORD && await h.same(np, env.MANAGER_PASSWORD)) || (env.EMPLOYEE_PASSWORD && await h.same(np, env.EMPLOYEE_PASSWORD))) return { ok: false, error: 'taken' };
      for (const o of people) if (o.id !== p.id && o.kind === 'employee' && o.pw && await h.same(await hashPw(h, (await db.prepare('SELECT salt FROM cal_people WHERE id = ?').bind(o.id).first()).salt, np), o.pw)) return { ok: false, error: 'taken' };
      salt = crypto.randomUUID(); pw = await hashPw(h, salt, np);
    }
    await db.prepare('UPDATE cal_people SET nick = ?, phone = ?, salt = ?, pw = ? WHERE id = ?').bind(nick, phone, salt, pw, p.id).run();
    return { ok: true, phone };
  }

  if (action === 'cal_list') {
    const from = h.str(req.from, 10), to = h.str(req.to, 10);
    if (!DATE.test(from) || !DATE.test(to) || to < from || daysBetween(from, to) > 400) return { ok: false, error: 'bad range' };
    const rows = (await db.prepare("SELECT * FROM cal_tasks WHERE due_date <= ? AND (due_date >= ? OR (COALESCE(rep, '') != '' AND (COALESCE(rep_until, '') = '' OR rep_until >= ?)))").bind(to, from, from).all()).results;
    const dn = (await db.prepare('SELECT task_id, person_id, occ FROM cal_done_occ WHERE occ >= ? AND occ <= ?').bind(from, to).all()).results;
    const out = [];
    for (const t of rows) {
      const ids = idsOf(t), all = t.assignees === '"all"';
      for (const d of occurrences(t, from, to)) {
        const base = { id: t.id, title: t.title, notes: t.notes, date: d, start: t.due_date, time: t.due_time, remindAt: t.remind_at, repeat: t.rep || '', repeatUntil: t.rep_until || '' };
        const done = dn.filter(x => x.task_id === t.id && x.occ === d);
        if (mgr) out.push({ ...base, all, ids, done: done.map(x => x.person_id) });
        else if (ids.includes(me.id)) out.push({ ...base, all, mine: true, done: done.some(x => x.person_id === me.id) });
      }
    }
    out.sort((x, y) => (x.date + (x.time || '')).localeCompare(y.date + (y.time || '')) || x.id - y.id);
    return { ok: true, tasks: out };
  }

  if (action === 'cal_done') {
    const pid = mgr ? Number(req.personId) : me.id, t = await taskRow(req.taskId);
    const d = DATE.test(h.str(req.date, 10)) ? req.date : (t && t.due_date);
    if (!t || !idsOf(t).includes(pid) || !occurrences(t, d, d).length) return { ok: false, error: 'not found' };
    await db.prepare(req.done ? 'INSERT OR REPLACE INTO cal_done_occ (task_id, person_id, occ, at) VALUES (?, ?, ?, ?)' : 'DELETE FROM cal_done_occ WHERE task_id = ? AND person_id = ? AND occ = ? AND ? IS NOT NULL')
      .bind(t.id, pid, d, new Date().toISOString()).run();
    return { ok: true };
  }

  if (!mgr) return { ok: false, error: 'manager only' };

  if (action === 'cal_task_save') {
    const title = h.str(req.title, 200).trim(), notes = h.str(req.notes, 1000), date = h.str(req.date, 10), time = h.str(req.time, 5), rem = h.str(req.remindAt, 16);
    const rp = REPS.includes(req.repeat) ? req.repeat : '', ru = rp ? h.str(req.repeatUntil, 10) : '';
    let as = req.assignees;
    if (as !== 'all') as = Array.isArray(as) ? [...new Set(as.map(Number))].filter(i => allIds.includes(i)) : [];
    if (!title || !DATE.test(date) || (time && !TIME.test(time)) || (rem && !STAMP.test(rem)) || (as !== 'all' && !as.length) || (ru && (!DATE.test(ru) || ru < date))) return { ok: false, error: 'invalid' };
    const a = JSON.stringify(as), id = Number(req.id) || 0;
    if (id) {
      const before = await taskRow(id);
      if (!before) return { ok: false, error: 'not found' };
      const stmts = [db.prepare('UPDATE cal_tasks SET title=?, notes=?, due_date=?, due_time=?, assignees=?, remind_at=?, rep=?, rep_until=? WHERE id=?').bind(title, notes, date, time, a, rem, rp, ru, id)];
      if (before.remind_at !== rem || before.due_date !== date) stmts.push(db.prepare("DELETE FROM cal_sent_occ WHERE task_id = ? AND kind = 'remind'").bind(id));   // new reminder time -> can be sent again
      await db.batch(stmts);
      return { ok: true, id };
    }
    const r = await db.prepare('INSERT INTO cal_tasks (title, notes, due_date, due_time, assignees, remind_at, created_by, created_at, rep, rep_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(title, notes, date, time, a, rem, 'manager', new Date().toISOString(), rp, ru).run();
    return { ok: true, id: r.meta.last_row_id };
  }

  if (action === 'cal_task_del') {                       // removes the task and all its repeats
    const id = Number(req.id) || 0;
    await db.batch([db.prepare('DELETE FROM cal_tasks WHERE id = ?').bind(id), db.prepare('DELETE FROM cal_done_occ WHERE task_id = ?').bind(id), db.prepare('DELETE FROM cal_sent_occ WHERE task_id = ?').bind(id)]);
    return { ok: true };
  }

  if (action === 'cal_sent') {
    const kind = req.kind === 'new' ? 'new' : 'remind', occ = DATE.test(h.str(req.date, 10)) ? req.date : '';
    await db.prepare('INSERT OR REPLACE INTO cal_sent_occ (task_id, person_id, kind, occ, at) VALUES (?, ?, ?, ?, ?)').bind(Number(req.taskId) || 0, Number(req.personId) || 0, kind, occ, new Date().toISOString()).run();
    return { ok: true };
  }

  if (action === 'cal_pending') {            // reminders whose time has come (Damascus time) and were not sent yet, for every repeat too
    const now = nowDam(), today = now.slice(0, 10), lo = minusDays(today, 7);
    const rows = (await db.prepare("SELECT * FROM cal_tasks WHERE remind_at != ''").all()).results;
    const dn = (await db.prepare('SELECT task_id, person_id, occ FROM cal_done_occ WHERE occ >= ?').bind(lo).all()).results;
    const sent = (await db.prepare("SELECT task_id, person_id, occ FROM cal_sent_occ WHERE kind = 'remind' AND occ >= ?").bind(lo).all()).results;
    const items = [];
    for (const t of rows) {
      const lead = Math.max(0, daysBetween(t.remind_at.slice(0, 10), t.due_date));
      for (const d of occurrences(t, lo, addD(today, lead + 1))) {
        const at = remindFor(t, d);
        if (at > now) continue;
        for (const pid of idsOf(t)) {
          if (dn.some(x => x.task_id === t.id && x.person_id === pid && x.occ === d) || sent.some(x => x.task_id === t.id && x.person_id === pid && x.occ === d)) continue;
          const p = people.find(x => x.id === pid);
          items.push({ taskId: t.id, personId: pid, label: p.label, nick: p.nick, phone: p.phone, title: t.title, notes: t.notes, date: d, time: t.due_time, at });
        }
      }
    }
    items.sort((x, y) => x.at.localeCompare(y.at));
    return { ok: true, items };
  }
  return { ok: false, error: 'unknown action' };
}
