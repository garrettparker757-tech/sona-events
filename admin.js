/* Staff page: sign in, create events, show the QR code, watch the queue, make print sheets. */
(function () {
  'use strict';
  var CFG = window.SONA, Sheet = window.SonaSheet, T = Sheet.template(CFG.template);
  var $ = function (id) { return document.getElementById(id); };
  var VIEWS = ['view-loading', 'view-login', 'view-denied', 'view-events', 'view-event'];
  var state = { events: [], event: null, orders: [], sig: '', timer: null, blobs: new Map(), pending: null, busy: false };
  var sb = null;

  function show(view) {
    VIEWS.forEach(function (id) { $(id).hidden = id !== view; });
    $('back').hidden = view !== 'view-event';
    $('signout').hidden = view === 'view-login' || view === 'view-loading';
    if (view !== 'view-event') { $('page-title').textContent = 'Events'; stopPolling(); }
  }
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function note(id, text, kind) { var n = $(id); n.textContent = text || ''; n.className = 'note' + (kind ? ' ' + kind : ''); }
  function guestUrl(ev) { return location.origin + '/e/' + ev.slug; }

  /* ---------- sign-in ---------- */
  async function route(session) {
    if (!session) { show('view-login'); return; }
    var res = await sb.from('staff').select('email').limit(1);
    if (res.error || !res.data || !res.data.length) {
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
  $('signout').addEventListener('click', async function () { await sb.auth.signOut(); state.event = null; show('view-login'); });
  $('back').addEventListener('click', async function () { discardPending(); state.event = null; await loadEvents(); show('view-events'); });

  /* ---------- events ---------- */
  function slugify(name) {
    var base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'event';
    var tail = '', chars = 'abcdefghjkmnpqrstuvwxyz23456789', r = new Uint8Array(4);
    crypto.getRandomValues(r);
    for (var i = 0; i < 4; i++) tail += chars[r[i] % chars.length];
    return base + '-' + tail;
  }
  async function loadEvents() {
    var res = await sb.from('events').select('*').order('created_at', { ascending: false });
    if (res.error) { note('events-msg', 'Could not load events. Reload the page.', 'bad'); return; }
    state.events = res.data;
    var ul = $('events'); ul.replaceChildren();
    state.events.forEach(function (ev) {
      var li = el('li', 'card');
      var left = el('div');
      left.appendChild(el('h3', null, ev.name));
      left.appendChild(el('p', 'note', 'Created ' + new Date(ev.created_at).toLocaleDateString() + ', up to ' + ev.max_magnets + ' magnets per order'));
      li.appendChild(left);
      var right = el('div', 'row');
      right.appendChild(el('span', 'chip ' + ev.status, ev.status.charAt(0).toUpperCase() + ev.status.slice(1)));
      var open = el('button', 'btn small', 'Open'); open.type = 'button';
      open.addEventListener('click', function () { openEvent(ev); });
      right.appendChild(open);
      li.appendChild(right);
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
    if (res.error) { note('event-msg', 'The event could not be created. Try again.', 'bad'); return; }
    note('event-msg', '');
    $('ev-name').value = ''; $('ev-welcome').value = '';
    openEvent(res.data);
  });

  /* ---------- one event ---------- */
  function renderStatus() {
    var ev = state.event, label = ev.status.charAt(0).toUpperCase() + ev.status.slice(1);
    $('status-chip').textContent = label; $('status-chip').className = 'chip ' + ev.status;
    Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.status === ev.status)); });
    note('status-note', ev.status === 'live' ? 'Guests can order now.' : ev.status === 'draft' ? 'Guests cannot see this event yet. Set it to Live when you are ready.' : 'Guests see that orders are closed.');
  }
  function openEvent(ev) {
    state.event = ev; state.orders = []; state.sig = '';
    $('page-title').textContent = ev.name;
    $('sign-name').textContent = ev.name;
    var url = guestUrl(ev);
    $('guest-link').textContent = url;
    $('open-link').href = url;
    var qr = $('qr'); qr.replaceChildren();
    if (window.QRCode) new window.QRCode(qr, { text: url, width: 440, height: 440, correctLevel: window.QRCode.CorrectLevel.M });
    else qr.textContent = 'The QR code could not load. Reload the page.';
    renderStatus();
    $('orders').replaceChildren();
    note('print-msg', ''); note('queue-msg', 'Loading orders.');
    show('view-event');
    $('page-title').textContent = ev.name;
    loadOrders();
    stopPolling();
    state.timer = setInterval(function () { if (!document.hidden) loadOrders(); }, 5000);
  }
  function stopPolling() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }
  Array.prototype.forEach.call(document.querySelectorAll('.seg button'), function (b) {
    b.addEventListener('click', async function () {
      var ev = state.event; if (!ev || ev.status === b.dataset.status) return;
      var res = await sb.from('events').update({ status: b.dataset.status }).eq('id', ev.id).select().single();
      if (res.error) { note('status-note', 'The status did not change. Try again.', 'bad'); return; }
      state.event = res.data; renderStatus();
    });
  });
  $('copy-link').addEventListener('click', async function () {
    try { await navigator.clipboard.writeText(guestUrl(state.event)); this.textContent = 'Copied'; }
    catch (err) { this.textContent = 'Copy failed'; }
    var b = this; setTimeout(function () { b.textContent = 'Copy link'; }, 1500);
  });
  $('print-sign').addEventListener('click', function () { window.print(); });

  /* ---------- queue ---------- */
  function byCreated(a, b) { return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0; }
  async function loadOrders() {
    var ev = state.event; if (!ev) return;
    var res = await sb.from('orders')
      .select('id, order_no, guest_name, contact, status, created_at, order_photos(id, path, qty, printed_at, created_at)')
      .eq('event_id', ev.id).order('order_no', { ascending: true });
    if (!state.event || state.event.id !== ev.id) return;
    if (res.error) { note('queue-msg', 'Could not refresh the queue. Trying again.', 'bad'); return; }
    res.data.forEach(function (o) { o.order_photos.sort(byCreated); });
    var sig = JSON.stringify(res.data);
    state.orders = res.data;
    if (sig !== state.sig) { state.sig = sig; renderOrders(); }
    note('queue-msg', state.orders.length ? 'Updates every 5 seconds.' : 'No orders yet.');
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
  function waitingRows() {
    var rows = [];
    state.orders.forEach(function (o) {
      if (o.status === 'done') return;
      o.order_photos.forEach(function (p) { if (!p.printed_at) rows.push({ order: o, photo: p }); });
    });
    return rows;
  }
  function layout() { return Sheet.geometry(T); }
  function renderOrders() {
    var rank = { 'new': 0, printed: 1, done: 2 }, per = layout().per;
    var waiting = waitingRows().reduce(function (n, r) { return n + r.photo.qty; }, 0);
    $('st-waiting').textContent = waiting;
    $('st-orders').textContent = state.orders.length;
    $('st-done').textContent = state.orders.filter(function (o) { return o.status === 'done'; }).length;
    $('print-one').disabled = !waiting; $('print-all').disabled = !waiting;
    if (!state.pending) note('print-msg', waiting ? waiting + (waiting === 1 ? ' magnet is' : ' magnets are') + ' waiting. A full sheet holds ' + per + '.' : 'Nothing is waiting to print.');

    var ul = $('orders'); ul.replaceChildren();
    state.orders.slice().sort(function (a, b) { return (rank[a.status] - rank[b.status]) || (a.order_no - b.order_no); }).forEach(function (o) {
      var li = el('li', 'order');
      var head = el('div', 'row between');
      var who = el('div', 'row');
      who.appendChild(el('span', 'no', '#' + o.order_no));
      who.appendChild(el('strong', null, o.guest_name));
      if (o.contact) who.appendChild(el('span', 'note', o.contact));
      head.appendChild(who);
      var meta = el('div', 'row');
      meta.appendChild(el('span', 'note', new Date(o.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })));
      var label = o.status === 'new' ? 'Waiting to print' : o.status === 'printed' ? 'Printed' : 'Picked up';
      meta.appendChild(el('span', 'chip ' + o.status, label));
      head.appendChild(meta);
      li.appendChild(head);

      var thumbs = el('div', 'thumbs');
      o.order_photos.forEach(function (p) {
        var t = el('div', 'thumb' + (p.printed_at ? ' printed' : ''));
        var img = document.createElement('img'); img.alt = 'Photo for order ' + o.order_no;
        photoBlob(p.path).then(function (b) { img.src = b.url; }).catch(function () { img.alt = 'Photo could not load'; });
        t.appendChild(img);
        if (p.qty > 1) t.appendChild(el('span', null, '×' + p.qty));
        thumbs.appendChild(t);
      });
      li.appendChild(thumbs);

      var actions = el('div', 'row');
      if (o.status !== 'done') {
        var done = el('button', 'btn small', 'Picked up'); done.type = 'button';
        done.addEventListener('click', function () { setOrder(o, { status: 'done' }); });
        actions.appendChild(done);
      } else {
        var undo = el('button', 'btn small', 'Not picked up yet'); undo.type = 'button';
        var allPrinted = o.order_photos.every(function (p) { return p.printed_at; });
        undo.addEventListener('click', function () { setOrder(o, { status: allPrinted ? 'printed' : 'new' }); });
        actions.appendChild(undo);
      }
      if (o.order_photos.some(function (p) { return p.printed_at; })) {
        var again = el('button', 'btn small', 'Print again'); again.type = 'button';
        again.addEventListener('click', async function () {
          var r = await sb.from('order_photos').update({ printed_at: null }).eq('order_id', o.id);
          if (r.error) { note('queue-msg', 'That did not save. Try again.', 'bad'); return; }
          setOrder(o, { status: 'new' });
        });
        actions.appendChild(again);
      }
      li.appendChild(actions);
      ul.appendChild(li);
    });
  }
  async function setOrder(o, patch) {
    var r = await sb.from('orders').update(patch).eq('id', o.id);
    if (r.error) { note('queue-msg', 'That did not save. Try again.', 'bad'); return; }
    loadOrders();
  }

  /* ---------- print sheets ---------- */
  function toDataUrl(blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }
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
      var b = await photoBlob(rows[k].photo.path);
      images[rows[k].photo.id] = await toDataUrl(b.blob);
    }
    var stamp = new Date().toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return Sheet.buildPdf(T, slots, {
      image: function (r) { return images[r.photo.id]; },
      key: function (r) { return r.photo.id; },
      label: function (r) { return '#' + r.order.order_no + ' ' + r.order.guest_name; }
    }, state.event.name + '  |  ' + stamp);
  }
  function discardPending() {
    if (state.pending) { URL.revokeObjectURL(state.pending.url); state.pending = null; }
    $('ready').hidden = true;
  }
  async function makeSheets(all) {
    if (state.busy) return;
    if (!window.jspdf) { note('print-msg', 'The PDF tool did not load. Reload the page.', 'bad'); return; }
    var rows = waitingRows();
    if (!rows.length) return;
    if (!all) rows = pickOneSheet(rows, layout().per);
    state.busy = true; discardPending();
    note('print-msg', 'Building the PDF.');
    try {
      var out = await buildPdf(rows), url = URL.createObjectURL(out.blob);
      state.pending = { rows: rows, url: url };
      $('ready-text').textContent = 'Ready: ' + out.magnets + (out.magnets === 1 ? ' magnet' : ' magnets') + ' on ' + out.sheets + (out.sheets === 1 ? ' sheet.' : ' sheets.');
      $('ready-open').href = url;
      $('ready-save').href = url; $('ready-save').download = 'sona-sheets-' + Date.now() + '.pdf';
      $('ready').hidden = false;
      note('print-msg', '');
    } catch (err) {
      note('print-msg', 'The PDF could not be built. Check the connection and try again.', 'bad');
    }
    state.busy = false;
  }
  $('print-one').addEventListener('click', function () { makeSheets(false); });
  $('print-all').addEventListener('click', function () { makeSheets(true); });
  $('ready-discard').addEventListener('click', function () { discardPending(); renderOrders(); });
  $('ready-mark').addEventListener('click', async function () {
    var pend = state.pending; if (!pend) return;
    var btn = this; btn.disabled = true;
    var ids = pend.rows.map(function (r) { return r.photo.id; });
    var r1 = await sb.from('order_photos').update({ printed_at: new Date().toISOString() }).in('id', ids);
    if (r1.error) { btn.disabled = false; note('print-msg', 'Could not mark them as printed. Try again.', 'bad'); return; }
    var finished = [];
    pend.rows.forEach(function (r) {
      var o = r.order;
      if (o.status === 'new' && finished.indexOf(o.id) < 0 && o.order_photos.every(function (p) { return p.printed_at || ids.indexOf(p.id) >= 0; })) finished.push(o.id);
    });
    if (finished.length) await sb.from('orders').update({ status: 'printed' }).in('id', finished).eq('status', 'new');
    btn.disabled = false;
    discardPending();
    await loadOrders();
  });

  /* ---------- start ---------- */
  if (!window.supabase) { show('view-login'); note('login-msg', 'The page did not finish loading. Check the connection and reload.', 'bad'); return; }
  sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey);
  sb.auth.getSession().then(function (r) { route(r.data.session); });
})();
