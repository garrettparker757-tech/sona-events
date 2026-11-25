/* Print sheet layout, measured from Sona's own Canva magnet template:
   a 2.75 in octagon outline, a 2.16 in photo in the middle, the brand line on three edges
   and "made in RVA" on the bottom edge, nine to a Letter page. All sizes are in inches. */
(function () {
  'use strict';
  var PAGE = { w: 8.5, h: 11 }, EDGE = 0.118;
  var DEFAULTS = {
    cut: 2.75, corner: 0.728, photo: 2.16, face: 2.0,
    outline: true, outlinePt: 1.5,
    sideText: 'Sona Magnets Co.', bottomText: 'made in RVA', textPt: 6,
    inset: { top: 0.256, side: 0.262, bottom: 0.272 },
    top: 0.147, gapX: 0.066, gapY: 0.134
  };
  function template(over) {
    var t = {}, k;
    for (k in DEFAULTS) t[k] = DEFAULTS[k];
    for (k in (over || {})) t[k] = over[k];
    return t;
  }
  function geometry(T) {
    var pitchX = T.cut + T.gapX, pitchY = T.cut + T.gapY;
    var cols = Math.max(1, Math.floor((PAGE.w + T.gapX) / pitchX));
    var rows = Math.max(1, Math.floor((PAGE.h - T.top - 1.2 + T.gapY) / pitchY));
    var gridW = cols * T.cut + (cols - 1) * T.gapX, left = (PAGE.w - gridW) / 2;
    /* Too wide to centre inside the printer's margins: keep the right edge printable, as the Canva template does. */
    if (left < EDGE) left = Math.max(0, PAGE.w - EDGE - gridW);
    return { cols: cols, rows: rows, per: cols * rows, left: left, top: T.top, pitchX: pitchX, pitchY: pitchY,
             off: (T.cut - T.photo) / 2, bottom: T.top + rows * T.cut + (rows - 1) * T.gapY };
  }
  /* Magnets fill down the first column, then the next, so a small order sits in one strip to cut. */
  function slotXY(G, i) { return { x: G.left + Math.floor(i / G.rows) * G.pitchX, y: G.top + (i % G.rows) * G.pitchY }; }
  function octagon(T) {
    var c = Math.max(0, Math.min(T.corner, T.cut / 2)), s = T.cut;
    return [[c, 0], [s - c, 0], [s, c], [s, s - c], [s - c, s], [c, s], [0, s - c], [0, c]];
  }
  function clean(s, max) { return String(s || '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?').slice(0, max || 40); }
  function paginate(slots, per) {
    var pages = [];
    for (var i = 0; i < slots.length; i += per) pages.push(slots.slice(i, i + per));
    if (!pages.length) pages.push([]);
    return pages;
  }
  var CHECK = 'This line should measure exactly 2 inches. If not, print at 100% (Actual size).';

  /* ---------- PDF (jsPDF, unit "in") ---------- */
  function pdfCell(doc, T, G, x, y, imageData, alias, label) {
    var cx = x + T.cut / 2, cy = y + T.cut / 2, i;
    if (T.outline) {
      var pts = octagon(T), d = [];
      for (i = 1; i < pts.length; i++) d.push([pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]]);
      doc.setDrawColor(0); doc.setLineWidth(T.outlinePt / 72);
      doc.lines(d, x + pts[0][0], y + pts[0][1], [1, 1], 'S', true);
    }
    if (imageData) doc.addImage(imageData, 'JPEG', x + G.off, y + G.off, T.photo, T.photo, alias, 'FAST');
    if (G.off > 0.15) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(T.textPt); doc.setTextColor(0);
      var s = clean(T.sideText), b = clean(T.bottomText);
      if (s) {
        var w = doc.getTextWidth(s);
        doc.text(s, cx - w / 2, y + T.inset.top);
        doc.text(s, x + T.inset.side, cy + w / 2, { angle: 90 });
        doc.text(s, x + T.cut - T.inset.side, cy - w / 2, { angle: -90 });
      }
      if (b) {
        var wb = doc.getTextWidth(b);
        doc.text(b, cx + wb / 2, y + T.cut - T.inset.bottom, { angle: 180 });
      }
    }
    if (label) {
      /* Order label sits outside the cut shape, in the bottom-right corner that gets punched away. */
      doc.setFont('helvetica', 'normal'); doc.setFontSize(5.5); doc.setTextColor(90);
      var l = clean(label, 14);
      doc.text(l, x + T.cut - 0.03 - doc.getTextWidth(l), y + T.cut - 0.04);
    }
  }
  function pdfFooter(doc, G, info) {
    var lx = (PAGE.w - 2) / 2, ly = G.bottom + 0.8;
    if (ly + 0.3 > PAGE.h - 0.15) return;
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.setTextColor(130);
    doc.text(clean(info, 120), PAGE.w / 2, G.bottom + 0.45, { align: 'center' });
    doc.setDrawColor(90); doc.setLineWidth(0.006);
    doc.line(lx, ly, lx + 2, ly); doc.line(lx, ly - 0.06, lx, ly + 0.06); doc.line(lx + 2, ly - 0.06, lx + 2, ly + 0.06);
    doc.setFontSize(6.5);
    doc.text(CHECK, PAGE.w / 2, ly + 0.2, { align: 'center' });
  }
  /* slots: one entry per printed magnet. image(slot) -> JPEG data URL, key(slot) -> stable id, label(slot) -> text or ''. */
  function buildPdf(T, slots, fns, infoPrefix) {
    var doc = new window.jspdf.jsPDF({ unit: 'in', format: 'letter', orientation: 'portrait', compress: true });
    var G = geometry(T), pages = paginate(slots, G.per);
    pages.forEach(function (page, p) {
      if (p > 0) doc.addPage('letter', 'portrait');
      page.forEach(function (slot, i) {
        var at = slotXY(G, i);
        pdfCell(doc, T, G, at.x, at.y, fns.image(slot), 'photo-' + fns.key(slot), fns.label ? fns.label(slot) : '');
      });
      pdfFooter(doc, G, (infoPrefix ? infoPrefix + '  |  ' : '') + 'Sheet ' + (p + 1) + ' of ' + pages.length);
    });
    return { blob: doc.output('blob'), sheets: pages.length, magnets: slots.length };
  }

  /* ---------- on-screen preview (canvas, P pixels per inch) ---------- */
  function previewCell(g, P, T, G, x, y, drawPhoto, label, opts) {
    var u = function (v) { return v * P; }, cx = x + T.cut / 2, cy = y + T.cut / 2;
    if (T.outline) {
      var pts = octagon(T);
      g.beginPath();
      pts.forEach(function (pt, i) { if (i) g.lineTo(u(x + pt[0]), u(y + pt[1])); else g.moveTo(u(x + pt[0]), u(y + pt[1])); });
      g.closePath(); g.strokeStyle = '#000'; g.lineWidth = Math.max(1, T.outlinePt / 72 * P); g.stroke();
    }
    if (drawPhoto) drawPhoto(u(x + G.off), u(y + G.off), u(T.photo));
    else { g.setLineDash([6, 6]); g.strokeStyle = '#d9d2c2'; g.lineWidth = 1; g.strokeRect(u(x + G.off), u(y + G.off), u(T.photo), u(T.photo)); g.setLineDash([]); }
    if (opts && opts.showFace && drawPhoto) {
      var f = (T.cut - T.face) / 2;
      g.setLineDash([6, 4]); g.strokeStyle = '#17807E'; g.lineWidth = 1.5;
      g.strokeRect(u(x + f), u(y + f), u(T.face), u(T.face)); g.setLineDash([]);
    }
    if (G.off > 0.15) {
      var px = T.textPt / 72 * P;
      g.fillStyle = '#000'; g.font = px + 'px Figtree, Helvetica, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
      var put = function (text, tx, ty, rot) { g.save(); g.translate(u(tx), u(ty)); g.rotate(rot); g.fillText(text, 0, 0); g.restore(); };
      var s = clean(T.sideText), b = clean(T.bottomText);
      if (s) {
        put(s, cx, y + T.inset.top, 0);
        put(s, x + T.inset.side, cy, -Math.PI / 2);
        put(s, x + T.cut - T.inset.side, cy, Math.PI / 2);
      }
      if (b) put(b, cx, y + T.cut - T.inset.bottom, Math.PI);
    }
    if (label) {
      g.fillStyle = '#5a5a5a'; g.font = (5.5 / 72 * P) + 'px Helvetica, Arial, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'alphabetic';
      g.fillText(clean(label, 14), u(x + T.cut - 0.03), u(y + T.cut - 0.04));
    }
  }
  function previewFooter(g, P, G, info) {
    var u = function (v) { return v * P; }, lx = (PAGE.w - 2) / 2, ly = G.bottom + 0.8;
    if (ly + 0.3 > PAGE.h - 0.15) return;
    g.fillStyle = '#8a8a8a'; g.font = (7 / 72 * P) + 'px Helvetica, Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';
    g.fillText(clean(info, 120), u(PAGE.w / 2), u(G.bottom + 0.45));
    g.strokeStyle = '#5a5a5a'; g.lineWidth = 1; g.beginPath();
    g.moveTo(u(lx), u(ly)); g.lineTo(u(lx + 2), u(ly));
    g.moveTo(u(lx), u(ly - 0.06)); g.lineTo(u(lx), u(ly + 0.06));
    g.moveTo(u(lx + 2), u(ly - 0.06)); g.lineTo(u(lx + 2), u(ly + 0.06));
    g.stroke();
    g.font = (6.5 / 72 * P) + 'px Helvetica, Arial, sans-serif';
    g.fillText(CHECK, u(PAGE.w / 2), u(ly + 0.2));
  }

  window.SonaSheet = { PAGE: PAGE, DEFAULTS: DEFAULTS, template: template, geometry: geometry, slotXY: slotXY, paginate: paginate,
                       clean: clean, buildPdf: buildPdf, previewCell: previewCell, previewFooter: previewFooter };
})();
