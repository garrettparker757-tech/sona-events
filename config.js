/* Sona Events settings. The key below is the public (publishable) key; it is safe in the browser.
   What guests and staff may do is enforced by the database rules, not by this file. */
window.SONA = {
  supabaseUrl: 'https://vufaeryoxlicmwkolaon.supabase.co',
  supabaseKey: 'sb_publishable_JeVo8w6yDNsHCY_XQ2qVCQ_SDfOaEol',
  /* Inches. The photo prints 2.16 wide; the middle 2.0 is the front of the magnet. */
  crop: { face: 2.0, photo: 2.16 },
  /* Pack prices in dollars. Any other number of magnets is charged as the cheapest mix of these packs. */
  prices: [{ qty: 1, price: 10 }, { qty: 3, price: 25 }, { qty: 6, price: 40 }, { qty: 9, price: 50 }],
  /* Overrides for the print sheet (see sheet.js for every setting), e.g. { bottomText: 'made in RVA' }. */
  template: {},
  /* Longest side, in pixels, of the photo a guest's phone sends. */
  uploadPx: 1600
};
