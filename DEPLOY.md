# Launch runbook

Follow top to bottom. Each step is verifiable before you move on.

## 1. Domain

Buy any cheap domain. Add an A record:

```
api.yourdomain.com   A   <your RackNerd IP>
```

Wait until `ping api.yourdomain.com` shows your IP. This is required — browsers
refuse `ws://` from an HTTPS page, and TLS certificates are not issued for bare
IP addresses. It also solves your changing-IP problem better than the GitHub
config does: change one DNS record and every installed extension follows.

## 2. Deploy to RackNerd

```bash
scp -r server root@<your-ip>:/root/otaku-server
ssh root@<your-ip>
cd /root/otaku-server
bash deploy.sh api.yourdomain.com admin.yourdomain.com
```

The second hostname is optional. Given one, the admin panel gets its own HTTPS
address; omit it and the panel stays on localhost, reached through a tunnel
(`ssh -L 3310:127.0.0.1:3310 root@<your-ip>`, then http://127.0.0.1:3310).

The script installs Node 20 and Caddy, sets up **two** services — `otaku-sync`
(API + room relay) and `otaku-admin` (database panel) — generates the JWT
secret, sets `PUBLIC_URL`, obtains TLS certificates, and health-checks itself.
Ports 8080 and 3310 stay closed to the internet; only Caddy reaches them.

On first run it generates a strong admin password and prints it **once** —
save it then. It is stored in `/opt/otaku-sync/server/.env`.

Verify:

```bash
curl https://api.yourdomain.com/health     # {"ok":true,...}
journalctl -u otaku-sync -f
journalctl -u otaku-admin -f
```

## 3. Secrets

```bash
nano /opt/otaku-sync/server/.env
systemctl restart otaku-sync
```

Fill in `RAZORPAY_KEY_SECRET`, `RAZORPAY_PLAN_ID`, `RAZORPAY_WEBHOOK_SECRET`.
Leave `SMS_PROVIDER=console` for now — login codes appear in the log, free.

## 4. Update your GitHub config

Edit `config.json` in `yogesh-m-2/crunchy-together` — only the first three
fields change:

```json
{
  "api": "https://api.yourdomain.com",
  "ws": "wss://api.yourdomain.com/ws",
  "fallbacks": [],
  "support_whatsapp": "+918660095124",
  "price_label": "₹5 / month",
  "trial_days": 7,
  "notice": null,
  "maintenance": false,
  "min_version": "3.0.0",
  "ice": [
    { "urls": "stun:stun.l.google.com:19302" },
    { "urls": "stun:stun1.l.google.com:19302" },
    { "urls": "stun:stun.cloudflare.com:3478" }
  ]
}
```

The extension already points at your raw URL. Extensions pick changes up within
15 minutes — that is your kill switch: set `maintenance: true` or write a
`notice` and every user sees it without an update.

## 5. Extension host permissions

In `extension/manifest.json`, replace both `YOURDOMAIN` entries with your real
domain. Chrome will not allow connections to a host that is not listed.

## 6. Publish the site

Push `site/` to a GitHub repo, then Settings → Pages → deploy from `main`.
You get `https://yogesh-m-2.github.io/<repo>/`. You need these URLs for both
Razorpay activation and the Chrome Web Store listing.

## 7. Razorpay

1. **Subscriptions → Plans** → monthly, INR 5 → copy the `plan_...` id into `.env`.
2. **Settings → Webhooks** → `https://api.yourdomain.com/billing/webhook`,
   secret of your choosing (same value into `.env`), events:
   `subscription.activated`, `subscription.charged`, `subscription.halted`,
   `subscription.cancelled`.
3. Test the whole flow with test cards while `rzp_test_*` keys are in place.
4. For live keys: complete KYC and submit your Pages URLs as website, privacy,
   terms and refund policy. International cards need **International Payments**
   enabled — a separate approval.

## 8. End-to-end test

1. Load `extension/` unpacked in Chrome.
2. Open an episode → panel appears → sign in with your phone → code shows in
   `journalctl -u otaku-sync -f`.
3. Start a party, open the invite link in a second browser profile signed in
   with a different number.
4. Pause on one side; confirm the other pauses within a second.
5. In the Razorpay test dashboard, confirm a subscription was created when you
   press Subscribe.

## Operating notes

```bash
systemctl status otaku-sync         # is it up
journalctl -u otaku-sync -f         # live logs
systemctl restart otaku-sync        # after .env changes
sqlite3 /opt/otaku-sync/server/data.sqlite "SELECT COUNT(*) FROM users;"
```

Back the database up on a cron — it holds every user and entitlement:

```bash
0 3 * * * sqlite3 /opt/otaku-sync/server/data.sqlite ".backup '/root/cp-$(date +\%F).sqlite'"
```
