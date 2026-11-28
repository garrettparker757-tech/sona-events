// Staff logins for Sona Events. Only a signed-in staff member can call this.
//   POST { action: "list" }           -> staff emails, whether each has a login, which one is you
//   POST { action: "login", email }   -> adds the email to the staff list if needed, then creates its login
//                                        (or resets its password) and returns a one-time temporary password
import { createClient } from "npm:@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
}
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });

// readable, easy to type on a phone: no 0/O/1/l/I
function tempPassword() {
  const chars = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let out = "";
  for (let i = 0; i < 12; i++) { out += chars[bytes[i] % chars.length]; if (i === 3 || i === 7) out += "-"; }
  return out;
}

async function caller(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.startsWith("sb_")) return null;
  const { data } = await db.auth.getUser(jwt);
  const user = data?.user;
  if (!user?.email || !user.email_confirmed_at) return null;
  const { data: row } = await db.from("staff").select("email").ilike("email", user.email).maybeSingle();
  return row ? user : null;
}

async function allUsers() {
  const users: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    users.push(...data.users);
    if (data.users.length < 200) break;
  }
  return users;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    const asked = req.headers.get("access-control-request-headers");
    return new Response("ok", { headers: { ...cors, ...(asked ? { "Access-Control-Allow-Headers": asked } : {}) } });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const me = await caller(req);
  if (!me) return json({ error: "NOT_STAFF" }, 403);
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action === "list") {
      const { data: staff } = await db.from("staff").select("email").order("email");
      const users = await allUsers();
      const has = new Set(users.map((u) => String(u.email || "").toLowerCase()));
      return json({
        staff: (staff || []).map((s: any) => ({
          email: s.email,
          has_login: has.has(String(s.email).toLowerCase()),
          me: String(s.email).toLowerCase() === String(me.email).toLowerCase(),
        })),
      });
    }
    if (body.action === "login") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 200) return json({ error: "BAD_EMAIL" }, 400);
      if (email === String(me.email).toLowerCase()) return json({ error: "USE_CHANGE_PASSWORD" }, 400);
      const { data: onList } = await db.from("staff").select("email").ilike("email", email).maybeSingle();
      if (!onList) {
        const { error } = await db.from("staff").insert({ email });
        if (error) throw error;
      }
      const password = tempPassword();
      const existing = (await allUsers()).find((u) => String(u.email || "").toLowerCase() === email);
      if (existing) {
        const { error } = await db.auth.admin.updateUserById(existing.id, { password, email_confirm: true });
        if (error) throw error;
      } else {
        const { error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
        if (error) throw error;
      }
      return json({ email, password });
    }
    return json({ error: "BAD_ACTION" }, 400);
  } catch (err) {
    console.error("staff-admin failed", String(err));
    return json({ error: "FAILED" }, 500);
  }
});
