// Otaku Sync — toolbar popup. Diagnoses the tab, opens the on-page panel.

const status = document.getElementById("status");
const FALLBACK_WHATSAPP = "+918660095124";

function strong(text) {
  const s = document.createElement("strong");
  s.textContent = text;
  return s;
}

function show(parts, ...buttons) {
  status.replaceChildren();
  const p = document.createElement("p");
  p.append(...parts);
  status.appendChild(p);
  for (const b of buttons) if (b) status.appendChild(b);
}

function button(label, onClick, cls) {
  const b = document.createElement("button");
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}

async function supportNumber() {
  try {
    const { configCache } = await chrome.storage.local.get("configCache");
    const n = configCache && configCache.config && configCache.config.support_whatsapp;
    return n || FALLBACK_WHATSAPP;
  } catch (_) {
    return FALLBACK_WHATSAPP;
  }
}

async function supportButton() {
  const num = (await supportNumber()).replace(/[^\d]/g, "");
  return button(
    "Support on WhatsApp",
    () =>
      chrome.tabs.create({
        url: `https://wa.me/${num}?text=${encodeURIComponent("Hi, I need help with Otaku Sync.")}`,
      }),
    "wa"
  );
}

async function main() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = (tab && tab.url) || "";

  if (!url.includes("crunchyroll.com")) {
    show(
      [
        "This tab isn't Crunchyroll. Open an episode on ",
        strong("crunchyroll.com"),
        " — the party panel appears on the page itself, bottom-right.",
      ],
      await supportButton()
    );
    return;
  }

  try {
    await chrome.tabs.sendMessage(
      tab.id,
      { channel: "otaku-sync", type: "show-panel" },
      { frameId: 0 }
    );
    window.close();
  } catch (_) {
    show(
      [
        "This tab was open before the extension loaded. Refresh it and the panel appears in the ",
        strong("bottom-right corner of the page"),
        ".",
      ],
      button("Refresh this tab", async () => {
        await chrome.tabs.reload(tab.id);
        window.close();
      }),
      await supportButton()
    );
  }
}

main();
