// Otaku Sync — background.
// 1) Relays messages between frames of a tab (content scripts can't talk
//    to each other directly).
// 2) Fetches the remote config from GitHub, with caching and fallback.
// 3) Proxies API and GIPHY calls, so the page's CSP can never interfere.

// Publish config.json here; changing it re-points every installed extension.
const CONFIG_URL =
  "https://raw.githubusercontent.com/yogesh-m-2/crunchy-together/main/config.json";
const CONFIG_TTL = 15 * 60 * 1000; // re-check every 15 minutes

const BUILTIN_CONFIG = {
  api: "https://api.YOURDOMAIN.com",
  ws: "wss://api.YOURDOMAIN.com/ws",
  fallbacks: [],
  support_whatsapp: "+918660095124",
  price_label: "₹50 / month",
  trial_days: 7,
  notice: null,
  maintenance: false,
  ice: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
  ],
};

const DEFAULT_GIPHY_KEY = "Ky4VSUGTSrg7tgRcjASnn2Be6JEkvawI";

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.channel === "otaku-sync-api") {
    handleApi(msg, sender)
      .then(sendResponse)
      .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
    return true; // async
  }

  if (msg && msg.channel === "otaku-sync") {
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) return;
    chrome.tabs.sendMessage(tabId, msg).catch(() => {});
  }
});

// Which tab is the Razorpay checkout, and which tab to return to afterwards.
let paymentWatch = null;

chrome.tabs.onRemoved.addListener((tabId) => {
  if (!paymentWatch || tabId !== paymentWatch.payTabId) return;
  const origin = paymentWatch.originTabId;
  paymentWatch = null;
  // The user closed the checkout themselves — prompt an immediate re-check
  // instead of waiting for the next poll.
  chrome.tabs
    .sendMessage(origin, { channel: "otaku-sync", type: "payment-tab-closed" }, { frameId: 0 })
    .catch(() => {});
});

// ------------------------------------------------------------------ config

async function getConfig(force = false) {
  const { configCache } = await chrome.storage.local.get("configCache");
  const fresh = configCache && Date.now() - configCache.at < CONFIG_TTL;
  if (fresh && !force) return { config: configCache.config, source: "cache" };

  try {
    const res = await fetch(CONFIG_URL, { cache: "no-cache" });
    if (res.ok) {
      const config = await res.json();
      if (config && typeof config.api === "string" && typeof config.ws === "string") {
        await chrome.storage.local.set({ configCache: { at: Date.now(), config } });
        return { config, source: "remote" };
      }
    }
  } catch (_) {
    // Offline or GitHub unreachable — fall through to whatever we have.
  }

  if (configCache) return { config: configCache.config, source: "stale-cache" };
  return { config: BUILTIN_CONFIG, source: "builtin" };
}

async function apiBase() {
  const { config } = await getConfig();
  return config;
}

// -------------------------------------------------------------------- API

async function callApi(path, { method = "GET", body = null, auth = false, token = null } = {}) {
  const config = await apiBase();
  const bases = [config.api, ...(config.fallbacks || []).map((f) => f && f.api)].filter(Boolean);

  const headers = { "Content-Type": "application/json" };
  if (auth) {
    // An explicit token wins — used by the device-limit screen, which holds a
    // short-lived management token before the real one is issued.
    const use = token || (await chrome.storage.local.get("token")).token;
    if (!use) return { error: "no-token", status: 401 };
    headers.Authorization = `Bearer ${use}`;
  }

  let lastError = "unreachable";
  for (const base of bases) {
    try {
      const res = await fetch(base.replace(/\/+$/, "") + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : {};
      } catch (_) {
        json = { error: "bad-response" };
      }
      if (!res.ok) {
        // Keep the whole body: error responses carry useful payload (the
        // device list and management token on a 409, for example).
        return {
          ...(json && typeof json === "object" ? json : {}),
          error: (json && json.error) || `http-${res.status}`,
          status: res.status,
        };
      }
      return json;
    } catch (e) {
      lastError = "unreachable";
    }
  }
  return { error: lastError };
}

async function handleApi(msg, sender) {
  if (msg.type === "config") return getConfig(msg.force);

  if (msg.type === "get" || msg.type === "post") {
    return callApi(msg.path, {
      method: msg.type === "post" ? "POST" : "GET",
      body: msg.body || null,
      auth: !!msg.auth,
      token: msg.token || null,
    });
  }

  if (msg.type === "open-tab") {
    try {
      const u = new URL(msg.url);
      if (u.protocol !== "https:") return { error: "bad-url" };
      const tab = await chrome.tabs.create({ url: u.toString() });
      if (msg.watch) {
        paymentWatch = {
          payTabId: tab.id,
          originTabId: (sender && sender.tab && sender.tab.id) || null,
        };
      }
      return { ok: true, tabId: tab.id };
    } catch (_) {
      return { error: "bad-url" };
    }
  }

  // Payment confirmed: close the checkout tab and put the user back where
  // they were watching.
  if (msg.type === "finish-payment") {
    if (paymentWatch) {
      const { payTabId, originTabId } = paymentWatch;
      paymentWatch = null;
      try {
        await chrome.tabs.remove(payTabId);
      } catch (_) {}
      if (originTabId != null) {
        try {
          const tab = await chrome.tabs.get(originTabId);
          await chrome.tabs.update(originTabId, { active: true });
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch (_) {}
      }
    }
    return { ok: true };
  }

  if (msg.type === "gif-search") {
    const { giphyKey } = await chrome.storage.local.get("giphyKey");
    const key = (giphyKey || DEFAULT_GIPHY_KEY).trim();
    const q = (msg.q || "").trim();
    const base = q
      ? `https://api.giphy.com/v1/gifs/search?q=${encodeURIComponent(q)}&`
      : "https://api.giphy.com/v1/gifs/trending?";
    const res = await fetch(`${base}api_key=${encodeURIComponent(key)}&limit=12&rating=pg-13`);
    if ([401, 403, 429].includes(res.status)) return { error: "auth" };
    if (!res.ok) return { error: `http-${res.status}` };
    const data = await res.json();
    const gifs = (data.data || [])
      .map((g) => {
        const imgs = g.images || {};
        const preview = (imgs.fixed_width_small || imgs.fixed_width || {}).url;
        const full = (imgs.fixed_width || imgs.original || {}).url;
        return preview && full ? { preview, full } : null;
      })
      .filter(Boolean);
    return { gifs };
  }

  if (msg.type === "set-giphy-key") {
    await chrome.storage.local.set({ giphyKey: String(msg.key || "").trim() });
    return { ok: true };
  }

  if (msg.type === "img-b64") {
    const u = new URL(msg.url);
    if (u.protocol !== "https:" || !/(^|\.)giphy\.com$/.test(u.hostname)) return { error: "bad-host" };
    const res = await fetch(msg.url);
    if (!res.ok) return { error: `http-${res.status}` };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 4 * 1024 * 1024) return { error: "too-big" };
    let bin = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    const mime = res.headers.get("content-type") || "image/gif";
    return { dataUrl: `data:${mime};base64,${btoa(bin)}` };
  }

  return { error: "unknown-type" };
}

// Warm the config cache on install and browser start.
chrome.runtime.onInstalled.addListener(() => getConfig(true));
chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(() => getConfig(true));

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  chrome.tabs
    .sendMessage(tab.id, { channel: "otaku-sync", type: "show-panel" }, { frameId: 0 })
    .catch(() => {});
});
