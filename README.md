# Sona Events

Photo magnet ordering for Sona Magnets Co. at markets and private events.

- **Guests** scan a QR code, add photos, frame each one and send the order. They get an order number.
- **Staff** sign in at `/admin`, create an event, show its QR code, watch orders arrive and make print sheets.
- **Print sheets** copy the Canva magnet template: a 2.75 in octagon outline, a 2.16 in photo, the brand line on the edges, nine to a Letter page.

## How it is put together

| File | What it does |
| --- | --- |
| `event.html`, `guest.js` | The guest order page, served at `/e/<event-link>` |
| `admin.html`, `admin.js` | The staff page, served at `/admin` |
| `sheet.js` | The print sheet layout. Sizes and edge text live in `DEFAULTS` at the top |
| `common.js` | Photo cropping and the drag, pinch and zoom editor |
| `config.js` | The Supabase project address and public key, plus template overrides |
| `styles.css` | Colours, type and layout |
| `vercel.json` | The `/e/...` and `/admin` addresses |
| `supabase/schema.sql` | A copy of the database tables and access rules, for reference |

There is no build step. Vercel serves these files as they are, and every push to `main` goes live.

## Services

- **Supabase** stores events, orders and the cropped photos. Guests can only upload to a live event and place an order. Only signed-in staff on the `staff` list can read orders and photos.
- **Vercel** hosts the site.

The key in `config.js` is Supabase's public key. It is meant to be visible. Secret keys (for example Stripe's) must never be added to this repository; they go in Vercel's environment settings.
