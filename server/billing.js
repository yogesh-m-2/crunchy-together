// Otaku Sync — Razorpay.
// Uses the REST API directly (no SDK) so there's one less dependency.
// The key SECRET lives only here, on the server.

const crypto = require("crypto");

const API = "https://api.razorpay.com/v1";

function authHeader() {
  const pair = `${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`;
  return "Basic " + Buffer.from(pair).toString("base64");
}

async function rzp(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (_) {}
  if (!res.ok) {
    const msg = (json && json.error && json.error.description) || text.slice(0, 200);
    const err = new Error(`razorpay ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// Creates a subscription and returns the hosted checkout URL. The extension
// just opens that URL in a tab — no payment SDK inside the extension, which
// keeps card data far away from us and keeps the Web Store review simple.
async function createSubscription(user) {
  const sub = await rzp("/subscriptions", {
    method: "POST",
    body: JSON.stringify({
      plan_id: process.env.RAZORPAY_PLAN_ID,
      customer_notify: 1,
      quantity: 1,
      total_count: 120, // 10 years of monthly cycles; cancel any time
      notes: { user_id: String(user.id), phone: user.phone },
    }),
  });
  return { id: sub.id, url: sub.short_url, status: sub.status };
}

async function fetchSubscription(id) {
  return rzp(`/subscriptions/${encodeURIComponent(id)}`);
}

async function cancelSubscription(id) {
  return rzp(`/subscriptions/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ cancel_at_cycle_end: 1 }),
  });
}

// Webhooks must be verified against the RAW body — parse only after this passes.
function verifyWebhook(rawBody, signature) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET || "";
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { createSubscription, fetchSubscription, cancelSubscription, verifyWebhook };
