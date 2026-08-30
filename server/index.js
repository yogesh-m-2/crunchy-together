// Otaku Sync — API + room relay.
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

const { q, now, entitlement, deviceOk } = require("./db");
const billing = require("./billing");
const { router: authRouter, publicUser, ipOf } = require("./auth");

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
function auth(req, res, next) {
  const h = req.get("Authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: "no-token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = q.userById.get(payload.uid);
    if (!user) return res.status(401).json({ error: "no-user" });
    // A revoked device must stop working immediately, even with a valid token.
    if (payload.did && !payload.pending && !deviceOk(user.id, payload.did)) {
      return res.status(401).json({ error: "device-revoked" });
    }
    req.user = user;
    req.deviceId = payload.did || null;
    next();
  } catch (_) {
    res.status(401).json({ error: "bad-token" });
  }
}

// Policy pages (privacy, terms, refunds) — the hosted sign-in page links to
// these, and Razorpay/Chrome Web Store need them publicly reachable.
app.use("/party", express.static(require("path").join(__dirname, "public"), { maxAge: "1h" }));

// Sign-in (Google, Facebook, email+password) lives in auth.js
app.use(authRouter);

app.get("/me", auth, (req, res) => res.json({ me: publicUser(req.user) }));

// ------------------------------------------------------------------ billing

app.post("/billing/subscribe", auth, async (req, res) => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    console.error("subscribe: RAZORPAY_KEY_ID/SECRET missing in .env");
    return res.status(503).json({ error: "billing-off" });
  }
  if (!process.env.RAZORPAY_PLAN_ID) {
    console.error("subscribe: RAZORPAY_PLAN_ID missing in .env — create a monthly INR 5 plan first");
    return res.status(503).json({ error: "billing-off" });
  }
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

// LATENCY NOTES (this is the hot path — a pause must reach the other side fast):
//  * perMessageDeflate off. Compressing a 60-byte JSON object costs CPU and
//    adds delay for no bandwidth win.
//  * setNoDelay(true) on every socket. Nagle's algorithm holds small packets
//    back for up to ~40ms waiting to coalesce them. That is the single biggest
//    avoidable delay here, and it is on by default.
//  * The relay never JSON.parses the payload. It peeks at the frame, then
//    forwards the original bytes inside a pre-built envelope by string
//    concatenation. No parse, no re-serialize.
//  * Nothing on this path touches SQLite or the disk. Entitlement is resolved
//    once at connect and cached on the socket, so no synchronous query can
//    ever stall the event loop mid-party.
const wss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
  maxPayload: 256 * 1024,
});

const rooms = new Map(); // code -> Set<ws>

function roomOf(code) {
  let set = rooms.get(code);
  if (!set) {
    set = new Set();
    rooms.set(code, set);
  }
  return set;
}

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

// Forward a raw frame to the peer without parsing it.
const ENVELOPE_HEAD = '{"t":"peer","payload":';
function relayRaw(from, raw) {
  const set = rooms.get(from.room);
  if (!set) return;
  let framed = null;
  for (const p of set) {
    if (p === from || p.readyState !== p.OPEN) continue;
    if (framed === null) framed = ENVELOPE_HEAD + raw + "}";
    p.send(framed);
  }
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
  const code = String(url.searchParams.get("room") || "").toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return socket.destroy();

  let user;
  let deviceId = null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    user = q.userById.get(payload.uid);
    deviceId = payload.did || null;
  } catch (_) {
    return socket.destroy();
  }
  if (!user) return socket.destroy();

  // Signed out from another device: cut this session off immediately.
  if (deviceId && !deviceOk(user.id, deviceId)) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      send(ws, { t: "denied", reason: "device-revoked" });
      setTimeout(() => ws.close(4003, "device-revoked"), 250);
    });
    return;
  }

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
    ws.deviceId = deviceId;
    ws.room = code;
    ws.alive = true;
    // Small control messages must go out immediately, not be held for
    // coalescing. This is the difference between a pause landing in 20ms
    // and landing in 60ms.
    try {
      socket.setNoDelay(true);
    } catch (_) {}
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

  ws.on("message", (data, isBinary) => {
    if (isBinary) return;
    const raw = data.toString("utf8");
    // Cheap peek instead of a full parse. Only "ping" needs handling here;
    // everything else is relayed byte-for-byte.
    if (raw.length < 24 && raw.indexOf('"ping"') !== -1) {
      return ws.send('{"t":"pong"}');
    }
    if (raw.length < 2 || raw.charCodeAt(0) !== 123 /* { */) return;
    relayRaw(ws, raw);
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

// Re-check entitlement periodically: a trial can lapse mid-session. This runs
// every few minutes, never on the message path, and uses one query for all
// connected users rather than one per socket.
setInterval(() => {
  if (!wss.clients.size) return;
  const ids = new Set();
  for (const ws of wss.clients) ids.add(ws.userId);
  const allowed = new Set();
  for (const id of ids) {
    const user = q.userById.get(id);
    if (user && entitlement(user).active) allowed.add(id);
  }
  for (const ws of wss.clients) {
    if (!allowed.has(ws.userId)) {
      send(ws, { t: "denied", reason: "expired" });
      ws.close(4003, "expired");
    }
  }
}, 300000).unref();

server.listen(PORT, () => console.log(`Otaku Sync server on :${PORT}`));
