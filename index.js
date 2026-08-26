// Crunchy Party — API + room relay.
//
//   POST /auth/otp/start    { phone }                 -> { ok }
//   POST /auth/otp/verify   { phone, code }           -> { token, me }
//   GET  /me                (Bearer)                  -> { me }
//   POST /billing/subscribe (Bearer)                  -> { url }
//   POST /billing/refresh   (Bearer)                  -> { me }   (poll after paying)
//   POST /billing/cancel    (Bearer)                  -> { me }
//   POST /billing/webhook   (Razorpay, raw body)
//   GET  /health
//   WS   /ws?token=JWT&room=123456
//
// Rooms hold at most 2 sockets and relay small JSON messages between them:
// playback sync, chat, reactions, GIF urls, and WebRTC signalling for cams.

require("dotenv").config();
const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const http = require("http");
const { WebSocketServer } = require("ws");

const { q, now, findOrCreateUser, entitlement } = require("./db");
const { sendOtp } = require("./sms");
const billing = require("./billing");

const PORT = parseInt(process.env.PORT || "8080", 10);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 24) {
  console.error("JWT_SECRET missing or too short — see .env.example");
  process.exit(1);
}

const app = express();
app.set("trust proxy", 1);

// Razorpay's webhook needs the raw body for signature checking.
app.use("/billing/webhook", express.raw({ type: "*/*", limit: "1mb" }));
app.use(express.json({ limit: "64kb" }));

// The extension calls from https://www.crunchyroll.com.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ------------------------------------------------------------------ helpers

const hits = new Map(); // key -> [timestamps]
function rateLimit(key, max, windowMs) {
  const t = now();
  const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
  arr.push(t);
  hits.set(key, arr);
  return arr.length <= max;
}
setInterval(() => {
  const t = now();
  for (const [k, arr] of hits) {
    const keep = arr.filter((x) => t - x < 3600000);
    if (keep.length) hits.set(k, keep);
    else hits.delete(k);
  }
}, 600000).unref();

// E.164, e.g. +919876543210. Keeps international users working.
function normalisePhone(raw) {
  const s = String(raw || "").replace(/[^\d+]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(s)) return null;
  return s;
}

const hashCode = (phone, code) =>
  crypto.createHmac("sha256", JWT_SECRET).update(`${phone}:${code}`).digest("hex");

function publicUser(user) {
  const ent = entitlement(user);
  return {
    phone: user.phone,
    status: ent.reason,
    active: ent.active,
    until: ent.until || null,
    sub_status: user.sub_status || null,
    support_whatsapp: process.env.SUPPORT_WHATSAPP || null,
  };
}

function auth(req, res, next) {
  const h = req.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no-token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = q.userById.get(payload.uid);
    if (!user) return res.status(401).json({ error: "no-user" });
    req.user = user;
    next();
  } catch (_) {
    res.status(401).json({ error: "bad-token" });
  }
}

// --------------------------------------------------------------------- auth

app.post("/auth/otp/start", async (req, res) => {
  const phone = normalisePhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: "bad-phone" });

  const ip = req.ip || "?";
  if (!rateLimit(`otp:ip:${ip}`, 20, 3600000)) return res.status(429).json({ error: "rate" });
  if (!rateLimit(`otp:ph:${phone}`, 5, 3600000)) return res.status(429).json({ error: "rate" });

  const code = String(crypto.randomInt(100000, 1000000));
  q.upsertOtp.run({
    phone,
    code_hash: hashCode(phone, code),
    expires_at: now() + 5 * 60000,
    sent_at: now(),
  });

  try {
    const out = await sendOtp(phone, code);
    res.json({ ok: true, dev: !!out.dev });
  } catch (e) {
    console.error("otp send failed:", e.message);
    res.status(502).json({ error: "sms-failed" });
  }
});

app.post("/auth/otp/verify", (req, res) => {
  const phone = normalisePhone(req.body && req.body.phone);
  const code = String((req.body && req.body.code) || "").trim();
  if (!phone || !/^\d{6}$/.test(code)) return res.status(400).json({ error: "bad-input" });

  const row = q.getOtp.get(phone);
  if (!row) return res.status(400).json({ error: "no-otp" });
  if (row.expires_at < now()) {
    q.clearOtp.run(phone);
    return res.status(400).json({ error: "expired" });
  }
  if (row.attempts >= 5) return res.status(429).json({ error: "too-many" });

  const given = Buffer.from(hashCode(phone, code));
  const want = Buffer.from(row.code_hash);
  const ok = given.length === want.length && crypto.timingSafeEqual(given, want);
  if (!ok) {
    q.bumpOtpAttempts.run(phone);
    return res.status(400).json({ error: "wrong-code" });
  }

  q.clearOtp.run(phone);
  const user = findOrCreateUser(phone);
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: "180d" });
  res.json({ token, me: publicUser(user) });
});

app.get("/me", auth, (req, res) => res.json({ me: publicUser(req.user) }));

// ------------------------------------------------------------------ billing

app.post("/billing/subscribe", auth, async (req, res) => {
  if (!process.env.RAZORPAY_PLAN_ID) return res.status(503).json({ error: "billing-off" });
  try {
    const sub = await billing.createSubscription(req.user);
    q.setSub.run(sub.id, sub.status, req.user.id);
    res.json({ url: sub.url, id: sub.id });
  } catch (e) {
    console.error("subscribe failed:", e.message);
    res.status(502).json({ error: "razorpay-failed" });
  }
});

