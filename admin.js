/* Staff page: sign in, manage events, show the QR code, watch the queue, make print sheets. */
(function () {
  'use strict';
  var CFG = window.SONA, Sheet = window.SonaSheet, C = window.SonaCommon, T = Sheet.template(CFG.template);
  var $ = function (id) { return document.getElementById(id); };
  var VIEWS = ['view-loading', 'view-login', 'view-denied', 'view-events', 'view-event'];
  var state = {
    events: [], event: null, orders: [], sig: '', timer: null, blobs: new Map(), pending: null, busy: false,
    known: null, fresh: {}, unseen: 0, filter: 'todo', query: '', sound: false, audio: null, pics: new Map(), fixing: null,
    kind: 'market', overlay: null, loadSeq: 0, channel: null, kick: null
  };
  var sb = null;
  /* Each phone or computer gets its own id, so two devices never put the same magnets on two sheets. */
  var DEVICE = (function () {
    var id = null;
    try { id = localStorage.getItem('sona-device'); } catch (err) {}
    if (!id || id.length < 8) { id = 'dev-' + C.uuid(); try { localStorage.setItem('sona-device', id); } catch (err) {} }
    return id.slice(0, 64);
  })();
  var HOLD_MS = 5 * 60 * 1000;
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
  function signUrl(ev) {
    return '/sign.html?sign=qr&slug=' + encodeURIComponent(ev.slug) + '&name=' + encodeURIComponent(ev.name) + (ev.kind === 'private' ? '&kind=private' : '');
  }
  /* Database times carry more decimals than some phone browsers accept. */
  function when(s) { var t = Date.parse(String(s || '').replace(/(\.\d{3})\d+/, '$1')); return isNaN(t) ? 0 : t; }
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
    if (error.status === 401 || /JWT|PGRST301|PGRST303|not authenticated|invalid.*token/i.test(m)) {
      /* A sign-in pass runs out every hour and is renewed quietly. Only when it truly cannot be renewed
         is this device sent back to the sign-in form, and only this device. */
      if (!auth.dead) return false;
      sb.auth.signOut({ scope: 'local' }).catch(function () {});
      signedOut('You were signed out. Please sign in again.');
      return true;
    }
    return false;
  }
  /* ---------- staying signed in ---------- */
  var auth = { dead: false, renewing: null };
  function renewPass() {
    if (!auth.renewing) {
      auth.renewing = sb.auth.refreshSession().then(function (r) {
        auth.renewing = null;
        var session = r && r.data && r.data.session;
        if (session) { auth.dead = false; return session.access_token; }
        var e = (r && r.error) || {}, offline = e.name === 'AuthRetryableFetchError' || e.status === 0 || e.status >= 500 || /fetch|network/i.test(String(e.message || ''));
        if (!offline) auth.dead = true;
        return null;
      }, function () { auth.renewing = null; return null; });
    }
    return auth.renewing;
  }
  /* If the server says the pass has run out, renew it and send the same request again, so nobody notices. */
  function staffFetch(input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    function again(res) {
      return renewPass().then(function (token) {
        if (!token) return res;
        var headers = new Headers((init && init.headers) || {});
        headers.set('Authorization', 'Bearer ' + token);
        return fetch(input, Object.assign({}, init, { headers: headers }));
      });
    }
    return fetch(input, init).then(function (res) {
      if (!sb || /\/auth\/v1\//.test(url)) return res;
      if (res.status === 401) return again(res);
      if ((res.status === 400 || res.status === 403) && /\/storage\/v1\//.test(url)) {
        return res.clone().text().then(function (t) { return /jwt|expired/i.test(t) ? again(res) : res; }, function () { return res; });
      }
      return res;
    });
  }
  /* Renew a little early, and straight away when the phone wakes up or the tab comes back. */
  function keepSignedIn() {
    if (!sb || !$('view-login').hidden) return;
    sb.auth.getSession().then(function (r) {
      var session = r && r.data && r.data.session;
      if (session && session.expires_at && session.expires_at * 1000 - Date.now() < 10 * 60 * 1000) renewPass();
    }, function () {});
  }
  setInterval(keepSignedIn, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) keepSignedIn(); });
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
    auth.dead = false;
    route(res.data.session);
  });
  $('signout').addEventListener('click', async function () { stopPolling(); await sb.auth.signOut({ scope: 'local' }).catch(function () {}); signedOut(''); });
  $('back').addEventListener('click', async function () { discardPending(); state.event = null; await loadEvents(); show('view-events'); });

  /* ---------- deleting an event's photos and orders ---------- */
  /* Print sheets saved for opening on a phone. olderThan 0 removes all of them. */
  async function clearSheets(eventId, olderThan) {
    for (var round = 0; round < 20; round++) {
      var list = await sb.storage.from('sheets').list(eventId, { limit: 100 });
      if (list.error) throw list.error;
      var old = (list.data || []).filter(function (f) { return f.name && (!olderThan || Date.now() - when(f.created_at) > olderThan); });
      if (!old.length) return;
      var del = await sb.storage.from('sheets').remove(old.map(function (f) { return eventId + '/' + f.name; }));
      if (del.error) throw del.error;
      if ((list.data || []).length < 100) return;
    }
  }
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
    /* the saved print sheets have the photos on them too */
    await clearSheets(ev.id, 0);
    var gone = await sb.from('orders').delete().eq('event_id', ev.id);
    if (gone.error) throw gone.error;
    return { removed: removed, event: closed.data };
  }
  async function removeEvent(ev, say) {
    var out = await purgeEvent(ev, say);
    say('Removing the event.');
    var files = await sb.storage.from('overlays').list(ev.id, { limit: 100 });
    if (!files.error && files.data && files.data.length) {
      await sb.storage.from('overlays').remove(files.data.map(function (f) { return ev.id + '/' + f.name; }));
    }
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
    renderEvents();
  }
  function kindOf(ev) { return ev.kind === 'private' ? 'private' : 'market'; }
  function priced() { return !state.event || state.event.show_prices !== false; }
  function renderEvents() {
    var special = state.kind === 'private';
    var count = { market: 0, 'private': 0 };
    state.events.forEach(function (ev) { count[kindOf(ev)]++; });
    Array.prototype.forEach.call(document.querySelectorAll('.seg button[data-kind]'), function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.kind === state.kind));
      b.textContent = (b.dataset.kind === 'private' ? 'Special events' : 'Markets') + ' (' + count[b.dataset.kind] + ')';
    });
    $('new-title').textContent = special ? 'New special event' : 'New market';
    $('new-note').hidden = !special;
    $('list-title').textContent = special ? 'Your special events' : 'Your markets';
    $('ev-name').placeholder = special ? 'Taylor and Jordan wedding' : 'South of the James Market';
    $('ev-welcome').placeholder = special ? 'Pick up your magnets before the end of the event.' : 'Made in 10-15 minutes while you shop around.';
    var ul = $('events'); ul.replaceChildren();
    var mine = state.events.filter(function (ev) { return kindOf(ev) === state.kind; });
    mine.forEach(function (ev) {
      var li = el('li', 'card soft');
      var left = el('div');
      left.appendChild(el('h3', null, ev.name));
      left.appendChild(el('p', 'note', 'Created ' + new Date(when(ev.created_at)).toLocaleDateString() + ', up to ' + ev.max_magnets + ' magnets per order' + (ev.overlay_path ? ', with an overlay' : '')));
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
    note('events-msg', mine.length ? '' : special ? 'No special events yet. Create one on the left, then import its overlay.' : 'No markets yet. Create your first one on the left.');
  }
  Array.prototype.forEach.call(document.querySelectorAll('.seg button[data-kind]'), function (b) {
    b.addEventListener('click', function () { state.kind = b.dataset.kind; note('event-msg', ''); renderEvents(); });
  });
  $('event-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var name = $('ev-name').value.trim(), max = parseInt($('ev-max').value, 10);
    if (!name) { note('event-msg', 'Give the event a name.', 'bad'); return; }
    if (!(max >= 1 && max <= 100)) { note('event-msg', 'Magnets per order must be between 1 and 100.', 'bad'); return; }
    var btn = $('event-btn'); btn.disabled = true; note('event-msg', 'Creating the event.');
    var res = await sb.from('events').insert({ name: name, slug: slugify(name), max_magnets: max, welcome: $('ev-welcome').value.trim(), ask_contact: $('ev-contact').checked, kind: state.kind, show_prices: state.kind !== 'private' }).select().single();
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
    $('sign-qr').href = signUrl(ev);
    $('set-name').value = ev.name; $('set-max').value = ev.max_magnets;
    $('set-welcome').value = ev.welcome || ''; $('set-contact').checked = !!ev.ask_contact;
    $('set-prices').checked = ev.show_prices !== false;
    var special = kindOf(ev) === 'private';
    Array.prototype.forEach.call(document.querySelectorAll('#view-event .market-only'), function (b) { b.hidden = special; });
    $('st-unpaid').parentNode.hidden = !priced(); $('st-collected').parentNode.hidden = !priced();
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
    clearSheets(ev.id, 24 * 3600 * 1000).catch(function () {});
    renderEventInfo(); renderStatus();
    $('overlay-fold').open = kindOf(ev) === 'private';
    loadOverlay(ev);
    purgeReset(); note('purge-msg', ''); note('settings-msg', '');
    $('orders').replaceChildren(); $('orders-empty').textContent = '';
    note('print-msg', ''); note('queue-msg', 'Loading orders.');
    show('view-event');
    $('page-title').textContent = ev.name;
    loadOrders();
    stopPolling();
    startPolling();
  }
  /* Two ways of staying in step with the other devices: the server tells this page the moment
     something changes, and the page also re-checks by itself every few seconds in case that is missed. */
  function startPolling() {
    var ev = state.event; if (!ev) return;
    if (!state.timer) state.timer = setInterval(function () { if (!document.hidden) loadOrders(); }, 4000);
    if (state.channel || !sb.channel) return;
    try {
      var kick = function () { clearTimeout(state.kick); state.kick = setTimeout(loadOrders, 250); };
      state.channel = sb.channel('event-' + ev.id)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: 'event_id=eq.' + ev.id }, kick)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'order_photos' }, kick)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'events', filter: 'id=eq.' + ev.id }, kick)
        .subscribe();
    } catch (err) { state.channel = null; }
  }
  function stopPolling() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    clearTimeout(state.kick);
    if (state.channel) { try { sb.removeChannel(state.channel); } catch (err) {} state.channel = null; }
  }
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
  $('settings-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var ev = state.event; if (!ev) return;
    var name = $('set-name').value.trim(), max = parseInt($('set-max').value, 10);
    if (!name) { note('settings-msg', 'The event needs a name.', 'bad'); return; }
    if (!(max >= 1 && max <= 100)) { note('settings-msg', 'Magnets per order must be between 1 and 100.', 'bad'); return; }
    var btn = $('settings-btn'); btn.disabled = true;
    var res = await sb.from('events').update({ name: name, max_magnets: max, welcome: $('set-welcome').value.trim(), ask_contact: $('set-contact').checked, show_prices: $('set-prices').checked }).eq('id', ev.id).select().single();
    btn.disabled = false;
    if (lostSession(res.error)) return;
    if (res.error) { note('settings-msg', 'The settings did not save. Try again.', 'bad'); return; }
    state.event = res.data; renderEventInfo(); renderOrders();
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
  /* The event itself can change on another device: closed, renamed, a new overlay, even removed. */
  async function syncEvent(row) {
    var old = state.event;
    if (!row) {
      if (state.busy) return false;
      stopPolling(); discardPending(true); state.event = null;
      await loadEvents(); show('view-events');
      note('events-msg', '"' + old.name + '" was removed on another device.');
      return false;
    }
    if (JSON.stringify(row) === JSON.stringify(old)) return true;
    state.event = row;
    if (old.status !== row.status) renderStatus();
    if (!$('settings-form').contains(document.activeElement)) renderEventInfo();
    if (old.show_prices !== row.show_prices || old.max_magnets !== row.max_magnets) state.sig = '';
    var moved = old.overlay_path !== row.overlay_path || Number(old.overlay_scale) !== Number(row.overlay_scale) ||
      Number(old.overlay_x) !== Number(row.overlay_x) || Number(old.overlay_y) !== Number(row.overlay_y);
    if (moved) { await loadOverlay(row); note('ov-msg', 'The overlay was changed on another device.'); }
    return true;
  }
  function heldElsewhere(p) {
    return !p.printed_at && p.claimed_at && p.claimed_by && p.claimed_by !== DEVICE && Date.now() - when(p.claimed_at) < HOLD_MS;
  }
  async function loadOrders() {
    var ev = state.event; if (!ev) return;
    var seq = ++state.loadSeq;
    var both = await Promise.all([
      sb.from('orders')
        .select('id, order_no, guest_name, contact, note, status, created_at, paid_at, paid_amount, order_photos(id, path, qty, printed_at, created_at, crop_zoom, crop_x, crop_y, claimed_at, claimed_by)')
        .eq('event_id', ev.id).order('order_no', { ascending: true }),
      sb.from('events').select('*').eq('id', ev.id).maybeSingle()
    ]);
    var res = both[0], evRes = both[1];
    if (seq !== state.loadSeq || !state.event || state.event.id !== ev.id) return;
    if (lostSession(res.error)) return;
    if (res.error) { note('queue-msg', 'No connection. Trying again.', 'bad'); return; }
    if (!evRes.error && !(await syncEvent(evRes.data))) return;
    if (seq !== state.loadSeq || !state.event) return;
    res.data.forEach(function (o) { o.order_photos.sort(byCreated); });
    if (state.known) {
      var fresh = res.data.filter(function (o) { return !state.known[o.id]; });
      if (fresh.length) { fresh.forEach(function (o) { state.fresh[o.id] = true; }); announce(fresh); }
    }
    state.known = {};
    res.data.forEach(function (o) { state.known[o.id] = true; });
    var sig = JSON.stringify(res.data);
    state.orders = res.data;
    checkPending();
    /* a hold on another device runs out with time, so redraw while any is showing */
    var holds = res.data.some(function (o) { return o.order_photos.some(function (p) { return !p.printed_at && p.claimed_at && p.claimed_by !== DEVICE; }); });
    if (sig !== state.sig || holds) { state.sig = sig; renderOrders(); }
    note('queue-msg', 'In step with your other devices.');
  }
  /* A sheet built here but not opened yet: keep its magnets reserved, and drop it if another device got there first. */
  function checkPending() {
    var pend = state.pending; if (!pend || pend.marked) return;
    var now = {};
    state.orders.forEach(function (o) { o.order_photos.forEach(function (p) { now[p.id] = p; }); });
    var lost = pend.rows.some(function (r) {
      var p = now[r.photo.id];
      return !p || (pend.claimed.indexOf(r.photo.id) >= 0 && (p.printed_at || heldElsewhere(p)));
    });
    if (lost) {
      discardPending();
      note('print-msg', 'Another device printed or changed some of those magnets, so that sheet was cancelled. Nothing is lost: press the print button again.', 'bad');
      return;
    }
    if (pend.claimed.length && Date.now() - pend.claimedAt > 60000) {
      pend.claimedAt = Date.now();
      sb.rpc('claim_photos', { p_ids: pend.claimed, p_device: DEVICE }).then(function () {}, function () {});
    }
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
    C.drawOverlay(g, state.overlay, 0, 0, canvas.width);
  }
  function waitingRows() {
    var rows = [];
    state.orders.forEach(function (o) {
      if (o.status === 'done') return;
      o.order_photos.forEach(function (p) { if (!p.printed_at && !heldElsewhere(p) && !onMySheet(p)) rows.push({ order: o, photo: p }); });
    });
    return rows;
  }
  /* On the sheet this device has built but not opened yet. */
  function onMySheet(p) {
    var pend = state.pending;
    return !!pend && !pend.marked && !p.printed_at && pend.claimed.indexOf(p.id) >= 0;
  }
  function mineCount() {
    var n = 0;
    state.orders.forEach(function (o) { if (o.status !== 'done') o.order_photos.forEach(function (p) { if (onMySheet(p)) n += p.qty; }); });
    return n;
  }
  function tally(rows) { return rows.reduce(function (n, r) { return n + r.photo.qty; }, 0); }
  /* Magnets sitting on a sheet that another device is printing right now. */
  function heldCount() {
    var n = 0;
    state.orders.forEach(function (o) { if (o.status !== 'done') o.order_photos.forEach(function (p) { if (heldElsewhere(p)) n += p.qty; }); });
    return n;
  }
  /* The oldest waiting magnets that fill whole sheets with no empty squares. Photos are never split:
     if the count is not a multiple of a sheet, the newest ones that make up the difference wait. */
  function fullSheetRows(rows, per) {
    var total = tally(rows), n = rows.length, cap = Math.min(total, 240);
    if (total < per) return [];
    var reach = [new Uint8Array(cap + 1)], i, s;
    reach[0][0] = 1;
    for (i = 0; i < n; i++) {
      var q = rows[i].photo.qty, prev = reach[i], next = new Uint8Array(prev);
      for (s = q; s <= cap; s++) if (prev[s - q]) next[s] = 1;
      reach.push(next);
    }
    var drop = -1;
    for (s = total % per; s <= cap; s += per) if (reach[n][s]) { drop = s; break; }
    if (drop < 0 || drop === total) return [];
    var keep = [];
    for (i = n - 1; i >= 0; i--) {
      var qty = rows[i].photo.qty;
      if (drop >= qty && reach[i][drop - qty]) drop -= qty; else keep.unshift(rows[i]);
    }
    return keep;
  }
  function renderSheetMeter() {
    var per = layout().per, rows = waitingRows(), waiting = tally(rows), full = tally(fullSheetRows(rows, per));
    var sheets = full / per, rest = waiting - full, held = heldCount(), mine = mineCount(), special = state.event && kindOf(state.event) === 'private';
    var shown = full ? per : waiting % per, cells = $('mini').children;
    for (var i = 0; i < cells.length; i++) cells[i].className = i < shown ? 'on' : '';
    $('mini').className = 'minisheet' + (full ? ' full' : '');
    var missing = (per - rest % per) % per, text;
    if (!waiting) text = mine ? 'Nothing else is waiting to print.' : 'Nothing is waiting to print.';
    else if (full) text = plural(sheets, 'full sheet') + ' ready (' + plural(full, 'magnet') + ').' + (rest ? ' ' + rest + ' more waiting, ' + missing + ' short of the next sheet.' : '');
    else if (waiting < per) text = waiting + ' of ' + per + ' waiting. ' + missing + ' more ' + (missing === 1 ? 'fills' : 'fill') + ' the sheet.';
    else text = plural(waiting, 'magnet') + ' waiting. ' + missing + ' more ' + (missing === 1 ? 'fills' : 'fill') + ' the last sheet.';
    $('sheet-text').textContent = text;
    $('sheet-held').textContent = [
      mine ? plural(mine, 'magnet') + (mine === 1 ? ' is' : ' are') + ' on your sheet below, ready to open.' : '',
      held ? plural(held, 'magnet') + (held === 1 ? ' is' : ' are') + ' on a sheet another device is printing right now.' : ''
    ].filter(Boolean).join(' ');
    var one = $('print-one'), all = $('print-all');
    /* one sheet at a time on each device: open or cancel the ready one first */
    one.disabled = !full || mine > 0; all.disabled = mine > 0;
    one.textContent = full ? 'Print ' + plural(sheets, 'full sheet') + ' (' + plural(full, 'magnet') + ')' : 'No full sheet yet';
    one.className = 'btn' + (full ? ' primary' : '');
    all.hidden = !rest;
    all.textContent = full || waiting > per ? 'Print everything waiting (' + plural(waiting, 'magnet') + ', ' + plural(Math.ceil(waiting / per), 'sheet') + ')'
      : 'Print ' + (waiting === 1 ? 'this 1' : 'these ' + waiting) + ' now (part of a sheet)';
    all.className = 'btn' + (!full && !special ? ' primary' : '');
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
    var waiting = tally(waitingRows()) + heldCount() + mineCount(), printedCount = 0;
    state.orders.forEach(function (o) { o.order_photos.forEach(function (p) { if (p.printed_at) printedCount += p.qty; }); });
    var doneCount = state.orders.filter(function (o) { return o.status === 'done'; }).length;
    $('st-waiting').textContent = waiting;
    $('st-printed').textContent = printedCount;
    renderSheetMeter();
    $('st-orders').textContent = state.orders.length;
    $('st-done').textContent = doneCount;
    var unpaid = 0, collected = 0;
    state.orders.forEach(function (o) { if (o.paid_at) collected += Number(o.paid_amount) || 0; else unpaid++; });
    $('st-unpaid').textContent = unpaid;
    $('st-collected').textContent = C.money(collected);
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
      var money = priced();
      var cost = o.paid_at && o.paid_amount != null ? Number(o.paid_amount) : C.priceFor(count);
      if (money && cost != null) meta.appendChild(el('strong', 'price', C.money(cost)));
      if (money) meta.appendChild(el('span', 'chip ' + (o.paid_at ? 'paid' : 'unpaid'), o.paid_at ? 'Paid' : 'Not paid'));
      meta.appendChild(el('span', 'note', plural(count, 'magnet') + ', ' + new Date(when(o.created_at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
      var label = o.status === 'new' ? 'Waiting to print' : o.status === 'printed' ? 'Printed' : 'Picked up';
      var busyElsewhere = o.status === 'new' && o.order_photos.some(heldElsewhere);
      meta.appendChild(el('span', 'chip ' + (busyElsewhere ? 'held' : o.status), busyElsewhere ? 'Printing on another device' : label));
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
      if (money && !o.paid_at) {
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
          var r = await sb.from('order_photos').update({ printed_at: null, claimed_at: null, claimed_by: null }).eq('order_id', o.id);
          if (lostSession(r.error)) return;
          if (r.error) { note('queue-msg', 'That did not save. Try again.', 'bad'); return; }
          setOrder(o, { status: 'new' });
        });
        actions.appendChild(again);
      }
      if (money && o.paid_at) {
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
  var fixEditor = C.attachEditor($('fix-canvas'), function () { return state.fixing ? state.fixing.item : null; }, function () { fixButtons(); }, function () { return state.overlay; });
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

  /* ---------- overlay: a picture printed on top of every magnet ---------- */
  var ov = null, ovSample = null;   /* ov is the copy being edited; state.overlay is the saved one */
  function decodeBlob(blob) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { resolve({ img: img, iw: img.naturalWidth, ih: img.naturalHeight }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('DECODE')); };
      img.src = url;
    });
  }
  function samplePhoto() {
    var c = document.createElement('canvas'); c.width = c.height = 600;
    var g = c.getContext('2d'), sky = g.createLinearGradient(0, 0, 0, 600);
    sky.addColorStop(0, '#BFE3E4'); sky.addColorStop(1, '#FBD3DC');
    g.fillStyle = sky; g.fillRect(0, 0, 600, 600);
    g.fillStyle = '#F6BC2F'; g.beginPath(); g.arc(440, 170, 70, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#5CA3A7'; g.beginPath(); g.moveTo(0, 600); g.lineTo(0, 430);
    g.quadraticCurveTo(170, 330, 330, 440); g.quadraticCurveTo(470, 520, 600, 400); g.lineTo(600, 600); g.fill();
    return { img: c, iw: 600, ih: 600, zoom: 1, cx: 0.5, cy: 0.5 };
  }
  function drawOv() {
    var cv = $('ov-canvas'), g = cv.getContext('2d'), n = cv.width;
    if (!ovSample) ovSample = samplePhoto();
    g.clearRect(0, 0, n, n);
    C.drawCrop(g, ovSample, 0, 0, n);
    C.drawOverlay(g, ov, 0, 0, n);
    C.drawGuides(g, n);
  }
  function renderOverlay() {
    var has = !!ov;
    $('ov-canvas').hidden = !has; $('ov-tools').hidden = !has;
    $('ov-save').hidden = !(has && ov.dirty);
    $('ov-undo').hidden = !(has && ov.dirty);
    $('ov-remove').hidden = !(state.event && state.event.overlay_path);
    $('ov-file-label').textContent = has ? 'Use a different overlay' : 'Import an overlay';
    $('ov-file-label').className = 'btn small' + (has ? '' : ' primary');
    if (has) { $('ov-size').value = ov.scale; drawOv(); }
  }
  function editCopy() {
    var s = state.overlay;
    ov = s ? { img: s.img, iw: s.iw, ih: s.ih, scale: s.scale, cx: s.cx, cy: s.cy, blob: null, dirty: false } : null;
  }
  /* The thumbnails, the fix window and the sheets all draw the saved overlay. */
  function overlayChanged() {
    discardPending();
    if (state.known) renderOrders();
  }
  async function loadOverlay(ev) {
    state.overlay = null; ov = null; note('ov-msg', ''); renderOverlay();
    if (!ev.overlay_path) return;
    try {
      var r = await sb.storage.from('overlays').download(ev.overlay_path);
      if (r.error) throw r.error;
      var pic = await decodeBlob(r.data);
      if (!state.event || state.event.id !== ev.id) return;
      state.overlay = {
        img: pic.img, iw: pic.iw, ih: pic.ih, scale: Number(ev.overlay_scale) || 1,
        cx: ev.overlay_x == null ? 0.5 : Number(ev.overlay_x), cy: ev.overlay_y == null ? 0.5 : Number(ev.overlay_y)
      };
      editCopy(); renderOverlay(); overlayChanged();
    } catch (err) {
      if (!lostSession(err)) note('ov-msg', 'The overlay could not load. Check the connection, then go back and open the event again.', 'bad');
    }
  }
  function ovTouched() { ov.dirty = true; note('ov-msg', 'Not saved yet. Press Save overlay when it looks right.'); renderOverlay(); }
  $('ov-file').addEventListener('change', async function () {
    var f = this.files && this.files[0]; this.value = '';
    if (!f || !state.event) return;
    if (!/^image\/(png|webp|jpeg)$/.test(f.type)) { note('ov-msg', 'That file type does not work as an overlay. Use a PNG picture. In Canva, download as PNG with Transparent background ticked.', 'bad'); return; }
    try {
      var pic = await decodeBlob(f), k = Math.min(1, 1600 / Math.max(pic.iw, pic.ih));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(pic.iw * k)); c.height = Math.max(1, Math.round(pic.ih * k));
      c.getContext('2d').drawImage(pic.img, 0, 0, c.width, c.height);
      /* does any of it let the photo show through? */
      var t = document.createElement('canvas'); t.width = t.height = 48;
      var tg = t.getContext('2d'); tg.drawImage(c, 0, 0, 48, 48);
      var px = tg.getImageData(0, 0, 48, 48).data, clear = false;
      for (var i = 3; i < px.length; i += 4) if (px[i] < 245) { clear = true; break; }
      var blob = await new Promise(function (resolve) { c.toBlob(resolve, 'image/png'); });
      if (!blob) throw new Error('ENCODE');
      ov = { img: c, iw: c.width, ih: c.height, scale: 1, cx: 0.5, cy: 0.5, blob: blob, dirty: true };
      renderOverlay();
      note('ov-msg', clear ? 'Drag it into place and set the size, then press Save overlay.'
        : 'This picture has no see-through areas, so it covers the photo wherever it sits. Shrink it into a corner, or import a PNG with a transparent background. Not saved yet.', clear ? '' : 'bad');
    } catch (err) { note('ov-msg', 'That picture could not be opened. Try a PNG file.', 'bad'); }
  });
  $('ov-test').addEventListener('change', async function () {
    var f = this.files && this.files[0]; this.value = '';
    if (!f) return;
    try {
      var pic = await C.loadPhoto(f);
      ovSample = { img: pic.img, iw: pic.iw, ih: pic.ih, zoom: 1, cx: 0.5, cy: 0.5 };
      C.normalize(ovSample); if (ov) drawOv();
    } catch (err) { note('ov-msg', 'That photo could not be opened. Try another one.', 'bad'); }
  });
  $('ov-size').addEventListener('input', function () { if (!ov) return; ov.scale = C.clamp(parseFloat(this.value) || 1, 0.1, 2); ovTouched(); });
  $('ov-fit').addEventListener('click', function () { if (!ov) return; ov.scale = 1; ov.cx = 0.5; ov.cy = 0.5; ovTouched(); });
  $('ov-centre').addEventListener('click', function () { if (!ov) return; ov.cx = 0.5; ov.cy = 0.5; ovTouched(); });
  $('ov-undo').addEventListener('click', function () { editCopy(); note('ov-msg', ''); renderOverlay(); });
  (function () {
    var cv = $('ov-canvas'), last = null;
    function face() { return cv.getBoundingClientRect().width * CFG.crop.face / CFG.crop.photo; }
    function nudge(dx, dy) { ov.cx = C.clamp(ov.cx + dx, -0.5, 1.5); ov.cy = C.clamp(ov.cy + dy, -0.5, 1.5); ovTouched(); }
    cv.addEventListener('pointerdown', function (e) { try { cv.setPointerCapture(e.pointerId); } catch (err) {} last = { id: e.pointerId, x: e.clientX, y: e.clientY }; });
    cv.addEventListener('pointermove', function (e) {
      if (!last || last.id !== e.pointerId || !ov) return;
      var F = face(); if (!F) return;
      nudge((e.clientX - last.x) / F, (e.clientY - last.y) / F);
      last.x = e.clientX; last.y = e.clientY;
    });
    function end(e) { if (last && last.id === e.pointerId) last = null; }
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.addEventListener('keydown', function (e) {
      var d = { ArrowLeft: [-0.01, 0], ArrowRight: [0.01, 0], ArrowUp: [0, -0.01], ArrowDown: [0, 0.01] }[e.key];
      if (!d || !ov) return;
      e.preventDefault(); nudge(d[0], d[1]);
    });
  })();
  $('ov-save').addEventListener('click', async function () {
    var ev = state.event; if (!ev || !ov || state.busy) return;
    var btn = this, old = ev.overlay_path, path = old;
    state.busy = true; btn.disabled = true; note('ov-msg', 'Saving the overlay.');
    try {
      if (ov.blob) {
        path = ev.id + '/' + Date.now() + '.png';
        var up = await sb.storage.from('overlays').upload(path, ov.blob, { contentType: 'image/png', cacheControl: '3600', upsert: false });
        if (up.error) throw up.error;
      }
      var res = await sb.from('events').update({ overlay_path: path, overlay_scale: Math.round(ov.scale * 1000) / 1000, overlay_x: Math.round(ov.cx * 10000) / 10000, overlay_y: Math.round(ov.cy * 10000) / 10000 }).eq('id', ev.id).select().single();
      if (res.error) throw res.error;
      if (old && old !== path) await sb.storage.from('overlays').remove([old]);
      state.event = res.data;
      state.overlay = { img: ov.img, iw: ov.iw, ih: ov.ih, scale: ov.scale, cx: ov.cx, cy: ov.cy };
      editCopy(); renderOverlay(); overlayChanged();
      note('ov-msg', 'Saved. Every magnet for this event now has this overlay, for guests and on the print sheets.', 'good');
    } catch (err) {
      if (!lostSession(err)) note('ov-msg', 'The overlay did not save. Check the connection and try again.', 'bad');
    }
    state.busy = false; btn.disabled = false;
  });
  $('ov-remove').addEventListener('click', async function () {
    var ev = state.event; if (!ev || !ev.overlay_path || state.busy) return;
    var btn = this, old = ev.overlay_path;
    state.busy = true; btn.disabled = true;
    var res = await sb.from('events').update({ overlay_path: null, overlay_scale: 1, overlay_x: 0.5, overlay_y: 0.5 }).eq('id', ev.id).select().single();
    state.busy = false; btn.disabled = false;
    if (lostSession(res.error)) return;
    if (res.error) { note('ov-msg', 'The overlay was not removed. Try again.', 'bad'); return; }
    await sb.storage.from('overlays').remove([old]);
    state.event = res.data; state.overlay = null; ov = null;
    renderOverlay(); overlayChanged();
    note('ov-msg', 'Overlay removed. Magnets for this event print as plain photos.', 'good');
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
      if (purgeMode === 'remove' && state.event) startPolling();
    }
    state.busy = false; btn.disabled = false; purgeReset();
  });

  /* ---------- print sheets ---------- */
  async function buildPdf(rows) {
    /* Never print an overlay event without its overlay. */
    if (state.event.overlay_path && !state.overlay) {
      await loadOverlay(state.event);
      if (!state.overlay) throw new Error('OVERLAY');
    }
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
  var HINT_BEFORE = 'Opening or printing the PDF marks these magnets as printed, so they will not print twice.';
  var HINT_AFTER = 'Marked as printed. In the PDF tab tap Share, then Print, at 100% (Actual size). If the print fails, open the PDF again here, or use the buttons on the order.';
  function release(ids) {
    if (!ids || !ids.length) return Promise.resolve();
    return sb.rpc('release_photos', { p_ids: ids, p_device: DEVICE }).then(function () {}, function () {});
  }
  function discardPending(quiet) {
    var pend = state.pending;
    if (pend) {
      URL.revokeObjectURL(pend.url); state.pending = null;
      if (!pend.marked && !quiet) release(pend.claimed).then(function () { if (state.event) loadOrders(); });
    }
    $('ready').hidden = true;
  }
  async function makeSheets(mode, order) {
    if (state.busy) return;
    if (!window.jspdf) { note('print-msg', 'The PDF tool did not load. Reload the page.', 'bad'); return; }
    var rows;
    if (mode === 'order') rows = order.order_photos.map(function (p) { return { order: order, photo: p }; });
    else { rows = waitingRows(); if (mode === 'full') rows = fullSheetRows(rows, layout().per); }
    if (!rows.length) return;
    state.busy = true;
    /* Open the new tab now, while the tap still counts, and load the sheet into it once it is built. */
    var tab = openTab();
    /* let go of an unopened sheet before reserving again, in that order */
    var before = state.pending && !state.pending.marked ? state.pending.claimed : [];
    discardPending(true);
    note('print-msg', 'Building the PDF.');
    var claimed = [], shared = false;
    try {
      await release(before);
      /* reserve the magnets first, so another device cannot put them on its own sheet */
      var need = rows.filter(function (r) { return !r.photo.printed_at; }).map(function (r) { return r.photo.id; });
      if (need.length) {
        var got = await sb.rpc('claim_photos', { p_ids: need, p_device: DEVICE });
        if (got.error) throw got.error;
        claimed = (got.data || []).map(function (x) { return typeof x === 'string' ? x : (x && (x.id || x.claim_photos)); });
        if (claimed.length < need.length) {
          if (mode === 'order') {
            release(claimed); state.busy = false; closeTab(tab);
            note('print-msg', 'Another device is printing order #' + order.order_no + ' right now, so it was not printed again here.', 'bad');
            loadOrders(); return;
          }
          rows = rows.filter(function (r) { return r.photo.printed_at || claimed.indexOf(r.photo.id) >= 0; });
          shared = true;
          if (!rows.length) {
            state.busy = false; closeTab(tab);
            note('print-msg', 'Another device just took those magnets for its own sheet. Nothing was left to print here.', 'bad');
            loadOrders(); return;
          }
        }
      }
      var out = await buildPdf(rows), url = URL.createObjectURL(out.blob);
      /* a normal web address opens in a new tab on every phone; the copy held in this page is the fallback */
      var link = await saveSheet(out.blob), href = link || url, opened = false;
      if (tab && !tab.closed) { try { tab.location.replace(href); opened = true; } catch (err) { opened = false; } }
      state.pending = { rows: rows, url: url, marked: false, claimed: claimed, claimedAt: Date.now(), file: pdfFile(out.blob) };
      /* From the home screen app the phone's own share sheet is the dependable way to reach Print. */
      var shareable = canSharePdf(state.pending.file);
      $('ready-share').hidden = !shareable;
      $('ready-open').className = 'btn' + (shareable && asApp() ? ' small' : ' primary');
      $('ready-share').className = 'btn' + (asApp() ? ' primary' : ' small');
      $('ready-text').textContent = (opened ? 'Opened in a new tab: ' : 'Ready: ') + (mode === 'order' ? 'order #' + order.order_no + ' for ' + order.guest_name + ', ' : '') +
        plural(out.magnets, 'magnet') + ' on ' + plural(out.sheets, 'sheet') + '.' + (shared ? ' Another device took the rest for its own sheet.' : '');
      $('ready-open').href = href; $('ready-open').textContent = 'Open PDF to print';
      $('ready-save').href = url; $('ready-save').download = 'sona-sheets-' + Date.now() + '.pdf';
      $('ready-hint').textContent = HINT_BEFORE;
      $('ready-discard').hidden = false; $('ready-mark').hidden = true; $('ready-done').hidden = true;
      $('ready').hidden = false;
      note('print-msg', '');
      if (opened) markPending(); else { renderOrders(); loadOrders(); }
    } catch (err) {
      closeTab(tab);
      release(claimed);
      if (!lostSession(err)) note('print-msg', String(err && err.message) === 'OVERLAY' ? 'The overlay for this event could not load, so no sheet was made. Check the connection and try again.' : 'The PDF could not be built. Check the connection and try again.', 'bad');
    }
    state.busy = false;
  }
  function openTab() {
    if (asApp()) return null;   /* the home screen app has no tabs: it shows the Open and Print buttons instead */
    try {
      var w = window.open('', '_blank');
      if (!w) return null;
      w.document.write('<!DOCTYPE html><title>Sona Magnets sheet</title><meta name="viewport" content="width=device-width, initial-scale=1">' +
        '<body style="margin:0;padding:32px;font:600 20px system-ui,sans-serif;color:#1B1F3B;background:#FDF8EE">Building your sheet. One moment.' +
        '<p id="slow" hidden style="font-weight:400">Taking a while? Close this tab, go back to the Sona Magnets tab and press Open PDF to print.</p>' +
        '<script>setTimeout(function () { document.getElementById("slow").hidden = false; }, 12000);<\/script></body>');
      w.document.close();
      return w;
    } catch (err) { return null; }
  }
  function closeTab(w) { try { if (w && !w.closed) w.close(); } catch (err) {} }
  /* Saves the sheet where only staff can reach it and returns a link that works for 12 hours. */
  function saveSheet(blob) {
    var ev = state.event;
    var work = (async function () {
      var path = ev.id + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.pdf';
      var up = await sb.storage.from('sheets').upload(path, blob, { contentType: 'application/pdf', upsert: false });
      if (up.error) return null;
      var signed = await sb.storage.from('sheets').createSignedUrl(path, 12 * 3600);
      return signed.error || !signed.data ? null : signed.data.signedUrl;
    })().catch(function () { return null; });
    return Promise.race([work, new Promise(function (resolve) { setTimeout(function () { resolve(null); }, 25000); })]);
  }
  async function markPending() {
    var pend = state.pending; if (!pend || pend.marked) return;
    pend.marked = true;
    $('ready-discard').hidden = true; $('ready-done').hidden = false;
    $('ready-open').textContent = 'Open PDF again';
    $('ready-hint').textContent = HINT_AFTER;
    var ids = pend.rows.map(function (r) { return r.photo.id; });
    var r1 = await sb.from('order_photos').update({ printed_at: new Date().toISOString(), claimed_at: null, claimed_by: null }).in('id', ids);
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
  $('print-one').addEventListener('click', function () { makeSheets('full'); });
  $('print-all').addEventListener('click', function () { makeSheets('all'); });
  /* The links open or save the PDF by themselves; marking happens alongside. */
  function pdfFile(blob) {
    try { return new File([blob], 'sona-magnets-sheets.pdf', { type: 'application/pdf' }); } catch (err) { return null; }
  }
  function canSharePdf(file) {
    try { return !!(file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })); } catch (err) { return false; }
  }
  function asApp() {
    try { return navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches; } catch (err) { return false; }
  }
  $('ready-share').addEventListener('click', function () {
    var pend = state.pending; if (!pend || !pend.file) return;
    navigator.share({ files: [pend.file], title: 'Sona Magnets sheets' }).then(function () { markPending(); }, function () {});
  });
  $('ready-open').addEventListener('click', function () { markPending(); });
  $('ready-save').addEventListener('click', function () { markPending(); });
  $('ready-mark').addEventListener('click', function () { markPending(); });
  $('ready-discard').addEventListener('click', function () { discardPending(); renderOrders(); });
  $('ready-done').addEventListener('click', function () { $('ready').hidden = true; renderOrders(); });

  /* ---------- start ---------- */
  if (!window.supabase) { show('view-login'); note('login-msg', 'The page did not finish loading. Check the connection and reload.', 'bad'); return; }
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    global: { fetch: staffFetch }
  });
  sb.auth.onAuthStateChange(function (event) { if (event === 'SIGNED_OUT' && $('view-login').hidden) signedOut('You were signed out. Please sign in again.'); });
  sb.auth.getSession().then(function (r) { route(r.data.session); }).catch(function () { show('view-login'); });
})();
