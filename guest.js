/* Guest order page. Two steps: choose photos, then give a name and send. */
(function () {
  'use strict';
  var C = window.SonaCommon, CFG = window.SONA;
  var $ = function (id) { return document.getElementById(id); };
  var parts = location.pathname.split('/').filter(Boolean);
  var slug = (parts[0] === 'e' && parts[1]) ? decodeURIComponent(parts[1]) : (new URLSearchParams(location.search).get('e') || '');
  slug = slug.toLowerCase();

  var state = { event: null, items: [], editing: null, nextId: 1, orderId: null, sending: false, busy: false };
  var sb = null;
  var VIEWS = ['view-loading', 'view-closed', 'view-photos', 'view-name', 'view-done'];

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
      $('last-text').textContent = 'We will call ' + saved.name + ' when it is ready. You can order more below.';
      $('last-order').hidden = false;
    } catch (err) {}
  }

  /* ---------- step 1: photos ---------- */
  function renderPhotos() {
    var ul = $('photos'), left = remaining(), max = state.event.max_magnets, n = total();
    ul.replaceChildren();
    state.items.forEach(function (it, idx) {
      var li = el('li', 'tile');
      var thumb = document.createElement('canvas');
      thumb.width = thumb.height = 240;
      thumb.setAttribute('role', 'img');
      thumb.setAttribute('aria-label', 'Photo ' + (idx + 1));
      C.drawCrop(thumb.getContext('2d'), it, 0, 0, 240);
      thumb.addEventListener('click', function () { openEditor(it); });
      li.appendChild(thumb);

      var side = el('div', 'controls');
      var copies = el('div', 'copies');
      copies.appendChild(el('span', null, 'How many?'));
      var qty = el('span', 'qty');
      var minus = el('button', null, '−'); minus.type = 'button'; minus.setAttribute('aria-label', 'One fewer of photo ' + (idx + 1));
      var out = el('output', null, String(it.qty));
      var plus = el('button', null, '+'); plus.type = 'button'; plus.setAttribute('aria-label', 'One more of photo ' + (idx + 1));
      minus.disabled = it.qty <= 1; plus.disabled = left <= 0;
      minus.addEventListener('click', function () { if (it.qty > 1) { it.qty--; renderPhotos(); } });
      plus.addEventListener('click', function () { if (remaining() > 0) { it.qty++; renderPhotos(); } });
      qty.appendChild(minus); qty.appendChild(out); qty.appendChild(plus);
      copies.appendChild(qty);
      side.appendChild(copies);
      var row = el('div', 'row');
      var adjust = el('button', 'btn small', 'Adjust photo'); adjust.type = 'button';
      adjust.addEventListener('click', function () { openEditor(it); });
      row.appendChild(adjust);
      var remove = el('button', 'btn small', 'Remove'); remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove photo ' + (idx + 1));
      remove.addEventListener('click', function () { state.items = state.items.filter(function (x) { return x !== it; }); note('photo-msg', ''); renderPhotos(); });
      row.appendChild(remove);
      side.appendChild(row);
      if (it.small) side.appendChild(el('p', 'tip', 'This photo is small, so it may print a little blurry.'));
      li.appendChild(side);
      ul.appendChild(li);
    });

    $('photo-help').textContent = state.items.length
      ? 'Each photo becomes one square magnet. Happy with them? Tap Next.'
      : 'Each photo becomes one square magnet. You can choose up to ' + max + '. Tap the yellow button to pick photos from your phone.';
    $('counter').textContent = plural(n, 'magnet') + ' of ' + max;
    var add = $('add-label');
    add.textContent = state.items.length ? 'Add another photo' : 'Choose photos';
    add.className = 'btn wide ' + (state.items.length ? '' : 'primary big');
    add.classList.toggle('disabled', left <= 0);
    $('file-input').disabled = left <= 0;
    if (left <= 0 && state.items.length) add.textContent = 'That is the most for one order';
    $('photos-bar').hidden = !state.items.length;
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
        state.items.push({ id: state.nextId++, img: photo.img, iw: photo.iw, ih: photo.ih, small: photo.small, zoom: 1, cx: 0.5, cy: 0.5, qty: 1, rev: 0, uploaded: null });
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
  var editor = C.attachEditor($('editor-canvas'), function () { return state.editing; }, function (it) { it.rev++; it.uploaded = null; syncZoom(); });
  function syncZoom() {
    var it = state.editing; if (!it) return;
    $('zoom-out').disabled = it.zoom <= 1.001;
    $('zoom-in').disabled = it.zoom >= 2.999;
  }
  function zoomBy(step) {
    var it = state.editing; if (!it) return;
    it.zoom = C.clamp(Math.round((it.zoom + step) * 100) / 100, 1, 3);
    C.normalize(it); it.rev++; it.uploaded = null; editor.draw(); syncZoom();
  }
  function openEditor(it) {
    state.editing = it;
    $('editor').hidden = false;
    editor.draw(); syncZoom();
    try { $('editor-done').focus({ preventScroll: true }); } catch (err) {}
  }
  function closeEditor() { state.editing = null; $('editor').hidden = true; renderPhotos(); }
  $('zoom-in').addEventListener('click', function () { zoomBy(0.25); });
  $('zoom-out').addEventListener('click', function () { zoomBy(-0.25); });
  $('editor-done').addEventListener('click', closeEditor);
  $('editor').addEventListener('click', function (e) { if (e.target === this) closeEditor(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.editing) closeEditor(); });

  /* ---------- step 2: name and send ---------- */
  function goName() {
    if (!state.items.length) return;
    var n = total();
    $('summary').textContent = 'You are ordering ' + plural(n, 'magnet') + '.';
    note('form-msg', '');
    show('view-name', 'guest-name');
  }
  function renderBlob(it) {
    return new Promise(function (resolve) {
      var n = CFG.uploadPx, c = document.createElement('canvas');
      c.width = c.height = n;
      var g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, n, n);
      g.imageSmoothingQuality = 'high';
      C.drawCrop(g, it, 0, 0, n);
      c.toBlob(function (b) { resolve(b); }, 'image/jpeg', 0.9);
    });
  }
  function friendly(err) {
    var m = String((err && err.message) || err || '');
    if (m.indexOf('EVENT_CLOSED') >= 0) return 'This event just stopped taking orders. Please ask us at the Sona Magnets table.';
    if (m.indexOf('TOO_MANY') >= 0 || m.indexOf('BAD_PHOTOS') >= 0) return 'That is more magnets than one order allows. Go back, remove a photo, and try again.';
    if (m.indexOf('BAD_NAME') >= 0) return 'Please type your name.';
    return 'Your order did not go through, most likely because of a weak signal. Tap Send my order to try again, or ask us at the table.';
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
  async function send(e) {
    e.preventDefault();
    if (state.sending) return;
    var name = $('guest-name').value.trim();
    if (!name) { note('form-msg', 'Please type your name so we know who to call.', 'bad'); $('guest-name').focus(); return; }
    if (!state.items.length) { show('view-photos', 'photos-title'); return; }
    state.sending = true;
    $('submit').disabled = true; note('form-msg', '');
    var steps = state.items.length + 1;
    progress('Getting started.', 0, steps);
    $('sending').hidden = false;
    try {
      if (!state.orderId) state.orderId = C.uuid();
      for (var i = 0; i < state.items.length; i++) {
        var it = state.items[i];
        progress('Sending photo ' + (i + 1) + ' of ' + state.items.length + '.', i, steps);
        if (it.uploaded) continue;
        var path = state.event.id + '/' + state.orderId + '/' + it.id + '-' + it.rev + '.jpg';
        await uploadOne(it, path);
        it.uploaded = path;
      }
      progress('Almost done.', state.items.length, steps);
      var res = null;
      for (var attempt = 0; attempt < 3; attempt++) {
        res = await sb.rpc('submit_order', {
          p_slug: slug, p_order_id: state.orderId, p_name: name,
          p_contact: $('guest-contact').value.trim(),
          p_photos: state.items.map(function (x) { return { path: x.uploaded, qty: x.qty }; })
        });
        if (!res.error || /EVENT_CLOSED|TOO_MANY|BAD_/.test(String(res.error.message || ''))) break;
        await wait(1200 * (attempt + 1));
      }
      if (res.error) throw res.error;
      var count = total();
      $('done-hello').textContent = 'You are all set, ' + name + '!';
      $('done-no').textContent = res.data;
      $('done-text').textContent = 'We are making ' + plural(count, 'magnet') + ' for you. Listen for your name at the table.';
      try { localStorage.setItem(storeKey(), JSON.stringify({ no: res.data, name: name, at: Date.now() })); } catch (err) {}
      state.items = []; state.orderId = null;
      $('last-order').hidden = true;
      $('sending').hidden = true;
      show('view-done');
    } catch (err) {
      $('sending').hidden = true;
      note('form-msg', friendly(err), 'bad');
    }
    state.sending = false; $('submit').disabled = false;
  }

  /* ---------- start ---------- */
  $('order-form').addEventListener('submit', send);
  $('file-input').addEventListener('change', function () { addFiles(this.files); this.value = ''; });
  $('to-name').addEventListener('click', goName);
  $('guest-name').addEventListener('input', function () { note('form-msg', ''); });
  $('back-photos').addEventListener('click', function () { show('view-photos', 'photos-title'); });
  $('again').addEventListener('click', function () { $('guest-name').value = ''; renderPhotos(); showLastOrder(); show('view-photos', 'photos-title'); });

  (async function start() {
    if (!window.supabase || !slug) {
      $('event-name').textContent = 'Sona Magnets';
      closed('This link is not working', slug ? 'The page could not load. Please check your signal, then close this page and scan the code again.' : 'Scan the QR code at the Sona Magnets table to place an order.');
      return;
    }
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
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
    $('welcome').textContent = ev.welcome || 'Turn your favourite photos into magnets.';
    if (ev.status !== 'live') { closed('Orders are closed', 'This event is not taking photo orders right now. Please ask us at the Sona Magnets table.'); return; }
    $('contact-wrap').hidden = !ev.ask_contact;
    renderPhotos();
    showLastOrder();
    show('view-photos');
  })();
})();
