// Otaku Sync — panel, auth gate and playback sync.
// Transport is CT_NET (WebSocket to your server; WebRTC only for cam video).

(() => {
  if (window.__otakuSyncLoaded) return;
  window.__otakuSyncLoaded = true;

  const CHANNEL = "otaku-sync";
  const frameKey = "room";
  const PARAM = "otaku_sync";
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
    url: null, // set on first watcher tick
    lastNavAt: 0,
    lastFollowAt: 0,
    camStream: null,
    remoteCam: null,
    partnerCamOn: false,
  };

  function episodeId() {
    const m = location.pathname.match(/\/watch\/([A-Za-z0-9]+)/);
    return m ? m[1] : null;
  }
  // Codes people read aloud and retype, so no 0/O/1/I/5/S confusion.
  const CODE_ALPHABET = "ABCDEFGHJKLMNPQRTUVWXY2346789";
  const CODE_RE = /^[A-Z0-9]{6}$/;

  function makeCode() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    let out = "";
    for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    return out;
  }

  const normCode = (s) => String(s || "").trim().toUpperCase();

  // Strip our own parameter so two URLs can be compared for "same page".
  function bareUrl(href) {
    try {
      const u = new URL(href);
      u.searchParams.delete(PARAM);
      return u.toString();
    } catch (_) {
      return href;
    }
  }

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
      return chrome.runtime.sendMessage({ channel: "otaku-sync-api", ...payload });
    } catch (_) {
      goDead();
      return Promise.resolve({ error: "dead" });
    }
  }

  // ------------------------------------------------------------------- UI

  const host = el("div", { id: "otaku-sync-host" });
  host.style.cssText = "all:initial;position:fixed;z-index:2147483647;right:0;bottom:0;";
  const shadow = host.attachShadow({ mode: "open" });

  shadow.appendChild(
    el("style", {
      text: `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
.panel {
  position: fixed; right: 0; top: 0; bottom: 0; width: 330px;
  background: #171b24; color: #e6e9f2;
  border-left: 1px solid #262c3a;
  box-shadow: -14px 0 40px rgba(0,0,0,.5);
  font-size: 13px; line-height: 1.45;
  display: flex; flex-direction: column;
  transition: transform .18s ease;
}
.panel[hidden] { display: none; }
.panel.collapsed { transform: translateX(100%); }
.panel.fsmode { opacity: .45; transition: opacity .15s, transform .18s ease; }
.panel.fsmode:hover, .panel.fsmode:focus-within { opacity: 1; }
/* Sits just outside the panel's left edge, so it stays on screen when the
   panel slides away. */
.handle {
  position: absolute; left: -24px; top: 50%; transform: translateY(-50%);
  width: 24px; height: 62px; cursor: pointer;
  background: #171b24; color: #8b93a7; border: 1px solid #262c3a; border-right: 0;
  border-radius: 8px 0 0 8px; font: 600 13px/1 ui-monospace, monospace;
  display: flex; align-items: center; justify-content: center;
}
.handle:hover { color: #ffb03b; }
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

.body { padding: 0 12px 14px; display: grid; gap: 10px; align-content: start;
  flex: 1; overflow-y: auto; }
/* In a party the chat should take all leftover height, pinning the input and
   buttons to the bottom of the panel. */
.body.room { display: flex; flex-direction: column; overflow: hidden; }
.body.room > * { flex: none; }
.body.room .log { flex: 1 1 auto; height: auto; min-height: 110px; }
.body::-webkit-scrollbar { width: 6px; }
.body::-webkit-scrollbar-thumb { background: #2f3646; border-radius: 3px; }
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
.trialrow { display: flex; align-items: center; gap: 8px; }
.trialrow .note { flex: 1; }
.devrow { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
  background: #10131a; border: 1px solid #262c3a; border-radius: 7px; }
.devinfo { flex: 1; min-width: 0; }
.devname { font-size: 13px; font-weight: 500; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.devwhen { font: 11px ui-monospace, monospace; color: #8b93a7; }
.acctrow { display: flex; align-items: center; gap: 8px; padding-top: 4px;
  border-top: 1px solid #1e2431; margin-top: 2px; }
.acctrow .who3 { flex: 1; min-width: 0; font: 11px ui-monospace, monospace;
  color: #8b93a7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.act.mini { width: auto; flex: none; padding: 5px 12px; font-size: 12px;
  border-color: #ffb03b; color: #ffb03b; background: transparent; }
button.act.mini:hover { background: #ffb03b; color: #191400; }

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

.camwrap { display: flex; align-items: center; gap: 4px; }
.camwrap.empty { display: none; }
.camstrip {
  flex: 1; min-width: 0; display: flex; gap: 6px; overflow-x: auto;
  scroll-snap-type: x mandatory; scroll-behavior: smooth;
  scrollbar-width: none;
}
.camstrip::-webkit-scrollbar { display: none; }
.camtile {
  position: relative; flex: 0 0 calc(50% - 3px); scroll-snap-align: start;
  aspect-ratio: 4 / 3; background: #10131a;
  border: 1px solid #262c3a; border-radius: 6px; overflow: hidden;
}
.camtile video { width: 100%; height: 100%; object-fit: cover; display: block; }
.camtile video.mirror { transform: scaleX(-1); }
.camtile .who2 {
  position: absolute; left: 4px; bottom: 3px; font: 10px ui-monospace, monospace;
  color: #e6e9f2; background: rgba(0,0,0,.55); padding: 1px 5px; border-radius: 4px;
  max-width: 80%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.camtile .pop {
  position: absolute; right: 3px; top: 3px; width: 20px; height: 20px;
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  background: rgba(0,0,0,.55); color: #e6e9f2; border: 0; border-radius: 4px;
  font: 11px/1 ui-monospace, monospace; opacity: 0; transition: opacity .12s;
}
.camtile:hover .pop { opacity: 1; }
.camtile .pop:hover { background: #ffb03b; color: #191400; }
.camnav {
  flex: none; width: 18px; height: 46px; cursor: pointer; padding: 0;
  background: #212736; color: #8b93a7; border: 1px solid #333b4d; border-radius: 5px;
  font: 13px/1 ui-monospace, monospace;
}
.camnav:hover { color: #e6e9f2; border-color: #4a5468; }
.camnav[hidden] { display: none; }

/* Popped-out cam: a local-only floating window, draggable and resizable. */
.popwin {
  position: fixed; z-index: 2147483647; width: 260px; height: 205px;
  min-width: 140px; min-height: 110px;
  background: #10131a; border: 1px solid #333b4d; border-radius: 9px;
  box-shadow: 0 14px 38px rgba(0,0,0,.6);
  display: flex; flex-direction: column; overflow: hidden; resize: both;
}
.popwin .bar {
  display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: move;
  background: #171b24; border-bottom: 1px solid #262c3a;
  font: 11px ui-monospace, monospace; color: #8b93a7; user-select: none;
}
.popwin .bar span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.popwin .bar button {
  background: none; border: 0; color: #8b93a7; cursor: pointer;
  font: 13px/1 ui-monospace, monospace; padding: 2px 4px; border-radius: 4px;
}
.popwin .bar button:hover { color: #e6e9f2; background: #212736; }
.popwin video { flex: 1; width: 100%; min-height: 0; object-fit: cover; background: #000; }
.popwin video.mirror { transform: scaleX(-1); }

/* GIFs float up the screen like reactions instead of sitting in the chat. */
.fx-gif { position: absolute; bottom: -160px; width: 130px; border-radius: 8px;
  box-shadow: 0 6px 18px rgba(0,0,0,.45);
  animation-name: floatUp; animation-timing-function: linear;
  animation-fill-mode: forwards; will-change: transform, opacity; }

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
  const title = el("h1", { text: "Otaku Sync" });
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
    onclick: () => {
      panel.hidden = true;
      syncLayout();
    },
  });

  const PANEL_W = 330;

  // Reserve space on the page rather than covering it: the panel sits beside
  // Crunchyroll instead of on top of it. Cleared whenever the panel is
  // collapsed, hidden or fullscreen.
  function reserveSpace(on) {
    const root = document.documentElement;
    if (on) {
      if (!root.dataset.cpMargin) {
        root.dataset.cpMargin = root.style.marginRight || "";
        root.style.setProperty("margin-right", PANEL_W + "px", "important");
        root.style.setProperty("width", `calc(100% - ${PANEL_W}px)`, "important");
      }
    } else if (root.dataset.cpMargin !== undefined) {
      root.style.marginRight = root.dataset.cpMargin || "";
      root.style.removeProperty("width");
      delete root.dataset.cpMargin;
    }
    window.dispatchEvent(new Event("resize")); // nudge the player to re-measure
  }

  function panelVisible() {
    return !panel.hidden && !panel.classList.contains("collapsed") && !document.fullscreenElement;
  }
  function syncLayout() {
    reserveSpace(panelVisible());
  }

  const handle = el("button", {
    class: "handle",
    title: "Hide the party panel",
    "aria-label": "Collapse panel",
    text: "›",
  });
  handle.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    handle.textContent = collapsed ? "‹" : "›";
    handle.title = collapsed ? "Show the party panel" : "Hide the party panel";
    syncLayout();
  });

  const panel = el("div", { class: "panel" }, [
    handle,
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

  function render(...nodes) {
    body.className = "body";
    body.replaceChildren(...nodes);
  }

  function showPanel() {
    panel.hidden = false;
    panel.classList.remove("collapsed");
    handle.textContent = "›";
    body.hidden = false;
    collapseBtn.textContent = "–";
    mount();
    syncLayout();
  }

  function supportButton(context) {
    return el("button", {
      class: "act wa",
      text: "Message support on WhatsApp",
      onclick: () => api({ type: "open-tab", url: NET.whatsappUrl(context) }),
    });
  }

  // -------------------------------------------------------- auth screens

  let signInPoll = null;
  function stopSignInPoll() {
    clearInterval(signInPoll);
    signInPoll = null;
  }

  // Sign-in happens on a hosted page (Google, Facebook, or email+password),
  // so no OAuth secrets ever ship inside the extension.
  function screenSignIn(errText) {
    stopSignInPoll();
    dot.classList.remove("on");
    title.textContent = "Otaku Sync";
    const btn = el("button", { class: "act primary", text: "Sign in" });

    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Opening…";
      const res = await NET.startSignIn();
      btn.disabled = false;
      btn.textContent = "Sign in";
      if (!res || !res.url) return screenSignIn("Couldn't reach the sign-in service.");
      if (!/^https:\/\//i.test(res.url)) {
        // Almost always PUBLIC_URL missing on the server, which yields a
        // relative link the browser can't open.
        return screenSignIn("The server returned an invalid sign-in link. Support can fix this.");
      }
      const opened = await api({ type: "open-tab", url: res.url, watch: true });
      if (!opened || opened.error) {
        return screenSignIn("Couldn't open the sign-in tab. Check that pop-ups aren't blocked.");
      }
      screenSignInWaiting(res.rid);
    });

    render(
      ...(errText ? [el("p", { class: "warn", text: errText })] : []),
      el("p", { class: "note", text: `Sign in with Google, Facebook, or an email address. Your first ${NET.config.trial_days || 7} days are free.` }),
      btn,
      supportButton("Hi, I need help signing in to Otaku Sync.")
    );
  }

  function screenSignInWaiting(rid) {
    title.textContent = "Signing in";
    render(
      el("p", { class: "note", text: "Finish signing in on the tab that just opened. This picks it up automatically." }),
      el("button", { class: "act", text: "Cancel", onclick: () => screenSignIn() })
    );

    stopSignInPoll();
    let tries = 0;
    signInPoll = setInterval(async () => {
      if (++tries > 150 || deadShown) return stopSignInPoll(); // ~5 minutes
      const res = await NET.pollSignIn(rid);
      if (!res || res.pending) return;

      if (res.token) {
        stopSignInPoll();
        await NET.setToken(res.token);
        state.me = res.me;
        api({ type: "finish-payment" }); // reuse: closes the tab, refocuses us
        return afterAuth();
      }
      if (res.error === "device-limit") {
        stopSignInPoll();
        api({ type: "finish-payment" });
        return screenDeviceLimit(res);
      }
      if (res.error === "expired" || res.error === "already-used") {
        stopSignInPoll();
        return screenSignIn("That sign-in link expired. Try again.");
      }
    }, 2000);
  }

  function whenText(ts) {
    if (!ts) return "";
    const mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 2) return "active now";
    if (mins < 60) return `last used ${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `last used ${hrs}h ago`;
    return `last used ${new Date(ts).toLocaleDateString()}`;
  }

  // One account, one active device. Signing in elsewhere means choosing which
  // device to sign out.
  function screenDeviceLimit(info) {
    title.textContent = "Already signed in elsewhere";
    const devices = info.devices || [];

    const rows = devices.map((d) => {
      const btn = el("button", { class: "act mini", text: "Sign out" });
      const row = el("div", { class: "devrow" }, [
        el("div", { class: "devinfo" }, [
          el("div", { class: "devname", text: d.label || "Unknown device" }),
          el("div", { class: "devwhen", text: whenText(d.last_seen) }),
        ]),
        btn,
      ]);

      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "…";
        const res = await NET.revokeDevice(d.id, info.manage_token);
        if (res && res.token) {
          await NET.setToken(res.token);
          state.me = res.me;
          return afterAuth();
        }
        btn.disabled = false;
        btn.textContent = "Sign out";
        render(
          el("p", { class: "warn", text: "Couldn't sign that device out. Try again." }),
          el("button", { class: "act", text: "Back", onclick: () => screenDeviceLimit(info) }),
          supportButton("Hi, I'm stuck on the Otaku Sync device limit.")
        );
      });
      return row;
    });

    render(
      el("p", {
        class: "note",
        text: `Your account is limited to ${info.max || 1} device at a time. Sign the other one out to continue here.`,
      }),
      ...(rows.length
        ? rows
        : [el("p", { class: "warn", text: "Couldn't list your other devices. Support can free the slot for you." })]),
      el("button", { class: "act", text: "Cancel", onclick: () => screenSignIn() }),
      supportButton("Hi, I need help with devices on my Otaku Sync account.")
    );
  }

  function backFromPayment() {
    stopPayPoll();
    if (state.me && state.me.active) screenStart();
    else screenExpired();
  }

  async function startCheckout(btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Opening…";
    const res = await NET.subscribe();
    btn.disabled = false;
    btn.textContent = label;
    if (res && res.url) {
      api({ type: "open-tab", url: res.url, watch: true });
      screenAwaitingPayment();
      return;
    }
    const why =
      res && res.error === "billing-off"
        ? "Subscriptions aren't switched on yet. Message support and they'll sort it out."
        : res && res.error === "razorpay-failed"
        ? "The payment provider rejected the request. Support can fix this."
        : res && (res.error === "no-token" || res.status === 401)
        ? "Your session expired. Sign in again to subscribe."
        : "Couldn't start the payment right now.";
    if (res && (res.error === "no-token" || res.status === 401)) {
      NET.setToken(null);
      return screenSignIn();
    }
    render(
      el("p", { class: "warn", text: why }),
      supportButton(`Hi, I couldn't start the Otaku Sync payment (${(res && res.error) || "unknown"}).`),
      el("button", { class: "act", text: "Back", onclick: backFromPayment })
    );
  }

  function screenExpired() {
    dot.classList.remove("on");
    title.textContent = "Trial ended";

    // A guest has nothing to attach a subscription to, and no way to recover
    // it on a new device — so sign-in comes first, then payment.
    if (state.me && state.me.guest) {
      const inBtn = el("button", { class: "act primary", text: "Sign in to subscribe" });
      inBtn.addEventListener("click", () => screenSignIn());
      return render(
        el("p", { class: "note", text: "Your free trial is over. Sign in to keep watching together — it also keeps your subscription safe if you change browsers." }),
        inBtn,
        el("p", { class: "note", text: `${NET.config.price_label || "₹5 / month"}, cancel any time.` }),
        supportButton("Hi, I need help subscribing to Otaku Sync.")
      );
    }

    const btn = el("button", { class: "act primary", text: `Subscribe — ${NET.config.price_label || "₹5 / month"}` });
    btn.addEventListener("click", () => startCheckout(btn));

    render(
      el("p", { class: "note", text: "Your free trial is over. Subscribe to keep watching together." }),
      btn,
      el("p", { class: "note", text: "Cancel any time. Payments handled by Razorpay." }),
      supportButton("Hi, I need help with my Otaku Sync subscription.")
    );
  }

  let payPoll = null;
  let payTries = 0;

  function stopPayPoll() {
    clearInterval(payPoll);
    payPoll = null;
    payTries = 0;
  }

  // Returns true once the subscription (not just the trial) is live.
  async function checkPaid() {
    const res = await NET.refreshBilling();
    if (res && res.me) {
      state.me = res.me;
      if (res.me.status === "subscribed") return true;
    }
    return false;
  }

  async function paymentDone() {
    stopPayPoll();
    // Close the Razorpay tab and switch back to the episode.
    api({ type: "finish-payment" });
    title.textContent = "Subscribed";
    dot.classList.remove("on");
    render(
      el("p", { class: "note", text: "Payment received — you're all set. Thanks!" }),
      el("button", { class: "act primary", text: "Back to the party", onclick: screenStart })
    );
    setTimeout(() => {
      // Move on by itself if they don't click.
      if (title.textContent === "Subscribed") screenStart();
    }, 4000);
  }

  function screenAwaitingPayment() {
    title.textContent = "Waiting for payment";
    const btn = el("button", { class: "act primary", text: "Check now" });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.textContent = "Checking…";
      const paid = await checkPaid();
      btn.disabled = false;
      btn.textContent = "Check now";
      if (paid) return paymentDone();
      render(
        el("p", { class: "warn", text: "Payment hasn't landed yet. It can take a minute — this keeps checking on its own." }),
        btn,
        supportButton("Hi, I paid for Otaku Sync but it still shows as unpaid."),
        el("button", { class: "act", text: "Back", onclick: backFromPayment })
      );
    });

    render(
      el("p", { class: "note", text: "Finish the payment in the tab that just opened. This closes it and brings you back automatically." }),
      btn,
      el("button", { class: "act", text: "Back", onclick: backFromPayment }),
      supportButton("Hi, I need help paying for Otaku Sync.")
    );

    // Poll until it lands (about 6 minutes), then leave it to the button.
    stopPayPoll();
    payPoll = setInterval(async () => {
      if (++payTries > 60 || deadShown) return stopPayPoll();
      if (await checkPaid()) paymentDone();
    }, 6000);
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
      supportButton("Hi, Otaku Sync can't reach the server."),
      el("p", { class: "note", text: `Support: ${NET.support()} (WhatsApp only)` })
    );
  }

  function screenMaintenance() {
    dot.classList.remove("on");
    title.textContent = "Back shortly";
    render(
      el("p", { class: "note", text: NET.config.notice || "Otaku Sync is down for maintenance. Please try again later." }),
      supportButton("Hi, is Otaku Sync still down?")
    );
  }

  // -------------------------------------------------------- room screens

  function screenStart() {
    dot.classList.remove("on");
    const ent = state.me || {};
    title.textContent = "Otaku Sync";

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

    const codeField = el("input", { class: "code", placeholder: "Party code", maxlength: "6", autocapitalize: "characters", spellcheck: "false" });
    codeField.addEventListener("input", () => {
      const pos = codeField.selectionStart;
      codeField.value = codeField.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
      codeField.setSelectionRange(pos, pos);
    });
    const joinBtn = el("button", {
      class: "act",
      text: "Join",
      onclick: () => {
        const c = normCode(codeField.value);
        if (CODE_RE.test(c)) joinRoom(c);
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
      // Let people pay before the trial runs out if they want to.
      const payBtn = el("button", { class: "act mini", text: "Subscribe" });
      payBtn.addEventListener("click", () => startCheckout(payBtn));
      nodes.push(
        el("div", { class: "trialrow" }, [
          el("span", { class: "note", text: `Free trial — ${days(ent.until)} left.` }),
          payBtn,
        ])
      );
    } else if (ent.status === "subscribed" && ent.until) {
      nodes.push(el("p", { class: "note", text: `Subscribed — renews in ${days(ent.until)}.` }));
    }
    if (NET.config.notice) nodes.push(el("p", { class: "warn", text: NET.config.notice }));

    if (state.me && state.me.guest) {
      // Anonymous trial: offer sign-in, don't demand it.
      const inBtn = el("button", { class: "act mini", text: "Sign in" });
      inBtn.addEventListener("click", () => screenSignIn());
      nodes.push(
        el("div", { class: "acctrow" }, [
          el("div", { class: "who3", text: "Not signed in — this device only" }),
          inBtn,
        ])
      );
    } else {
      const who = (state.me && (state.me.email || state.me.phone || state.me.name)) || "Signed in";
      const outBtn = el("button", { class: "act mini", text: "Sign out" });
      outBtn.addEventListener("click", async () => {
        outBtn.disabled = true;
        outBtn.textContent = "…";
        leaveRoom();
        await NET.logout();
        state.me = null;
        screenSignIn();
      });
      nodes.push(el("div", { class: "acctrow" }, [el("div", { class: "who3", text: who }), outBtn]));
    }

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

    const cams = buildCams();
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
    body.className = "body room";
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
            gifAll(g.full);
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

  function spawnGif(url) {
    const safe = safeGifUrl(url);
    if (!safe) return;
    const img = el("img", { class: "fx-gif", alt: "GIF" });
    img.style.left = 4 + Math.random() * 72 + "vw";
    img.style.width = 110 + Math.random() * 50 + "px";
    img.style.setProperty("--rot", (Math.random() * 20 - 10).toFixed(0) + "deg");
    img.style.animationDuration = (5 + Math.random() * 1.5).toFixed(2) + "s";
    loadImg(img, safe);
    fxLayer.appendChild(img);
    setTimeout(() => img.remove(), 7000);
  }

  function gifAll(url) {
    spawnGif(url);
    toPlayer({ type: "fs-gif", url });
  }

  // -------------------------------------------------------------- webcam

  function refreshCams() {
    const wrap = screenRoom.camWrap;
    const strip = screenRoom.camStrip;
    if (!wrap || !strip) return;

    // Built generically from a list, so extra participants slot straight in.
    const feeds = [];
    if (state.camStream) feeds.push({ id: "me", name: "You", stream: state.camStream, mirror: true });
    if (state.remoteCam && state.partnerCamOn) {
      feeds.push({ id: "them", name: state.partner, stream: state.remoteCam, mirror: false });
    }

    wrap.classList.toggle("empty", feeds.length === 0);
    screenRoom.feeds = feeds;

    // A popped-out feed leaves the strip — it lives in its floating window
    // until closed, then comes back here.
    const inStrip = feeds.filter((f) => !popWins.has(f.id));

    // Reuse tiles where possible so the video element isn't torn down (which
    // would restart the stream and flicker).
    const existing = new Map();
    for (const tile of strip.children) existing.set(tile.dataset.id, tile);

    wrap.classList.toggle("empty", inStrip.length === 0);

    strip.replaceChildren(
      ...inStrip.map((f) => {
        let tile = existing.get(f.id);
        if (!tile) {
          tile = el("div", { class: "camtile" });
          tile.dataset.id = f.id;
          const v = el("video", { autoplay: "", playsinline: "" });
          if (f.id === "me") v.muted = true;
          tile.append(
            v,
            el("span", { class: "who2" }),
            el("button", {
              class: "pop",
              type: "button",
              title: "Pop out",
              "aria-label": "Pop out this camera",
              text: "⧉",
              onclick: () => popOutCam(f.id),
            })
          );
        }
        const v = tile.querySelector("video");
        v.classList.toggle("mirror", !!f.mirror);
        if (v.srcObject !== f.stream) v.srcObject = f.stream;
        tile.querySelector(".who2").textContent = f.name;
        return tile;
      })
    );

    const overflow = inStrip.length > 2;
    if (screenRoom.camPrev) screenRoom.camPrev.hidden = !overflow;
    if (screenRoom.camNext) screenRoom.camNext.hidden = !overflow;

    // Keep any open pop-out windows pointed at live streams.
    for (const [id, win] of popWins) {
      const feed = feeds.find((f) => f.id === id);
      if (!feed) {
        win.remove();
        popWins.delete(id);
      } else {
        const v = win.querySelector("video");
        if (v.srcObject !== feed.stream) v.srcObject = feed.stream;
      }
    }
  }

  function buildCams() {
    const strip = el("div", { class: "camstrip" });
    const prev = el("button", {
      class: "camnav",
      type: "button",
      title: "Previous cameras",
      "aria-label": "Scroll cameras left",
      text: "‹",
      onclick: () => strip.scrollBy({ left: -strip.clientWidth / 2 - 3, behavior: "smooth" }),
    });
    const next = el("button", {
      class: "camnav",
      type: "button",
      title: "More cameras",
      "aria-label": "Scroll cameras right",
      text: "›",
      onclick: () => strip.scrollBy({ left: strip.clientWidth / 2 + 3, behavior: "smooth" }),
    });
    prev.hidden = true;
    next.hidden = true;
    const wrap = el("div", { class: "camwrap empty" }, [prev, strip, next]);
    screenRoom.camWrap = wrap;
    screenRoom.camStrip = strip;
    screenRoom.camPrev = prev;
    screenRoom.camNext = next;
    return wrap;
  }

  // Pop-outs are purely local: nothing is sent to the other person.
  const popWins = new Map();

  function popOutCam(id) {
    if (popWins.has(id)) {
      popWins.get(id).remove();
      popWins.delete(id);
      refreshCams(); // tile returns to the strip
      return;
    }
    const feed = (screenRoom.feeds || []).find((f) => f.id === id);
    if (!feed) return;

    const video = el("video", { autoplay: "", playsinline: "" });
    if (id === "me") video.muted = true;
    video.classList.toggle("mirror", !!feed.mirror);
    video.srcObject = feed.stream;

    const close = el("button", { type: "button", title: "Close", "aria-label": "Close", text: "×" });
    const bar = el("div", { class: "bar" }, [el("span", { text: feed.name }), close]);
    const win = el("div", { class: "popwin" }, [bar, video]);

    const offset = popWins.size * 26;
    win.style.left = 60 + offset + "px";
    win.style.top = 90 + offset + "px";

    close.addEventListener("click", () => {
      win.remove();
      popWins.delete(id);
      refreshCams(); // tile returns to its original place in the strip
    });

    // Drag by the title bar. Pointer capture keeps it smooth over the video.
    let dragging = false;
    let dx = 0;
    let dy = 0;
    bar.addEventListener("pointerdown", (e) => {
      if (e.target === close) return;
      dragging = true;
      const r = win.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      bar.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    bar.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const maxX = window.innerWidth - win.offsetWidth;
      const maxY = window.innerHeight - win.offsetHeight;
      win.style.left = Math.max(0, Math.min(maxX, e.clientX - dx)) + "px";
      win.style.top = Math.max(0, Math.min(maxY, e.clientY - dy)) + "px";
    });
    const stop = (e) => {
      dragging = false;
      try {
        bar.releasePointerCapture(e.pointerId);
      } catch (_) {}
    };
    bar.addEventListener("pointerup", stop);
    bar.addEventListener("pointercancel", stop);

    shadow.appendChild(win);
    popWins.set(id, win);
    refreshCams(); // tile leaves the strip while it's floating
  }

  function closeAllPopouts() {
    for (const win of popWins.values()) win.remove();
    popWins.clear();
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
    if (msg.t === "gif") return gifAll(msg.url);
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
      if (msg.url && bareUrl(msg.url) !== state.url) {
        state.partnerEp = msg.ep || null;
        addLine("", `${state.partner} is on a different page — following…`, "sys");
        return followTo(msg);
      }
      state.lastActAt = Date.now();
      applyRemote(msg, 1.0);
      addLine("", `Synced to ${state.partner}: ${msg.paused ? "paused" : "playing"} at ${clock(msg.time)}.`, "sys");
      return;
    }
    if (msg.t === "nav") {
      state.partnerEp = msg.ep || null;
      followTo(msg);
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
          supportButton("Hi, my Otaku Sync account seems blocked.")
        );
      }
    }
    if (res.error === "no-token") return screenSignIn();
    screenUnreachable("Couldn't reach the party server.");
  }

  function leaveRoom() {
    state.leaving = true;
    closeAllPopouts();
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
      if (detail === "device-revoked") {
        NET.setToken(null);
        screenSignIn("You were signed out because this account was used on another device.");
      }
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

  function followTo(msg) {
    if (!state.code || !msg || !msg.url) return;
    if (bareUrl(msg.url) === state.url) return; // already together
    // Don't follow if we just navigated ourselves — otherwise two people
    // moving at the same time bounce each other around.
    if (Date.now() - (state.lastNavAt || 0) < 6000) return;
    if (Date.now() - (state.lastFollowAt || 0) < 8000) return;
    try {
      const u = new URL(msg.url);
      if (u.hostname !== "www.crunchyroll.com") return;
      state.lastFollowAt = Date.now();
      u.searchParams.set(PARAM, state.code);
      addLine("", `Following ${state.partner}…`, "sys");
      setTimeout(() => location.assign(u.toString()), 1200);
    } catch (_) {}
  }

  // --------------------------------------------------------- player link

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.channel !== CHANNEL) return;
    if (msg.frameKey === frameKey) return;

    if (msg.type === "toggle-panel") {
      panel.hidden = !panel.hidden;
      syncLayout();
      return;
    }
    if (msg.type === "show-panel") return showPanel();

    if (msg.type === "payment-tab-closed") {
      // They shut the checkout tab — check straight away rather than waiting
      // for the next poll tick.
      if (payPoll) {
        checkPaid().then((paid) => paid && paymentDone());
      }
      return;
    }

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
      else if (res && res.error === "device-revoked") {
        await NET.setToken(null);
        return screenSignIn("You were signed out because this account was used on another device.");
      } else if (res && (res.error === "no-token" || res.status === 401)) {
        await NET.setToken(null);
        return screenSignIn();
      } else return screenUnreachable();
    }
    if (!state.me.active) return screenExpired();

    screenStart();

    const urlCode = normCode(new URL(location.href).searchParams.get(PARAM));
    if (urlCode && CODE_RE.test(urlCode)) {
      let hosted = null;
      try {
        hosted = normCode(sessionStorage.getItem("cp-code"));
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
    if (token) return afterAuth();

    // No token yet: start the trial silently. Nobody should have to create an
    // account before they've seen the thing work.
    render(el("p", { class: "note", text: "Getting things ready…" }));
    const res = await NET.startGuest();
    if (res && res.token) {
      await NET.setToken(res.token);
      state.me = res.me;
      return afterAuth();
    }
    if (res && res.error === "device-limit") return screenDeviceLimit(res);
    // Couldn't start a trial — signing in is the way forward.
    screenSignIn(res && res.error === "unreachable" ? "Couldn't reach the server." : null);
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
    // In fullscreen the page fills the screen, so the reserved margin must go.
    syncLayout();
  });

  // Page watcher: any navigation — a new episode, autoplay rolling over, or
  // backing out to a listing page — is announced so the other side follows.
  setInterval(() => {
    const ep = episodeId();
    const url = bareUrl(location.href);
    if (url === state.url && ep === state.episode) return;
    const first = state.url === null; // page we loaded on, not a move
    const epChanged = ep !== state.episode;
    state.episode = ep;
    state.url = url;
    if (first) return;
    state.lastNavAt = Date.now();
    if (epChanged) latestRemoteSeq = 0;
    if (state.code) rememberUrl(state.code);
    if (state.linked) wire({ t: "nav", url, ep });
  }, 1500);

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
