// Square checkout for Sona Events.
//   POST { action: "create", order_id }  -> makes (or reuses) a Square checkout page for that order
//   POST { action: "status", order_id }  -> asks Square whether it has been paid, and records it
//   POST { action: "check" }             -> says whether Square is connected (no secrets returned)
//   Square's own notices (payment.updated) arrive here too, signed with the webhook signature key.
// Secrets, never in the code: read from Edge Function secrets first, then from the database's
// private.app_secrets table (readable only by this function's service role):
//   SQUARE_ACCESS_TOKEN, SQUARE_WEBHOOK_SIGNATURE_KEY, optional SQUARE_LOCATION_ID, optional SQUARE_ENV=sandbox
// The webhook subscription and its signature key are set up automatically on the first "check".
import { createClient } from "npm:@supabase/supabase-js@2";

const SITE = "https://sona-events.vercel.app";
const HOOK_URL = "https://vufaeryoxlicmwkolaon.supabase.co/functions/v1/square";
const SQUARE_VERSION = "2024-12-18";
// Keep in step with config.js (prices for 1-9; above 9 is a 9-pack plus the rest).
const PRICES: Record<number, number> = { 1: 10, 2: 20, 3: 25, 4: 32, 5: 37, 6: 40, 7: 45, 8: 48, 9: 50 };
function priceFor(n: number): number {
  if (n <= 0) return 0;
  if (PRICES[n] != null) return PRICES[n];
  return PRICES[9] + priceFor(n - 9);
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const secretCache: Record<string, { v: string; at: number }> = {};
async function secret(name: string): Promise<string> {
  const env = Deno.env.get(name);
  if (env) return env;
  const c = secretCache[name];
  if (c && Date.now() - c.at < 60_000) return c.v;
  const { data } = await db.rpc("get_app_secret", { p_name: name });
  const v = typeof data === "string" ? data : "";
  secretCache[name] = { v, at: Date.now() };
  return v;
}
async function saveSecret(name: string, value: string) {
  await db.rpc("set_app_secret", { p_name: name, p_value: value });
  secretCache[name] = { v: value, at: Date.now() };
}
let TOKEN = "";
const token = () => TOKEN;
let SANDBOX = false;
const base = () => (SANDBOX ? "https://connect.squareupsandbox.com" : "https://connect.squareup.com");
async function loadSecrets() {
  TOKEN = await secret("SQUARE_ACCESS_TOKEN");
  SANDBOX = (await secret("SQUARE_ENV")) === "sandbox";
}

async function square(path: string, init: RequestInit = {}) {
  const res = await fetch(base() + path, {
    ...init,
    headers: { "Authorization": "Bearer " + token(), "Square-Version": SQUARE_VERSION, "Content-Type": "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("SQUARE " + res.status + " " + JSON.stringify(body.errors || body).slice(0, 300));
  return body;
}

let locationCache: { id: string; name: string } | null = null;
async function location() {
  if (locationCache) return locationCache;
  const data = await square("/v2/locations");
  const all = (data.locations || []).filter((l: any) => l.status === "ACTIVE");
  const want = await secret("SQUARE_LOCATION_ID");
  const pick = (want && all.find((l: any) => l.id === want)) || all.find((l: any) => (l.capabilities || []).includes("CREDIT_CARD_PROCESSING")) || all[0];
  if (!pick) throw new Error("NO_LOCATION");
  locationCache = { id: pick.id, name: pick.business_name || pick.name || "Square" };
  return locationCache;
}

async function loadOrder(orderId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(orderId || "")) return null;
  const { data } = await db.from("orders")
    .select("id, order_no, guest_name, paid_at, pay_status, pay_url, pay_amount, square_order_id, events(slug, name, pay_online, show_prices), order_photos(qty)")
    .eq("id", orderId).maybeSingle();
  return data as any;
}

async function markPaid(o: any, payment: any) {
  if (o.paid_at) return;
  const cents = payment?.total_money?.amount ?? payment?.amount_money?.amount;
  await db.from("orders").update({
    paid_at: new Date().toISOString(),
    paid_amount: cents != null ? cents / 100 : o.pay_amount,
    pay_status: "paid",
    square_payment_id: payment?.id || null,
  }).eq("id", o.id).is("paid_at", null);
}

async function create(orderId: string) {
  const o = await loadOrder(orderId);
  if (!o) return json({ error: "NOT_FOUND" }, 404);
  if (o.paid_at) return json({ paid: true });
  const ev = o.events;
  const count = (o.order_photos || []).reduce((n: number, p: any) => n + (p.qty || 0), 0);
  const amount = priceFor(count);
  if (!ev?.pay_online || !ev?.show_prices || !amount) return json({ error: "NOT_ONLINE" }, 400);
  if (o.pay_url && Number(o.pay_amount) === amount) return json({ url: o.pay_url, amount });
  try {
    if (!token()) throw new Error("NOT_CONNECTED");
    const loc = await location();
    const res = await square("/v2/online-checkout/payment-links", {
      method: "POST",
      body: JSON.stringify({
        idempotency_key: o.id + "-" + amount,
        quick_pay: {
          name: "Sona Magnets order #" + o.order_no + " (" + count + (count === 1 ? " magnet)" : " magnets)"),
          price_money: { amount: Math.round(amount * 100), currency: "USD" },
          location_id: loc.id,
        },
        checkout_options: { redirect_url: SITE + "/e/" + ev.slug + "?paid=" + o.id, ask_for_shipping_address: false },
        payment_note: "Sona Events " + ev.name + ", order #" + o.order_no + " for " + o.guest_name + " (" + o.id + ")",
      }),
    });
    const link = res.payment_link;
    await db.from("orders").update({ pay_status: "pending", pay_url: link.url, pay_amount: amount, square_order_id: link.order_id }).eq("id", o.id);
    return json({ url: link.url, amount });
  } catch (err) {
    console.error("create failed", String(err));
    // let the order go to the print queue as "pay at the table" instead of holding it forever
    await db.from("orders").update({ pay_status: "failed" }).eq("id", o.id).is("paid_at", null);
    return json({ error: "SQUARE_FAILED" }, 502);
  }
}

async function status(orderId: string) {
  const o = await loadOrder(orderId);
  if (!o) return json({ error: "NOT_FOUND" }, 404);
  if (o.paid_at) return json({ paid: true, order_no: o.order_no });
  if (!o.square_order_id || !token()) return json({ paid: false, url: o.pay_url, order_no: o.order_no });
  try {
    const so = (await square("/v2/orders/" + o.square_order_id)).order;
    for (const t of so?.tenders || []) {
      if (!t.payment_id) continue;
      const pay = (await square("/v2/payments/" + t.payment_id)).payment;
      if (pay?.status === "COMPLETED") { await markPaid(o, pay); return json({ paid: true, order_no: o.order_no }); }
    }
  } catch (err) { console.error("status failed", String(err)); }
  return json({ paid: false, url: o.pay_url, order_no: o.order_no });
}

/* Make sure Square tells us about payments: one subscription to payment.updated at HOOK_URL,
   with its signature key stored so notices can be checked. Safe to run again and again. */
async function ensureWebhook(): Promise<boolean> {
  if (await secret("SQUARE_WEBHOOK_SIGNATURE_KEY")) return true;
  try {
    const list = await square("/v2/webhooks/subscriptions?include_disabled=true");
    const mine = (list.subscriptions || []).find((s: any) => s.notification_url === HOOK_URL);
    let key = "";
    if (mine) {
      if (!mine.enabled || !(mine.event_types || []).includes("payment.updated")) {
        await square("/v2/webhooks/subscriptions/" + mine.id, { method: "PUT", body: JSON.stringify({ subscription: { enabled: true, event_types: ["payment.updated"] } }) });
      }
      const k = await square("/v2/webhooks/subscriptions/" + mine.id + "/signature-key", { method: "POST", body: JSON.stringify({ idempotency_key: crypto.randomUUID() }) });
      key = k.signature_key || "";
    } else {
      const made = await square("/v2/webhooks/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          idempotency_key: crypto.randomUUID(),
          subscription: { name: "Sona Events payments", event_types: ["payment.updated"], notification_url: HOOK_URL, api_version: SQUARE_VERSION },
        }),
      });
      key = made.subscription?.signature_key || "";
    }
    if (key) await saveSecret("SQUARE_WEBHOOK_SIGNATURE_KEY", key);
    return !!key;
  } catch (err) {
    console.error("webhook setup failed", String(err));
    return false;
  }
}

