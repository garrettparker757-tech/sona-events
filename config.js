/* Sona Events settings. The key below is the public (publishable) key; it is safe in the browser.
   What guests and staff may do is enforced by the database rules, not by this file. */
window.SONA = {
  supabaseUrl: 'https://vufaeryoxlicmwkolaon.supabase.co',
  supabaseKey: 'sb_publishable_JeVo8w6yDNsHCY_XQ2qVCQ_SDfOaEol',
  /* Inches. The photo prints 2.16 wide; the middle 2.0 is the front of the magnet. */
  crop: { face: 2.0, photo: 2.16 },
  /* Prices in dollars. The four packs (pack: true) are what the signs and the order page advertise.
     The in-between sizes are accepted quietly, priced so the next pack is always the better deal.
     Orders above 9 are a 9-pack plus the price of the rest (12 = 9 + 3). */
  prices: [
    { qty: 1, price: 10, pack: true },
    { qty: 2, price: 20 },
    { qty: 3, price: 25, pack: true },
    { qty: 4, price: 32 },
    { qty: 5, price: 37 },
    { qty: 6, price: 40, pack: true },
    { qty: 7, price: 45 },
    { qty: 8, price: 48 },
    { qty: 9, price: 50, pack: true }
  ],
  /* Overrides for the print sheet (see sheet.js for every setting), e.g. { bottomText: 'made in RVA' }. */
  template: {},
  /* Longest side, in pixels, of the photo a guest's phone sends. */
  uploadPx: 1600
};
