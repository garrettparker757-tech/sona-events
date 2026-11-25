/* Guest order page: pick photos, frame them, send the order, get an order number. */
(function () {
  'use strict';
  var C = window.SonaCommon, CFG = window.SONA;
  var $ = function (id) { return document.getElementById(id); };
  var parts = location.pathname.split('/').filter(Boolean);
  var slug = (parts[0] === 'e' && parts[1]) ? decodeURIComponent(parts[1]) : (new URLSearchParams(location.search).get('e') || '');
  slug = slug.toLowerCase();

  var state = { event: null, items: [], editing: null, nextId: 1, orderId: null, sending: false };
  var sb = null;

  function show(view) {
    ['view-loading', 'view-closed', 'view-form', 'view-done'].forEach(function (id) { $(id).hidden = id !== view; });
  }
  function closed(title, msg) {
    $('closed-title').textContent = title;
    $('closed-msg').textContent = msg;
    show('view-closed');
  }
  function total() { return state.items.reduce(function (n, it) { return n + it.qty; }, 0); }
  function remaining() { return state.event.max_magnets - total(); }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }

  /* ---------- last order reminder ---------- */
  function storeKey() { return 'sona-last-order-' + slug; }
  function showLastOrder() {
    try {
      var saved = JSON.parse(localStorage.getItem(storeKey()) || 'null');
      if (!saved || Date.now() - saved.at > 12 * 3600 * 1000) return;
      $('last-no').textContent = 'Your last order here was number ' + saved.no + '.';
      $('last-text').textContent = 'Listen for ' + saved.name + ' at the table.';
      $('last-order').hidden = false;
    } catch (err) {}
  }

  /* ---------- photos ---------- */
  function renderPhotos() {
    var ul = $('photos'), left = remaining();
    ul.replaceChildren();
    state.items.forEach(function (it, idx) {
      var li = el('li', 'tile');
      var thumb = document.createElement('canvas');
      thumb.width = thumb.height = 168;
      thumb.setAttribute('role', 'button'); thumb.tabIndex = 0;
      thumb.setAttribute('aria-label', 'Frame photo ' + (idx + 1));
      C.drawCrop(thumb.getContext('2d'), it, 0, 0, 168);
      var open = function () { openEditor(it); };
      thumb.addEventListener('click', open);
      thumb.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
      li.appendChild(thumb);

      var controls = el('div', 'controls');
      var qty = el('span', 'qty');
      var minus = el('button', null, '−'); minus.type = 'button'; minus.setAttribute('aria-label', 'One fewer copy');
      var out = el('output', null, String(it.qty));
      var plus = el('button', null, '+'); plus.type = 'button'; plus.setAttribute('aria-label', 'One more copy');
      minus.disabled = it.qty <= 1; plus.disabled = left <= 0;
      minus.addEventListener('click', function () { if (it.qty > 1) { it.qty--; renderPhotos(); } });
      plus.addEventListener('click', function () { if (remaining() > 0) { it.qty++; renderPhotos(); } });
      qty.appendChild(minus); qty.appendChild(out); qty.appendChild(plus);
      controls.appendChild(qty);
      var frame = el('button', 'btn small', 'Move or zoom'); frame.type = 'button'; frame.addEventListener('click', open);
      controls.appendChild(frame);
      var remove = el('button', 'btn small', 'Remove'); remove.type = 'button';
      remove.addEventListener('click', function () { state.items = state.items.filter(function (x) { return x !== it; }); renderPhotos(); });
      controls.appendChild(remove);
      li.appendChild(controls);
      ul.appendChild(li);
    });
    var max = state.event.max_magnets;
    $('counter').textContent = total() + ' of ' + max + (max === 1 ? ' magnet' : ' magnets');
    $('add-label').classList.toggle('disabled', left <= 0);
    $('file-input').disabled = left <= 0;
    $('add-label').textContent = state.items.length ? 'Add more photos' : 'Add photos';
  }
  async function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []), msg = $('photo-msg');
    if (!files.length) return;
    var room = remaining(), failed = 0, skipped = 0;
    msg.className = 'note'; msg.textContent = 'Opening your photos.';
    for (var i = 0; i < files.length; i++) {
      if (room <= 0) { skipped++; continue; }
      var img = await C.loadImage(files[i]);
      if (img && img.naturalWidth && img.naturalHeight) {
        state.items.push({ id: state.nextId++, img: img, iw: img.naturalWidth, ih: img.naturalHeight, zoom: 1, cx: 0.5, cy: 0.5, qty: 1, rev: 0, uploaded: null });
        room--;
      } else { failed++; }
    }
    var notes = [];
    if (failed) notes.push(failed + (failed === 1 ? ' photo' : ' photos') + ' could not be opened. Try a different photo.');
    if (skipped) notes.push('Only ' + state.event.max_magnets + ' magnets fit in one order, so ' + skipped + (skipped === 1 ? ' photo was' : ' photos were') + ' left out.');
    msg.className = notes.length ? 'note bad' : 'note';
    msg.textContent = notes.join(' ');
    renderPhotos();
  }

  /* ---------- editor ---------- */
  var editor = C.attachEditor($('editor-canvas'), function () { return state.editing; }, function (it) {
    it.rev++; it.uploaded = null; $('zoom').value = it.zoom;
  });
  function openEditor(it) {
    state.editing = it;
    $('zoom').value = it.zoom;
    $('editor').hidden = false;
    editor.draw();
    $('editor-done').focus();
  }
  function closeEditor() { state.editing = null; $('editor').hidden = true; renderPhotos(); }
  $('zoom').addEventListener('input', function () {
    var it = state.editing; if (!it) return;
    it.zoom = C.clamp(parseFloat(this.value) || 1, 1, 4);
    C.normalize(it); it.rev++; it.uploaded = null; editor.draw();
  });
  $('editor-done').addEventListener('click', closeEditor);
  $('editor').addEventListener('click', function (e) { if (e.target === this) closeEditor(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.editing) closeEditor(); });

  /* ---------- sending ---------- */
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
  function formMsg(text, kind) { var n = $('form-msg'); n.textContent = text; n.className = 'note' + (kind ? ' ' + kind : ''); }
  function friendly(err) {
    var m = String((err && err.message) || err || '');
    if (m.indexOf('EVENT_CLOSED') >= 0) return 'This event just stopped taking orders. Ask at the Sona Magnets table.';
    if (m.indexOf('TOO_MANY') >= 0 || m.indexOf('BAD_PHOTOS') >= 0) return 'That is more magnets than one order allows. Remove a photo and try again.';
    if (m.indexOf('BAD_NAME') >= 0) return 'Please enter your name.';
    return 'Your order did not go through. Check your signal and tap Send again. If it keeps failing, ask at the table.';
  }
  async function send(e) {
    e.preventDefault();
    if (state.sending) return;
    var name = $('guest-name').value.trim();
    if (!name) { formMsg('Please enter your name so we can call you.', 'bad'); $('guest-name').focus(); return; }
    if (!state.items.length) { formMsg('Add at least one photo.', 'bad'); return; }
    state.sending = true;
    var btn = $('submit'); btn.disabled = true;
    try {
      if (!state.orderId) state.orderId = C.uuid();
      for (var i = 0; i < state.items.length; i++) {
        var it = state.items[i];
        formMsg('Sending photo ' + (i + 1) + ' of ' + state.items.length + '.');
        if (it.uploaded) continue;
        var blob = await renderBlob(it);
        if (!blob) throw new Error('RENDER');
        var path = state.event.id + '/' + state.orderId + '/' + it.id + '-' + it.rev + '.jpg';
        var up = await sb.storage.from('uploads').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
        if (up.error) throw up.error;
        it.uploaded = path;
      }
      formMsg('Placing your order.');
      var res = await sb.rpc('submit_order', {
        p_slug: slug, p_order_id: state.orderId, p_name: name,
        p_contact: $('guest-contact').value.trim(),
        p_photos: state.items.map(function (x) { return { path: x.uploaded, qty: x.qty }; })
      });
      if (res.error) throw res.error;
      var count = total();
      $('done-no').textContent = '#' + res.data;
      $('done-text').textContent = 'Thanks, ' + name + '. We are making ' + count + (count === 1 ? ' magnet' : ' magnets') + ' for you. Keep this number and listen for your name at the table.';
      try { localStorage.setItem(storeKey(), JSON.stringify({ no: res.data, name: name, at: Date.now() })); } catch (err) {}
      state.items = []; state.orderId = null;
      $('last-order').hidden = true;
      formMsg('');
      show('view-done');
      window.scrollTo(0, 0);
    } catch (err) {
      formMsg(friendly(err), 'bad');
    }
    state.sending = false; btn.disabled = false;
  }

  /* ---------- start ---------- */
  $('order-form').addEventListener('submit', send);
  $('file-input').addEventListener('change', function () { addFiles(this.files); this.value = ''; });
  $('again').addEventListener('click', function () { renderPhotos(); showLastOrder(); show('view-form'); });

  (async function start() {
    if (!window.supabase || !slug) {
      $('event-name').textContent = 'Sona Magnets';
      closed('This link is not working', slug ? 'The page could not load. Check your signal and reload.' : 'Scan the QR code at the Sona Magnets table to place an order.');
      return;
    }
    sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    var res = await sb.rpc('get_event', { p_slug: slug });
    var ev = res.data && res.data[0];
    if (res.error) { $('event-name').textContent = 'Sona Magnets'; closed('The page could not load', 'Check your signal and reload this page.'); return; }
    if (!ev) { $('event-name').textContent = 'Sona Magnets'; closed('Event not found', 'This order link is not active. Ask at the Sona Magnets table for the current QR code.'); return; }
    state.event = ev;
    document.title = ev.name + ' | Sona Magnets';
    $('event-name').textContent = ev.name;
    $('welcome').textContent = ev.welcome || '';
    if (ev.status !== 'live') { closed('Orders are closed', 'This event is not taking photo orders right now. Ask at the Sona Magnets table.'); return; }
    $('contact-wrap').hidden = !ev.ask_contact;
    renderPhotos();
    showLastOrder();
    show('view-form');
  })();
})();