async function check() {
  if (!token()) return json({ connected: false, reason: "no_token" });
  try {
    const loc = await location();
    const webhook = await ensureWebhook();
    return json({ connected: true, location: loc.name, webhook, sandbox: SANDBOX });
  } catch (err) {
    return json({ connected: false, reason: String(err).includes("401") ? "bad_token" : "error" });
  }
}

async function validSignature(raw: string, sig: string) {
  const key = await secret("SQUARE_WEBHOOK_SIGNATURE_KEY");
  if (!key || !sig) return false;
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(HOOK_URL + raw));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  return diff === 0;
}

async function webhook(req: Request) {
  const raw = await req.text();
  if (!(await validSignature(raw, req.headers.get("x-square-hmacsha256-signature") || ""))) return new Response("bad signature", { status: 401 });
  try {
    const evt = JSON.parse(raw);
    const pay = evt?.data?.object?.payment;
    if (pay && pay.status === "COMPLETED" && pay.order_id) {
      const { data } = await db.from("orders").select("id, paid_at, pay_amount").eq("square_order_id", pay.order_id).maybeSingle();
      if (data) await markPaid(data, pay);
    }
  } catch (err) { console.error("webhook failed", String(err)); }
  return new Response("ok");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  await loadSecrets();
  if (req.headers.get("x-square-hmacsha256-signature")) return webhook(req);
  const body = await req.json().catch(() => ({}));
  if (body.action === "create") return create(String(body.order_id || ""));
  if (body.action === "status") return status(String(body.order_id || ""));
  if (body.action === "check") return check();
  return json({ error: "BAD_ACTION" }, 400);
});
