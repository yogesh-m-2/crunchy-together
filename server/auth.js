// Otaku Sync — sign-in.
//
// Device-code flow: the extension creates a request, opens a hosted page in a
// tab, and polls for the resulting token. Nothing OAuth-related lives in the
// extension, so no client secrets ship to users and every provider is wired
// the same way.
//
//   POST /auth/request        { device_id, label }  -> { rid, url }
//   GET  /auth/page?rid=...                          hosted sign-in page
//   GET  /auth/google?rid=... , /auth/google/callback
//   GET  /auth/facebook?rid=... , /auth/facebook/callback
//   POST /auth/email/start    { rid, email }         send code
//   POST /auth/email/verify   { rid, email, code, password? }
//   POST /auth/password       { rid, email, password }   sign in
//   POST /auth/poll           { rid, device_id }     -> { token, me } | pending
//   GET  /devices             (Bearer)
//   POST /devices/revoke      (Bearer) { id }

const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");

const {
  q,
  now,
  MAX_DEVICES,
  hashPassword,
  checkPassword,
  createUser,
  findOrCreateGuest,
  attachIdentity,
  isGuest,
  entitlement,
  registerDevice,
} = require("./db");
const { sendCode } = require("./mailer");

const router = express.Router();

const JWT_SECRET = () => process.env.JWT_SECRET;

// Prefer the configured public URL, but fall back to the request's own host so
// a missing PUBLIC_URL can't produce relative (and therefore unusable) links.
function baseOf(req) {
  const configured = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
  if (configured) return configured;
  const proto = req.get("X-Forwarded-Proto") || req.protocol || "https";
  const host = req.get("X-Forwarded-Host") || req.get("host");
  return host ? `${proto}://${host}` : "";
}


const haveGoogle = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
const haveFacebook = () => !!(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);

const hits = new Map();
function rateLimit(key, max, windowMs) {
  const t = now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  arr.push(t);
  hits.set(key, arr);
  return arr.length <= max;
}

const esc = (s) =>
  String(s || "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const normEmail = (raw) => {
  const s = String(raw || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254 ? s : null;
};

const hashCode = (ident, code) =>
  crypto.createHmac("sha256", JWT_SECRET()).update(`${ident}:${code}`).digest("hex");

function ipOf(req) {
  return (req.ip || "").replace(/^::ffff:/, "");
}

function publicUser(user) {
  const ent = entitlement(user);
  return {
    email: user.email || null,
    phone: user.phone || null,
    name: user.name || null,
    guest: isGuest(user),
    status: ent.reason,
    active: ent.active,
    until: ent.until || null,
    sub_status: user.sub_status || null,
    support_whatsapp: process.env.SUPPORT_WHATSAPP || null,
  };
}

// Marks a sign-in request as belonging to this user. The extension's next
// poll turns it into a token.
function completeRequest(rid, userId) {
  const reqRow = q.getAuthReq.get(rid);
  if (!reqRow) return false;
  q.fillAuthReq.run(userId, rid);
  return true;
}

// ------------------------------------------------------------ start / page


// Start (or resume) an anonymous trial for this device. No sign-in needed —
// people can watch with a friend immediately, and are only asked to sign in
// when the trial runs out and they want to subscribe.
router.post("/auth/guest", (req, res) => {
  const deviceId = String((req.body && req.body.device_id) || "").slice(0, 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) return res.status(400).json({ error: "bad-device" });
  if (!rateLimit(`guest:${ipOf(req)}`, 40, 3600000)) return res.status(429).json({ error: "rate" });

  const label = String((req.body && req.body.label) || "").slice(0, 60) || "Browser";
  const user = findOrCreateGuest(deviceId, ipOf(req));
  const reg = registerDevice(user.id, deviceId, label, ipOf(req));
  if (!reg.ok) return res.status(409).json({ error: "device-limit", max: MAX_DEVICES, devices: reg.devices });

  const token = jwt.sign({ uid: user.id, did: deviceId }, JWT_SECRET(), { expiresIn: "180d" });
  res.json({ token, me: publicUser(user) });
});

router.post("/auth/request", (req, res) => {
  const deviceId = String((req.body && req.body.device_id) || "").slice(0, 64);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) return res.status(400).json({ error: "bad-device" });
  if (!rateLimit(`req:${ipOf(req)}`, 30, 3600000)) return res.status(429).json({ error: "rate" });

  const rid = crypto.randomBytes(18).toString("base64url");
  q.newAuthReq.run(rid, deviceId, ipOf(req), now());
  res.json({ rid, url: `${baseOf(req)}/auth/page?rid=${encodeURIComponent(rid)}` });
});

