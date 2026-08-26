// Crunchy Party — panel, auth gate and playback sync.
// Transport is CT_NET (WebSocket to your server; WebRTC only for cam video).

(() => {
  if (window.__crunchyPartyLoaded) return;
  window.__crunchyPartyLoaded = true;

  const CHANNEL = "crunchy-party";
  const frameKey = "room";
  const PARAM = "crunchy_party";
  const NET = window.CT_NET;
  const REACTS = ["❤️", "🔥", "😂", "😢"];

  const state = {
    me: null, // { phone, status, active, until }
    code: null,
    linked: false, // both peers in the room
    leaving: false,
    name: "You",
    partner: "Friend",
    local: { paused: true, time: 0 },
    lastApplied: null,
    lastActAt: 0,
    lastTickAt: 0,
    lastSyncSent: 0,
    holdSendUntil: 0,
    episode: episodeId(),
    camStream: null,
    remoteCam: null,
    partnerCamOn: false,
  };

  function episodeId() {
    const m = location.pathname.match(/\/watch\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }
  const makeCode = () => String(Math.floor(100000 + Math.random() * 900000));

  function shareUrl(code) {
    const u = new URL(location.href);
    u.searchParams.set(PARAM, code);
    return u.toString();
  }
  function rememberUrl(code) {
    try {
      history.replaceState(null, "", shareUrl(code));
    } catch (_) {}
  }
  function forgetUrl() {
    try {
      const u = new URL(location.href);
      u.searchParams.delete(PARAM);
      history.replaceState(null, "", u.toString());
    } catch (_) {}
  }

  // ---------------------------------------------------------------- helpers

  function el(tag, props = {}, kids = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const kid of [].concat(kids)) {
      node.appendChild(typeof kid === "string" ? document.createTextNode(kid) : kid);
    }
    // Crunchyroll has page-level hotkeys (F, M, space…). Keys typed here must
    // not escape the panel.
    if (tag === "input" || tag === "textarea") {
      for (const ev of ["keydown", "keyup", "keypress"]) {
        node.addEventListener(ev, (e) => e.stopPropagation());
      }
    }
    return node;
  }

  function clock(sec) {
    if (!isFinite(sec)) return "--:--";
    const s = Math.max(0, Math.floor(sec));
    return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }

  function days(until) {
    const d = Math.ceil((until - Date.now()) / 86400000);
    return d <= 0 ? "today" : d === 1 ? "1 day" : `${d} days`;
  }

  function extAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  let deadShown = false;
  function goDead() {
    if (deadShown) return;
    deadShown = true;
    NET.closeRoom();
    dot.classList.remove("on");
    title.textContent = "Needs refresh";
    render(
      el("p", {
        class: "note",
        text: "The extension was updated while this page was open. Refresh the page (Ctrl+R / Cmd+R) to reconnect.",
      })
    );
  }

  function toPlayer(payload) {
    if (deadShown) return;
    if (!extAlive()) return goDead();
    try {
      chrome.runtime.sendMessage({ channel: CHANNEL, frameKey, ...payload });
    } catch (_) {
      goDead();
    }
  }

  function wire(msg) {
    if (NET.send(msg)) pulse();
  }

  function api(payload) {
    try {
      return chrome.runtime.sendMessage({ channel: "crunchy-party-api", ...payload });
    } catch (_) {
      goDead();
      return Promise.resolve({ error: "dead" });
    }
  }

  // ------------------------------------------------------------------- UI

  const host = el("div", { id: "crunchy-party-host" });
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:0;bottom:0;";
  const shadow = host.attachShadow({ mode: "open" });

  shadow.appendChild(
    el("style", {
      text: `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
.panel {
  position: fixed; right: 18px; bottom: 18px; width: 306px;
  background: #171b24; color: #e6e9f2;
  border: 1px solid #262c3a; border-radius: 10px;
  box-shadow: 0 18px 44px rgba(0,0,0,.55);
  overflow: hidden; font-size: 13px; line-height: 1.45;
}
.panel[hidden] { display: none; }
.panel.fsmode { opacity: .45; transition: opacity .15s; }
.panel.fsmode:hover, .panel.fsmode:focus-within { opacity: 1; }
.wire { height: 2px; background: #262c3a; position: relative; overflow: hidden; }
.wire span { position: absolute; inset: 0; transform: translateX(-100%);
  background: linear-gradient(90deg, transparent, #ffb03b, transparent); }
.wire.live span { animation: run .5s ease-out; }
@keyframes run { to { transform: translateX(100%); } }

header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #8b93a7; flex: none; }
.dot.on { background: #5fd1a0; }
h1 { font-size: 12px; font-weight: 600; flex: 1; }
.icon { background: none; border: 0; color: #8b93a7; cursor: pointer;
  font: 600 15px/1 ui-monospace, monospace; padding: 4px 6px; border-radius: 5px; }
.icon:hover { color: #e6e9f2; background: #212736; }

.body { padding: 0 12px 12px; display: grid; gap: 10px; }
.body[hidden] { display: none; }
p.note { color: #8b93a7; font-size: 12px; }
p.warn { color: #ffb03b; font-size: 12px; }
.step { font: 600 10px/1 ui-monospace, monospace; letter-spacing: .12em; color: #ffb03b; text-transform: uppercase; }
.bigcode { font: 700 26px/1 ui-monospace, monospace; letter-spacing: .18em; text-align: center;
  color: #ffb03b; background: #10131a; border: 1px solid #262c3a; border-radius: 6px;
  padding: 12px 0; user-select: all; }

button.act { width: 100%; padding: 9px 12px; border-radius: 7px; cursor: pointer;
  border: 1px solid #333b4d; background: #212736; color: #e6e9f2;
  font-size: 13px; font-weight: 500; text-align: center; }
button.act:hover { border-color: #4a5468; }
button.act.primary { background: #ffb03b; border-color: #ffb03b; color: #191400; font-weight: 600; }
button.act.primary:hover { background: #ffbf5e; }
button.act.wa { background: #1f7a4d; border-color: #1f7a4d; color: #fff; }
button.act.wa:hover { background: #26935c; }
button.act:disabled { opacity: .5; cursor: default; }
button.act:focus-visible { outline: 2px solid #ffb03b; outline-offset: 2px; }
.row { display: flex; gap: 8px; }
.row > * { flex: 1; }

input { width: 100%; background: #10131a; color: #e6e9f2; border: 1px solid #262c3a;
  border-radius: 6px; padding: 8px; font-size: 13px; }
input:focus { outline: none; border-color: #ffb03b; }
input.code { font: 600 15px/1.4 ui-monospace, monospace; letter-spacing: .15em; text-align: center; }

.log { height: 148px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px;
  padding: 8px; background: #10131a; border: 1px solid #262c3a; border-radius: 6px; }
.log::-webkit-scrollbar, .egrid::-webkit-scrollbar, .ggrid::-webkit-scrollbar { width: 6px; }
.log::-webkit-scrollbar-thumb, .egrid::-webkit-scrollbar-thumb, .ggrid::-webkit-scrollbar-thumb {
  background: #2f3646; border-radius: 3px; }
.msg { font-size: 12px; word-wrap: break-word; }
.msg .who { color: #ffb03b; font-weight: 600; }
.msg.them .who { color: #7fb7ff; }
.msg.sys { color: #8b93a7; font: 11px ui-monospace, monospace; }
.msg img.gif { max-width: 100%; max-height: 150px; border-radius: 6px; display: block; margin-top: 3px; }
.status { display: flex; justify-content: space-between; font: 11px ui-monospace, monospace; color: #8b93a7; }

.cams { display: flex; gap: 8px; }
.cams:not(:has(.cam.on)) { display: none; }
.cam { flex: 1; min-width: 0; aspect-ratio: 4 / 3; display: none; background: #10131a;
  border: 1px solid #262c3a; border-radius: 6px; object-fit: cover; }
.cam.on { display: block; }
.cam.mirror { transform: scaleX(-1); }

.reacts { display: flex; gap: 8px; }
.reacts button { flex: 1; padding: 6px 0; font-size: 16px; line-height: 1; cursor: pointer;
  background: #212736; border: 1px solid #333b4d; border-radius: 7px; }
.reacts button:hover { border-color: #4a5468; }
.reacts button:active { transform: scale(1.15); }

.pickrow { display: flex; gap: 8px; }
.pickrow button.act { padding: 6px 0; font-size: 12px; }
.pickrow button.act.open { border-color: #ffb03b; color: #ffb03b; }
.drawer { display: grid; gap: 8px; }
.egrid { height: 132px; overflow-y: auto; display: grid; grid-template-columns: repeat(8, 1fr);
  gap: 2px; align-content: start; background: #10131a; border: 1px solid #262c3a;
  border-radius: 6px; padding: 5px; }
.egrid button { font-size: 17px; line-height: 1; background: none; border: 0; cursor: pointer;
  padding: 4px 0; border-radius: 5px; }
.egrid button:hover { background: #212736; }
.ggrid { height: 168px; overflow-y: auto; display: grid; grid-template-columns: repeat(2, 1fr);
  gap: 6px; align-content: start; background: #10131a; border: 1px solid #262c3a;
  border-radius: 6px; padding: 6px; }
.ggrid img { width: 100%; height: 78px; object-fit: cover; border-radius: 5px; cursor: pointer; background: #171b24; }
.ggrid img:hover { outline: 2px solid #ffb03b; }
.gnote { font: 10px ui-monospace, monospace; color: #59627a; text-align: right; }
.empty { color: #8b93a7; font-size: 12px; padding: 8px; text-align: center; grid-column: 1 / -1; }

.fx-layer { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: 2147483647; }
.fx { position: absolute; bottom: -70px; animation-name: floatUp;
  animation-timing-function: ease-out; animation-fill-mode: forwards; will-change: transform, opacity; }
@keyframes floatUp {
  0% { transform: translateY(0) rotate(0deg); opacity: 1; }
  75% { opacity: 1; }
  100% { transform: translateY(-115vh) rotate(var(--rot, 0deg)); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .wire.live span { animation: none; opacity: .5; transform: none; }
  .fx { animation-name: fadeOnly; animation-duration: 1.4s !important; bottom: 20vh; }
  @keyframes fadeOnly { 0% { opacity: 1; } 100% { opacity: 0; } }
}`,
    })
  );

  const dot = el("div", { class: "dot" });
  const title = el("h1", { text: "Crunchy Party" });
  const wireBar = el("div", { class: "wire" }, [el("span")]);
  const body = el("div", { class: "body" });

  const collapseBtn = el("button", {
    class: "icon",
    title: "Collapse",
    "aria-label": "Collapse panel",
    text: "–",
    onclick: () => {
      body.hidden = !body.hidden;
      collapseBtn.textContent = body.hidden ? "+" : "–";
    },
  });
  const closeBtn = el("button", {
    class: "icon",
    title: "Hide",
    "aria-label": "Hide panel",
    text: "×",
    onclick: () => (panel.hidden = true),
  });

  const panel = el("div", { class: "panel" }, [
    wireBar,
    el("header", {}, [dot, title, collapseBtn, closeBtn]),
    body,
  ]);
  shadow.appendChild(panel);

  const fxLayer = el("div", { class: "fx-layer" });
  shadow.appendChild(fxLayer);

  let pulseTimer = null;
  function pulse() {
    wireBar.classList.remove("live");
    void wireBar.offsetWidth;
    wireBar.classList.add("live");
    clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => wireBar.classList.remove("live"), 600);
  }

  const render = (...nodes) => body.replaceChildren(...nodes);

  function showPanel() {
    panel.hidden = false;
    body.hidden = false;
    collapseBtn.textContent = "–";
    mount();
  }

  function supportButton(context) {
    return el("button", {
      class: "act wa",
      text: "Message support on WhatsApp",
      onclick: () => api({ type: "open-tab", url: NET.whatsappUrl(context) }),
    });
  }

  // -------------------------------------------------------- auth screens

  function screenPhone(prefill) {
    dot.classList.remove("on");
    title.textContent = "Crunchy Party";
    const phone = el("input", { placeholder: "+91 98765 43210", maxlength: "20", inputmode: "tel" });
    if (prefill) phone.value = prefill;
    const msg = el("p", { class: "note", text: `Sign in with your phone number. First ${NET.config.trial_days || 7} days are free.` });
    const btn = el("button", { class: "act primary", text: "Send code" });

    async function go() {
      const val = phone.value.replace(/[^\d+]/g, "");
      if (!/^\+[1-9]\d{7,14}$/.test(val)) {
        msg.className = "warn";
        msg.textContent = "Use the international format, including the country code (+91…).";
        return;
      }
      btn.disabled = true;
      btn.textContent = "Sending…";
      const res = await NET.startOtp(val);
      btn.disabled = false;
      btn.textContent = "Send code";
      if (res && res.ok) return screenOtp(val, res.dev);
      if (res && res.error === "rate") {
        msg.className = "warn";
        msg.textContent = "Too many codes requested. Wait a while and try again.";
        return;
      }
      screenUnreachable(`Couldn't send a code to ${val}.`);
    }

    btn.addEventListener("click", go);
    phone.addEventListener("keydown", (e) => e.key === "Enter" && go());
    render(msg, phone, btn, el("p", { class: "note", text: "Standard SMS rates may apply." }));
  }

  function screenOtp(phone, dev) {
    const code = el("input", { class: "code", placeholder: "6-digit code", maxlength: "6", inputmode: "numeric" });
    const msg = el("p", { class: "note", text: dev ? "Dev mode: check the server log for the code." : `Code sent to ${phone}.` });
    const btn = el("button", { class: "act primary", text: "Verify" });

    async function go() {
      const val = code.value.trim();
      if (!/^\d{6}$/.test(val)) return code.focus();
      btn.disabled = true;
      btn.textContent = "Checking…";
      const res = await NET.verifyOtp(phone, val);
      btn.disabled = false;
      btn.textContent = "Verify";
      if (res && res.token) {
        await NET.setToken(res.token);
        state.me = res.me;
        return afterAuth();
      }
      msg.className = "warn";
      msg.textContent =
        res && res.error === "wrong-code" ? "That code didn't match. Try again."
        : res && res.error === "expired" ? "That code expired. Request a new one."
        : res && res.error === "too-many" ? "Too many wrong attempts. Request a new code."
        : "Couldn't verify right now.";
    }

    btn.addEventListener("click", go);
    code.addEventListener("keydown", (e) => e.key === "Enter" && go());
    render(msg, code, btn, el("button", { class: "act", text: "Use a different number", onclick: () => screenPhone(phone) }));
    code.focus();
  }

  function screenExpired() {
    dot.classList.remove("on");
    title.textContent = "Trial ended";
    const btn = el("button", { class: "act primary", text: `Subscribe — ${NET.config.price_label || "₹5 / month"}` });

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Opening payment…";
      const res = await NET.subscribe();
      btn.disabled = false;
      btn.textContent = `Subscribe — ${NET.config.price_label || "₹5 / month"}`;
      if (res && res.url) {
        api({ type: "open-tab", url: res.url });
        screenAwaitingPayment();
      } else {
        render(
          el("p", { class: "warn", text: "Couldn't start the payment right now." }),
          supportButton("Hi, I couldn't start the Crunchy Party payment."),
          el("button", { class: "act", text: "Back", onclick: screenExpired })
        );
      }
    });

    render(
      el("p", { class: "note", text: "Your free trial is over. Subscribe to keep watching together." }),
      btn,
      el("p", { class: "note", text: "Cancel any time. Payments handled by Razorpay." }),
      supportButton("Hi, I need help with my Crunchy Party subscription.")
    );
  }

  function screenAwaitingPayment() {
    title.textContent = "Waiting for payment";
    const btn = el("button", { class: "act primary", text: "I've paid — check now" });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Checking…";
      const res = await NET.refreshBilling();
      btn.disabled = false;
      btn.textContent = "I've paid — check now";
      if (res && res.me) {
        state.me = res.me;
        if (res.me.active) return afterAuth();
      }
      render(
        el("p", { class: "warn", text: "Payment hasn't landed yet. It can take a minute — check again shortly." }),
        btn,
        supportButton("Hi, I paid for Crunchy Party but it still shows as unpaid."),
        el("button", { class: "act", text: "Back", onclick: screenExpired })
      );
    });
    render(
      el("p", { class: "note", text: "Finish the payment in the tab that just opened, then come back here." }),
      btn,
      supportButton("Hi, I need help paying for Crunchy Party.")
    );
  }

  function screenUnreachable(detail) {
    dot.classList.remove("on");
    title.textContent = "Can't reach the server";
    render(
      el("p", { class: "note", text: detail || "The service isn't reachable from here right now." }),
      el("button", {
        class: "act primary",
        text: "Try again",
        onclick: async () => {
          render(el("p", { class: "note", text: "Retrying…" }));
          await api({ type: "config", force: true });
          await NET.loadConfig();
          boot();
        },
      }),
      supportButton("Hi, Crunchy Party can't reach the server."),
      el("p", { class: "note", text: `Support: ${NET.support()} (WhatsApp only)` })
    );
  }

  function screenMaintenance() {
    dot.classList.remove("on");
    title.textContent = "Back shortly";
    render(
      el("p", { class: "note", text: NET.config.notice || "Crunchy Party is down for maintenance. Please try again later." }),
      supportButton("Hi, is Crunchy Party still down?")
    );
  }

  // -------------------------------------------------------- room screens

  function screenStart() {
    dot.classList.remove("on");
    const ent = state.me || {};
    title.textContent = "Crunchy Party";

    const nameField = el("input", { placeholder: "Your name", maxlength: "24" });
    nameField.value = state.name === "You" ? "" : state.name;
    nameField.addEventListener("input", () => {
      state.name = nameField.value.trim() || "You";
      try {
        chrome.storage.local.set({ name: state.name });
      } catch (_) {
        goDead();
      }
    });

    const codeField = el("input", { class: "code", placeholder: "6-digit code", maxlength: "6", inputmode: "numeric" });
    const joinBtn = el("button", {
      class: "act",
      text: "Join",
      onclick: () => {
        const c = codeField.value.trim();
        if (/^\d{6}$/.test(c)) joinRoom(c);
        else codeField.focus();
      },
    });
    codeField.addEventListener("keydown", (e) => e.key === "Enter" && joinBtn.click());

    const nodes = [
      el("p", { class: "note", text: "Start a party on an episode page and send the link — it connects automatically." }),
      nameField,
      el("button", { class: "act primary", text: "Start a party", onclick: () => startRoom() }),
      el("p", { class: "note", text: "Or join with a code:" }),
      el("div", { class: "row" }, [codeField, joinBtn]),
    ];
    if (ent.status === "trial" && ent.until) {
      nodes.push(el("p", { class: "note", text: `Free trial — ${days(ent.until)} left.` }));
    } else if (ent.status === "subscribed" && ent.until) {
      nodes.push(el("p", { class: "note", text: `Subscribed — renews in ${days(ent.until)}.` }));
    }
    if (NET.config.notice) nodes.push(el("p", { class: "warn", text: NET.config.notice }));
    render(...nodes);
  }

  function screenWaiting(text) {
    render(el("p", { class: "note", text }), el("button", { class: "act", text: "Cancel", onclick: leaveRoom }));
  }

  function copyLinkButton(code) {
    const b = el("button", { class: "act primary", text: "Copy invite link" });
    b.addEventListener("click", () => {
      navigator.clipboard.writeText(shareUrl(code)).then(
        () => {
          b.textContent = "Copied";
          setTimeout(() => (b.textContent = "Copy invite link"), 1400);
        },
        () => {
          b.textContent = "Couldn't copy — use the address bar URL";
          setTimeout(() => (b.textContent = "Copy invite link"), 3000);
        }
      );
    });
    return b;
  }

  function screenHostWaiting(code) {
    title.textContent = "Party open";
    render(
      el("div", { class: "step", text: "Party code" }),
      el("div", { class: "bigcode", text: code }),
      copyLinkButton(code),
      el("p", { class: "note", text: "Send the link. Your friend joins automatically when they open it." }),
      el("button", { class: "act", text: "Close party", onclick: leaveRoom })
    );
  }

  function screenRoom() {
    dot.classList.add("on");
    title.textContent = "Linked";

    const cams = el("div", { class: "cams" });
    const localV = el("video", { class: "cam mirror", autoplay: "", playsinline: "" });
    localV.muted = true;
    const remoteV = el("video", { class: "cam", autoplay: "", playsinline: "" });
    cams.append(localV, remoteV);
    screenRoom.localV = localV;
    screenRoom.remoteV = remoteV;
    refreshCams();

    const log = el("div", { class: "log" });
    const input = el("input", { placeholder: "Say something…", maxlength: "300" });
    const time = el("div", { text: "00:00" });
    const who = el("div", { text: `${state.partner} · ${state.code || ""}` });

    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !input.value.trim()) return;
      const text = input.value.trim();
      input.value = "";
      wire({ t: "msg", text });
      addLine(state.name, text, "me");
    });

    const reacts = el(
      "div",
      { class: "reacts" },
      REACTS.map((emoji) =>
        el("button", {
          type: "button",
          "aria-label": `React ${emoji}`,
          text: emoji,
          onclick: () => {
            wire({ t: "react", e: emoji });
            reactAll(emoji);
          },
        })
      )
    );

    const camBtn = el("button", { class: "act", text: state.camStream ? "Cam off" : "Cam on" });
    camBtn.addEventListener("click", () => toggleCam(camBtn));

    const drawer = el("div", { class: "drawer" });
    const emojiBtn = el("button", { class: "act", text: "😊 Emoji" });
    const gifBtn = el("button", { class: "act", text: "GIF" });
    let openDrawer = null;
    function setDrawer(kind) {
      openDrawer = openDrawer === kind ? null : kind;
      emojiBtn.classList.toggle("open", openDrawer === "emoji");
      gifBtn.classList.toggle("open", openDrawer === "gif");
      drawer.replaceChildren();
      if (openDrawer === "emoji") buildEmojiDrawer(drawer, input);
      if (openDrawer === "gif") buildGifDrawer(drawer);
    }
    emojiBtn.addEventListener("click", () => setDrawer("emoji"));
    gifBtn.addEventListener("click", () => setDrawer("gif"));

    render(
      el("div", { class: "status" }, [who, time]),
      cams,
      log,
      reacts,
      el("div", { class: "pickrow" }, [emojiBtn, gifBtn]),
      drawer,
      input,
      el("div", { class: "row" }, [camBtn, el("button", { class: "act", text: "Leave", onclick: leaveRoom })])
    );

    screenRoom.log = log;
    screenRoom.time = time;
    if (screenRoom.history) {
      for (const line of screenRoom.history) log.appendChild(line.cloneNode(true));
      log.scrollTop = log.scrollHeight;
    }
  }

  function addLine(name, text, kind) {
    const node =
      kind === "sys"
        ? el("div", { class: "msg sys", text })
        : el("div", { class: `msg ${kind}` }, [el("span", { class: "who", text: name + ": " }), text]);
    screenRoom.history = (screenRoom.history || []).concat(node);
    if (screenRoom.history.length > 200) screenRoom.history.shift();
    if (screenRoom.log) {
      screenRoom.log.appendChild(node.cloneNode(true));
      screenRoom.log.scrollTop = screenRoom.log.scrollHeight;
    }
    toPlayer({ type: "fs-line", name, text, kind });
  }

  function spawnReact(emoji) {
    const span = el("span", { class: "fx", text: emoji });
    span.style.left = 5 + Math.random() * 85 + "vw";
    span.style.fontSize = 38 + Math.random() * 20 + "px";
    span.style.setProperty("--rot", (Math.random() * 44 - 22).toFixed(0) + "deg");
    span.style.animationDuration = (2.4 + Math.random() * 1.2).toFixed(2) + "s";
    fxLayer.appendChild(span);
    setTimeout(() => span.remove(), 4200);
  }
  function reactAll(emoji) {
    spawnReact(emoji);
    toPlayer({ type: "fs-react", e: emoji });
  }

  // ------------------------------------------------- emoji & gif pickers

  const EMOJI_DATA = (typeof CT_EMOJIS !== "undefined" ? CT_EMOJIS : []).map((s) => {
    const i = s.indexOf("|");
    return { e: s.slice(0, i), k: s.slice(i + 1) };
  });

  function buildEmojiDrawer(drawer, chatInput) {
    const search = el("input", { placeholder: "Search emojis…", maxlength: "40" });
    const grid = el("div", { class: "egrid" });
    function fill(q) {
      const query = q.trim().toLowerCase();
      const hits = (query ? EMOJI_DATA.filter((x) => x.k.includes(query)) : EMOJI_DATA).slice(0, 120);
      grid.replaceChildren(
        ...(hits.length
          ? hits.map((x) =>
              el("button", {
                type: "button",
                text: x.e,
                "aria-label": x.k.split(" ")[0],
                onclick: () => {
                  chatInput.value = (chatInput.value + x.e).slice(0, 300);
                  chatInput.focus();
                },
              })
            )
          : [el("div", { class: "empty", text: "No emoji matches that." })])
      );
    }
    search.addEventListener("input", () => fill(search.value));
    drawer.append(search, grid);
    fill("");
    search.focus();
  }

  function buildGifDrawer(drawer) {
    const search = el("input", { placeholder: "Search GIFs…", maxlength: "60" });
    const grid = el("div", { class: "ggrid" });
    let seq = 0;
    let debounce = null;

    async function run(q) {
      const my = ++seq;
      grid.replaceChildren(el("div", { class: "empty", text: "Loading…" }));
      const res = await api({ type: "gif-search", q });
      if (my !== seq) return;
      if (!res || res.error || !res.gifs) {
        grid.replaceChildren(el("div", { class: "empty", text: "GIF search failed. Try again in a moment." }));
        return;
      }
      if (!res.gifs.length) {
        grid.replaceChildren(el("div", { class: "empty", text: "No GIFs for that. Try another word." }));
        return;
      }
      grid.replaceChildren(
        ...res.gifs.map((g) => {
          const img = el("img", { alt: "GIF", loading: "lazy" });
          loadImg(img, g.preview);
          img.addEventListener("click", () => {
            if (!state.linked) return;
            wire({ t: "gif", url: g.full });
            addGifLine(state.name, g.full, "me");
          });
          return img;
        })
      );
    }

    search.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => run(search.value), 450);
    });
    search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        clearTimeout(debounce);
        run(search.value);
      }
    });
    drawer.append(search, grid, el("div", { class: "gnote", text: "Powered by GIPHY" }));
    run("");
    search.focus();
  }

  function safeGifUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === "https:" && /(^|\.)giphy\.com$/.test(u.hostname) ? u.toString() : null;
    } catch (_) {
      return null;
    }
  }

  function loadImg(img, url) {
    const safe = safeGifUrl(url);
    if (!safe) return img.remove();
    let triedB64 = false;
    img.addEventListener("error", async () => {
      if (triedB64) return img.replaceWith(el("span", { class: "msg sys", text: "[GIF failed to load]" }));
      triedB64 = true;
      const res = await api({ type: "img-b64", url: safe });
      if (res && res.dataUrl) img.src = res.dataUrl;
      else img.replaceWith(el("span", { class: "msg sys", text: "[GIF failed to load]" }));
    });
    img.src = safe;
  }

  function addGifLine(name, url, kind) {
    const safe = safeGifUrl(url);
    if (!safe) return;
    const img = el("img", { class: "gif", alt: "GIF" });
    loadImg(img, safe);
    const node = el("div", { class: `msg ${kind}` }, [el("span", { class: "who", text: name + ": " }), img]);
    screenRoom.history = (screenRoom.history || []).concat(node);
    if (screenRoom.history.length > 200) screenRoom.history.shift();
    if (screenRoom.log) {
      screenRoom.log.appendChild(node);
      screenRoom.log.scrollTop = screenRoom.log.scrollHeight;
    }
    toPlayer({ type: "fs-line", name, kind, gif: safe });
  }

  // -------------------------------------------------------------- webcam

  function refreshCams() {
    const lv = screenRoom.localV;
    const rv = screenRoom.remoteV;
    if (!lv || !rv) return;
    if (state.camStream) {
      if (lv.srcObject !== state.camStream) lv.srcObject = state.camStream;
      lv.classList.add("on");
    } else {
      lv.srcObject = null;
      lv.classList.remove("on");
    }
    if (state.remoteCam && state.partnerCamOn) {
      if (rv.srcObject !== state.remoteCam) rv.srcObject = state.remoteCam;
      rv.classList.add("on");
    } else {
      rv.srcObject = null;
      rv.classList.remove("on");
    }
  }

  async function toggleCam(btn) {
    if (state.camStream) {
      try {
        state.camStream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      state.camStream = null;
      if (btn) btn.textContent = "Cam on";
      refreshCams();
      wire({ t: "cam", on: false });
      await NET.setLocalCam(null);
      return;
    }
    try {
      state.camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: "user" },
        audio: false,
      });
    } catch (_) {
      addLine("", "Camera blocked. Allow camera access for crunchyroll.com in the address bar.", "sys");
      return;
    }
    if (btn) btn.textContent = "Cam off";
    refreshCams();
    wire({ t: "cam", on: true });
    await NET.setLocalCam(state.camStream);
  }

  NET.onRemoteStream = (stream) => {
    state.remoteCam = stream;
    refreshCams();
  };

  // ------------------------------------------------- acknowledged actions

  let actSeq = 0;
  let latestRemoteSeq = 0;
  const pendingActs = new Map();
  const seqOf = (id) => parseInt(String(id || "").split("-").pop(), 10) || 0;

  function sendAct(action, paused, time) {
    for (const [oldId, entry] of pendingActs) {
      clearTimeout(entry.timer);
      pendingActs.delete(oldId);
    }
    const id = `a-${++actSeq}`;
    state.lastActAt = Date.now();
    const msg = { t: "act", id, action, paused, time, ep: state.episode };
    wire(msg);
    const entry = { msg, tries: 0, timer: setTimeout(() => retryAct(id), 1600) };
    pendingActs.set(id, entry);
  }

  function retryAct(id) {
    const entry = pendingActs.get(id);
    if (!entry) return;
    if (!NET.connected()) return pendingActs.delete(id);
    if (entry.tries >= 2) {
      pendingActs.delete(id);
      const what = entry.msg.action === "seeked" ? "seek" : entry.msg.paused ? "pause" : "play";
      addLine("", `Your ${what} wasn't confirmed on their side — try it once more.`, "sys");
      return;
    }
    entry.tries++;
    wire(entry.msg);
    entry.timer = setTimeout(() => retryAct(id), 1600);
  }

  function settleAct(id) {
    const entry = pendingActs.get(id);
    if (!entry) return null;
    clearTimeout(entry.timer);
    pendingActs.delete(id);
    return entry;
  }

  function applyRemote(msg, tolerance) {
    state.holdSendUntil = Date.now() + 1200;
    state.lastApplied = { paused: msg.paused, time: msg.time, at: Date.now() };
    toPlayer({ type: "apply", paused: msg.paused, time: msg.time, tolerance });
  }

  function verifyAct(msg, attempt) {
    if (!NET.connected()) return;
    if (seqOf(msg.id) < latestRemoteSeq) return wire({ t: "ack", id: msg.id });
    const fresh = Date.now() - state.lastTickAt < 2500;
    const timeOk =
      typeof msg.time !== "number" || Math.abs(state.local.time - msg.time) < (msg.paused ? 3 : 8);
    if (fresh && state.local.paused === msg.paused && timeOk) return wire({ t: "ack", id: msg.id });
    if (attempt < 1) {
      applyRemote(msg, 0.4);
      setTimeout(() => verifyAct(msg, attempt + 1), 1000);
      return;
    }
    wire({ t: "fail", id: msg.id, reason: msg.paused === false ? "play-blocked" : "no-player" });
  }

  function onWire(msg) {
    pulse();
    if (msg.t === "hello") {
      state.partner = msg.name && msg.name !== "You" ? msg.name : "Friend";
      state.partnerCamOn = !!msg.cam;
      if (msg.ep && state.episode && msg.ep !== state.episode) {
        addLine("", "You two are on different episodes.", "sys");
      }
      latestRemoteSeq = 0;
      screenRoom();
      return;
    }
    if (msg.t === "msg") return addLine(state.partner, msg.text, "them");
    if (msg.t === "gif") return addGifLine(state.partner, msg.url, "them");
    if (msg.t === "react") {
      if (REACTS.includes(msg.e)) reactAll(msg.e);
      return;
    }
    if (msg.t === "cam") {
      state.partnerCamOn = !!msg.on;
      refreshCams();
      return;
    }
    if (msg.t === "init") {
      if (msg.ep && state.episode && msg.ep !== state.episode) {
        state.partnerEp = msg.ep;
        addLine("", `${state.partner} is on a different episode — following in a moment…`, "sys");
        return scheduleFollow(msg);
      }
      state.lastActAt = Date.now();
      applyRemote(msg, 1.0);
      addLine("", `Synced to ${state.partner}: ${msg.paused ? "paused" : "playing"} at ${clock(msg.time)}.`, "sys");
      return;
    }
    if (msg.t === "ep") {
      state.partnerEp = msg.ep;
      if (msg.ep && state.episode && msg.ep !== state.episode) {
        addLine("", `${state.partner} moved to a new episode — following in a moment…`, "sys");
        scheduleFollow(msg);
      }
      return;
    }
    if (msg.t === "ack") return void settleAct(msg.id);
    if (msg.t === "fail") {
      const entry = settleAct(msg.id);
      if (!entry) return;
      addLine(
        "",
        msg.reason === "play-blocked"
          ? "Their browser blocked the play — they need to click play once themselves."
          : "That didn't apply on their side — their player may not be loaded.",
        "sys"
      );
      return;
    }
    if (msg.t === "act") {
      if (msg.ep && state.episode && msg.ep !== state.episode) return wire({ t: "ack", id: msg.id });
      const seq = seqOf(msg.id);
      if (seq && seq <= latestRemoteSeq) return wire({ t: "ack", id: msg.id });
      latestRemoteSeq = seq;
      state.lastActAt = Date.now();
      applyRemote(msg, 0.4);
      if (msg.id) setTimeout(() => verifyAct(msg, 0), 1000);
      const verb = msg.action === "seeked" ? "jumped to" : msg.paused ? "paused at" : "resumed at";
      addLine("", `${state.partner} ${verb} ${clock(msg.time)}`, "sys");
      return;
    }
    if (msg.t === "sync") {
      if (msg.ep && state.episode && msg.ep !== state.episode) return;
      if (Date.now() - state.lastActAt < 3000) return;
      applyRemote(msg, 2.0);
    }
  }

  // ----------------------------------------------------------- room flow

  async function startRoom(existing) {
    const code = existing || makeCode();
    state.code = code;
    try {
      sessionStorage.setItem("cp-code", code);
    } catch (_) {}
    rememberUrl(code);
    showPanel();
    screenWaiting("Opening your party…");
    const res = await NET.connectRoom(code);
    if (res.ok) return screenHostWaiting(code);
    handleConnectError(res);
  }

  async function joinRoom(code) {
    state.code = code;
    try {
      sessionStorage.setItem("cp-code", code);
    } catch (_) {}
    rememberUrl(code);
    showPanel();
    screenWaiting(`Joining party ${code}…`);
    const res = await NET.connectRoom(code);
    if (res.ok) {
      if (NET.role === "host") return screenHostWaiting(code); // we arrived first
      return screenWaiting("Connected. Syncing…");
    }
    handleConnectError(res);
  }

  function handleConnectError(res) {
    if (res.error === "denied") {
      if (res.reason === "expired") return screenExpired();
      if (res.reason === "room-full") {
        return render(
          el("p", { class: "warn", text: "That party already has two people in it." }),
          el("button", { class: "act", text: "Back", onclick: leaveRoom })
        );
      }
      if (res.reason === "blocked") {
        return render(
          el("p", { class: "warn", text: "This account can't start parties right now." }),
          supportButton("Hi, my Crunchy Party account seems blocked.")
        );
      }
    }
    if (res.error === "no-token") return screenPhone();
    screenUnreachable("Couldn't reach the party server.");
  }

  function leaveRoom() {
    state.leaving = true;
    try {
      state.camStream && state.camStream.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    state.camStream = null;
    state.remoteCam = null;
    state.partnerCamOn = false;
    state.linked = false;
    NET.closeRoom();
    try {
      sessionStorage.removeItem("cp-code");
    } catch (_) {}
    forgetUrl();
    state.code = null;
    screenRoom.log = null;
    screenRoom.time = null;
    screenRoom.history = null;
    screenStart();
    setTimeout(() => (state.leaving = false), 500);
  }

  NET.onMessage = onWire;

  NET.onStatus = (status, detail) => {
    if (status === "joined") {
      if (detail && detail.peers === 2) onPeerPresent();
      return;
    }
    if (status === "peer-joined") return onPeerPresent();
    if (status === "peer-left") {
      state.linked = false;
      state.partnerCamOn = false;
      state.remoteCam = null;
      refreshCams();
      dot.classList.remove("on");
      addLine("", "Your friend left. The party stays open if they come back.", "sys");
      title.textContent = "Party open";
      return;
    }
    if (status === "denied") {
      if (detail === "expired") screenExpired();
      return;
    }
    if (status === "closed" && !state.leaving && state.code) {
      state.linked = false;
      dot.classList.remove("on");
      addLine("", "Connection lost — reconnecting…", "sys");
      setTimeout(async () => {
        if (state.leaving || !state.code) return;
        const res = await NET.connectRoom(state.code);
        if (!res.ok) handleConnectError(res);
      }, 2500);
    }
  };

  function onPeerPresent() {
    state.linked = true;
    screenRoom();
    addLine("", "Linked. Play, pause and seek are shared from here on.", "sys");
    wire({ t: "hello", name: state.name, ep: state.episode, cam: !!state.camStream });
    toPlayer({ type: "request-state" });
    NET.primeMedia();
    if (state.camStream) NET.setLocalCam(state.camStream);
    if (NET.role === "host") {
      setTimeout(() => {
        if (state.linked) {
          wire({
            t: "init",
            paused: state.local.paused,
            time: state.local.time,
            ep: state.episode,
            url: location.href,
          });
        }
      }, 1200);
    }
  }

  function scheduleFollow(msg) {
    setTimeout(() => {
      if (!state.linked || !state.code) return;
      if (!msg.ep || msg.ep !== state.partnerEp) return;
      if (state.episode === msg.ep) return;
      if (Date.now() - (state.lastEpChangeAt || 0) < 10000) return;
      if (Date.now() - (state.lastFollowAt || 0) < 30000) return;
      state.lastFollowAt = Date.now();
      try {
        const u = new URL(msg.url);
        if (u.hostname !== "www.crunchyroll.com") return;
        u.searchParams.set(PARAM, state.code);
        addLine("", "Following to their episode…", "sys");
        location.assign(u.toString());
      } catch (_) {}
    }, 6000);
  }

  // --------------------------------------------------------- player link

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.channel !== CHANNEL) return;
    if (msg.frameKey === frameKey) return;

    if (msg.type === "toggle-panel") {
      panel.hidden = !panel.hidden;
      return;
    }
    if (msg.type === "show-panel") return showPanel();

    if (msg.type === "tick") {
      state.lastTickAt = Date.now();
      state.local = { paused: msg.paused, time: msg.time };
      if (screenRoom.time) screenRoom.time.textContent = clock(msg.time);
      if (state.linked && !msg.paused && Date.now() - state.lastSyncSent > 4000) {
        state.lastSyncSent = Date.now();
        wire({ t: "sync", paused: msg.paused, time: msg.time, ep: state.episode });
      }
      return;
    }

    if (msg.type === "local-event") {
      state.local = { paused: msg.paused, time: msg.time };
      if (!state.linked) return;
      const a = state.lastApplied;
      const isEcho =
        a && Date.now() - a.at < 1500 && msg.paused === a.paused && Math.abs(msg.time - a.time) < 2.5;
      if (!isEcho) sendAct(msg.action, msg.paused, msg.time);
      return;
    }

    if (msg.type === "play-blocked") {
      addLine("", "Chrome blocked autoplay. Click play once to hand back control.", "sys");
      return;
    }
    if (msg.type === "fs-send" && msg.text) {
      if (state.linked) {
        const text = String(msg.text).slice(0, 300);
        wire({ t: "msg", text });
        addLine(state.name, text, "me");
      }
      return;
    }
    if (msg.type === "fs-react-click" && REACTS.includes(msg.e)) {
      if (state.linked) wire({ t: "react", e: msg.e });
      reactAll(msg.e);
    }
  });

  // ---------------------------------------------------------------- boot

  function mount() {
    if (!document.body.contains(host)) document.body.appendChild(host);
  }

  async function afterAuth() {
    if (!state.me) {
      const res = await NET.me();
      if (res && res.me) state.me = res.me;
      else if (res && (res.error === "no-token" || res.status === 401)) {
        await NET.setToken(null);
        return screenPhone();
      } else return screenUnreachable();
    }
    if (!state.me.active) return screenExpired();

    screenStart();

    const urlCode = new URL(location.href).searchParams.get(PARAM);
    if (urlCode && /^\d{6}$/.test(urlCode)) {
      let hosted = null;
      try {
        hosted = sessionStorage.getItem("cp-code");
      } catch (_) {}
      if (hosted === urlCode) startRoom(urlCode);
      else joinRoom(urlCode);
    }
  }

  async function boot() {
    await NET.loadConfig();
    if (NET.config.maintenance) return screenMaintenance();
    try {
      const { name } = await chrome.storage.local.get("name");
      if (name) state.name = name;
    } catch (_) {}
    const token = await NET.getToken();
    if (!token) return screenPhone();
    afterAuth();
  }

  mount();
  setInterval(mount, 3000);

  document.addEventListener("fullscreenchange", () => {
    const fs = document.fullscreenElement;
    if (fs && fs !== host && fs.tagName !== "IFRAME" && fs.appendChild) {
      fs.appendChild(host);
      panel.classList.add("fsmode");
    } else {
      panel.classList.remove("fsmode");
      if (!fs && !document.body.contains(host)) document.body.appendChild(host);
    }
  });

  setInterval(() => {
    const ep = episodeId();
    if (ep === state.episode) return;
    state.episode = ep;
    state.lastEpChangeAt = Date.now();
    latestRemoteSeq = 0;
    if (state.code) rememberUrl(state.code);
    if (state.linked && ep) wire({ t: "ep", ep, url: location.href });
  }, 2000);

  setInterval(() => {
    if (deadShown) return;
    if (!extAlive()) return goDead();
    if (state.linked) {
      const playerSeen = Date.now() - state.lastTickAt < 3500;
      title.textContent = playerSeen ? "Linked" : "Linked — no player (open an episode)";
    }
  }, 2000);

  // Re-check entitlement occasionally: a trial can lapse mid-session.
  setInterval(async () => {
    if (deadShown || !(await NET.getToken())) return;
    const res = await NET.me();
    if (res && res.me) {
      state.me = res.me;
      if (!res.me.active && !state.linked) screenExpired();
    }
  }, 15 * 60000);

  boot();
})();
