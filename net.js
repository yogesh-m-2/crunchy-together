// Crunchy Party — networking.
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
      return chrome.runtime.sendMessage({ channel: "crunchy-party-api", ...payload });
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
    const text = encodeURIComponent(msg || "Hi, I need help with Crunchy Party.");
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

  NET.startOtp = (phone) => api({ type: "post", path: "/auth/otp/start", body: { phone } });
  NET.verifyOtp = (phone, code) =>
    api({ type: "post", path: "/auth/otp/verify", body: { phone, code } });
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
  // One RTCPeerConnection with a single video sender in each direction. The
  // sender always carries a track — a blank canvas track when the cam is off —
  // so toggling a cam is just replaceTrack() with no renegotiation. That is
  // what makes both cams show reliably regardless of who enables first.

  let pc = null;
  let localSender = null;
  let blankTrack = null;
  let blankCanvas = null;
  let makingOffer = false;

  function blank() {
    if (blankTrack && blankTrack.readyState === "live") return blankTrack;
    blankCanvas = document.createElement("canvas");
    blankCanvas.width = 2;
    blankCanvas.height = 2;
    const ctx = blankCanvas.getContext("2d");
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 2, 2);
    blankTrack = blankCanvas.captureStream(1).getVideoTracks()[0];
    return blankTrack;
  }

  function ensurePc() {
    if (pc) return pc;
    pc = new RTCPeerConnection({ iceServers: NET.config.ice || BUILTIN.ice });

    pc.addEventListener("icecandidate", (e) => {
      if (e.candidate) NET.send({ t: "rtc", kind: "ice", candidate: e.candidate });
    });

    pc.addEventListener("track", (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      NET.onRemoteStream && NET.onRemoteStream(stream);
    });

    pc.addEventListener("connectionstatechange", () => {
      if (["failed", "closed"].includes(pc.connectionState)) {
        NET.onRemoteStream && NET.onRemoteStream(null);
      }
    });

    localSender = pc.addTrack(blank());
    return pc;
  }

  async function negotiate() {
    // Only the host offers, so the two sides can't collide.
    if (NET.role !== "host" || !pc || makingOffer) return;
    try {
      makingOffer = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      NET.send({ t: "rtc", kind: "offer", sdp: pc.localDescription });
    } catch (e) {
      console.debug("[crunchy-party] offer failed", e);
    } finally {
      makingOffer = false;
    }
  }

  async function handleSignal(msg) {
    try {
      if (msg.kind === "offer") {
        ensurePc();
        await pc.setRemoteDescription(msg.sdp);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        NET.send({ t: "rtc", kind: "answer", sdp: pc.localDescription });
      } else if (msg.kind === "answer") {
        if (pc && pc.signalingState !== "stable") await pc.setRemoteDescription(msg.sdp);
      } else if (msg.kind === "ice") {
        if (pc && msg.candidate) await pc.addIceCandidate(msg.candidate).catch(() => {});
      }
    } catch (e) {
      console.debug("[crunchy-party] signal failed", e);
    }
  }

  // Called when our cam turns on/off. Starts media if needed, then swaps the
  // outgoing track in place.
  NET.setLocalCam = async function (stream) {
    ensurePc();
    const track = stream ? stream.getVideoTracks()[0] : blank();
    if (localSender) {
      try {
        await localSender.replaceTrack(track);
      } catch (_) {}
    }
    // First time through (or after a reconnect) the host must offer.
    if (!pc.currentRemoteDescription) await negotiate();
  };

  // Kick media off once both sides are present, so cams can appear instantly
  // when either person enables one later.
  NET.primeMedia = async function () {
    ensurePc();
    await negotiate();
  };

  function stopMedia() {
    try {
      pc && pc.close();
    } catch (_) {}
    pc = null;
    localSender = null;
    makingOffer = false;
    NET.onRemoteStream && NET.onRemoteStream(null);
  }
  NET.stopMedia = stopMedia;

  window.CT_NET = NET;
})();
