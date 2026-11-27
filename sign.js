/* One printable table sign per page: /sign.html?sign=qr|how|prices (&slug=&name=&kind= for the QR sign). */
(function () {
  'use strict';
  var C = window.SonaCommon;
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  var q = new URLSearchParams(location.search);
  var kind = { qr: 'qr-sign', how: 'how', prices: 'prices' }[q.get('sign') || 'qr'] || 'qr-sign';
  var slug = (q.get('slug') || '').replace(/[^a-z0-9-]/g, ''), name = (q.get('name') || '').slice(0, 80), special = q.get('kind') === 'private';
  var poster = $('poster-' + kind);

  if (kind === 'qr-sign') {
    document.title = 'QR sign' + (name ? ' for ' + name : '');
    $('poster-event').textContent = name;
    $('poster-qr-sub').textContent = special ? 'Pick them up before the end of the event.' : 'Made in 10-15 minutes while you shop around.';
    $('poster-step3').textContent = special ? 'Pick up before you leave' : 'Ready in 10-15 minutes';
    if (!slug) $('sign-msg').textContent = 'This sign needs an event. Go back to the staff page, open the event, and press Open QR sign to print.';
    else if (!window.QRCode) $('sign-msg').textContent = 'The QR code could not load. Check the connection and reload this page.';
    else new window.QRCode($('poster-qr'), { text: location.origin + '/e/' + slug, width: 900, height: 900, correctLevel: window.QRCode.CorrectLevel.M });
  } else if (kind === 'prices') {
    document.title = 'Price sign';
    var list = $('poster-price-list'), tiers = C.packs(Infinity);
    var best = tiers.reduce(function (m, t) { return !m || t.price / t.qty < m.price / m.qty ? t : m; }, null);
    tiers.forEach(function (t) {
      var li = el('li', t === best && tiers.length > 1 ? 'best' : '');
      li.appendChild(el('b', null, String(t.qty)));
      li.appendChild(el('span', null, t.qty === 1 ? 'magnet' : 'magnets'));
      li.appendChild(el('strong', null, C.money(t.price)));
      if (t === best && tiers.length > 1) li.appendChild(el('em', null, 'Best value'));
      list.appendChild(li);
    });
  } else {
    document.title = 'How it works sign';
    /* events that take payment online: guests pay on their phone, not at the table */
    if (q.get('pay') !== 'table') {
      $('how-pay').textContent = 'Pay on your phone';
      $('how-pay-sub').textContent = 'Apple Pay, Google Pay or card. No waiting in line.';
    }
  }
  Array.prototype.forEach.call(document.querySelectorAll('.poster'), function (p) { if (p !== poster) p.parentNode.removeChild(p); });
  poster.hidden = false;

  /* On screen the sign is shrunk to fit the phone; on paper it is always full size. */
  function fit() {
    var w = poster.offsetWidth, h = poster.offsetHeight, k = Math.min(1, (document.documentElement.clientWidth - 24) / w);
    poster.style.transform = k < 1 ? 'scale(' + k + ')' : '';
    $('fit').style.width = Math.round(w * k) + 'px';
    $('fit').style.height = Math.round(h * k) + 'px';
  }
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);
  $('print').addEventListener('click', function () { window.print(); });
})();
