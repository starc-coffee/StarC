/* Login gate that reuses your existing /starc-auth.js (same manager / employee passwords).
   Usage: StarcGate('manager' | 'any', onOpen)   -- needs /starc-config.js and /starc-auth.js loaded first */
(function () {
  var T = { wrong: 'Wrong password. · كلمة المرور خاطئة', locked: 'Too many wrong tries. Wait and try again. · محاولات كثيرة، انتظر قليلاً',
    network: 'Could not reach the server. · تعذر الاتصال بالخادم', config: 'Not set up yet (starc-config.js). · لم يتم الإعداد',
    https: 'This needs a secure (https) connection. · يلزم اتصال آمن', mgr: 'This page is for the manager only. · هذه الصفحة للمدير فقط' };
  window.StarcGate = function (need, onOpen) {
    var g = document.createElement('div'); g.className = 'gate';
    g.innerHTML = '<form><h2>' + (need === 'manager' ? 'Manager · المدير' : 'Staff · الموظفون') + '</h2><p>' +
      (need === 'manager' ? 'Manager access only. · للمدير فقط.' : 'Enter your password. · أدخل كلمة المرور.') +
      '</p><input type="password" placeholder="Password · كلمة المرور" autocomplete="current-password" required>' +
      '<button class="btn">Enter · دخول</button><div class="err"></div></form>';
    document.body.appendChild(g);
    var pw = g.querySelector('input'), msg = g.querySelector('.err'), opened = false;
    var ok = function (r) { return need === 'manager' ? r === 'manager' : (r === 'manager' || r === 'employee'); };
    function open() { g.style.display = 'none'; if (!opened) { opened = true; onOpen(); } }
    function lock(m) { g.style.display = 'flex'; msg.textContent = m || ''; }
    window.gateLock = function () { if (window.STARC) STARC.logout(); location.reload(); };
    if (!window.STARC) { msg.textContent = 'Could not load /starc-auth.js'; return; }
    var r = STARC.role();
    if (ok(r)) open(); else if (r) { STARC.logout(); lock(T.mgr); }
    g.querySelector('form').addEventListener('submit', async function (e) {
      e.preventDefault(); msg.textContent = '';
      var res = await STARC.login(pw.value); pw.value = '';
      if (!res.ok) { msg.textContent = T[res.error] || 'Error'; return; }
      if (ok(res.role)) open(); else { STARC.logout(); msg.textContent = T.mgr; }
    });
    setInterval(function () { if (opened && !ok(STARC.role())) { opened = false; lock('Session ended. Please log in again. · انتهت الجلسة'); } }, 15000);
  };
})();
