/* One printable table sign per page: /sign.html?sign=qr|how|prices (&slug=&name=&kind= for the QR sign). */
(function () {
  'use strict';
  var C = window.SonaCommon;
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  var q = new URLSearchParams(location.search);
  var kind = { qr: 'qr-sign', how: 'how', prices: 'prices' }[q.get('sign') || 'qr'] || 'qr-sign';
  var slug = (q.get('slug') || '').replace(/[^a-z0-9-]/g, ''), name = (q.get('name') || '').slice(0, 80), special = q.get('kind') === 'private';
  var poster = $('poster-' + kind), embed = q.get('embed') === '1';
  if (embed) document.body.classList.add('embed');

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
    if (embed) return;   /* drawn for the PDF at full size */
    var w = poster.offsetWidth, h = poster.offsetHeight, k = Math.min(1, (document.documentElement.clientWidth - 24) / w);
    poster.style.transform = k < 1 ? 'scale(' + k + ')' : '';
    $('fit').style.width = Math.round(w * k) + 'px';
    $('fit').style.height = Math.round(h * k) + 'px';
  }
  fit();
  window.addEventListener('resize', fit);
  window.addEventListener('orientationchange', fit);

  /* ---------- the sign as a one-page Letter PDF ---------- */
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var ready = (async function () {
    try {
      if (document.fonts && document.fonts.load) {
        await Promise.all(['700 34pt Fredoka', '600 24pt Fredoka', '400 14pt Nunito', '700 14pt Nunito', '800 14pt Nunito'].map(function (f) {
          return document.fonts.load(f).catch(function () {});
        }));
      }
      if (document.fonts && document.fonts.ready) await Promise.race([document.fonts.ready, wait(6000)]);
    } catch (err) {}
    /* the QR code turns from a drawing into a picture a moment after it is made */
    var qr = kind === 'qr-sign' ? $('poster-qr') : null, t0 = Date.now();
    while (qr && slug && window.QRCode && !qr.querySelector('img[src]') && Date.now() - t0 < 2000) await wait(50);
    await Promise.all(Array.prototype.map.call(poster.querySelectorAll('img'), function (im) {
      if (!im.getAttribute('src')) return null;
      return im.complete ? null : Promise.race([new Promise(function (r) { im.onload = im.onerror = r; }), wait(8000)]);
    }));
  })();
  async function makePdf() {
    await ready;
    if (!window.html2canvas || !window.jspdf) throw new Error('LIBS');
    if (kind === 'qr-sign' && (!slug || !$('poster-qr').firstChild)) throw new Error('NO_QR');
    poster.style.transform = '';
    var shot = await window.html2canvas(poster, { scale: 3, backgroundColor: '#ffffff', useCORS: true, logging: false });
    var doc = new window.jspdf.jsPDF({ unit: 'in', format: 'letter', orientation: 'portrait', compress: true });
    var w = 7.7, h = w * shot.height / shot.width;
    if (h > 10.2) { h = 10.2; w = h * shot.width / shot.height; }
    doc.setProperties({ title: document.title, creator: 'Sona Magnets Co.' });
    doc.addImage(shot.toDataURL('image/jpeg', 0.94), 'JPEG', (8.5 - w) / 2, (11 - h) / 2, w, h);
    return doc.output('arraybuffer');
  }
  window.SonaSign = { pdf: makePdf };
  if (embed) return;

  /* On this page: make the PDF and open it in a new tab. Signed-in staff get a normal web address
     for it, which every phone opens; otherwise the copy held in this page is used. */
  var sb = null, busy = false, made = null;
  try {
    if (window.supabase && window.SONA) sb = window.supabase.createClient(window.SONA.supabaseUrl, window.SONA.supabaseKey, { auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false } });
  } catch (err) { sb = null; }
  function say(text, bad) { $('sign-msg').textContent = text; $('sign-msg').className = 'note' + (bad ? ' bad' : ''); }
  function asApp() { try { return navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches; } catch (err) { return false; } }
  function openTab() {
    if (asApp()) return null;
    try {
      var t = window.open('', '_blank');
      if (!t) return null;
      t.document.write('<!DOCTYPE html><title>Sona Magnets sign</title><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<body style="margin:0;padding:32px;font:600 20px system-ui,sans-serif;color:#1B1F3B;background:#FDF8EE">Building your sign. One moment.</body>');
      t.document.close();
      return t;
    } catch (err) { return null; }
  }
  async function upload(blob) {
    if (!sb) return null;
    var work = (async function () {
      var s = await sb.auth.getSession();
      if (!s.data || !s.data.session) return null;
      var path = 'signs/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.pdf';
      var up = await sb.storage.from('sheets').upload(path, blob, { contentType: 'application/pdf', upsert: false });
      if (up.error) return null;
      var signed = await sb.storage.from('sheets').createSignedUrl(path, 12 * 3600);
      return signed.error || !signed.data ? null : signed.data.signedUrl;
    })().catch(function () { return null; });
    return Promise.race([work, wait(20000).then(function () { return null; })]);
  }
  $('print').addEventListener('click', async function () {
    if (busy) return;
    busy = true;
    var tab = openTab();
    say('Making the PDF. One moment.');
    try {
      var buf = await C.signPdf(location.pathname + location.search);
      var blob = new Blob([buf], { type: 'application/pdf' });
      if (made) { try { URL.revokeObjectURL(made.url); } catch (err) {} }
      made = { url: URL.createObjectURL(blob), file: null };
      try { made.file = new File([blob], 'sona-magnets-sign.pdf', { type: 'application/pdf' }); } catch (err) { made.file = null; }
      var link = await upload(blob), go = link || made.url, opened = false;
      if (tab && !tab.closed) { try { tab.location.replace(go); opened = true; } catch (err) { opened = false; } }
      var share = false;
      try { share = !!(made.file && navigator.share && navigator.canShare && navigator.canShare({ files: [made.file] })); } catch (err) { share = false; }
      $('pdf-share').hidden = !share; $('pdf-open').hidden = false; $('pdf-save').hidden = false;
      $('pdf-open').href = go; $('pdf-open').textContent = opened ? 'Open PDF again' : 'Open PDF to print';
      $('pdf-open').className = 'btn' + (opened ? ' small' : ' primary');
      $('pdf-save').href = made.url; $('pdf-save').download = 'sona-magnets-sign.pdf';
      $('pdf-row').hidden = false;
      say(opened ? 'The PDF opened in a new tab. Print it from there.' : 'The PDF is ready. Tap Open PDF to print.');
    } catch (err) {
      try { if (tab && !tab.closed) tab.close(); } catch (e) {}
      $('pdf-row').hidden = false; $('pdf-open').removeAttribute('href'); $('pdf-open').hidden = true; $('pdf-save').hidden = true; $('pdf-share').hidden = true;
      say(String(err && err.message) === 'NO_QR' ? 'This sign needs an event. Open the event on the staff page and use QR sign PDF.' : 'The PDF could not be made. Check the connection and try again, or use Print this page instead.', true);
    }
    busy = false;
  });
  $('pdf-share').addEventListener('click', function () {
    if (made && made.file) navigator.share({ files: [made.file], title: 'Sona Magnets sign' }).catch(function () {});
  });
  $('plain-print').addEventListener('click', function () { try { window.print(); } catch (err) {} });
})();
