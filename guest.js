/* Guest order page. Two steps: choose photos, then give a name and send. */
(function () {
  'use strict';
  var C = window.SonaCommon, CFG = window.SONA;
  var $ = function (id) { return document.getElementById(id); };
  var parts = location.pathname.split('/').filter(Boolean);
  var slug = (parts[0] === 'e' && parts[1]) ? decodeURIComponent(parts[1]) : (new URLSearchParams(location.search).get('e') || '');
  slug = slug.toLowerCase();

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
    } catch (err) {}
  }

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
      C.drawCrop(thumb.getContext('2d'), it, 0, 0, 240);
      C.drawOverlay(thumb.getContext('2d'), state.overlay, 0, 0, 240);
      thumb.addEventListener('click', function () { openEditor(it); });
      li.appendChild(thumb);

      var side = el('div', 'controls');
      var copies = el('div', 'copies');
      copies.appendChild(el('span', null, 'How many?'));
      var qty = el('span', 'qty');
      var minus = el('button', null, '−'); minus.type = 'button'; minus.setAttribute('aria-label', 'One fewer of photo ' + (idx + 1));
      var out;
      if (max > 12) {
        out = document.createElement('input'); out.type = 'number'; out.inputMode = 'numeric'; out.min = 1; out.max = it.qty + left; out.value = it.qty;
        out.className = 'qtynum'; out.setAttribute('aria-label', 'How many of photo ' + (idx + 1));
        out.addEventListener('change', function () {
          var others = total() - it.qty, v = Math.round(Number(out.value) || 1);
          it.qty = Math.min(Math.max(1, v), Math.max(1, state.event.max_magnets - others));
          renderPhotos();
        });
      } else { out = el('output', null, String(it.qty)); }
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
      if (notSquare(it)) row.appendChild(fitButton(it, idx, renderPhotos));
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
        state.items.push({ id: state.nextId++, img: photo.img, iw: photo.iw, ih: photo.ih, small: photo.small, blob: photo.blob, fit: false, zoom: 1, cx: 0.5, cy: 0.5, qty: 1, rev: 0, uploaded: null });
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
  var editor = C.attachEditor($('editor-canvas'), function () { return state.editing; }, function () { syncZoom(); }, function () { return state.overlay; });
  /* Fill crops the photo to the square. Fit keeps the whole photo and puts white around it. */
  function syncMode() {
    var it = state.editing; if (!it) return;
    $('mode-fill').setAttribute('aria-pressed', String(!it.fit));
    $('mode-fit').setAttribute('aria-pressed', String(!!it.fit));
    $('zoom-tools').hidden = !!it.fit;
    $('ed-help').textContent = it.fit ? 'Your whole photo is on the magnet, edge to edge, with white filling the rest. Nothing is cut off.' : 'Drag the photo with your finger to move it.';
  }
  function setMode(fit) {
    var it = state.editing; if (!it) return;
    it.fit = fit; editor.draw(); syncMode(); syncZoom();
  }
  $('mode-fill').addEventListener('click', function () { setMode(false); });
  $('mode-fit').addEventListener('click', function () { setMode(true); });
  function syncZoom() {
    var it = state.editing; if (!it) return;
    $('zoom-out').disabled = it.zoom <= 1.001;
    $('zoom-in').disabled = it.zoom >= 2.999;
    $('zoom').value = it.zoom;
  }
  function zoomBy(step) {
    var it = state.editing; if (!it) return;
    it.zoom = C.clamp(Math.round((it.zoom + step) * 100) / 100, 1, 3);
    C.normalize(it); editor.draw(); syncZoom();
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
    it.zoom = C.clamp(parseFloat(this.value) || 1, 1, 3);
    C.normalize(it); editor.draw();
    $('zoom-out').disabled = it.zoom <= 1.001; $('zoom-in').disabled = it.zoom >= 2.999;
  });
  $('zoom-in').addEventListener('click', function () { zoomBy(0.25); });
  $('zoom-out').addEventListener('click', function () { zoomBy(-0.25); });
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
      /* show only the front of the magnet: the part inside the dashed square */
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
      }
      progress('Almost done.', state.items.length, steps);
      var res = null;
      for (var attempt = 0; attempt < 3; attempt++) {
        res = await sb.rpc('submit_order', {
          p_slug: slug, p_order_id: state.orderId, p_name: name,
          p_contact: $('guest-contact').value.trim(),
          p_photos: state.items.map(function (x) { return { path: x.uploaded, qty: x.qty, zoom: x.zoom, cx: x.cx, cy: x.cy, fit: !!x.fit }; }),
          p_note: $('guest-note').value.trim()
        });
        if (!res.error || /EVENT_CLOSED|TOO_MANY|BAD_/.test(String(res.error.message || ''))) break;
        await wait(1200 * (attempt + 1));
      }
      if (res.error) throw res.error;
      var count = total();
      $('done-hello').textContent = 'You are all set, ' + name + '!';
      $('done-no').textContent = res.data;
      var cost = priceOf(count);
      $('done-total').textContent = cost != null ? C.money(cost) : '';
      $('done-totalbox').hidden = cost == null;
      $('done-text').textContent = 'We are making ' + plural(count, 'magnet') + ' for you. ' + (state.event.kind === 'private'
        ? 'They will be ready a little later, so please pick them up at the Sona Magnets table before the end of the event. Just tell us your name or order number.'
        : 'They will be ready in 10-15 minutes, so feel free to shop around. Then come back to the table and tell us your name or order number.');
      try { localStorage.setItem(storeKey(), JSON.stringify({ no: res.data, name: name, at: Date.now() })); } catch (err) {}
      state.items = []; state.orderId = null;
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
  $('guest-name').addEventListener('input', function () { note('form-msg', ''); });
  $('note-open').addEventListener('click', function () { this.hidden = true; $('note-wrap').hidden = false; $('guest-note').focus(); });
  $('back-photos').addEventListener('click', function () { show('view-photos', 'photos-title'); });
  $('again').addEventListener('click', function () { $('guest-name').value = ''; $('guest-note').value = ''; $('note-wrap').hidden = true; $('note-open').hidden = false; renderPhotos(); showLastOrder(); show('view-photos', 'photos-title'); });

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
    $('welcome').textContent = ev.welcome || (ev.kind === 'private' ? 'Your photos, made into magnets. Pick them up before the end of the event.' : 'Your photos, made into magnets in 10-15 minutes while you shop around.');
    if (ev.status !== 'live') { closed('Orders are closed', 'This event is not taking photo orders right now. Please ask us at the Sona Magnets table.'); return; }
    $('contact-wrap').hidden = !ev.ask_contact;
    if (ev.overlay_path) {
      var pic = await C.loadOverlayImage(C.overlayUrl(ev.overlay_path));
      if (pic) state.overlay = { img: pic.img, iw: pic.iw, ih: pic.ih, scale: Number(ev.overlay_scale) || 1, cx: ev.overlay_x == null ? 0.5 : Number(ev.overlay_x), cy: ev.overlay_y == null ? 0.5 : Number(ev.overlay_y) };
    }
    renderPhotos();
    showLastOrder();
    show('view-photos');
  })();
})();