function page(body, title = "Sign in") {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · Otaku Sync</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box;margin:0;font-family:ui-sans-serif,system-ui,"Segoe UI",sans-serif}
body{background:#10131a;color:#e6e9f2;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{width:100%;max-width:380px;background:#171b24;border:1px solid #262c3a;border-radius:12px;padding:26px}
h1{font-size:20px;margin-bottom:4px}
p.sub{color:#8b93a7;font-size:13px;margin-bottom:20px}
p.err{color:#ff9d9d;font-size:13px;margin-bottom:14px}
p.ok{color:#5fd1a0;font-size:13px;margin-bottom:14px}
label{display:block;font-size:12px;color:#8b93a7;margin:12px 0 5px}
input{width:100%;background:#10131a;color:#e6e9f2;border:1px solid #262c3a;border-radius:7px;padding:10px;font-size:14px}
input:focus{outline:none;border-color:#ffb03b}
button,.btn{width:100%;padding:11px;border-radius:8px;border:1px solid #333b4d;background:#212736;color:#e6e9f2;
font-size:14px;font-weight:500;cursor:pointer;margin-top:10px;display:block;text-align:center;text-decoration:none}
button:hover,.btn:hover{border-color:#4a5468}
.primary{background:#ffb03b;border-color:#ffb03b;color:#191400;font-weight:600}
.primary:hover{background:#ffbf5e}
.g{background:#fff;border-color:#fff;color:#1a1a1a;font-weight:600}
.fb{background:#1877f2;border-color:#1877f2;color:#fff;font-weight:600}
.divider{display:flex;align-items:center;gap:10px;color:#59627a;font-size:11px;margin:18px 0 4px}
.divider::before,.divider::after{content:"";flex:1;height:1px;background:#262c3a}
.foot{margin-top:18px;font-size:12px;color:#8b93a7;text-align:center}
a{color:#ffb03b}
</style></head><body><div class="card">${body}</div></body></html>`;
}

router.get("/auth/page", (req, res) => {
  const rid = String(req.query.rid || "");
  const reqRow = q.getAuthReq.get(rid);
  if (!reqRow) {
    return res.status(400).send(page(`<h1>Link expired</h1><p class="sub">Close this tab and press Sign in again in the extension.</p>`));
  }
  const err = req.query.err ? `<p class="err">${esc(req.query.err)}</p>` : "";
  const social = [
    haveGoogle() ? `<a class="btn g" href="/auth/google?rid=${esc(rid)}">Continue with Google</a>` : "",
    haveFacebook() ? `<a class="btn fb" href="/auth/facebook?rid=${esc(rid)}">Continue with Facebook</a>` : "",
  ].join("");

  res.send(
    page(`
<h1>Sign in</h1>
<p class="sub">Your first ${esc(process.env.TRIAL_DAYS || "7")} days are free.</p>
${err}
${social}
${social ? '<div class="divider">or with email</div>' : ""}
<form method="POST" action="/auth/email">
  <input type="hidden" name="rid" value="${esc(rid)}">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" required placeholder="you@example.com">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password"
         minlength="8" required placeholder="At least 8 characters">
  <button class="primary" type="submit">Continue</button>
</form>
<p class="foot">New here? The same form creates your account.<br>
<a href="/party/terms.html">Terms</a> · <a href="/party/privacy.html">Privacy</a></p>`)
  );
});

// --------------------------------------------------------- email + password

router.post("/auth/email", express.urlencoded({ extended: false }), async (req, res) => {
  const rid = String((req.body && req.body.rid) || "");
  const email = normEmail(req.body && req.body.email);
  const password = String((req.body && req.body.password) || "");
  const back = (msg) => res.redirect(`/auth/page?rid=${encodeURIComponent(rid)}&err=${encodeURIComponent(msg)}`);

  if (!q.getAuthReq.get(rid)) return back("That sign-in link expired.");
  if (!email) return back("That email address doesn't look right.");
  if (password.length < 8) return back("Use a password of at least 8 characters.");
  if (!rateLimit(`pw:${ipOf(req)}`, 20, 900000)) return back("Too many attempts. Try again shortly.");

  const existing = q.userByEmail.get(email);

  if (existing && existing.pass_hash) {
    if (!checkPassword(password, existing.pass_hash)) return back("Wrong password for that email.");
    if (!existing.verified) return sendVerify(res, rid, email, "Verify your email to continue.");
    completeRequest(rid, existing.id);
    return res.send(donePage());
  }

  if (existing && !existing.pass_hash) {
    // Account was created through Google/Facebook — set a password after
    // proving control of the mailbox.
    return sendVerify(res, rid, email, "Check your email for a code to finish setting this password.", password);
  }

  return sendVerify(res, rid, email, "Check your email for your verification code.", password);
});

async function sendVerify(res, rid, email, note, password) {
  const code = String(crypto.randomInt(100000, 1000000));
  q.upsertOtp.run({
    ident: `email:${email}`,
    code_hash: hashCode(`email:${email}`, code),
    expires_at: now() + 10 * 60000,
    sent_at: now(),
  });
  let dev = false;
  try {
    const out = await sendCode(email, code);
    dev = !!out.dev;
  } catch (e) {
    console.error("mail failed:", e.message);
    return res.redirect(`/auth/page?rid=${encodeURIComponent(rid)}&err=${encodeURIComponent("Couldn't send the email. Try again.")}`);
  }
  res.send(
    page(`
<h1>Check your email</h1>
<p class="sub">${esc(note)}${dev ? " (dev mode: see the server log)" : ""}</p>
<form method="POST" action="/auth/email/verify">
  <input type="hidden" name="rid" value="${esc(rid)}">
  <input type="hidden" name="email" value="${esc(email)}">
  <input type="hidden" name="password" value="${esc(password || "")}">
  <label for="code">6-digit code</label>
  <input id="code" name="code" inputmode="numeric" maxlength="6" required placeholder="000000"
         style="font-family:ui-monospace,monospace;letter-spacing:.2em;text-align:center">
  <button class="primary" type="submit">Verify</button>
</form>`)
  );
}

router.post("/auth/email/verify", express.urlencoded({ extended: false }), (req, res) => {
  const rid = String((req.body && req.body.rid) || "");
  const email = normEmail(req.body && req.body.email);
  const code = String((req.body && req.body.code) || "").trim();
  const password = String((req.body && req.body.password) || "");
  const back = (msg) => res.redirect(`/auth/page?rid=${encodeURIComponent(rid)}&err=${encodeURIComponent(msg)}`);

  const reqRow = q.getAuthReq.get(rid);
  if (!reqRow) return back("That sign-in link expired.");
  if (!email || !/^\d{6}$/.test(code)) return back("Enter the 6-digit code.");

  const ident = `email:${email}`;
  const row = q.getOtp.get(ident);
  if (!row) return back("Request a new code.");
  if (row.expires_at < now()) {
    q.clearOtp.run(ident);
    return back("That code expired. Try again.");
  }
  if (row.attempts >= 5) return back("Too many wrong attempts. Start again.");

  const given = Buffer.from(hashCode(ident, code));
  const want = Buffer.from(row.code_hash);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    q.bumpOtpAttempts.run(ident);
    return back("That code didn't match.");
  }
  q.clearOtp.run(ident);

  let user = q.userByEmail.get(email);
  if (!user) {
    user = attachIdentity(
      { email, pass_hash: password ? hashPassword(password) : null },
      { deviceId: reqRow.device_id, ip: reqRow.ip }
    );
  } else {
    q.setVerified.run(user.id);
    if (password) q.setPassHash.run(hashPassword(password), user.id);
  }
  completeRequest(rid, user.id);
  res.send(donePage());
});

// ----------------------------------------------------------------- google

router.get("/auth/google", (req, res) => {
  if (!haveGoogle()) return res.status(503).send(page("<h1>Google sign-in isn't configured.</h1>"));
  const rid = String(req.query.rid || "");
  if (!q.getAuthReq.get(rid)) return res.status(400).send(page("<h1>Link expired</h1>"));
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", process.env.GOOGLE_CLIENT_ID);
  u.searchParams.set("redirect_uri", `${baseOf(req)}/auth/google/callback`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", rid);
  res.redirect(u.toString());
});

router.get("/auth/google/callback", async (req, res) => {
  const rid = String(req.query.state || "");
  const code = String(req.query.code || "");
  const reqRow = q.getAuthReq.get(rid);
  if (!reqRow || !code) return res.status(400).send(page("<h1>Sign-in failed</h1><p class='sub'>Try again from the extension.</p>"));

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${baseOf(req)}/auth/google/callback`,
        grant_type: "authorization_code",
      }),
    });
    if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
    const tok = await tokenRes.json();

    // The id_token came straight from Google over TLS in exchange for our
    // secret, so the payload can be read directly.
    const payload = JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64").toString("utf8"));
    const sub = payload.sub;
    const email = normEmail(payload.email);
    if (!sub) throw new Error("no subject");

    let user = q.userByGoogle.get(sub) || (email && q.userByEmail.get(email));
    if (!user) {
      user = attachIdentity(
        { email, google_id: sub, name: payload.name || null },
        { deviceId: reqRow.device_id, ip: reqRow.ip }
      );
    } else if (!user.google_id) {
      q.linkGoogle.run(sub, user.id);
    }
    if (payload.name) q.setName.run(payload.name, user.id);
    completeRequest(rid, user.id);
    res.send(donePage());
  } catch (e) {
    console.error("google auth failed:", e.message);
    res.redirect(`/auth/page?rid=${encodeURIComponent(rid)}&err=${encodeURIComponent("Google sign-in failed. Try again.")}`);
  }
});

// --------------------------------------------------------------- facebook

router.get("/auth/facebook", (req, res) => {
  if (!haveFacebook()) return res.status(503).send(page("<h1>Facebook sign-in isn't configured.</h1>"));
  const rid = String(req.query.rid || "");
  if (!q.getAuthReq.get(rid)) return res.status(400).send(page("<h1>Link expired</h1>"));
  const u = new URL("https://www.facebook.com/v21.0/dialog/oauth");
  u.searchParams.set("client_id", process.env.FACEBOOK_APP_ID);
  u.searchParams.set("redirect_uri", `${baseOf(req)}/auth/facebook/callback`);
  u.searchParams.set("state", rid);
  u.searchParams.set("scope", "email");
  res.redirect(u.toString());
});

router.get("/auth/facebook/callback", async (req, res) => {
  const rid = String(req.query.state || "");
  const code = String(req.query.code || "");
  const reqRow = q.getAuthReq.get(rid);
  if (!reqRow || !code) return res.status(400).send(page("<h1>Sign-in failed</h1>"));

  try {
    const tokenUrl = new URL("https://graph.facebook.com/v21.0/oauth/access_token");
    tokenUrl.searchParams.set("client_id", process.env.FACEBOOK_APP_ID);
    tokenUrl.searchParams.set("client_secret", process.env.FACEBOOK_APP_SECRET);
    tokenUrl.searchParams.set("redirect_uri", `${baseOf(req)}/auth/facebook/callback`);
    tokenUrl.searchParams.set("code", code);
    const tokenRes = await fetch(tokenUrl);
    if (!tokenRes.ok) throw new Error(`token ${tokenRes.status}`);
    const tok = await tokenRes.json();

    const meUrl = new URL("https://graph.facebook.com/v21.0/me");
    meUrl.searchParams.set("fields", "id,name,email");
    meUrl.searchParams.set("access_token", tok.access_token);
    const meRes = await fetch(meUrl);
    if (!meRes.ok) throw new Error(`me ${meRes.status}`);
    const me = await meRes.json();
    if (!me.id) throw new Error("no id");

    const email = normEmail(me.email);
    let user = q.userByFacebook.get(me.id) || (email && q.userByEmail.get(email));
    if (!user) {
      user = attachIdentity(
        { email, facebook_id: me.id, name: me.name || null },
        { deviceId: reqRow.device_id, ip: reqRow.ip }
      );
    } else if (!user.facebook_id) {
      q.linkFacebook.run(me.id, user.id);
    }
    if (me.name) q.setName.run(me.name, user.id);
    completeRequest(rid, user.id);
    res.send(donePage());
  } catch (e) {
    console.error("facebook auth failed:", e.message);
    res.redirect(`/auth/page?rid=${encodeURIComponent(rid)}&err=${encodeURIComponent("Facebook sign-in failed. Try again.")}`);
  }
});

function donePage() {
  return page(`
<h1>You're signed in</h1>
<p class="sub">Head back to your Crunchyroll tab — the extension picks this up on its own. You can close this tab.</p>
<script>setTimeout(function(){ try { window.close(); } catch(e){} }, 2500);</script>`, "Signed in");
}

// ------------------------------------------------------------------- poll

router.post("/auth/poll", (req, res) => {
  const rid = String((req.body && req.body.rid) || "");
  const deviceId = String((req.body && req.body.device_id) || "");
  const label = String((req.body && req.body.label) || "").slice(0, 60) || "Browser";

  const row = q.getAuthReq.get(rid);
  if (!row) return res.status(404).json({ error: "expired" });
  if (row.device_id !== deviceId) return res.status(403).json({ error: "device-mismatch" });
  if (!row.user_id) return res.json({ pending: true });
  if (row.claimed) return res.status(410).json({ error: "already-used" });

  const user = q.userById.get(row.user_id);
  if (!user) return res.status(404).json({ error: "no-user" });

  const reg = registerDevice(user.id, deviceId, label, ipOf(req));
  if (!reg.ok) {
    // Signed in fine, but they're over the device limit — let them choose.
    const token = jwt.sign({ uid: user.id, did: deviceId, pending: true }, JWT_SECRET(), { expiresIn: "1h" });
    return res.status(409).json({
      error: "device-limit",
      max: MAX_DEVICES,
      devices: reg.devices,
      manage_token: token,
    });
  }

  q.claimAuthReq.run(rid);
  const token = jwt.sign({ uid: user.id, did: deviceId }, JWT_SECRET(), { expiresIn: "180d" });
  res.json({ token, me: publicUser(user) });
});

// ---------------------------------------------------------------- devices

function bearer(req) {
  const h = req.get("Authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function authAny(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: "no-token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET());
    const user = q.userById.get(payload.uid);
    if (!user) return res.status(401).json({ error: "no-user" });
    req.user = user;
    req.deviceId = payload.did || null;
    req.pendingDevice = !!payload.pending;
    next();
  } catch (_) {
    res.status(401).json({ error: "bad-token" });
  }
}

// Sign out: release this device's slot so the account can be used elsewhere
// (or here again) without hitting the device limit.
router.post("/auth/logout", authAny, (req, res) => {
  if (req.deviceId) {
    const d = q.deviceFor.get(req.user.id, req.deviceId);
    if (d) q.revokeDevice.run(req.user.id, d.id);
  }
  res.json({ ok: true });
});

router.get("/devices", authAny, (req, res) => {
  res.json({
    max: MAX_DEVICES,
    devices: q.devices.all(req.user.id).map((d) => ({
      id: d.id,
      label: d.label || "Unnamed device",
      last_seen: d.last_seen,
      current: d.device_id === req.deviceId,
    })),
  });
});

// Sign another device out, then finish signing this one in.
router.post("/devices/revoke", authAny, (req, res) => {
  const id = parseInt((req.body && req.body.id) || 0, 10);
  if (!id) return res.status(400).json({ error: "bad-id" });
  q.revokeDevice.run(req.user.id, id);

  if (req.pendingDevice && req.deviceId) {
    const label = String((req.body && req.body.label) || "Browser").slice(0, 60);
    const reg = registerDevice(req.user.id, req.deviceId, label, ipOf(req));
    if (!reg.ok) return res.status(409).json({ error: "device-limit", devices: reg.devices });
    const token = jwt.sign({ uid: req.user.id, did: req.deviceId }, JWT_SECRET(), { expiresIn: "180d" });
    return res.json({ token, me: publicUser(q.userById.get(req.user.id)) });
  }
  res.json({ ok: true });
});

module.exports = { router, publicUser, authAny, ipOf };
