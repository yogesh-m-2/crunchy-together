# Crunchy Party

Watch Crunchyroll in sync with a friend — shared play, pause and seek, plus
chat, emoji, GIFs, reactions and webcam. Phone-number sign-in, 7-day free
trial, then a monthly subscription through Razorpay.

```
crunchy-party/
├── extension/    Chrome extension (MV3)
├── server/       Node API + WebSocket relay for your Rackners VM
└── config/       config.json to publish on GitHub
```

## How the pieces talk

```
Extension ──(https)──> raw.githubusercontent.com/…/config.json   endpoints, notices
Extension ──(https)──> api.YOURDOMAIN.com          auth, billing, entitlement
Extension ──(wss)───-> api.YOURDOMAIN.com/ws       room relay: sync, chat, acks
Extension <──(WebRTC)─> other extension            webcam video only, peer-to-peer
Razorpay  ──(https)──> api.YOURDOMAIN.com/billing/webhook
```

Sync messages are tiny JSON objects, so a party costs a few KB per minute of
your bandwidth. Webcam video never touches the server.

## Setup order

1. **Domain + server** — `server/README.md`. Do this first; nothing works
   without a reachable `https://` endpoint.
2. **Publish the config** — put `config/config.json` in a public GitHub repo,
   open the *Raw* view, copy that URL into `CONFIG_URL` at the top of
   `extension/background.js`. Set `api`, `ws` and `fallbacks` to your domain.
3. **Point the extension at your server** — replace `api.YOURDOMAIN.com` in
   `extension/manifest.json` (`host_permissions`), `extension/net.js` and
   `extension/background.js`.
4. **Load it** — `chrome://extensions` → Developer mode → Load unpacked →
   `extension/`. Sign in with your phone; with `SMS_PROVIDER=console` the code
   appears in the server log.

## What changed from the P2P version

| Then | Now |
| --- | --- |
| PeerJS public broker | Your own WebSocket relay |
| Anonymous | Phone + OTP, 180-day token |
| Free | 7-day trial, then ₹5/month via Razorpay |
| Fixed endpoints | Fetched from GitHub, cached, with fallbacks |
| — | WhatsApp support surfaced on every failure screen |

Playback sync keeps everything the P2P version learned: sequence-numbered
actions, acknowledgements with real video-state verification, retries,
supersede-on-newer, drift heartbeats, join-time state sync, and episode
auto-follow.

## Before you publish to the Chrome Web Store

- **Privacy policy is mandatory** — you collect phone numbers. It must be a
  public URL, and the listing must disclose what you collect and why.
- **Name and branding.** "Crunchy" plus a Crunchyroll-shaped logo invites both
  a Web Store rejection and a trademark complaint from Sony. A neutral name
  ("Watch Party for Anime", "Sync Party") is the safer listing. Nothing stops
  you saying "works with Crunchyroll" in the description.
- **Single purpose** — the listing should describe one job: synced watching.
- **Justify each permission** in the review notes; `storage` is for the login
  token, host permissions for the sync endpoint and GIF search.
- Subscriptions are your own (Razorpay), which is allowed — the Web Store's own
  payments system was retired years ago.

## Economics worth checking before launch

At ₹5/month, per paying user per month:

| Item | Rough cost |
| --- | --- |
| Razorpay fee (~2% + GST, per charge) | ₹0.10–0.30 |
| SMS OTP (one per sign-in, MSG91) | ₹0.15–0.25 |
| Server share (₹500 VM ÷ N users) | falls as you grow |

Recurring ₹5 mandates also sit near the awkward end of what card networks and
UPI AutoPay like to process, and each renewal carries the fixed fee again.
Two adjustments that keep the price friendly but the maths comfortable:
charge annually (₹49–99/year, one fee instead of twelve), or keep ₹5/month but
require a longer first commitment. Worth deciding before you have paying users,
since changing a live price is much harder than setting it.
