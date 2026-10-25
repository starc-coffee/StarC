/*
 * StarC — login helper. The password is checked by your Google Apps Script
 * (Code.gs), never inside the website's files. Needs starc-config.js (the URL).
 */
(function () {
  var KEY = 'starcAuth', FKEY = 'starcFails';
  function url() { var c = window.STARC_CONFIG || {}; return (c.url && c.url.indexOf('PASTE') < 0) ? c.url : ''; }
  function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  // returns { ok, role } or { ok:false, error: 'wrong' | 'locked' | 'network' | 'config' }
  async function login(pw) {
    var u = url();
    if (!u) return { ok: false, error: 'config' };
    var f = lsGet(FKEY) || { n: 0, until: 0 };
    if (f.until > Date.now()) return { ok: false, error: 'locked' };
    var j = null;
    try {
      var r = await fetch(u, { method: 'POST', body: JSON.stringify({ action: 'login', password: pw }) });   // plain-text body = no CORS preflight
      j = await r.json();
    } catch (e) { return { ok: false, error: 'network' }; }
    if (!j || !j.ok) {
      if (j && j.error === 'locked') return { ok: false, error: 'locked' };
      f.n = (f.n || 0) + 1;
      if (f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; }            // 5 wrong tries on this device -> wait 1 minute
      lsSet(FKEY, f);
      return { ok: false, error: j ? 'wrong' : 'network' };
    }
    lsSet(FKEY, { n: 0, until: 0 });
    lsSet(KEY, { role: j.role, token: j.token, exp: j.exp });
    return { ok: true, role: j.role };
  }
  function session() { var s = lsGet(KEY); return (s && s.token && s.exp > Date.now()) ? s : null; }
  function role() { var s = session(); return s ? s.role : null; }          // 'manager' | 'employee' | null (the server re-checks on every request)
  function token() { var s = session(); return s ? s.token : null; }
  function logout() { try { localStorage.removeItem(KEY); } catch (e) {} }

  window.STARC = { login: login, role: role, token: token, logout: logout };
})();
