/* Guest order page. Two steps: choose photos, then give a name and send. */
(function () {
  'use strict';
  var C = window.SonaCommon, CFG = window.SONA;
  var $ = function (id) { return document.getElementById(id); };
  var parts = location.pathname.split('/').filter(Boolean);
  var slug = (parts[0] === 'e' && parts[1]) ? decodeURIComponent(parts[1]) : (new URLSearchParams(location.search).get('e') || '');
  slug = slug.toLowerCase();
  /* Staff mode (/e/<event>?staff=1): a signed-in staff member makes an order themselves.
     Same photo tools, but no prices or payment, any event status, and it goes straight to the print queue. */
  var STAFF = new URLSearchParams(location.search).get('staff') === '1';
  var DKEY = (STAFF ? 'staff|' : '') + slug;   /* staff and guest drafts on one device stay apart */

  var state = { event: null, items: [], editing: null, nextId: 1, orderId: null, sending: false, busy: false, overlay: null };
  /* Private events can hide prices: the host pays, not the guest. */
  function priceOf(n) { return state.event && state.event.show_prices === false ? null : C.priceFor(n); }
  var sb = null;
  var VIEWS = ['view-loading', 'view-closed', 'view-photos', 'view-name', 'view-check', 'view-done'];

  function show(view, focusId) {
    VIEWS.forEach(function (id) { $(id).hidden = id !== view; });
    $('help-line').hidden = view === 'view-loading';
    window.scrollTo(0, 0);
    if (focusId) { try { $(focusId).focus({ preventScroll: true }); } catch (err) {} }
  }
  function closed(title, msg) {
    $('closed-title').textContent = title;
    $('closed-msg').textContent = msg;
    show('view-closed');
  }
  function total() { return state.items.reduce(function (n, it) { return n + it.qty; }, 0); }
  function remaining() { return state.event.max_magnets - total(); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- reminder of the last order placed on this phone ---------- */
  function storeKey() { return 'sona-last-order-' + slug; }
  function showLastOrder() {
    try {
      var saved = JSON.parse(localStorage.getItem(storeKey()) || 'null');
      if (!saved || Date.now() - saved.at > 12 * 3600 * 1000) return;
      $('last-no').textContent = 'Your order number is ' + saved.no + '.';
      $('last-text').textContent = (state.event && state.event.kind === 'private'
        ? 'Pick your magnets up at the Sona Magnets table before the end of the event, under the name '
        : 'Magnets take 10-15 minutes. Pick them up at the table under the name ') + saved.name + '. You can order more below.';
      $('last-order').hidden = false;
      $('last-pay').hidden = true;
      if (saved.id) track(saved.id, true);
      if (saved.payId) {
        sb.rpc('order_payment', { p_order_id: saved.payId }).then(function (r) {
          var p = r.data && r.data[0];
          if (p && !p.paid && p.pay_status === 'pending' && p.pay_url) { $('last-pay').href = p.pay_url; $('last-pay').hidden = false; }
        }, function () {});
      }
    } catch (err) {}
  }
  /* coming back with the browser's Back button from Square: start fresh so the page is not stuck */
  window.addEventListener('pageshow', function (e) { if (e.persisted) location.reload(); });
  function payOnline() { return !!(state.event && state.event.pay_online && state.event.show_prices !== false); }
  /* asks our server to make a Square checkout page for the order (or check whether it is paid) */
  async function squareCall(action, orderId, tip) {
    var body = { action: action, order_id: orderId };
    if (tip) body.tip = tip;
    var r = await sb.functions.invoke('square', { body: body });
    if (r.error) throw r.error;
    return r.data || {};
  }
  function doneText(count, paid) {
    var ready = state.event.kind === 'private'
      ? 'They will be ready a little later, so please pick them up at the Sona Magnets table before the end of the event. Just tell us your name or order number.'
      : 'They will be ready in 10-15 minutes, so feel free to shop around. Then come back to the table and tell us your name or order number.';
    return (count ? 'We are making ' + plural(count, 'magnet') + ' for you. ' : 'We are making your magnets. ') + ready;
  }
  /* Back from Square: say whether the payment went through. */
  async function returnFromSquare(orderId) {
    try { history.replaceState(null, '', location.pathname); } catch (err) {}
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(storeKey()) || 'null'); } catch (err) {}
    $('done-no').textContent = saved && saved.payId === orderId ? saved.no : '';
    $('done-hello').textContent = 'Checking your payment.';
    $('done-totalbox').hidden = true; $('pay-again').hidden = true; $('done-text').textContent = '';
    show('view-done');
    state.fromSquare = true;
    var name = saved && saved.name ? ', ' + saved.name : '';
    function paid(st) {
      $('done-hello').textContent = 'Paid. Thank you' + name + '!';
      $('done-text').textContent = doneText(saved && saved.count, true) + (st && st.tip > 0 ? ' And thank you so much for the tip!' : '');
      $('pay-again').hidden = true;
      track(orderId);
    }
    async function ask() {
      var st = {};
      try { st = await squareCall('status', orderId); } catch (err) { st = {}; }
      if (st.order_no) $('done-no').textContent = st.order_no;
      return st;
    }
    /* Square usually confirms within a few seconds; give it up to about 20 */
    var st = {};
    for (var i = 0; i < 8; i++) {
      st = await ask();
      if (st.paid) { paid(st); return; }
      await wait(2500);
    }
    $('done-hello').textContent = 'We have not received your payment yet';
    $('done-text').textContent = 'Your photos are saved with us. If you already paid, it can take a minute to show up: keep this page open, or show it at the Sona Magnets table.';
    if (st.url) { $('pay-link').href = st.url; $('pay-again').hidden = false; }
    /* keep checking quietly for a few minutes and switch to "Paid" when it arrives */
    for (var j = 0; j < 36; j++) {
      await wait(5000);
      if (document.hidden) continue;
      st = await ask();
      if (st.paid) { paid(st); return; }
    }
  }

  /* ---------- live order status: in the queue, printing, ready ----------
     The guest's page asks every few seconds while it is open. Staff tap Ready on their side. */
  var tracking = { id: null, timer: null, wasReady: false, since: 0, compact: false };
  function progressText(p) {
    if (p.status === 'done') return { step: 3, line: 'Picked up. Enjoy your magnets!', sub: '' };
    if (p.ready) return { step: 3, line: 'Your magnets are ready!', sub: 'Come to the Sona Magnets table and give us your name or order number ' + p.order_no + '.' };
    if (p.pay_status === 'pending' && !p.paid) return { step: 1, line: 'Waiting for your payment', sub: 'Your magnets start once you have paid.' };
    if (p.printed) return { step: 2, line: 'Your magnets are being made', sub: 'We print, cut and press each one. This page shows Ready when they are done.' };
    var ahead = p.ahead_orders || 0;
    return { step: 1, line: ahead ? (ahead === 1 ? '1 order ahead of yours' : ahead + ' orders ahead of yours') : 'You are next in line',
      sub: 'Keep this page open. It changes to Ready when your magnets are done.' };
  }
  function showProgress(p, compact) {
    var t = progressText(p), ready = p.ready && p.status !== 'done';
    if (compact) {
      $('last-status').hidden = false;
      $('last-status').textContent = t.line;
      $('last-status').className = 'track-line small' + (ready ? ' ready' : '');
    } else {
      $('track').hidden = false;
      $('track').className = 'track' + (ready ? ' is-ready' : '');
      [1, 2, 3].forEach(function (i) { $('tr-' + i).className = i < t.step ? 'on' : i === t.step ? 'now' : ''; });
      $('track-line').textContent = t.line;
      $('track-sub').textContent = t.sub;
    }
    if (ready && !tracking.wasReady) {
      tracking.wasReady = true;
      document.title = 'Ready! | Sona Magnets';
      try { if (navigator.vibrate) navigator.vibrate([200, 100, 200]); } catch (err) {}
    }
  }
  function track(orderId, compact) {
    clearTimeout(tracking.timer);
    var wasReady = tracking.id === orderId && tracking.wasReady;
    tracking = { id: orderId, timer: null, wasReady: wasReady, since: Date.now(), compact: !!compact };
    var mine = tracking;
    async function tick() {
      if (tracking !== mine) return;
      if (!document.hidden) {
        var r = null;
        try { r = await sb.rpc('order_progress', { p_order_id: orderId }); } catch (err) { r = null; }
        if (tracking !== mine) return;
        var p = r && r.data && r.data[0];
        if (p) {
          showProgress(p, mine.compact);
          if (p.status === 'done') return;   /* picked up: nothing more to watch */
        }
      }
      /* every 6 seconds for the first hour, then every 30 seconds, for up to 8 hours */
      var age = Date.now() - mine.since;
      if (age > 8 * 3600 * 1000) return;
      mine.timer = setTimeout(tick, age < 3600 * 1000 ? 6000 : 30000);
    }
    tick();
  }
  /* coming back to the page: check straight away */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && tracking.id) track(tracking.id, tracking.compact);
  });

  /* ---------- an unfinished order is kept on this device ----------
     Photos and every adjustment are written to the browser's own storage as you go, so a closed tab,
     a locked phone or a dead battery does not lose the work. It is cleared once the order is sent. */
  var draft = { db: null, timer: null, ok: false, failed: false, restored: 0, KEEP_MS: 48 * 3600 * 1000 };
  function draftOpen() {
    return new Promise(function (resolve) {
      try {
        if (!window.indexedDB) return resolve(null);
        var req = indexedDB.open('sona-drafts', 1);
        req.onupgradeneeded = function () {
          var db = req.result;
          if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { resolve(null); };
        req.onblocked = function () { resolve(null); };
      } catch (err) { resolve(null); }
    });
  }
  function draftTx(store, mode, work) {
    return new Promise(function (resolve) {
      if (!draft.db) return resolve(null);
      try {
        var tx = draft.db.transaction(store, mode), out = work(tx.objectStore(store));
        tx.oncomplete = function () { resolve({ value: out ? out.result : undefined }); };
        tx.onerror = tx.onabort = function () { resolve(null); };
      } catch (err) { resolve(null); }
    });
  }
  function photoKey(id) { return DKEY + '|' + id; }
  function draftPutPhoto(it) { return draftTx('photos', 'readwrite', function (s) { return s.put(it.blob, photoKey(it.id)); }); }
  function draftDropPhoto(id) { return draftTx('photos', 'readwrite', function (s) { return s.delete(photoKey(id)); }); }
  function draftMeta() {
    return {
      at: Date.now(), nextId: state.nextId, orderId: state.orderId,
      name: $('guest-name').value, contact: $('guest-contact').value, note: $('guest-note').value,
      items: state.items.filter(function (it) { return it.stored; }).map(function (it) {
        return { id: it.id, iw: it.iw, ih: it.ih, small: it.small, fit: !!it.fit, zoom: it.zoom, cx: it.cx, cy: it.cy, fz: it.fz, fx: it.fx, fy: it.fy, qty: it.qty, uploaded: it.uploaded };
      })
    };
  }
  async function draftWrite() {
    clearTimeout(draft.timer); draft.timer = null;
    if (!draft.db || !state.event) return;
    var meta = draftMeta();
    var done = meta.items.length
      ? await draftTx('meta', 'readwrite', function (s) { return s.put(meta, DKEY); })
      : await draftTx('meta', 'readwrite', function (s) { return s.delete(DKEY); });
    draft.ok = !!done && meta.items.length === state.items.length;
    draft.failed = !draft.ok && state.items.length > 0;
    draftNote();
  }
  /* called after anything changes; writes a moment later so dragging does not write on every movement */
  function saveDraft() {
    if (!draft.db) return;
    clearTimeout(draft.timer);
    draft.timer = setTimeout(draftWrite, 350);
  }
  function draftNote() {
    var has = state.items.length > 0, n = $('draft-msg');
    n.hidden = !(has && draft.db);
    $('draft-clear').hidden = !(has && draft.restored);
    if (!has || !draft.db) return;
    n.className = 'note' + (draft.ok ? ' good' : draft.failed ? ' bad' : '');
    n.textContent = draft.ok
      ? (draft.restored ? 'Welcome back. Your ' + plural(draft.restored, 'photo') + ' and adjustments were kept. ' : '') + 'Your progress is saved on this device. If this page closes, open it again and it will all be here.'
      : draft.failed ? 'This device could not save your progress, so please finish and send this order without closing the page.'
      : 'Saving your progress on this device.';
  }
  async function draftClear() {
    clearTimeout(draft.timer); draft.timer = null; draft.restored = 0; draft.ok = false; draft.failed = false;
    if (!draft.db) return;
    await draftTx('meta', 'readwrite', function (s) { return s.delete(DKEY); });
    await draftTx('photos', 'readwrite', function (s) { return s.delete(IDBKeyRange.bound(DKEY + '|', DKEY + '|\uffff')); });
  }
  function draftImage(blob) {
    return new Promise(function (resolve) {
      var img = new Image();
      img.onload = function () { resolve(img.naturalWidth ? img : null); };
      img.onerror = function () { resolve(null); };
      try { img.src = URL.createObjectURL(blob); } catch (err) { resolve(null); }
    });
  }
  async function draftRestore() {
    draft.db = await draftOpen();
    if (!draft.db) return;
    var got = await draftTx('meta', 'readonly', function (s) { return s.get(DKEY); }), meta = got && got.value;
    if (!meta || !meta.items || !meta.items.length) return;
    if (Date.now() - meta.at > draft.KEEP_MS) { await draftClear(); return; }
    var room = state.event.max_magnets;
    for (var i = 0; i < meta.items.length; i++) {
      var m = meta.items[i];
      var kept = await draftTx('photos', 'readonly', function (s) { return s.get(photoKey(m.id)); }), blob = kept && kept.value;
      if (!blob || room < 1) continue;
      var img = await draftImage(blob);
      if (!img) continue;
      var qty = Math.max(1, Math.min(m.qty || 1, room)); room -= qty;
      state.items.push({ id: m.id, img: img, iw: img.naturalWidth, ih: img.naturalHeight, small: !!m.small, blob: blob, stored: true,
        fit: !!m.fit, zoom: m.zoom || 1, cx: m.cx == null ? 0.5 : m.cx, cy: m.cy == null ? 0.5 : m.cy,
        fz: m.fz || 1, fx: m.fx == null ? 0.5 : m.fx, fy: m.fy == null ? 0.5 : m.fy, qty: qty, rev: 0, uploaded: m.uploaded || null });
      C.normalize(state.items[state.items.length - 1]); C.normalizeFit(state.items[state.items.length - 1]);
    }
    if (!state.items.length) { await draftClear(); return; }
    state.nextId = Math.max(meta.nextId || 1, state.items.reduce(function (n, it) { return Math.max(n, it.id + 1); }, 1));
    state.orderId = meta.orderId || null;
    $('guest-name').value = meta.name || ''; $('guest-contact').value = meta.contact || '';
    if (meta.note) { $('guest-note').value = meta.note; $('note-wrap').hidden = false; $('note-open').hidden = true; }
    draft.restored = state.items.length; draft.ok = true;
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden && draft.timer) draftWrite(); });
  window.addEventListener('pagehide', function () { if (draft.timer) draftWrite(); });

  /* ---------- step 1: photos ---------- */
  /* Only a photo that is clearly not square loses anything to the square crop, so only those get the one-tap choice. */
  function notSquare(it) { return Math.max(it.iw, it.ih) / Math.min(it.iw, it.ih) >= 1.1; }
  function fitButton(it, idx, after) {
    var b = el('button', 'btn small', it.fit ? 'Fill the magnet' : 'Fit whole photo'); b.type = 'button';
    b.setAttribute('aria-label', (it.fit ? 'Fill the magnet with photo ' : 'Fit the whole of photo ') + (idx + 1));
    b.addEventListener('click', function () { it.fit = !it.fit; after(); });
    return b;
  }
  function renderPhotos() {
    var ul = $('photos'), left = remaining(), max = state.event.max_magnets, n = total();
    ul.replaceChildren();
    state.items.forEach(function (it, idx) {
      var li = el('li', 'tile');
      var thumb = document.createElement('canvas');
      thumb.width = thumb.height = 240;
      thumb.setAttribute('role', 'img');
      thumb.setAttribute('aria-label', 'Photo ' + (idx + 1));
      C.drawFront(thumb.getContext('2d'), it, state.overlay, 240);
      thumb.addEventListener('click', function () { openEditor(it); });
      li.appendChild(thumb);

      var side = el('div', 'controls');
      var copies = el('div', 'copies');
      copies.appendChild(el('span', null, 'How many?'));
      var qty = el('span', 'qty');
      var minus = el('button', null, '−'); minus.type = 'button'; minus.setAttribute('aria-label', 'One fewer of photo ' + (idx + 1));
      var out;
      if (max > 12) {
        out = document.createElement('input'); out.type = 'number'; out.inputMode = 'numeric'; out.min = 1; out.max = Math.min(100, it.qty + left); out.value = it.qty;
        out.className = 'qtynum'; out.setAttribute('aria-label', 'How many of photo ' + (idx + 1));
        out.addEventListener('change', function () {
          var others = total() - it.qty, v = Math.round(Number(out.value) || 1);
          it.qty = Math.min(Math.max(1, v), Math.max(1, state.event.max_magnets - others), 100);
          renderPhotos();
        });
      } else { out = el('output', null, String(it.qty)); }
      var plus = el('button', null, '+'); plus.type = 'button'; plus.setAttribute('aria-label', 'One more of photo ' + (idx + 1));
      minus.disabled = it.qty <= 1; plus.disabled = left <= 0 || it.qty >= 100;
      minus.addEventListener('click', function () { if (it.qty > 1) { it.qty--; renderPhotos(); } });
      plus.addEventListener('click', function () { if (remaining() > 0 && it.qty < 100) { it.qty++; renderPhotos(); } });
      qty.appendChild(minus); qty.appendChild(out); qty.appendChild(plus);
      copies.appendChild(qty);
      side.appendChild(copies);
      var row = el('div', 'row');
      var adjust = el('button', 'btn small', 'Adjust photo'); adjust.type = 'button';
      adjust.addEventListener('click', function () { openEditor(it); });
      row.appendChild(adjust);
      if (notSquare(it)) row.appendChild(fitButton(it, idx, renderPhotos));
      var remove = el('button', 'btn small', 'Remove'); remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove photo ' + (idx + 1));
      remove.addEventListener('click', function () { state.items = state.items.filter(function (x) { return x !== it; }); draftDropPhoto(it.id); note('photo-msg', ''); renderPhotos(); });
      row.appendChild(remove);
      side.appendChild(row);
      if (it.small) side.appendChild(el('p', 'tip', 'This photo is small, so it may print a little blurry.'));
      li.appendChild(side);
      ul.appendChild(li);
    });

    $('photo-help').textContent = state.items.length
      ? 'Each photo becomes one square magnet. Happy with them? Tap Next.'
      : 'Each photo becomes one square magnet. You can choose up to ' + max + '. Tap the yellow button to pick photos from your phone.';
    var cost = priceOf(n);
    $('counter').textContent = plural(n, 'magnet');
    $('tally-price').textContent = cost != null ? C.money(cost) : '';
    $('price-list').textContent = state.event.show_prices === false ? '' : C.packs(max).map(function (t) { return t.qty + ' for ' + C.money(t.price); }).join('  \u00b7  ');
    var priced = state.event.show_prices !== false;
    var hint = priced ? packHint(n, max) : '', more = hint || !priced ? null : C.oneMore(n, max);
    if (more) hint = 'Add 1 more magnet for only ' + C.money(more.extra) + ' more. ' + more.qty + ' magnets are ' + C.money(more.price) + '.';
    $('deal').hidden = !hint;
    $('deal').textContent = hint; $('deal').className = 'deal';
    var add = $('add-label');
    add.textContent = state.items.length ? 'Add another photo' : 'Choose photos';
    add.className = 'btn wide ' + (state.items.length ? '' : 'primary big');
    add.classList.toggle('disabled', left <= 0);
    $('file-input').disabled = left <= 0;
    if (left <= 0 && state.items.length) add.textContent = 'That is the most for one order';
    $('photos-bar').hidden = !state.items.length;
    draftNote(); saveDraft();
  }
  /* Magnets are sold in packs. When the count is in between, say exactly what to do. */
  function listSizes(sizes) {
    return sizes.length < 2 ? sizes.join('') : sizes.slice(0, -1).join(', ') + ' or ' + sizes[sizes.length - 1];
  }
  function packHint(n, max) {
    if (!n || priceOf(n) != null) return '';
    var near = C.nearestPacks(n, max), ways = [];
    if (near.up) ways.push('add ' + (near.up - n) + ' more for a pack of ' + near.up + ' (' + C.money(C.priceFor(near.up)) + ')');
    if (near.down) ways.push('remove ' + (n - near.down) + ' for a pack of ' + near.down + ' (' + C.money(C.priceFor(near.down)) + ')');
    return 'Magnets come in packs of ' + listSizes(C.packSizes(max)) + '. You have ' + n + ', so ' + ways.join(', or ') + '. You can use the same photo more than once with the + button.';
  }
  function note(id, text, kind) { var n = $(id); n.textContent = text || ''; n.className = 'note' + (kind ? ' ' + kind : ''); }

  async function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length || state.busy) return;
    state.busy = true;
    var room = remaining(), failed = 0, skipped = 0;
    for (var i = 0; i < files.length; i++) {
      if (room <= 0) { skipped++; continue; }
      note('photo-msg', 'Opening photo ' + (i + 1) + ' of ' + files.length + '. One moment.');
      var photo = await C.loadPhoto(files[i]);
      if (photo) {
        var added = { id: state.nextId++, img: photo.img, iw: photo.iw, ih: photo.ih, small: photo.small, blob: photo.blob, fit: false, zoom: 1, cx: 0.5, cy: 0.5, fz: 1, fx: 0.5, fy: 0.5, qty: 1, rev: 0, uploaded: null };
        state.items.push(added);
        added.stored = !!(await draftPutPhoto(added));
        room--;
        renderPhotos();
      } else { failed++; }
    }
    var notes = [];
    if (failed) notes.push((failed === 1 ? 'One photo' : failed + ' photos') + ' could not be opened. Please try a different photo, or ask us at the table.');
    if (skipped) notes.push('One order holds ' + plural(state.event.max_magnets, 'magnet') + ', so ' + (skipped === 1 ? 'one photo was' : skipped + ' photos were') + ' left out.');
    note('photo-msg', notes.join(' '), notes.length ? 'bad' : '');
    state.busy = false;
    renderPhotos();
  }

  /* ---------- adjust one photo ---------- */
  var editor = C.attachEditor($('editor-canvas'), function () { return state.editing; }, function () { syncZoom(); saveDraft(); }, function () { return state.overlay; });
  /* Fill crops the photo to the square. Fit keeps the whole photo and puts white around it. */
  function syncMode() {
    var it = state.editing; if (!it) return;
    $('mode-fill').setAttribute('aria-pressed', String(!it.fit));
    $('mode-fit').setAttribute('aria-pressed', String(!!it.fit));
    /* a fitted photo zooms too, as far as the point where its white bars are gone */
    $('zoom-tools').hidden = !!it.fit && C.fitMax(it) < 1.03;
    $('zoom').max = C.zoomMax(it);
    syncHelp();
  }
  function syncHelp() {
    var it = state.editing; if (!it) return;
    $('ed-help').textContent = !it.fit ? 'Drag the photo with your finger to move it.'
      : C.getZoom(it) <= 1.005 ? 'Your whole photo is on the magnet with white filling the rest. Nothing is cut off. Zoom in a little to shrink the white.'
      : 'Zoomed in: the white is smaller and a little is trimmed off the ends. Drag to choose which part shows.';
  }
  function setMode(fit) {
    var it = state.editing; if (!it) return;
    it.fit = fit; editor.draw(); syncMode(); syncZoom(); saveDraft();
  }
  $('mode-fill').addEventListener('click', function () { setMode(false); });
  $('mode-fit').addEventListener('click', function () { setMode(true); });
  function syncZoom() {
    var it = state.editing; if (!it) return;
    var z = C.getZoom(it), max = C.zoomMax(it);
    $('zoom-out').disabled = z <= 1.001;
    $('zoom-in').disabled = z >= max - 0.001;
    $('zoom').max = max; $('zoom').value = z;
    syncHelp();
  }
  /* dir is +1 or -1. A fitted photo has a short zoom range, so it moves in quarters of that range. */
  function zoomBy(dir) {
    var it = state.editing; if (!it) return;
    var step = it.fit ? Math.max(0.02, (C.zoomMax(it) - 1) / 4) : 0.25;
    C.setZoom(it, Math.round((C.getZoom(it) + dir * step) * 100) / 100);
    editor.draw(); syncZoom(); saveDraft();
  }
  function openEditor(it) {
    state.editing = it;
    $('editor').hidden = false;
    editor.draw(); syncMode(); syncZoom();
    try { $('editor-done').focus({ preventScroll: true }); } catch (err) {}
  }
  function closeEditor() {
    state.editing = null; $('editor').hidden = true; renderPhotos();
    if (state.returnToCheck) { state.returnToCheck = false; goCheck(); }
  }
  $('zoom').addEventListener('input', function () {
    var it = state.editing; if (!it) return;
    C.setZoom(it, parseFloat(this.value) || 1);
    editor.draw(); saveDraft();
    var z = C.getZoom(it);
    $('zoom-out').disabled = z <= 1.001; $('zoom-in').disabled = z >= C.zoomMax(it) - 0.001;
    syncHelp();
  });
  $('zoom-in').addEventListener('click', function () { zoomBy(1); });
  $('zoom-out').addEventListener('click', function () { zoomBy(-1); });
  $('editor-done').addEventListener('click', closeEditor);
  $('editor').addEventListener('click', function (e) { if (e.target === this) closeEditor(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.editing) closeEditor(); });

  /* ---------- step 2: name ---------- */
  function goName() {
    if (!state.items.length) return;
    var hint = state.event.show_prices === false ? '' : packHint(total(), state.event.max_magnets);
    if (hint) {
      $('deal').hidden = false; $('deal').textContent = hint; $('deal').className = 'deal stop';
      try { $('deal').scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (err) {}
      return;
    }
    note('form-msg', '');
    var n = total(), cost = priceOf(n);
    $('name-count').textContent = 'Your order: ' + plural(n, 'magnet');
    $('name-total').textContent = cost != null ? C.money(cost) : '';
    show('view-name', 'guest-name');
  }

  /* ---------- step 3: one last look ---------- */
  function goCheck(e) {
    if (e) e.preventDefault();
    saveDraft();
    var name = $('guest-name').value.trim();
    if (!name) { note('form-msg', 'Please type your name so we know who to call.', 'bad'); $('guest-name').focus(); return; }
    if (!state.items.length || (state.event.show_prices !== false && packHint(total(), state.event.max_magnets))) { show('view-photos', 'photos-title'); renderPhotos(); return; }
    var ul = $('proofs'), n = total(), cost = priceOf(n), ratio = CFG.crop.photo / CFG.crop.face;
    ul.replaceChildren();
    state.items.forEach(function (it, idx) {
      var li = el('li', 'proof');
      var cv = document.createElement('canvas'), px = 360, full = px * ratio;
      cv.width = cv.height = px;
      cv.setAttribute('role', 'img');
      cv.setAttribute('aria-label', 'Magnet ' + (idx + 1) + ' as it will be made');
      var g = cv.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, px, px);
      g.imageSmoothingQuality = 'high';
      /* show only the front of the magnet, the same as every other picture on screen */
      C.drawCrop(g, it, (px - full) / 2, (px - full) / 2, full);
      C.drawOverlay(g, state.overlay, (px - full) / 2, (px - full) / 2, full);
      /* tapping the picture adjusts it, the same as the Adjust button under it */
      var pic = el('button', 'proofpic'); pic.type = 'button';
      pic.setAttribute('aria-label', 'Adjust magnet ' + (idx + 1));
      pic.appendChild(cv);
      pic.addEventListener('click', function () { state.returnToCheck = true; openEditor(it); });
      li.appendChild(pic);
      li.appendChild(el('p', null, it.qty === 1 ? '1 magnet' : it.qty + ' magnets of this photo'));
      var fix = el('button', 'btn small', 'Adjust'); fix.type = 'button';
      fix.addEventListener('click', function () { state.returnToCheck = true; openEditor(it); });
      li.appendChild(fix);
      if (notSquare(it)) li.appendChild(fitButton(it, idx, goCheck));
      ul.appendChild(li);
    });
    $('summary').textContent = plural(n, 'magnet') + ' for ' + name;
    $('check-total').textContent = cost != null ? 'Total ' + C.money(cost) : '';
    $('check-pay').hidden = cost == null;
    var online = payOnline() && cost != null;
    $('check-pay').textContent = online ? 'You pay on the next screen.' : 'You pay at the table.';
    $('pay-methods').hidden = !online;
    /* a single magnet gets a simple $1 / $2 / $3 tip choice here; bigger orders see Square's own tip choice */
    var pickTip = online && !STAFF && state.event.tips && n === 1;
    state.check = { cost: cost, online: online, pickTip: pickTip };
    if (!pickTip) { state.tip = 0; state.tipChosen = false; }
    $('tip-box').hidden = !pickTip;
    $('tip-note').hidden = !(online && state.event.tips) || pickTip;
    showTip();
    note('check-msg', '');
    show('view-check', 'check-title');
  }
  /* The whole photo goes up (scaled to a sensible size) along with how it was framed,
     so staff can re-frame it later if the crop turns out wrong. */
  function renderBlob(it) {
    if (it.blob) return Promise.resolve(it.blob);
    return new Promise(function (resolve) {
      var k = Math.min(1, CFG.uploadPx / Math.max(it.iw, it.ih)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(it.iw * k)); c.height = Math.max(1, Math.round(it.ih * k));
      var g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.imageSmoothingQuality = 'high';
      g.drawImage(it.img, 0, 0, c.width, c.height);
      c.toBlob(function (b) { resolve(b); }, 'image/jpeg', 0.88);
    });
  }
  function friendly(err) {
    var m = String((err && err.message) || err || '');
    if (m.indexOf('EVENT_CLOSED') >= 0) return 'This event just stopped taking orders. Please ask us at the Sona Magnets table.';
    if (m.indexOf('TOO_MANY') >= 0 || m.indexOf('BAD_PHOTOS') >= 0) return 'That is more magnets than one order allows. Go back, remove a photo, and try again.';
    if (m.indexOf('BAD_NAME') >= 0) return 'Please type your name.';
    if (m.indexOf('NOT_STAFF') >= 0 || m.indexOf('JWT') >= 0) return 'You are not signed in any more. Sign in on the staff page in this browser, then come back and press the button again. Your photos are kept.';
    return 'Your order did not go through, most likely because of a weak signal. Tap the yellow button to try again, or ask us at the table.';
  }
  function progress(text, done, of) {
    $('sending-text').textContent = text;
    $('sending-bar').style.width = Math.round(100 * done / of) + '%';
  }
  async function uploadOne(it, path) {
    var blob = await renderBlob(it), last = null;
    if (!blob) throw new Error('RENDER');
    for (var attempt = 0; attempt < 3; attempt++) {
      var up = await sb.storage.from('uploads').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (!up.error) return;
      /* "already exists" means an earlier try got through after all */
      if (/exist|duplicate/i.test(String(up.error.message || '')) || up.error.statusCode === '409') return;
      last = up.error;
      await wait(1200 * (attempt + 1));
    }
    throw last;
  }
  function showTip() {
    var c = state.check || {}, tip = c.pickTip ? (state.tip || 0) : 0;
    Array.prototype.forEach.call(document.querySelectorAll('#tip-box [data-tip]'), function (b) {
      b.setAttribute('aria-pressed', String(!!state.tipChosen && Number(b.getAttribute('data-tip')) === tip));
    });
    if (c.cost != null) $('check-total').textContent = 'Total ' + C.money(c.cost + tip) + (tip ? ' with a ' + C.money(tip) + ' tip' : '');
    $('submit').textContent = STAFF ? 'Add to the print queue' : c.online ? 'Pay ' + C.money(c.cost + tip) + ' and make my magnets' : 'Yes, make my magnets';
  }
  Array.prototype.forEach.call(document.querySelectorAll('#tip-box [data-tip]'), function (b) {
    b.addEventListener('click', function () { state.tip = Number(b.getAttribute('data-tip')) || 0; state.tipChosen = true; showTip(); });
  });
  async function send(e) {
    if (e && e.preventDefault) e.preventDefault();
    if (state.sending) return;
    var name = $('guest-name').value.trim();
    if (!name) { show('view-name', 'guest-name'); return; }
    if (!state.items.length) { show('view-photos', 'photos-title'); return; }
    state.sending = true;
    $('submit').disabled = true; note('check-msg', '');
    var steps = state.items.length + 1;
    progress('Getting started.', 0, steps);
    $('sending').hidden = false;
    try {
      if (!state.orderId) state.orderId = C.uuid();
      for (var i = 0; i < state.items.length; i++) {
        var it = state.items[i];
        progress('Sending photo ' + (i + 1) + ' of ' + state.items.length + '.', i, steps);
        if (it.uploaded) continue;
        var path = state.event.id + '/' + state.orderId + '/' + it.id + '.jpg';
        await uploadOne(it, path);
        it.uploaded = path;
        saveDraft();
      }
      progress('Almost done.', state.items.length, steps);
      var res = null;
      for (var attempt = 0; attempt < 3; attempt++) {
        var photos = state.items.map(function (x) { return { path: x.uploaded, qty: x.qty, zoom: x.zoom, cx: x.cx, cy: x.cy, fit: !!x.fit, fit_zoom: x.fz || 1, fit_x: x.fx == null ? 0.5 : x.fx, fit_y: x.fy == null ? 0.5 : x.fy }; });
        res = STAFF
          ? await sb.rpc('staff_submit_order', { p_event_id: state.event.id, p_order_id: state.orderId, p_name: name, p_photos: photos, p_note: $('guest-note').value.trim() })
          : await sb.rpc('submit_order', {
              p_slug: slug, p_order_id: state.orderId, p_name: name,
              p_contact: $('guest-contact').value.trim(), p_photos: photos, p_note: $('guest-note').value.trim()
            });
        if (!res.error || /EVENT_CLOSED|TOO_MANY|BAD_|NOT_STAFF/.test(String(res.error.message || ''))) break;
        await wait(1200 * (attempt + 1));
      }
      if (res.error) throw res.error;
      var count = total(), orderId = state.orderId, tip = state.check && state.check.pickTip ? (state.tip || 0) : 0;
      $('done-hello').textContent = 'You are all set, ' + name + '!';
      $('done-no').textContent = res.data;
      var cost = priceOf(count);
      $('done-total').textContent = cost != null ? C.money(cost) : '';
      $('done-totalbox').hidden = cost == null;
      $('done-pay').textContent = 'Please pay at the table.';
      $('pay-again').hidden = true;
      $('done-text').textContent = doneText(count);
      var online = payOnline() && cost != null;
      /* online payment may have been switched on after this page opened: the server knows for sure */
      if (!online && !STAFF && cost != null) {
        try {
          var ps = await sb.rpc('order_payment', { p_order_id: orderId });
          if (ps.data && ps.data[0] && ps.data[0].pay_status === 'pending') online = true;
        } catch (err) {}
      }
      if (!STAFF) try { localStorage.setItem(storeKey(), JSON.stringify({ no: res.data, id: orderId, name: name, count: count, at: Date.now(), payId: online ? orderId : null })); } catch (err) {}
      if (!STAFF && !online) track(orderId);
      if (STAFF) {
        $('done-hello').textContent = 'Added to the print queue';
        $('done-text').textContent = plural(count, 'magnet') + ' for "' + name + '". It is on the staff page now, ready to print with everything else.';
      }
      state.items = []; state.orderId = null; state.tip = 0; state.tipChosen = false;
      await draftClear();
      if (online) {
        /* the order is in; now off to Square's secure page to pay, which comes back here afterwards */
        progress('Opening the payment page.', steps, steps);
        try {
          var pay = await squareCall('create', orderId, tip);
          if (pay.url) { location.href = pay.url; return; }
        } catch (err) {}
        $('done-pay').textContent = 'The payment page did not open, so please pay at the table.';
        track(orderId);
      }
      $('last-order').hidden = true;
      $('sending').hidden = true;
      show('view-done');
    } catch (err) {
      $('sending').hidden = true;
      note('check-msg', friendly(err), 'bad');
    }
    state.sending = false; $('submit').disabled = false;
  }

  /* ---------- start ---------- */
  $('order-form').addEventListener('submit', goCheck);
  $('submit').addEventListener('click', send);
  $('check-back').addEventListener('click', function () { show('view-photos', 'photos-title'); });
  $('file-input').addEventListener('change', function () { addFiles(this.files); this.value = ''; });
  $('to-name').addEventListener('click', goName);
  $('guest-name').addEventListener('input', function () { note('form-msg', ''); saveDraft(); });
  $('guest-contact').addEventListener('input', saveDraft);
  $('guest-note').addEventListener('input', saveDraft);
  $('draft-clear').addEventListener('click', async function () {
    state.items = []; state.orderId = null; state.nextId = 1;
    $('guest-name').value = ''; $('guest-contact').value = ''; $('guest-note').value = '';
    await draftClear();
    note('photo-msg', ''); renderPhotos();
  });
  $('note-open').addEventListener('click', function () { this.hidden = true; $('note-wrap').hidden = false; $('guest-note').focus(); });
  $('back-photos').addEventListener('click', function () { show('view-photos', 'photos-title'); });
  $('again').addEventListener('click', function () {
    /* after coming back from Square the page skipped its usual set-up, so start it fresh */
    if (state.fromSquare) { location.assign(location.pathname); return; }
    $('track').hidden = true;
    $('guest-name').value = ''; $('guest-note').value = ''; $('note-wrap').hidden = true; $('note-open').hidden = false; renderPhotos(); showLastOrder(); show('view-photos', 'photos-title'); });

  (async function start() {
    if (!window.supabase || !slug) {
      $('event-name').textContent = 'Sona Magnets';
      closed('This link is not working', slug ? 'The page could not load. Please check your signal, then close this page and scan the code again.' : 'Scan the QR code at the Sona Magnets table to place an order.');
      return;
    }
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: STAFF, autoRefreshToken: STAFF, detectSessionInUrl: false } });
    if (STAFF) { await startStaff(); return; }
    var res = null;
    for (var attempt = 0; attempt < 3; attempt++) {
      res = await sb.rpc('get_event', { p_slug: slug });
      if (!res.error) break;
      await wait(1000 * (attempt + 1));
    }
    var ev = res.data && res.data[0];
    if (res.error) { $('event-name').textContent = 'Sona Magnets'; closed('The page could not load', 'Please check your signal, then close this page and scan the code again.'); return; }
    if (!ev) { $('event-name').textContent = 'Sona Magnets'; closed('Event not found', 'This order link is not active. Please ask us at the Sona Magnets table for the current QR code.'); return; }
    state.event = ev;
    document.title = ev.name + ' | Sona Magnets';
    $('event-name').textContent = ev.name;
    $('welcome').textContent = ev.welcome || (ev.kind === 'private' ? 'Your photos, made into magnets. Pick them up before the end of the event.' : 'Your photos, made into magnets in 10-15 minutes while you shop around.');
    var back = new URLSearchParams(location.search).get('paid');
    if (back && /^[0-9a-f-]{36}$/i.test(back)) { returnFromSquare(back); return; }
    if (ev.status !== 'live') { closed('Orders are closed', 'This event is not taking photo orders right now. Please ask us at the Sona Magnets table.'); return; }
    $('contact-wrap').hidden = !ev.ask_contact;
    if (ev.overlay_path) {
      var pic = await C.loadOverlayImage(C.overlayUrl(ev.overlay_path));
      if (pic) state.overlay = { img: pic.img, iw: pic.iw, ih: pic.ih, scale: Number(ev.overlay_scale) || 1, cx: ev.overlay_x == null ? 0.5 : Number(ev.overlay_x), cy: ev.overlay_y == null ? 0.5 : Number(ev.overlay_y) };
    }
    await draftRestore();
    renderPhotos();
    showLastOrder();
    show('view-photos');
  })();

  async function startStaff() {
    document.body.classList.add('staffmode');
    var who = await sb.auth.getSession().catch(function () { return null; });
    if (!who || !who.data || !who.data.session) {
      closed('Sign in first', 'Open the staff page in this browser and sign in, then press Add an order yourself again.');
      $('event-name').textContent = 'Sona Magnets staff';
      return;
    }
    var r = await sb.from('events').select('*').eq('slug', slug).maybeSingle();
    if (r.error || !r.data) { closed('Event not found', 'Go back to the staff page and open the event again.'); return; }
    var ev = r.data;
    /* no prices, no payment, no per-order limit for our own orders */
    ev.show_prices = false; ev.pay_online = false; ev.max_magnets = 500; ev.ask_contact = false;
    state.event = ev;
    document.title = 'Staff order | ' + ev.name;
    $('event-name').textContent = 'Staff order: ' + ev.name;
    $('welcome').textContent = 'Your own order. No payment and no limit. When you add it, it goes straight to the print queue for this event.';
    $('name-title').textContent = 'Name for this order';
    $('guest-name').placeholder = 'For example: Sona samples or Taylor (texted photos)';
    $('guest-name').setAttribute('autocomplete', 'off');
    $('help-line').textContent = '';
    var back = el('a', 'btn small', 'Back to the staff page'); back.href = '/admin';
    $('again').parentNode.insertBefore(back, $('again').nextSibling);
    $('again').textContent = 'Make another order';
    if (ev.overlay_path) {
      var pic = await C.loadOverlayImage(C.overlayUrl(ev.overlay_path));
      if (pic) state.overlay = { img: pic.img, iw: pic.iw, ih: pic.ih, scale: Number(ev.overlay_scale) || 1, cx: ev.overlay_x == null ? 0.5 : Number(ev.overlay_x), cy: ev.overlay_y == null ? 0.5 : Number(ev.overlay_y) };
    }
    await draftRestore();
    renderPhotos();
    show('view-photos');
  }
})();
