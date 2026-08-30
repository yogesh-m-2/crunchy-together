// Otaku Sync — networking.
// Owns: remote config, API calls (proxied through the background so page CSP
// can't interfere), the room WebSocket, and the WebRTC transport used only
// for webcam video. Exposes window.CT_NET.

(() => {
  const SUPPORT_WHATSAPP = "+918660095124";

  // Shipped defaults — used only until the GitHub config is fetched, and as a
  // last resort if it can't be reached.
  const BUILTIN = {
    api: "https://api.YOURDOMAIN.com",
    ws: "wss://api.YOURDOMAIN.com/ws",
    fallbacks: [],
    support_whatsapp: SUPPORT_WHATSAPP,
    price_label: "₹5 / month",
    trial_days: 7,
    notice: null,
    maintenance: false,
    ice: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" },
    ],
  };

  const NET = {
    config: BUILTIN,
    configSource: "builtin",
    ws: null,
    role: null,
    onMessage: null,
    onStatus: null, // (status, detail) => void
    onRemoteStream: null,
  };

  function api(payload) {
    try {
      return chrome.runtime.sendMessage({ channel: "otaku-sync-api", ...payload });
    } catch (_) {
      return Promise.resolve({ error: "extension-reloaded" });
    }
  }

  // ------------------------------------------------------------- config

  NET.loadConfig = async function () {
    const res = await api({ type: "config" });
    if (res && res.config) {
      NET.config = Object.assign({}, BUILTIN, res.config);
      NET.configSource = res.source || "remote";
    }
    return NET.config;
  };

  NET.support = () => NET.config.support_whatsapp || SUPPORT_WHATSAPP;

  NET.whatsappUrl = function (msg) {
    const num = NET.support().replace(/[^\d]/g, "");
    const text = encodeURIComponent(msg || "Hi, I need help with Otaku Sync.");
    return `https://wa.me/${num}?text=${text}`;
  };

  // ---------------------------------------------------------------- auth

  NET.getToken = async function () {
    try {
      const { token } = await chrome.storage.local.get("token");
      return token || null;
    } catch (_) {
      return null;
    }
  };

  NET.setToken = async function (token) {
    try {
      if (token) await chrome.storage.local.set({ token });
      else await chrome.storage.local.remove("token");
    } catch (_) {}
  };

  // A stable per-install id. NOT a hardware identifier — browsers can't read
  // MAC addresses — so it identifies this browser profile, and clearing
  // extension storage resets it.
  NET.deviceId = async function () {
    try {
      const { deviceId } = await chrome.storage.local.get("deviceId");
      if (deviceId) return deviceId;
      const fresh = crypto.randomUUID();
      await chrome.storage.local.set({ deviceId: fresh });
      return fresh;
    } catch (_) {
      return null;
    }
  };

  NET.deviceLabel = function () {
    const ua = navigator.userAgent;
    const os = /Windows/.test(ua) ? "Windows"
      : /Mac OS X|Macintosh/.test(ua) ? "Mac"
      : /Android/.test(ua) ? "Android"
      : /Linux/.test(ua) ? "Linux"
      : /iPhone|iPad/.test(ua) ? "iOS"
      : "Browser";
    const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : "Chrome";
    return `${browser} on ${os}`;
  };

  // Start watching with no sign-in at all: the trial is tied to this device.
  NET.startGuest = async function () {
    const device_id = await NET.deviceId();
    return api({
      type: "post",
      path: "/auth/guest",
      body: { device_id, label: NET.deviceLabel() },
    });
  };

  // Sign-in is a device-code flow: create a request, open the hosted page,
  // poll until the page reports success.
  NET.startSignIn = async function () {
    const device_id = await NET.deviceId();
    return api({ type: "post", path: "/auth/request", body: { device_id } });
  };

  NET.pollSignIn = async function (rid) {
    const device_id = await NET.deviceId();
    return api({
      type: "post",
      path: "/auth/poll",
      body: { rid, device_id, label: NET.deviceLabel() },
    });
  };

  NET.devices = () => api({ type: "get", path: "/devices", auth: true });

  NET.logout = async function () {
    // Tell the server first so the device slot is freed, then drop the token
    // locally regardless of whether that call succeeded.
    try {
      await api({ type: "post", path: "/auth/logout", auth: true });
    } catch (_) {}
    await NET.setToken(null);
  };

  NET.revokeDevice = (id, token) =>
    api({
      type: "post",
      path: "/devices/revoke",
      body: { id, label: NET.deviceLabel() },
      auth: true,
      token,
    });

  NET.me = () => api({ type: "get", path: "/me", auth: true });
  NET.subscribe = () => api({ type: "post", path: "/billing/subscribe", auth: true });
  NET.refreshBilling = () => api({ type: "post", path: "/billing/refresh", auth: true });

  // ---------------------------------------------------------------- room

  NET.connectRoom = async function (code) {
    NET.closeRoom();
    const token = await NET.getToken();
    if (!token) return { error: "no-token" };

    const targets = [NET.config, ...(NET.config.fallbacks || [])]
      .map((c) => c && c.ws)
      .filter(Boolean);

    for (const base of targets) {
      const url = `${base}?token=${encodeURIComponent(token)}&room=${encodeURIComponent(code)}`;
      const ok = await openSocket(url);
      if (ok === true) return { ok: true };
      if (ok === "denied") return { error: "denied", reason: NET.lastDenial };
    }
    return { error: "unreachable" };
  };

  function openSocket(url) {
    return new Promise((resolve) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (_) {
        return resolve(false);
      }

      const giveUp = setTimeout(() => {
        if (!settled) {
          settled = true;
          try {
            ws.close();
          } catch (_) {}
          resolve(false);
        }
      }, 8000);

      ws.addEventListener("open", () => {
        NET.ws = ws;
        startHeartbeat();
      });

      ws.addEventListener("message", (e) => {
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch (_) {
          return;
        }

        if (msg.t === "joined") {
          NET.role = msg.role;
          if (!settled) {
            settled = true;
            clearTimeout(giveUp);
            resolve(true);
          }
          NET.onStatus && NET.onStatus("joined", msg);
          return;
        }
        if (msg.t === "denied") {
          NET.lastDenial = msg.reason;
          if (!settled) {
            settled = true;
            clearTimeout(giveUp);
            resolve("denied");
          }
          NET.onStatus && NET.onStatus("denied", msg.reason);
          return;
        }
        if (msg.t === "peer-joined") return NET.onStatus && NET.onStatus("peer-joined");
        if (msg.t === "peer-left") {
          stopMedia();
          return NET.onStatus && NET.onStatus("peer-left");
        }
        if (msg.t === "pong") return;
        if (msg.t === "peer" && msg.payload) {
          const p = msg.payload;
          if (p.t === "rtc") return handleSignal(p);
          NET.onMessage && NET.onMessage(p);
        }
      });

      ws.addEventListener("close", () => {
        stopHeartbeat();
        if (NET.ws === ws) {
          NET.ws = null;
          NET.role = null;
          stopMedia();
          NET.onStatus && NET.onStatus("closed");
        }
        if (!settled) {
          settled = true;
          clearTimeout(giveUp);
          resolve(false);
        }
      });

      ws.addEventListener("error", () => {
        // "close" always follows; resolution happens there.
      });
    });
  }

  let hb = null;
  function startHeartbeat() {
    stopHeartbeat();
    hb = setInterval(() => NET.send({ t: "ping" }), 25000);
  }
  function stopHeartbeat() {
    clearInterval(hb);
    hb = null;
  }

  NET.send = function (msg) {
    if (NET.ws && NET.ws.readyState === WebSocket.OPEN) {
      NET.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  };

  NET.connected = () => !!(NET.ws && NET.ws.readyState === WebSocket.OPEN);

  NET.closeRoom = function () {
    stopMedia();
    stopHeartbeat();
    if (NET.ws) {
      try {
        NET.ws.close();
      } catch (_) {}
      NET.ws = null;
    }
    NET.role = null;
  };

  // -------------------------------------------------------------- webcam
  //
  // W3C "perfect negotiation": either side may (re)negotiate at any time;
  // glare is resolved by roles — the guest is the "polite" peer and rolls
  // back on collision, the host is "impolite" and ignores colliding offers.
  // Each side adds its OWN track when its cam turns on (which triggers
  // renegotiation automatically), so the order people press "Cam on" in can
  // never matter again.

  let pc = null;
  let camSender = null;
  let makingOffer = false;
  let ignoreOffer = false;

  const polite = () => NET.role !== "host";

  function ensurePc() {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: NET.config.ice || BUILTIN.ice });

    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) NET.send({ t: "rtc", kind: "ice", candidate: e.candidate });
    });

    pc.addEventListener("track", (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      NET.onRemoteStream && NET.onRemoteStream(stream);
      e.track.addEventListener("ended", () => {
        NET.onRemoteStream && NET.onRemoteStream(null);
      });
    });

    pc.addEventListener("negotiationneeded", async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        NET.send({ t: "rtc", kind: "desc", sdp: pc.localDescription });
      } catch (e) {
        console.debug("[otaku-sync] negotiation failed", e);
      } finally {
        makingOffer = false;
      }
    });

    pc.addEventListener("connectionstatechange", () => {
      if (pc && ["failed", "closed"].includes(pc.connectionState)) {
        NET.onRemoteStream && NET.onRemoteStream(null);
      }
    });

    return pc;
  }

  async function handleSignal(msg) {
    const p = ensurePc();
    try {
      if (msg.kind === "desc" && msg.sdp) {
        const desc = msg.sdp;
        const collision = desc.type === "offer" && (makingOffer || p.signalingState !== "stable");
        ignoreOffer = !polite() && collision;
        if (ignoreOffer) return;
        await p.setRemoteDescription(desc); // polite side rolls back implicitly
        if (desc.type === "offer") {
          await p.setLocalDescription();
          NET.send({ t: "rtc", kind: "desc", sdp: p.localDescription });
        }
      } else if (msg.kind === "ice" && msg.candidate) {
        try {
          await p.addIceCandidate(msg.candidate);
        } catch (e) {
          if (!ignoreOffer) console.debug("[otaku-sync] ice failed", e);
        }
      }
    } catch (e) {
      console.debug("[otaku-sync] signal failed", e);
    }
  }

  // Our cam turned on (stream) or off (null). addTrack/removeTrack fire
  // negotiationneeded, and perfect negotiation does the rest.
  NET.setLocalCam = async function (stream) {
    const p = ensurePc();
    if (camSender) {
      try {
        p.removeTrack(camSender);
      } catch (_) {}
      camSender = null;
    }
    if (stream) {
      const track = stream.getVideoTracks()[0];
      if (track) camSender = p.addTrack(track, stream);
    }
  };

  // Create the connection early so incoming tracks are never missed.
  NET.primeMedia = async function () {
    ensurePc();
  };

  function stopMedia() {
    try {
      pc && pc.close();
    } catch (_) {}
    pc = null;
    camSender = null;
    makingOffer = false;
    ignoreOffer = false;
    NET.onRemoteStream && NET.onRemoteStream(null);
  }
  NET.stopMedia = stopMedia;

  window.CT_NET = NET;
})();
