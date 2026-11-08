/* Shared helpers for the discount pages: server calls (same style as your billing pages), dates, coupon card image. */
(function () {
  var D = window.DC = {
    api: async function (payload) {
      var c = window.STARC_CONFIG || {}, url = (c.url && c.url.indexOf('PASTE') < 0) ? c.url : '';
      if (!url) { var e0 = new Error('config'); e0.kind = 'config'; throw e0; }
      var r;
      try { r = await fetch(url, { method: 'POST', body: JSON.stringify(Object.assign({}, payload, { token: window.STARC ? STARC.token() : null })) }); }
      catch (e) { var e1 = new Error('offline'); e1.kind = 'offline'; throw e1; }
      var j = null; try { j = await r.json(); } catch (e) {}
      if (!j) { var e2 = new Error('bad'); e2.kind = 'server'; e2.detail = 'unexpected reply'; throw e2; }
      if (j.ok !== true) { var e3 = new Error(j.error || 'bad'); e3.kind = j.error === 'auth' ? 'auth' : 'server'; e3.detail = j.error; e3.coupon = j.coupon; throw e3; }
      return j;
    },
    errText: function (e) {
      if (e.kind === 'config') return 'Server not set up (starc-config.js). · الخادم غير مُعدّ';
      if (e.kind === 'offline') return 'No connection. · لا يوجد اتصال';
      if (e.kind === 'auth') return 'Session ended, log in again. · انتهت الجلسة';
      if (e.detail === 'manager only') return 'Manager only. · للمدير فقط';
      if (e.detail === 'invalid') return 'Check the name, percentage (1-100) and date. · تحقق من الاسم والنسبة والتاريخ';
      if (e.detail === 'not found') return 'Coupon not found · القسيمة غير موجودة';
      return 'Server error' + (e.detail ? ' (' + e.detail + ')' : '') + '. · خطأ في الخادم';
    },
    esc: function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); },
    pad: function (n) { return String(n).padStart(2, '0'); },
    ymd: function (d) { return d.getFullYear() + '-' + D.pad(d.getMonth() + 1) + '-' + D.pad(d.getDate()); },
    today: function () { return D.ymd(new Date()); },
    addDays: function (n) { var d = new Date(); d.setDate(d.getDate() + n); return D.ymd(d); },
    checkUrl: function (code) { return new URL('check.html?c=' + code, location.href).href; },
    status: { valid: '✔ Valid · صالحة', expired: '✖ Expired · منتهية الصلاحية', used: '⚠ Already used · مستخدمة مسبقاً' },
    drawCard: function (cv, c) {
      var x = cv.getContext('2d'), W = 1080, H = 1350, F = '"Tajawal","Segoe UI",Tahoma,Arial,sans-serif', B = '#be8c32', K = '#3b2a1c';
      x.direction = 'ltr'; x.textAlign = 'center';
      x.fillStyle = '#fcf6e8'; x.fillRect(0, 0, W, H);
      x.strokeStyle = B; x.lineWidth = 10; rr(x, 28, 28, W - 56, H - 56, 64); x.stroke();
      x.strokeStyle = '#e6d3a8'; x.lineWidth = 3; rr(x, 52, 52, W - 104, H - 104, 48); x.stroke();
      x.fillStyle = '#2b2b29'; x.font = 'bold 84px Georgia,serif'; x.fillText('StarC', W / 2, 165);
      x.font = '30px Georgia,serif'; x.letterSpacing = '14px'; x.fillText('CAFE', W / 2 + 7, 215); x.letterSpacing = '0px';
      x.fillStyle = K; x.font = '900 100px ' + F; x.fillText('خصم', W / 2, 345);
      x.font = '700 40px ' + F; x.fillText('DISCOUNT', W / 2, 395);
      x.fillStyle = B; x.font = '900 240px ' + F; x.fillText(c.percent + '%', W / 2, 620);
      x.fillStyle = K; x.font = '800 58px ' + F; x.fillText('على الفاتورة كاملة', W / 2, 705);
      x.font = '600 34px ' + F; x.fillText('on the full bill', W / 2, 752);
      var q = qrcode(0, 'M'); q.addData(D.checkUrl(c.code)); q.make();
      var img = new Image();
      img.onload = function () {
        x.fillStyle = '#fff'; rr(x, W / 2 - 180, 785, 360, 360, 26); x.fill();
        x.imageSmoothingEnabled = false; x.drawImage(img, W / 2 - 160, 805, 320, 320);
        x.fillStyle = K; x.direction = 'auto'; x.font = '700 44px ' + F; x.fillText(c.holder, W / 2, 1196);
        x.direction = 'ltr'; x.font = '600 34px ' + F; x.fillText('Valid until · صالحة حتى ' + c.validUntil, W / 2, 1245);
        x.fillStyle = B; x.font = 'bold 40px monospace'; x.fillText(c.code, W / 2, 1296);
      };
      img.src = q.createDataURL(8, 0);
      function rr(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
    }
  };
})();
