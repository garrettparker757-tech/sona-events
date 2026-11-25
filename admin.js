/* Staff page: sign in, manage events, show the QR code, watch the queue, make print sheets. */
(function () {
  'use strict';
  var CFG = window.SONA, Sheet = window.SonaSheet, C = window.SonaCommon, T = Sheet.template(CFG.template);
  var $ = function (id) { return document.getElementById(id); };
  var VIEWS = ['view-loading', 'view-login', 'view-denied', 'view-events', 'view-event'];
  var state = {
    events: [], event: null, orders: [], sig: '', timer: null, blobs: new Map(), pending: null, busy: false,
    known: null, fresh: {}, unseen: 0, filter: 'todo', query: '', sound: false, audio: null, pics: new Map(), fixing: null
  };
  var sb = null;
  var TITLE = 'Sona Events staff';

  function show(view) {
    VIEWS.forEach(function (id) { $(id).hidden = id !== view; });
    $('back').hidden = view !== 'view-event';
    $('signout').hidden = view === 'view-login' || view === 'view-loading';
    if (view !== 'view-event') { $('page-title').textContent = 'Events'; stopPolling(); clearNew(); }
  }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function note(id, text, kind) { var n = $(id); n.textContent = text || ''; n.className = 'note' + (kind ? ' ' + kind : ''); }
  function guestUrl(ev) { return location.origin + '/e/' + ev.slug; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  /* ---------- sign-in ---------- */
  function signedOut(message) {
    state.event = null; discardPending();
    show('view-login');
    note('login-msg', message || '', message ? 'bad' : '');
  }
  /* True when an error means the sign-in has expired; sends staff back to the sign-in form. */
  function lostSession(error) {
    if (!error) return false;
    var m = String(error.message || '') + ' ' + String(error.code || '');
    if (error.status === 401 || /JWT|PGRST301|not authenticated|invalid.*token/i.test(m)) {
      sb.auth.signOut().catch(function () {});
      signedOut('You were signed out. Please sign in again.');
      return true;
    }
    return false;
  }
  async function route(session) {
    if (!session) { show('view-login'); return; }
    var res = await sb.from('staff').select('email').limit(1);
    if (lostSession(res.error)) return;
    if (res.error) { show('view-login'); note('login-msg', 'Could not reach the server. Check the connection and reload.', 'bad'); return; }
    if (!res.data || !res.data.length) {
      $('denied-msg').textContent = 'You are signed in as ' + (session.user.email || 'this account') + ', which has not been added to the Sona Events staff list.';
      show('view-denied');
      return;
    }
    await loadEvents();
    show('view-events');
  }
  $('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = $('login-btn'); btn.disabled = true; note('login-msg', 'Signing in.');
    var res = await sb.auth.signInWithPassword({ email: $('login-email').value.trim(), password: $('login-password').value });
    btn.disabled = false;
    if (res.error) { note('login-msg', 'That email and password did not match. Check them and try again.', 'bad'); return; }
    note('login-msg', '');
    $('login-password').value = '';
    route(res.data.session);
  });
  $('signout').addEventListener('click', async function () { await sb.auth.signOut(); signedOut(''); });
  $('back').addEventListener('click', async function () { discardPending(); state.event = null; await loadEvents(); show('view-events'); });

  /* ---------- deleting an event's photos and orders ---------- */
  async function purgeEvent(ev, say) {
    say('Closing the event.');
    var closed = await sb.from('events').update({ status: 'closed' }).eq('id', ev.id).select().single();
    if (closed.error) throw closed.error;
    var removed = 0;
    for (var round = 0; round < 200; round++) {
      var list = await sb.rpc('event_upload_paths', { p_event_id: ev.id });
      if (list.error) throw list.error;
      var paths = list.data || [];
      if (!paths.length) break;
      for (var i = 0; i < paths.length; i += 100) {
        var del = await sb.storage.from('uploads').remove(paths.slice(i, i + 100));
        if (del.error) throw del.error;
        removed += Math.min(100, paths.length - i);
        say('Deleted ' + plural(removed, 'photo') + ' so far.');
      }
    }
    var left = await sb.rpc('event_upload_paths', { p_event_id: ev.id });
    if (left.error || (left.data || []).length) throw new Error('PHOTOS_LEFT');
    var gone = await sb.from('orders').delete().eq('event_id', ev.id);
    if (gone.error) throw gone.error;
    return { removed: removed, event: closed.data };
  }
  async function removeEvent(ev, say) {
    var out = await purgeEvent(ev, say);
    say('Removing the event.');
    var del = await sb.from('events').delete().eq('id', ev.id);
    if (del.error) throw del.error;
    return out;
  }
  var STOPPED = 'Something stopped partway through. Nothing was deleted that should have been kept. Press the button again to finish.';

  /* ---------- events list ---------- */
  function slugify(name) {
    var base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'event';
    var tail = '', chars = 'abcdefghjkmnpqrstuvwxyz23456789', r = new Uint8Array(4);
    crypto.getRandomValues(r);
    for (var i = 0; i < 4; i++) tail += chars[r[i] % chars.length];
    return base + '-' + tail;
  }
  async function loadEvents() {
    var res = await sb.from('events').select('*').order('created_at', { ascending: false });
    if (lostSession(res.error)) return;
    if (res.error) { note('events-msg', 'Could not load events. Reload the page.', 'bad'); return; }
    state.events = res.data;
    var ul = $('events'); ul.replaceChildren();
    state.events.forEach(function (ev) {
      var li = el('li', 'card soft');
      var left = el('div');
      left.appendChild(el('h3', null, ev.name));
      left.appendChild(el('p', 'note', 'Created ' + new Date(ev.created_at).toLocaleDateString() + ', up to ' + ev.max_magnets + ' magnets per order'));
      li.appendChild(left);
      var right = el('div', 'row');
      right.appendChild(el('span', 'chip ' + ev.status, cap(ev.status)));
      var open = el('button', 'btn small primary', 'Open'); open.type = 'button';
      open.addEventListener('click', function () { openEvent(ev); });
      right.appendChild(open);
      var remove = el('button', 'btn small', 'Remove'); remove.type = 'button';
      remove.setAttribute('aria-label', 'Remove event ' + ev.name);
      right.appendChild(remove);
      li.appendChild(right);

      var confirm = el('div', 'confirm'); confirm.hidden = true;
      var msg = el('span', null, 'Remove "' + ev.name + '" with all of its orders and photos? This cannot be undone.');
      var yes = el('button', 'btn small', 'Yes, remove it'); yes.type = 'button';
      var no = el('button', 'btn small', 'Keep it'); no.type = 'button';
      confirm.appendChild(msg); confirm.appendChild(yes); confirm.appendChild(no);
      li.appendChild(confirm);
      remove.addEventListener('click', function () { confirm.hidden = false; remove.hidden = true; });
      no.addEventListener('click', function () { confirm.hidden = true; remove.hidden = false; });
      yes.addEventListener('click', async function () {
        if (state.busy) return;
        state.busy = true; yes.disabled = true; no.disabled = true;
        try {
          await removeEvent(ev, function (t) { msg.textContent = t; });
          state.busy = false;
          await loadEvents();
          note('events-msg', '"' + ev.name + '" was removed.', 'good');
        } catch (err) {
          state.busy = false; yes.disabled = false; no.disabled = false;
          if (!lostSession(err)) msg.textContent = STOPPED;
        }
      });
      ul.appendChild(li);
    });
    note('events-msg', state.events.length ? '' : 'No events yet. Create your first one on the left.');
  }
  $('event-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var name = $('ev-name').value.trim(), max = parseInt($('ev-max').value, 10);
    if (!name) { note('event-msg', 'Give the event a name.', 'bad'); return; }
    if (!(max >= 1 && max <= 50)) { note('event-msg', 'Magnets per order must be between 1 and 50.', 'bad'); return; }
    var btn = $('event-btn'); btn.disabled = true; note('event-msg', 'Creating the event.');
    var res = await sb.from('events').insert({ name: name, slug: slugify(name), max_magnets: max, welcome: $('ev-welcome').value.trim(), ask_contact: $('ev-contact').checked }).select().single();
    btn.disabled = false;
    if (lostSession(res.error)) return;
    if (res.error) { note('event-msg', 'The event could not be created. Try again.', 'bad'); return; }
    note('event-msg', '');
    $('ev-name').value = ''; $('ev-welcome').value = '';
    openEvent(res.data);
  });

  /* ---------- one event ---------- */
  function renderEventInfo() {
    var ev = state.event;
    $('page-title').textContent = ev.name;
    $('sign-name').textContent = ev.name;
    $('poster-event').textContent = ev.name;
    $('set-name').value = ev.name; $('set-max').value = ev.max_magnets;
    $('set-welcome').value = ev.welcome || ''; $('set-contact').checked = !!ev.ask_contact;
  }
  function renderStatus() {
    var ev = state.event;
    $('status-chip').textContent = cap(ev.status); $('status-chip').className = 'chip ' + ev.status;
    Array.prototype.forEach.call(document.querySelectorAll('.seg button[data-status]'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.status === ev.status)); });
    var live = ev.status === 'live';
    $('not-live').hidden = live;
    $('not-live-text').textContent = ev.status === 'draft'
      ? 'This event is still a draft. Guests who scan the code cannot order yet.'
      : 'This event is closed. Guests who scan the code see that orders are closed.';
    $('go-live').textContent = ev.status === 'draft' ? 'Go live now' : 'Reopen for orders';
    note('status-note', live ? 'Live: guests can order now.' : '');
  }
  async function setStatus(status) {
    var ev = state.event; if (!ev || ev.status === status) return;
    var res = await sb.from('events').update({ status: status }).eq('id', ev.id).select().single();
    if (lostSession(res.error)) return;
    if (res.error) { note('status-note', 'The status did not change. Try again.', 'bad'); return; }
    state.event = res.data; renderStatus();
  }
  function openEvent(ev) {
    state.event = ev; state.orders = []; state.sig = ''; state.known = null; state.fresh = {};
    state.filter = 'todo'; state.query = ''; $('order-search').value = ''; renderFilter(); clearNew();
    var url = guestUrl(ev);
    $('guest-link').textContent = url;
    $('open-link').href = url;
    var qr = $('qr'); qr.replaceChildren();
    if (window.QRCode) new window.QRCode(qr, { text: url, width: 440, height: 440, correctLevel: window.QRCode.CorrectLevel.M });
    else qr.textContent = 'The QR code could not load. Reload the page.';
    var pq = $('poster-qr'); pq.replaceChildren();
    if (window.QRCode) new window.QRCode(pq, { text: url, width: 900, height: 900, correctLevel: window.QRCode.CorrectLevel.M });
    renderEventInfo(); renderStatus();
    purgeReset(); note('purge-msg', ''); note('settings-msg', '');
    $('orders').replaceChildren(); $('orders-empty').textContent = '';
    note('print-msg', ''); note('queue-msg', 'Loading orders.');
    show('view-event');
    $('page-title').textContent = ev.name;
    loadOrders();
    stopPolling();
    state.timer = setInterval(function () { if (!document.hidden) loadOrders(); }, 5000);
  }
  function stopPolling() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }
  document.addEventListener('visibilitychange', function () { if (!document.hidden && state.event) loadOrders(); });
  Array.prototype.forEach.call(document.querySelectorAll('.seg button[data-status]'), function (b) {
    b.addEventListener('click', function () { setStatus(b.dataset.status); });
  });
  $('go-live').addEventListener('click', function () { setStatus('live'); });
  $('copy-link').addEventListener('click', async function () {
    try { await navigator.clipboard.writeText(guestUrl(state.event)); this.textContent = 'Copied'; }
    catch (err) { this.textContent = 'Copy failed'; }
    var b = this; setTimeout(function () { b.textContent = 'Copy link'; }, 1500);
  });
  /* Table signs: pick which poster shows on paper, then print. */
  (function () {
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
  })();
  Array.prototype.forEach.call(document.querySelectorAll('[data-print]'), function (b) {
    b.addEventListener('click', function () { document.body.setAttribute('data-print', b.getAttribute('data-print')); window.print(); });
  });
  $('settings-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var ev = state.event; if (!ev) return;
    var name = $('set-name').value.trim(), max = parseInt($('set-max').value, 10);
    if (!name) { note('settings-msg', 'The event needs a name.', 'bad'); return; }
    if (!(max >= 1 && max <= 50)) { note('settings-msg', 'Magnets per order must be between 1 and 50.', 'bad'); return; }
    var btn = $('settings-btn'); btn.disabled = true;
    var res = await sb.from('events').update({ name: name, max_magnets: max, welcome: $('set-welcome').value.trim(), ask_contact: $('set-contact').checked }).eq('id', ev.id).select().single();
    btn.disabled = false;
    if (lostSession(res.error)) return;
    if (res.error) { note('settings-msg', 'The settings did not save. Try again.', 'bad'); return; }
    state.event = res.data; renderEventInfo();
    note('settings-msg', 'Saved. The guest link and QR code stay the same.', 'good');
  });

  /* ---------- new-order alert ---------- */
  function beep() {
    if (!state.sound || !state.audio) return;
    try {
      var ctx = state.audio, t = ctx.currentTime;
      [880, 1175].forEach(function (freq, i) {
        var osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.type = 'sine'; osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t + i * 0.22);
        gain.gain.exponentialRampToValueAtTime(0.25, t + i * 0.22 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.22 + 0.2);
        osc.connect(gain); gain.connect(ctx.destination);
        osc.start(t + i * 0.22); osc.stop(t + i * 0.22 + 0.22);
      });
    } catch (err) {}
  }
  function armAudio() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!state.audio && AC) state.audio = new AC();
      if (state.audio && state.audio.state === 'suspended') state.audio.resume();
    } catch (err) {}
  }
  function renderSound() {
    $('sound-toggle').textContent = 'Sound for new orders: ' + (state.sound ? 'on' : 'off');
    $('sound-toggle').setAttribute('aria-pressed', String(state.sound));
  }
  $('sound-toggle').addEventListener('click', function () {
    state.sound = !state.sound;
    try { localStorage.setItem('sona-sound', state.sound ? '1' : '0'); } catch (err) {}
    renderSound();
    if (state.sound) { armAudio(); beep(); }
  });
  try { state.sound = localStorage.getItem('sona-sound') === '1'; } catch (err) {}
  renderSound();
  /* Browsers only allow sound after a click, so wake the audio on the first click of each visit. */
  document.addEventListener('click', function () { if (state.sound) armAudio(); });
  function clearNew() {
    state.unseen = 0; $('new-bar').hidden = true; document.title = TITLE;
  }
  function announce(newOrders) {
    state.unseen += newOrders.length;
    var last = newOrders[newOrders.length - 1];
    $('new-text').textContent = state.unseen === 1
      ? 'New order: #' + last.order_no + ' for ' + last.guest_name
      : state.unseen + ' new orders, latest #' + last.order_no + ' for ' + last.guest_name;
    $('new-bar').hidden = false;
    document.title = '(' + state.unseen + ') New order | ' + TITLE;
    beep();
  }
  $('new-ok').addEventListener('click', function () { clearNew(); state.fresh = {}; renderOrders(); });

  /* ---------- queue ---------- */
  function byCreated(a, b) { return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0; }
  async function loadOrders() {
    var ev = state.event; if (!ev) return;
    var res = await sb.from('orders')
      .select('id, order_no, guest_name, contact, note, status, created_at, paid_at, paid_amount, order_photos(id, path, qty, printed_at, created_at, crop_zoom, crop_x, crop_y)')
      .eq('event_id', ev.id).order('order_no', { ascending: true });
    if (!state.event || state.event.id !== ev.id) return;
    if (lostSession(res.error)) return;
    if (res.error) { note('queue-msg', 'No connection. Trying again.', 'bad'); return; }
    res.data.forEach(function (o) { o.order_photos.sort(byCreated); });
    if (state.known) {
      var fresh = res.data.filter(function (o) { return !state.known[o.id]; });
      if (fresh.length) { fresh.forEach(function (o) { state.fresh[o.id] = true; }); announce(fresh); }
    }
    state.known = {};
    res.data.forEach(function (o) { state.known[o.id] = true; });
    var sig = JSON.stringify(res.data);
    state.orders = res.data;
    if (sig !== state.sig) { state.sig = sig; renderOrders(); }
    note('queue-msg', 'Updates every 5 seconds.');
  }
  function photoBlob(path) {
    if (!state.blobs.has(path)) {
      state.blobs.set(path, sb.storage.from('uploads').download(path).then(function (r) {
        if (r.error) throw r.error;
        return { blob: r.data, url: URL.createObjectURL(r.data) };
      }).catch(function (err) { state.blobs.delete(path); throw err; }));
    }
    return state.blobs.get(path);
  }
  /* The decoded picture for a path, ready to draw. */
  function photoPic(path) {
    if (!state.pics.has(path)) {
      state.pics.set(path, photoBlob(path).then(function (b) {
        return new Promise(function (resolve, reject) {
          var img = new Image();
          img.onload = function () { resolve({ img: img, iw: img.naturalWidth, ih: img.naturalHeight }); };
          img.onerror = function () { reject(new Error('DECODE')); };
          img.src = b.url;
        });
      }).catch(function (err) { state.pics.delete(path); throw err; }));
    }
    return state.pics.get(path);
  }
  /* How a photo is framed: the guest's choice, or the staff fix saved over it. */
  function framing(p) {
    return { zoom: Number(p.crop_zoom) || 1, cx: p.crop_x == null ? 0.5 : Number(p.crop_x), cy: p.crop_y == null ? 0.5 : Number(p.crop_y) };
  }
  function drawFramed(canvas, pic, f) {
    var g = canvas.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height);
    g.imageSmoothingQuality = 'high';
    C.drawCrop(g, { img: pic.img, iw: pic.iw, ih: pic.ih, zoom: f.zoom, cx: f.cx, cy: f.cy }, 0, 0, canvas.width);
  }
  function waitingRows() {
    var rows = [];
    state.orders.forEach(function (o) {
      if (o.status === 'done') return;
      o.order_photos.forEach(function (p) { if (!p.printed_at) rows.push({ order: o, photo: p }); });
    });
    return rows;
  }
  function layout() { return Sheet.geometry(T); }
  function renderFilter() {
    Array.prototype.forEach.call(document.querySelectorAll('.seg button[data-filter]'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.filter === state.filter)); });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.seg button[data-filter]'), function (b) {
    b.addEventListener('click', function () { state.filter = b.dataset.filter; renderFilter(); renderOrders(); });
  });
  $('order-search').addEventListener('input', function () { state.query = this.value.trim().toLowerCase(); renderOrders(); });

  function renderOrders() {
    var rank = { 'new': 0, printed: 1, done: 2 }, per = layout().per;
    var waiting = waitingRows().reduce(function (n, r) { return n + r.photo.qty; }, 0);
    var doneCount = state.orders.filter(function (o) { return o.status === 'done'; }).length;
    $('st-waiting').textContent = waiting;
    $('st-orders').textContent = state.orders.length;
    $('st-done').textContent = doneCount;
    var unpaid = 0, collected = 0;
    state.orders.forEach(function (o) { if (o.paid_at) collected += Number(o.paid_amount) || 0; else unpaid++; });
    $('st-unpaid').textContent = unpaid;
    $('st-collected').textContent = C.money(collected);
    $('print-one').disabled = !waiting; $('print-all').disabled = !waiting;
    if ($('ready').hidden) note('print-msg', waiting ? (waiting === 1 ? '1 magnet is' : waiting + ' magnets are') + ' waiting. A full sheet holds ' + per + '.' : 'Nothing is waiting to print.');
    var labels = { todo: 'To do (' + (state.orders.length - doneCount) + ')', done: 'Picked up (' + doneCount + ')', all: 'All (' + state.orders.length + ')' };
    Array.prototype.forEach.call(document.querySelectorAll('.seg button[data-filter]'), function (b) { b.textContent = labels[b.dataset.filter]; });

    var q = state.query.replace(/^#/, '');
    var shown = state.orders.filter(function (o) {
      if (q) return String(o.order_no) === q || o.guest_name.toLowerCase().indexOf(q) >= 0 || (o.contact || '').toLowerCase().indexOf(q) >= 0;
      return state.filter === 'all' || (state.filter === 'done') === (o.status === 'done');
    }).sort(function (a, b) { return (rank[a.status] - rank[b.status]) || (a.order_no - b.order_no); });

    var ul = $('orders'); ul.replaceChildren();
    $('orders-empty').textContent = shown.length ? '' :
      q ? 'No order matches "' + state.query + '".' :
      !state.orders.length ? 'No orders yet. They appear here within a few seconds of a guest sending one.' :
      state.filter === 'todo' ? 'Nothing left to do. Every order has been picked up.' : 'No orders have been picked up yet.';
    shown.forEach(function (o) {
      var li = el('li', 'order' + (o.status === 'new' ? ' waiting' : '') + (state.fresh[o.id] ? ' fresh' : ''));
      var head = el('div', 'row between');
      var who = el('div', 'row');
      who.appendChild(el('span', 'no', '#' + o.order_no));
      who.appendChild(el('strong', null, o.guest_name));
      if (o.contact) who.appendChild(el('span', 'note', o.contact));
      head.appendChild(who);
      var meta = el('div', 'row');
      var count = o.order_photos.reduce(function (n, p) { return n + p.qty; }, 0);
      var cost = o.paid_at && o.paid_amount != null ? Number(o.paid_amount) : C.priceFor(count);
      if (cost != null) meta.appendChild(el('strong', 'price', C.money(cost)));
      meta.appendChild(el('span', 'chip ' + (o.paid_at ? 'paid' : 'unpaid'), o.paid_at ? 'Paid' : 'Not paid'));
      meta.appendChild(el('span', 'note', plural(count, 'magnet') + ', ' + new Date(o.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
      var label = o.status === 'new' ? 'Waiting to print' : o.status === 'printed' ? 'Printed' : 'Picked up';
      meta.appendChild(el('span', 'chip ' + o.status, label));
      head.appendChild(meta);
      li.appendChild(head);

      if (o.note) li.appendChild(el('p', 'guest-note', 'Note: ' + o.note));
      var thumbs = el('div', 'thumbs');
      o.order_photos.forEach(function (p) {
        var t = el('button', 'thumb' + (p.printed_at ? ' printed' : '')); t.type = 'button';
        t.title = 'Fix how this photo is framed';
        t.setAttribute('aria-label', 'Fix photo for order ' + o.order_no);
        var cv = document.createElement('canvas'); cv.width = cv.height = 132;
        photoPic(p.path).then(function (pic) { drawFramed(cv, pic, framing(p)); }).catch(function () { t.title = 'Photo could not load'; });
        t.appendChild(cv);
        if (p.qty > 1) t.appendChild(el('span', null, 'x' + p.qty));
        t.addEventListener('click', function () { openFix(o, p); });
        thumbs.appendChild(t);
      });
      li.appendChild(thumbs);
      li.appendChild(el('p', 'note', 'Tap a photo to fix how it is framed.'));

      var actions = el('div', 'row');
      if (!o.paid_at) {
        var pay = el('button', 'btn small primary', 'Mark paid' + (cost != null ? ' ' + C.money(cost) : '')); pay.type = 'button';
        pay.addEventListener('click', function () { setOrder(o, { paid_at: new Date().toISOString(), paid_amount: cost }); });
        actions.appendChild(pay);
      }
      var printed = o.order_photos.some(function (p) { return p.printed_at; });
      var one = el('button', 'btn small' + (o.status === 'new' ? ' primary' : ''), printed ? 'Print this order again' : 'Print this order'); one.type = 'button';
      one.addEventListener('click', function () { makeSheets('order', o); });
      actions.appendChild(one);
      if (o.status !== 'done') {
        var done = el('button', 'btn small' + (o.status === 'printed' ? ' primary' : ''), 'Picked up'); done.type = 'button';
        done.addEventListener('click', function () { setOrder(o, { status: 'done' }); });
        actions.appendChild(done);
      } else {
        var undo = el('button', 'btn small', 'Not picked up yet'); undo.type = 'button';
        var allPrinted = o.order_photos.every(function (p) { return p.printed_at; });
        undo.addEventListener('click', function () { setOrder(o, { status: allPrinted ? 'printed' : 'new' }); });
        actions.appendChild(undo);
      }
      if (printed && o.status !== 'done') {
        var again = el('button', 'btn small', 'Put back in the print queue'); again.type = 'button';
        again.addEventListener('click', async function () {
          var r = await sb.from('order_photos').update({ printed_at: null }).eq('order_id', o.id);
          if (lostSession(r.error)) return;
          if (r.error) { note('queue-msg', 'That did not save. Try again.', 'bad'); return; }
          setOrder(o, { status: 'new' });
        });
        actions.appendChild(again);
      }
      if (o.paid_at) {
        var unpay = el('button', 'btn small', 'Undo paid'); unpay.type = 'button';
        unpay.addEventListener('click', function () { setOrder(o, { paid_at: null, paid_amount: null }); });
        actions.appendChild(unpay);
      }
      li.appendChild(actions);
      ul.appendChild(li);
    });
  }
  async function setOrder(o, patch) {
    var r = await sb.from('orders').update(patch).eq('id', o.id);
    if (lostSession(r.error)) return;
    if (r.error) { note('queue-msg', 'That did not save. Try again.', 'bad'); return; }
    loadOrders();
  }

  /* ---------- fix how a guest framed a photo ---------- */
  var fixEditor = C.attachEditor($('fix-canvas'), function () { return state.fixing ? state.fixing.item : null; }, function () { fixButtons(); });
  function fixButtons() {
    var it = state.fixing && state.fixing.item; if (!it) return;
    $('fix-out').disabled = it.zoom <= 1.001; $('fix-in').disabled = it.zoom >= 2.999;
    $('fix-zoom').value = it.zoom;
  }
  function closeFix() { state.fixing = null; $('fix').hidden = true; }
  async function openFix(order, photo) {
    note('fix-msg', '');
    $('fix-who').textContent = 'Order #' + order.order_no + ' for ' + order.guest_name + (photo.printed_at ? '. Already printed, so print the order again after saving.' : '');
    try {
      var pic = await photoPic(photo.path), f = framing(photo);
      state.fixing = { order: order, photo: photo, item: { img: pic.img, iw: pic.iw, ih: pic.ih, zoom: f.zoom, cx: f.cx, cy: f.cy } };
      C.normalize(state.fixing.item);
      $('fix').hidden = false;
      fixEditor.draw(); fixButtons();
    } catch (err) { note('queue-msg', 'That photo could not be opened. Check the connection and try again.', 'bad'); }
  }
  function fixZoom(step) {
    var it = state.fixing && state.fixing.item; if (!it) return;
    it.zoom = C.clamp(Math.round((it.zoom + step) * 100) / 100, 1, 3);
    C.normalize(it); fixEditor.draw(); fixButtons();
  }
  $('fix-zoom').addEventListener('input', function () {
    var it = state.fixing && state.fixing.item; if (!it) return;
    it.zoom = C.clamp(parseFloat(this.value) || 1, 1, 3);
    C.normalize(it); fixEditor.draw();
    $('fix-out').disabled = it.zoom <= 1.001; $('fix-in').disabled = it.zoom >= 2.999;
  });
  $('fix-in').addEventListener('click', function () { fixZoom(0.25); });
  $('fix-out').addEventListener('click', function () { fixZoom(-0.25); });
  $('fix-reset').addEventListener('click', function () {
    var it = state.fixing && state.fixing.item; if (!it) return;
    it.zoom = 1; it.cx = 0.5; it.cy = 0.5; C.normalize(it); fixEditor.draw(); fixButtons();
  });
  $('fix-cancel').addEventListener('click', closeFix);
  $('fix').addEventListener('click', function (e) { if (e.target === this) closeFix(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.fixing) closeFix(); });
  $('fix-save').addEventListener('click', async function () {
    var fx = state.fixing; if (!fx) return;
    var btn = this, it = fx.item; btn.disabled = true; note('fix-msg', 'Saving.');
    var r = await sb.from('order_photos').update({ crop_zoom: it.zoom, crop_x: it.cx, crop_y: it.cy }).eq('id', fx.photo.id);
    btn.disabled = false;
    if (lostSession(r.error)) { closeFix(); return; }
    if (r.error) { note('fix-msg', 'That did not save. Check the connection and try again.', 'bad'); return; }
    closeFix(); discardPending();
    await loadOrders();
  });

  /* ---------- after the event ---------- */
  var purgeMode = 'purge';
  function purgeReset() { $('purge-confirm').hidden = true; $('purge-open').hidden = false; $('remove-open').hidden = false; }
  function purgeAsk(mode) {
    purgeMode = mode;
    var n = state.orders.length;
    $('purge-text').textContent = mode === 'remove'
      ? 'This removes the event from your list and permanently deletes ' + plural(n, 'order') + ' and every uploaded photo. The QR code for it stops working. It cannot be undone.'
      : 'This closes the event and permanently deletes ' + plural(n, 'order') + ' and every uploaded photo. It cannot be undone.';
    $('purge-confirm').hidden = false; $('purge-open').hidden = true; $('remove-open').hidden = true; note('purge-msg', '');
  }
  $('purge-open').addEventListener('click', function () { purgeAsk('purge'); });
  $('remove-open').addEventListener('click', function () { purgeAsk('remove'); });
  $('purge-no').addEventListener('click', purgeReset);
  $('purge-yes').addEventListener('click', async function () {
    var ev = state.event, btn = this; if (!ev || state.busy) return;
    state.busy = true; btn.disabled = true; discardPending();
    var say = function (t) { note('purge-msg', t); };
    try {
      if (purgeMode === 'remove') {
        stopPolling();
        await removeEvent(ev, say);
        state.busy = false; btn.disabled = false; purgeReset();
        state.event = null;
        await loadEvents(); show('view-events');
        note('events-msg', '"' + ev.name + '" was removed.', 'good');
        return;
      }
      var out = await purgeEvent(ev, say);
      state.event = out.event; renderStatus();
      state.blobs.forEach(function (pr) { pr.then(function (b) { URL.revokeObjectURL(b.url); }).catch(function () {}); });
      state.blobs = new Map(); state.pics = new Map(); state.sig = ''; state.known = null; clearNew();
      await loadOrders();
      note('purge-msg', 'Done. ' + (out.removed === 1 ? '1 photo was' : out.removed + ' photos were') + ' deleted along with the orders.', 'good');
    } catch (err) {
      if (!lostSession(err)) note('purge-msg', STOPPED, 'bad');
      if (purgeMode === 'remove' && state.event && !state.timer) state.timer = setInterval(function () { if (!document.hidden) loadOrders(); }, 5000);
    }
    state.busy = false; btn.disabled = false; purgeReset();
  });

  /* ---------- print sheets ---------- */
  function pickOneSheet(rows, per) {
    var out = [], n = 0;
    for (var i = 0; i < rows.length && n < per; i++) {
      if (n + rows[i].photo.qty <= per) { out.push(rows[i]); n += rows[i].photo.qty; }
    }
    return out.length ? out : rows.slice(0, 1);
  }
  async function buildPdf(rows) {
    var slots = [], images = {};
    rows.forEach(function (r) { for (var i = 0; i < r.photo.qty; i++) slots.push(r); });
    for (var k = 0; k < rows.length; k++) {
      var pic = await photoPic(rows[k].photo.path), c = document.createElement('canvas');
      c.width = c.height = Math.round(T.photo * 300);
      drawFramed(c, pic, framing(rows[k].photo));
      images[rows[k].photo.id] = c.toDataURL('image/jpeg', 0.92);
    }
    var stamp = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return Sheet.buildPdf(T, slots, {
      image: function (r) { return images[r.photo.id]; },
      key: function (r) { return r.photo.id; },
      label: function (r) { return '#' + r.order.order_no + ' ' + r.order.guest_name; }
    }, state.event.name + '  |  ' + stamp);
  }
  var HINT_BEFORE = 'Opening the PDF marks these magnets as printed, so they will not print twice.';
  var HINT_AFTER = 'Marked as printed. Print at 100% (Actual size). If the print fails, print again from the PDF tab, or use the buttons on the order.';
  function discardPending() {
    if (state.pending) { URL.revokeObjectURL(state.pending.url); state.pending = null; }
    $('ready').hidden = true;
  }
  async function makeSheets(mode, order) {
    if (state.busy) return;
    if (!window.jspdf) { note('print-msg', 'The PDF tool did not load. Reload the page.', 'bad'); return; }
    var rows;
    if (mode === 'order') rows = order.order_photos.map(function (p) { return { order: order, photo: p }; });
    else { rows = waitingRows(); if (mode === 'one') rows = pickOneSheet(rows, layout().per); }
    if (!rows.length) return;
    state.busy = true; discardPending();
    note('print-msg', 'Building the PDF.');
    try {
      var out = await buildPdf(rows), url = URL.createObjectURL(out.blob);
      state.pending = { rows: rows, url: url, marked: false };
      $('ready-text').textContent = 'Ready: ' + (mode === 'order' ? 'order #' + order.order_no + ' for ' + order.guest_name + ', ' : '') +
        plural(out.magnets, 'magnet') + ' on ' + plural(out.sheets, 'sheet') + '.';
      $('ready-open').href = url; $('ready-open').textContent = 'Open PDF to print';
      $('ready-save').href = url; $('ready-save').download = 'sona-sheets-' + Date.now() + '.pdf';
      $('ready-hint').textContent = HINT_BEFORE;
      $('ready-discard').hidden = false; $('ready-mark').hidden = true; $('ready-done').hidden = true;
      $('ready').hidden = false;
      note('print-msg', '');
      $('ready').scrollIntoView({ block: 'center', behavior: 'smooth' });
    } catch (err) {
      if (!lostSession(err)) note('print-msg', 'The PDF could not be built. Check the connection and try again.', 'bad');
    }
    state.busy = false;
  }
  async function markPending() {
    var pend = state.pending; if (!pend || pend.marked) return;
    pend.marked = true;
    $('ready-discard').hidden = true; $('ready-done').hidden = false;
    $('ready-open').textContent = 'Open PDF again';
    $('ready-hint').textContent = HINT_AFTER;
    var ids = pend.rows.map(function (r) { return r.photo.id; });
    var r1 = await sb.from('order_photos').update({ printed_at: new Date().toISOString() }).in('id', ids);
    if (r1.error) {
      pend.marked = false;
      if (lostSession(r1.error)) return;
      $('ready-mark').hidden = false;
      $('ready-hint').textContent = 'The PDF opened, but these could not be marked as printed. Press Mark these as printed once the connection is back.';
      return;
    }
    $('ready-mark').hidden = true;
    var finished = [];
    pend.rows.forEach(function (r) {
      var o = r.order;
      if (o.status === 'new' && finished.indexOf(o.id) < 0 && o.order_photos.every(function (p) { return p.printed_at || ids.indexOf(p.id) >= 0; })) finished.push(o.id);
    });
    if (finished.length) await sb.from('orders').update({ status: 'printed' }).in('id', finished).eq('status', 'new');
    await loadOrders();
  }
  $('print-one').addEventListener('click', function () { makeSheets('one'); });
  $('print-all').addEventListener('click', function () { makeSheets('all'); });
  /* The links open or save the PDF by themselves; marking happens alongside. */
  $('ready-open').addEventListener('click', function () { markPending(); });
  $('ready-save').addEventListener('click', function () { markPending(); });
  $('ready-mark').addEventListener('click', function () { markPending(); });
  $('ready-discard').addEventListener('click', function () { discardPending(); renderOrders(); });
  $('ready-done').addEventListener('click', function () { $('ready').hidden = true; renderOrders(); });

  /* ---------- start ---------- */
  if (!window.supabase) { show('view-login'); note('login-msg', 'The page did not finish loading. Check the connection and reload.', 'bad'); return; }
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  sb.auth.onAuthStateChange(function (event) { if (event === 'SIGNED_OUT' && $('view-login').hidden) signedOut('You were signed out. Please sign in again.'); });
  sb.auth.getSession().then(function (r) { route(r.data.session); }).catch(function () { show('view-login'); });
})();
