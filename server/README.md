# Otaku Sync — server deployment

Node 18+ on your Rackners VM. SQLite, no external database.

## 1. A domain is not optional

The extension runs on `https://www.crunchyroll.com`, so it can only talk to
`https://` and `wss://` endpoints. Browsers reject plain `ws://` from an HTTPS
page, and Let's Encrypt does not issue certificates for bare IP addresses.

So: buy a cheap domain, point an `A` record at your Rackners IP, and use that
name everywhere. When the IP changes you update **one DNS record** and every
installed extension follows automatically — no GitHub config edit, no user
action. (The GitHub config file still earns its keep: notices, maintenance
mode, and moving to an entirely different host.)

## 2. Install

```bash
sudo apt update && sudo apt install -y nodejs npm
cd /opt && sudo git clone <your repo> otaku-sync && cd otaku-sync/server
npm install
cp .env.example .env && nano .env        # fill in every value
node index.js                            # smoke test, then Ctrl+C
```

## 3. Run it as a service

`/etc/systemd/system/otaku-sync.service`:

```ini
[Unit]
Description=Otaku Sync API
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/otaku-sync/server
EnvironmentFile=/opt/otaku-sync/server/.env
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now otaku-sync
sudo systemctl status otaku-sync
```

## 4. TLS + WebSocket proxy

Caddy is the shortest path — it obtains and renews certificates itself and
proxies WebSockets with no extra configuration. `/etc/caddy/Caddyfile`:

```
api.YOURDOMAIN.com {
    reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo apt install -y caddy && sudo systemctl reload caddy
curl https://api.YOURDOMAIN.com/health     # {"ok":true,...}
```

Open ports 80 and 443 in the Rackners firewall; keep 8080 closed to the world.

## 5. Razorpay

1. Complete KYC, then **Settings → API Keys** → put the key id and secret in `.env`.
2. **Subscriptions → Plans** → create a monthly INR 5 plan → paste the plan id
   (`plan_...`) into `RAZORPAY_PLAN_ID`.
3. **Settings → Webhooks** → add `https://api.YOURDOMAIN.com/billing/webhook`,
   set a secret (same value into `RAZORPAY_WEBHOOK_SECRET`), and subscribe to
   the `subscription.*` events (activated, charged, halted, cancelled).
4. International cards need **International Payments** enabled on your account
   — a separate approval with its own documentation, not on by default.

The secret never leaves this server. The extension only ever opens the hosted
checkout URL the server returns.

## 6. SMS

Start with `SMS_PROVIDER=console` (codes print to `journalctl -u otaku-sync`).
For production use MSG91 for Indian numbers, Twilio for international ones.
Both need a registered sender/template before they'll deliver.

## API surface

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/otp/start` | – | Send a code (rate limited per phone and IP) |
| POST | `/auth/otp/verify` | – | Exchange the code for a 180-day token |
| GET | `/me` | Bearer | Entitlement status |
| POST | `/billing/subscribe` | Bearer | Create subscription, return checkout URL |
| POST | `/billing/refresh` | Bearer | Pull status from Razorpay right now |
| POST | `/billing/cancel` | Bearer | Cancel at cycle end |
| POST | `/billing/webhook` | signature | Razorpay events |
| GET | `/health` | – | Uptime check |
| WS | `/ws?token=…&room=123456` | token | Room relay, max 2 peers |

## Notes

- Back up `data.sqlite` (it holds users and entitlements):
  `sqlite3 data.sqlite ".backup '/root/backup-$(date +%F).sqlite'"` on a cron.
- The relay never inspects sync or chat payloads; it forwards them between the
  two sockets in a room. Webcam video does **not** pass through the server —
  that stays peer-to-peer over WebRTC, with this server only carrying the
  signalling. Bandwidth per party stays in the kilobytes.
- Trials are keyed to a phone number, so a new number gets a new trial. If that
  becomes a problem, add a device/IP heuristic later.