// Called by the extension after the payment tab closes, so the user doesn't
// have to wait on webhook timing.
app.post("/billing/refresh", auth, async (req, res) => {
  const user = q.userById.get(req.user.id);
  if (!user.sub_id) return res.json({ me: publicUser(user) });
  try {
    const sub = await billing.fetchSubscription(user.sub_id);
    applySubscription(user.id, sub);
  } catch (e) {
    console.error("refresh failed:", e.message);
  }
  res.json({ me: publicUser(q.userById.get(req.user.id)) });
});

app.post("/billing/cancel", auth, async (req, res) => {
  const user = q.userById.get(req.user.id);
  if (!user.sub_id) return res.status(400).json({ error: "no-sub" });
  try {
    const sub = await billing.cancelSubscription(user.sub_id);
    q.setSub.run(user.sub_id, sub.status, user.id);
    // Paid time already bought is kept; access ends when paid_until passes.
    res.json({ me: publicUser(q.userById.get(user.id)) });
  } catch (e) {
    console.error("cancel failed:", e.message);
    res.status(502).json({ error: "razorpay-failed" });
  }
});

// current_end is a unix seconds timestamp of the end of the paid cycle.
function applySubscription(userId, sub) {
  const user = q.userById.get(userId);
  if (!user) return;
  q.setSub.run(sub.id, sub.status, userId);
  const activeStates = ["active", "authenticated", "completed"];
  if (activeStates.includes(sub.status) && sub.current_end) {
    const until = sub.current_end * 1000 + 2 * 86400000; // small grace period
    if (!user.paid_until || until > user.paid_until) {
      q.setPaid.run(until, sub.status, userId);
    }
  }
}

app.post("/billing/webhook", async (req, res) => {
  const sig = req.get("X-Razorpay-Signature");
  const raw = req.body; // Buffer, thanks to express.raw above
  if (!billing.verifyWebhook(raw, sig)) return res.status(400).send("bad-signature");

  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch (_) {
    return res.status(400).send("bad-json");
  }

  // Razorpay retries; make replays harmless.
  const id = req.get("X-Razorpay-Event-Id") || `${event.event}:${JSON.stringify(event.payload).length}`;
  if (q.seenEvent.get(id)) return res.json({ ok: true, duplicate: true });
  q.markEvent.run(id, now());

  try {
    const sub = event.payload && event.payload.subscription && event.payload.subscription.entity;
    if (sub && sub.id) {
      const user = q.userBySub.get(sub.id);
      const uid = user ? user.id : parseInt((sub.notes && sub.notes.user_id) || "0", 10);
      if (uid) applySubscription(uid, sub);
    }
  } catch (e) {
    console.error("webhook handling failed:", e.message);
  }

  res.json({ ok: true });
});

app.get("/health", (_req, res) => res.json({ ok: true, t: now() }));

// ------------------------------------------------------------ rooms over ws

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const rooms = new Map(); // code -> Set<ws>

function roomOf(code) {
  if (!rooms.has(code)) rooms.set(code, new Set());
  return rooms.get(code);
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, "http://x");
  } catch (_) {
    return socket.destroy();
  }
  if (url.pathname !== "/ws") return socket.destroy();

  const token = url.searchParams.get("token") || "";
  const code = url.searchParams.get("room") || "";
  if (!/^\d{6}$/.test(code)) return socket.destroy();

  let user;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    user = q.userById.get(payload.uid);
  } catch (_) {
    return socket.destroy();
  }
  if (!user) return socket.destroy();

  const ent = entitlement(user);
  if (!ent.active) {
    // Let the client read the reason before we hang up.
    wss.handleUpgrade(req, socket, head, (ws) => {
      send(ws, { t: "denied", reason: ent.reason });
      setTimeout(() => ws.close(4003, ent.reason), 250);
    });
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.userId = user.id;
    ws.room = code;
    ws.alive = true;
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  const peers = roomOf(ws.room);
  if (peers.size >= 2) {
    send(ws, { t: "denied", reason: "room-full" });
    return ws.close(4004, "room-full");
  }
  ws.role = peers.size === 0 ? "host" : "guest";
  peers.add(ws);

  send(ws, { t: "joined", role: ws.role, peers: peers.size });
  for (const p of peers) if (p !== ws) send(p, { t: "peer-joined" });

  ws.on("pong", () => (ws.alive = true));

  ws.on("message", (data) => {
    if (data.length > 256 * 1024) return; // GIF urls are small; nothing here is big
    let msg;
    try {
      msg = JSON.parse(data.toString("utf8"));
    } catch (_) {
      return;
    }
    if (msg.t === "ping") return send(ws, { t: "pong" });
    // Everything else is relayed verbatim to the other side. The server does
    // not interpret sync/chat payloads.
    for (const p of roomOf(ws.room)) {
      if (p !== ws) send(p, { t: "peer", payload: msg });
    }
  });

  ws.on("close", () => {
    const set = roomOf(ws.room);
    set.delete(ws);
    for (const p of set) send(p, { t: "peer-left" });
    if (!set.size) rooms.delete(ws.room);
  });
});

// Drop half-open sockets so rooms don't stay "full" with ghosts.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) {
      ws.terminate();
      continue;
    }
    ws.alive = false;
    try {
      ws.ping();
    } catch (_) {}
  }
}, 30000).unref();

// Re-check entitlement periodically: a trial can lapse mid-session.
setInterval(() => {
  for (const ws of wss.clients) {
    const user = q.userById.get(ws.userId);
    if (!entitlement(user).active) {
      send(ws, { t: "denied", reason: "expired" });
      ws.close(4003, "expired");
    }
  }
}, 300000).unref();

server.listen(PORT, () => console.log(`Crunchy Party server on :${PORT}`));
