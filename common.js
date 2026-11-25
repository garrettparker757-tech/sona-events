/* Shared helpers: photo cropping and the drag / pinch / zoom editor. */
(function () {
  'use strict';
  var clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)); };

  function cropRect(it) {
    var s = Math.min(it.iw, it.ih) / it.zoom;
    var cx = clamp(it.cx * it.iw, s / 2, it.iw - s / 2);
    var cy = clamp(it.cy * it.ih, s / 2, it.ih - s / 2);
    return { sx: cx - s / 2, sy: cy - s / 2, s: s };
  }
  function normalize(it) {
    var r = cropRect(it);
    it.cx = (r.sx + r.s / 2) / it.iw;
    it.cy = (r.sy + r.s / 2) / it.ih;
  }
  function drawCrop(g, it, x, y, size) {
    var r = cropRect(it);
    g.drawImage(it.img, r.sx, r.sy, r.s, r.s, x, y, size, size);
  }
  /* Older phones: small stand-ins for two newer browser features this app uses. */
  if (!Element.prototype.replaceChildren) {
    Element.prototype.replaceChildren = function () {
      while (this.lastChild) this.removeChild(this.lastChild);
      for (var i = 0; i < arguments.length; i++) this.appendChild(arguments[i]);
    };
  }

  function decode(blob) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(blob), img = new Image();
      img.onload = function () { resolve(img.naturalWidth && img.naturalHeight ? img : null); };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }
  /* iPhone-style HEIC photos: most phones hand them over as JPEG, but when one arrives as HEIC
     on a browser that cannot open it, fetch a converter only then. */
  var heicTool = null;
  function loadHeicTool() {
    if (!heicTool) {
      heicTool = new Promise(function (resolve) {
        var el = document.createElement('script');
        el.src = 'https://cdn.jsdelivr.net/npm/heic-to@1.5.2/dist/iife/heic-to.js';
        el.onload = function () { resolve(window.HeicTo || null); };
        el.onerror = function () { heicTool = null; resolve(null); };
        document.head.appendChild(el);
      });
    }
    return heicTool;
  }
  function looksHeic(file) {
    return /hei[cf]/i.test(file.type || '') || /\.(heic|heif)$/i.test(file.name || '') || !file.type;
  }
  async function heicToJpeg(file) {
    try {
      var tool = await loadHeicTool();
      if (!tool) return null;
      var out = await tool({ blob: file, type: 'image/jpeg', quality: 0.92 });
      return Array.isArray(out) ? out[0] : out;
    } catch (err) { return null; }
  }
  /* Opens any photo the browser (or the HEIC converter) can read and returns a working copy
     no larger than 2000 px on its long side, which keeps old phones fast and within memory. */
  async function loadPhoto(file) {
    var img = await decode(file);
    if (!img && looksHeic(file)) {
      var jpeg = await heicToJpeg(file);
      if (jpeg) img = await decode(jpeg);
    }
    if (!img) return null;
    var w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, 2000 / Math.max(w, h));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    var g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.imageSmoothingQuality = 'high';
    try { g.drawImage(img, 0, 0, c.width, c.height); } catch (err) { return null; }
    URL.revokeObjectURL(img.src);
    return { img: c, iw: c.width, ih: c.height, small: Math.min(w, h) < 700 };
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  /* Wires a canvas so one finger drags, two fingers pinch, arrow keys nudge. */
  function attachEditor(canvas, getItem, onChange) {
    var pts = new Map(), lastDist = 0;
    var faceRatio = window.SONA.crop.face / window.SONA.crop.photo;
    function draw() {
      var it = getItem(); if (!it) return;
      var g = canvas.getContext('2d'), n = canvas.width;
      g.clearRect(0, 0, n, n);
      drawCrop(g, it, 0, 0, n);
      var inset = (1 - faceRatio) / 2 * n;
      g.fillStyle = 'rgba(251, 245, 233, 0.55)';
      g.fillRect(0, 0, n, inset); g.fillRect(0, n - inset, n, inset);
      g.fillRect(0, inset, inset, n - 2 * inset); g.fillRect(n - inset, inset, inset, n - 2 * inset);
      g.setLineDash([12, 8]); g.lineWidth = 3; g.strokeStyle = '#17807E';
      g.strokeRect(inset, inset, n - 2 * inset, n - 2 * inset);
      g.setLineDash([]);
    }
    function moveBy(it, dx, dy) {
      var r = cropRect(it);
      it.cx = (r.sx + r.s / 2 + dx) / it.iw;
      it.cy = (r.sy + r.s / 2 + dy) / it.ih;
      normalize(it);
    }
    canvas.addEventListener('pointerdown', function (e) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) {}
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      lastDist = 0;
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!pts.has(e.pointerId)) return;
      var it = getItem(); if (!it) return;
      var prev = pts.get(e.pointerId), cur = { x: e.clientX, y: e.clientY };
      pts.set(e.pointerId, cur);
      if (pts.size === 1) {
        var k = cropRect(it).s / canvas.getBoundingClientRect().width;
        moveBy(it, -(cur.x - prev.x) * k, -(cur.y - prev.y) * k);
      } else if (pts.size === 2) {
        var two = Array.from(pts.values());
        var dist = Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y);
        if (lastDist > 0 && dist > 0) { it.zoom = clamp(it.zoom * dist / lastDist, 1, 3); normalize(it); }
        lastDist = dist;
      }
      draw(); onChange(it);
    });
    function end(e) { pts.delete(e.pointerId); lastDist = 0; }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('keydown', function (e) {
      var it = getItem(); if (!it) return;
      var step = cropRect(it).s / 40;
      var d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (!d) return;
      e.preventDefault(); moveBy(it, d[0], d[1]); draw(); onChange(it);
    });
    return { draw: draw };
  }

  /* ---------- prices ---------- */
  function tiers() { return (window.SONA.prices || []).slice().sort(function (a, b) { return a.qty - b.qty; }); }
  /* The price of n magnets, or null when n is not a size that is sold. */
  function priceFor(n) {
    var list = tiers(), top = list[list.length - 1], i, rest;
    if (!list.length || n < 1) return null;
    for (i = 0; i < list.length; i++) if (list[i].qty === n) return list[i].price;
    if (n > top.qty) { rest = priceFor(n - top.qty); return rest == null ? null : top.price + rest; }
    return null;
  }
  function money(v) { return v == null ? '' : '$' + (Math.round(v * 100) % 100 ? v.toFixed(2) : String(Math.round(v))); }
  /* The nearest sizes that are sold, below and above n, within the event's limit. */
  function nearestPacks(n, max) {
    var down = null, up = null, m;
    for (m = n - 1; m >= 1; m--) if (priceFor(m) != null) { down = m; break; }
    for (m = n + 1; m <= max; m++) if (priceFor(m) != null) { up = m; break; }
    return { down: down, up: up };
  }
  function packs(max) { return tiers().filter(function (t) { return t.pack && t.qty <= max; }); }
  function packSizes(max) { return packs(max).map(function (t) { return t.qty; }); }
  /* When one more magnet completes a pack for only a few dollars, say so. */
  function oneMore(n, max) {
    var now = priceFor(n), next = priceFor(n + 1);
    if (now == null || next == null || n + 1 > max) return null;
    var isPack = tiers().some(function (t) { return t.pack && t.qty === n + 1; });
    return isPack && next - now <= 5 ? { qty: n + 1, extra: next - now, price: next } : null;
  }

  window.SonaCommon = { clamp: clamp, cropRect: cropRect, normalize: normalize, drawCrop: drawCrop, loadPhoto: loadPhoto, priceFor: priceFor, money: money, nearestPacks: nearestPacks, packs: packs, packSizes: packSizes, oneMore: oneMore, uuid: uuid, attachEditor: attachEditor };
})();
