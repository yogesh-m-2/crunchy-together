// Otaku Sync — player hook.
// Runs in every frame. Only does something once it finds a <video>.
// Reports local play/pause/seek to room.js, and applies remote commands.
// Also owns the FULLSCREEN overlay: when the player element goes fullscreen,
// nothing outside it is painted, so a compact chat + reactions overlay is
// injected here, inside the fullscreened element itself.

(() => {
  const CHANNEL = "otaku-sync";
  const frameKey = Math.random().toString(36).slice(2);
  const REACTS = ["❤️", "🔥", "😂", "😢"];

  let video = null;
  // While we're applying a remote command, ignore the events it fires,
  // otherwise the two browsers ping-pong commands at each other forever.
  let muteEventsUntil = 0;
  let dead = false;
  const timers = [];
  const chatLines = []; // { name, text, kind } — mirrored from room.js

  function send(payload) {
    if (dead) return;
    try {
      if (!chrome.runtime || !chrome.runtime.id) throw new Error("gone");
      chrome.runtime.sendMessage({ channel: CHANNEL, frameKey, ...payload });
    } catch (_) {
      // Extension was reloaded while this page stayed open. Stop everything;
      // the page needs one refresh to pick up the new copy.
      dead = true;
      timers.forEach(clearInterval);
      destroyOverlay();
    }
  }

  function onLocalEvent(e) {
    if (!video || Date.now() < muteEventsUntil) return;

    // Not the viewer: the page's own player changed state by itself.
    if (!userDrivenNow()) {
      if (desired && Date.now() < desired.until && video.paused !== desired.paused) {
        // Put it back where the party wants it. Silently — no broadcast.
        muteEventsUntil = Date.now() + 800;
        if (desired.paused) video.pause();
        else {
          const p = video.play();
          if (p && p.catch) p.catch(() => {});
        }
      }
      return;
    }

    // A real click or keypress: this is the viewer's intent, so it becomes
    // the party's intent too.
    desired = { paused: video.paused, until: Date.now() + 5000 };
    send({
      type: "local-event",
      action: e.type,
      paused: video.paused,
      time: video.currentTime,
    });
  }

  let buffering = false;

  // --- user intent -------------------------------------------------------
  // A play/pause event counts as the viewer's only if a real interaction
  // happened just before it. Everything else is the site's own player
  // reasserting itself, and must not be broadcast.
  let lastGesture = 0;
  const GESTURE_WINDOW = 1800;
  const markGesture = () => (lastGesture = Date.now());
  for (const ev of ["pointerdown", "mousedown", "keydown", "touchstart"]) {
    document.addEventListener(ev, markGesture, true);
  }
  const userDrivenNow = () => Date.now() - lastGesture < GESTURE_WINDOW;

  // The state we were last told to be in. If the player drifts away from it
  // on its own, put it back rather than telling the other side.
  let desired = null; // { paused, until }

  function reportBuffering(on) {
    if (buffering === on) return;
    buffering = on;
    send({ type: "buffering", on, time: video ? video.currentTime : 0 });
  }

  const onStall = () => reportBuffering(true);
  const onReady = () => reportBuffering(false);

  function attach() {
    const found = document.querySelector("video");
    if (!found) return;
    if (found === video) return;

    if (video) {
      for (const ev of ["play", "pause", "seeked"]) {
        video.removeEventListener(ev, onLocalEvent);
      }
      for (const ev of ["waiting", "stalled"]) video.removeEventListener(ev, onStall);
      for (const ev of ["playing", "canplay", "canplaythrough"]) {
        video.removeEventListener(ev, onReady);
      }
    }
    video = found;
    for (const ev of ["play", "pause", "seeked"]) {
      video.addEventListener(ev, onLocalEvent);
    }
    // Buffering signals: "waiting"/"stalled" mean the player ran dry.
    for (const ev of ["waiting", "stalled"]) video.addEventListener(ev, onStall);
    for (const ev of ["playing", "canplay", "canplaythrough"]) {
      video.addEventListener(ev, onReady);
    }
    buffering = false;
    send({ type: "player-ready" });
  }

  function tick() {
    if (!video || !document.contains(video)) {
      video = null;
      attach();
      return;
    }
    // readyState < 3 means it can't play through from here — a seek now would
    // make things worse.
    const ready = video.readyState >= 3;
    if (buffering && ready) reportBuffering(false);
    send({
      type: "tick",
      paused: video.paused,
      time: video.currentTime,
      duration: video.duration || 0,
      ready,
      buffering,
    });
  }

  function apply(msg) {
    if (!video) return;
    const tolerance = msg.tolerance != null ? msg.tolerance : 0.4;
    muteEventsUntil = Date.now() + 1200;
    // Hold this state for a few seconds against the site's own player.
    if (typeof msg.paused === "boolean") {
      desired = { paused: msg.paused, until: Date.now() + 5000 };
    }

    // Omitting time (auto pause/resume around buffering) must not seek: a
    // seek discards the buffer the player is trying to build.
    if (typeof msg.time === "number" && Math.abs(video.currentTime - msg.time) > tolerance) {
      video.currentTime = msg.time;
    }

    if (msg.paused === true && !video.paused) {
      video.pause();
    } else if (msg.paused === false && video.paused) {
      const p = video.play();
      if (p && p.catch) {
        p.catch(() => send({ type: "play-blocked" }));
      }
    }

    // Fresh state report shortly after applying, so the other side's
    // acknowledgement check isn't waiting on the 1s heartbeat.
    setTimeout(tick, 400);
  }

  // ------------------------------------------------- fullscreen overlay

  let fsHost = null;
  let fsShadow = null;
  let fsLog = null;
  let fsFx = null;

  function fsEl(tag, props = {}, kids = []) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k === "text") node.textContent = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const kid of [].concat(kids)) node.appendChild(kid);
    if (tag === "input") {
      for (const ev of ["keydown", "keyup", "keypress"]) {
        node.addEventListener(ev, (e) => e.stopPropagation());
      }
    }
    return node;
  }

  function lineNode(l) {
    if (l.kind === "sys") return fsEl("div", { class: "msg sys", text: l.text });
    const node = fsEl("div", { class: `msg ${l.kind}` });
    node.appendChild(fsEl("span", { class: "who", text: l.name + ": " }));
    if (l.gif) {
      const img = fsEl("img", { alt: "GIF" });
      img.style.cssText = "max-width:100%;max-height:120px;border-radius:5px;display:block;margin-top:3px;";
      img.addEventListener("error", () => img.replaceWith(document.createTextNode("[GIF]")));
      img.src = l.gif;
      node.appendChild(img);
    } else {
      node.appendChild(document.createTextNode(l.text));
    }
    return node;
  }

  function buildOverlay() {
    if (fsHost) return;
    fsHost = document.createElement("div");
    fsHost.style.cssText = "all:initial;";
    fsShadow = fsHost.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
* { box-sizing: border-box; margin: 0; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
.box {
  position: fixed; right: 16px; bottom: 72px; width: 250px; z-index: 2147483647;
  background: rgba(23,27,36,.88); color: #e6e9f2;
  border: 1px solid rgba(56,64,82,.9); border-radius: 10px;
  padding: 8px; display: grid; gap: 7px;
  font-size: 12px; line-height: 1.4; opacity: .55; transition: opacity .15s;
}
.box:hover, .box:focus-within { opacity: 1; }
.log { height: 108px; overflow-y: auto; display: flex; flex-direction: column; gap: 5px; }
.log::-webkit-scrollbar { width: 5px; }
.log::-webkit-scrollbar-thumb { background: #2f3646; border-radius: 3px; }
.msg { word-wrap: break-word; }
.msg .who { color: #ffb03b; font-weight: 600; }
.msg.them .who { color: #7fb7ff; }
.msg.sys { color: #8b93a7; font: 10px ui-monospace, monospace; }
input {
  width: 100%; background: rgba(16,19,26,.9); color: #e6e9f2;
  border: 1px solid rgba(56,64,82,.9); border-radius: 6px; padding: 6px 8px; font-size: 12px;
}
input:focus { outline: none; border-color: #ffb03b; }
.reacts { display: flex; gap: 6px; }
.reacts button {
  flex: 1; padding: 4px 0; font-size: 15px; line-height: 1; cursor: pointer;
  background: rgba(33,39,54,.9); border: 1px solid rgba(56,64,82,.9); border-radius: 6px;
}
.reacts button:hover { border-color: #6a7590; }
.fx-layer { position: fixed; inset: 0; overflow: hidden; pointer-events: none; z-index: 2147483647; }
.fx {
  position: absolute; bottom: -70px;
  animation-name: floatUp; animation-timing-function: ease-out; animation-fill-mode: forwards;
  will-change: transform, opacity;
}
@keyframes floatUp {
  0%   { transform: translateY(0) rotate(0deg); opacity: 1; }
  75%  { opacity: 1; }
  100% { transform: translateY(-115vh) rotate(var(--rot, 0deg)); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .fx { animation-name: fadeOnly; animation-duration: 1.4s !important; bottom: 20vh; }
  @keyframes fadeOnly { 0% { opacity: 1; } 100% { opacity: 0; } }
}`;
    fsShadow.appendChild(style);

    fsFx = fsEl("div", { class: "fx-layer" });
    fsShadow.appendChild(fsFx);

    fsLog = fsEl("div", { class: "log" });
    for (const l of chatLines) fsLog.appendChild(lineNode(l));

    const input = fsEl("input", { placeholder: "Say something…", maxlength: "300" });
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !input.value.trim()) return;
      send({ type: "fs-send", text: input.value.trim() });
      input.value = "";
    });

    const reacts = fsEl(
      "div",
      { class: "reacts" },
      REACTS.map((emoji) =>
        fsEl("button", {
          type: "button",
          "aria-label": `React ${emoji}`,
          text: emoji,
          onclick: () => send({ type: "fs-react-click", e: emoji }),
        })
      )
    );

    const box = fsEl("div", { class: "box" }, [fsLog, reacts, input]);
    fsShadow.appendChild(box);
    fsLog.scrollTop = fsLog.scrollHeight;
  }

  function destroyOverlay() {
    if (fsHost && fsHost.parentNode) fsHost.parentNode.removeChild(fsHost);
    fsHost = fsShadow = fsLog = fsFx = null;
  }

  function onFullscreenChange() {
    const fs = document.fullscreenElement;
    if (fs && video) {
      buildOverlay();
      const target = fs === document.documentElement ? document.body : fs;
      if (fsHost.parentNode !== target) target.appendChild(fsHost);
    } else {
      destroyOverlay();
    }
  }
  // Only when the player lives in an IFRAME: the main panel (in the top
  // frame) can't render inside a fullscreened iframe, so this overlay stands
  // in. When the video is in the top document, the main panel handles
  // fullscreen itself — building this too would double the UI.
  if (window !== window.top) {
    document.addEventListener("fullscreenchange", onFullscreenChange);
  }

  function fsAddLine(l) {
    chatLines.push(l);
    if (chatLines.length > 60) chatLines.shift();
    if (fsLog) {
      fsLog.appendChild(lineNode(l));
      fsLog.scrollTop = fsLog.scrollHeight;
    }
  }

  function fsSpawnReact(emoji) {
    if (!fsFx) return;
    const span = fsEl("span", { class: "fx", text: emoji });
    span.style.left = 5 + Math.random() * 85 + "vw";
    span.style.fontSize = 38 + Math.random() * 20 + "px";
    span.style.setProperty("--rot", (Math.random() * 44 - 22).toFixed(0) + "deg");
    span.style.animationDuration = (2.4 + Math.random() * 1.2).toFixed(2) + "s";
    fsFx.appendChild(span);
    setTimeout(() => span.remove(), 4200);
  }

  function fsSpawnGif(url) {
    if (!fsFx) return;
    const img = fsEl("img", { alt: "GIF" });
    img.className = "fx";
    img.style.left = 4 + Math.random() * 72 + "vw";
    img.style.width = 110 + Math.random() * 50 + "px";
    img.style.bottom = "-160px";
    img.style.borderRadius = "8px";
    img.style.setProperty("--rot", (Math.random() * 20 - 10).toFixed(0) + "deg");
    img.style.animationDuration = (5 + Math.random() * 1.5).toFixed(2) + "s";
    img.addEventListener("error", () => img.remove());
    img.src = url;
    fsFx.appendChild(img);
    setTimeout(() => img.remove(), 7000);
  }

  // ---------------------------------------------------------- messaging

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.channel !== CHANNEL) return;
    if (msg.frameKey === frameKey) return; // our own echo
    if (msg.type === "apply") apply(msg);
    if (msg.type === "request-state" && video) tick();
    if (msg.type === "fs-line") fsAddLine({ name: msg.name, text: msg.text, kind: msg.kind });
    if (msg.type === "fs-react" && REACTS.includes(msg.e)) fsSpawnReact(msg.e);
    if (msg.type === "fs-gif" && msg.url) fsSpawnGif(msg.url);
  });

  // Crunchyroll swaps the player out on episode changes, so keep looking.
  timers.push(setInterval(attach, 1000));
  timers.push(setInterval(tick, 1000));
  attach();
})();
