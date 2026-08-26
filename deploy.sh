#!/usr/bin/env bash
# Crunchy Party — one-shot setup for a fresh RackNerd Ubuntu VPS (22.04/24.04).
#
#   sudo bash deploy.sh api.yourdomain.com
#
# Before running: point an A record for that hostname at this server's IP and
# wait for it to resolve, or the TLS certificate step will fail.

set -euo pipefail

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "Usage: sudo bash deploy.sh api.yourdomain.com"
  exit 1
fi

APP_DIR=/opt/crunchy-party/server
SERVICE=crunchy-party

echo "==> Checking DNS for $DOMAIN"
RESOLVED=$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1 || true)
MYIP=$(curl -s --max-time 10 https://api.ipify.org || echo "?")
echo "    $DOMAIN -> ${RESOLVED:-nothing}   this server -> $MYIP"
if [[ -z "$RESOLVED" ]]; then
  echo "!!  $DOMAIN does not resolve yet. Add the A record and re-run."
  exit 1
fi
if [[ "$RESOLVED" != "$MYIP" && "$MYIP" != "?" ]]; then
  echo "!!  Warning: DNS points elsewhere. Certificate issuance will fail."
  read -rp "    Continue anyway? [y/N] " ok
  [[ "$ok" == "y" ]] || exit 1
fi

echo "==> Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg sqlite3 ufw build-essential

if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]]; then
  echo "==> Installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y -qq nodejs
fi
echo "    node $(node -v)"

if ! command -v caddy >/dev/null; then
  echo "==> Installing Caddy (TLS + WebSocket proxy)"
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy
fi

echo "==> Installing app to $APP_DIR"
mkdir -p "$APP_DIR"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -r "$SRC_DIR"/*.js "$SRC_DIR"/package.json "$APP_DIR"/
[[ -f "$APP_DIR/.env" ]] || cp "$SRC_DIR/.env.example" "$APP_DIR/.env"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

id -u crunchy >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin crunchy
chown -R crunchy:crunchy "$APP_DIR"
chmod 600 "$APP_DIR/.env"

if grep -q "change-me" "$APP_DIR/.env"; then
  echo "==> Generating JWT_SECRET"
  SECRET=$(openssl rand -hex 48)
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$SECRET|" "$APP_DIR/.env"
fi

echo "==> Writing systemd unit"
cat > /etc/systemd/system/$SERVICE.service <<UNIT
[Unit]
Description=Crunchy Party API and room relay
After=network.target

[Service]
Type=simple
User=crunchy
Group=crunchy
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=3
# Keep the event loop responsive under load
Nice=-5
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT

echo "==> Writing Caddyfile"
cat > /etc/caddy/Caddyfile <<CADDY
$DOMAIN {
	encode zstd gzip

	# WebSocket upgrades pass through untouched and uncompressed.
	@ws {
		header Connection *Upgrade*
		header Upgrade websocket
	}
	handle @ws {
		reverse_proxy 127.0.0.1:8080 {
			flush_interval -1
		}
	}

	handle {
		reverse_proxy 127.0.0.1:8080
	}
}
CADDY

echo "==> Firewall"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null || true

echo "==> Starting services"
systemctl daemon-reload
systemctl enable --now $SERVICE
systemctl restart caddy
sleep 3

echo "==> Health check"
curl -fsS "https://$DOMAIN/health" && echo || {
  echo "!!  Health check failed. Look at:"
  echo "    journalctl -u $SERVICE -n 50 --no-pager"
  echo "    journalctl -u caddy -n 30 --no-pager"
  exit 1
}

cat <<DONE

Done.

  API   https://$DOMAIN
  WS    wss://$DOMAIN/ws
  Logs  journalctl -u $SERVICE -f

Next:
  1. nano $APP_DIR/.env    (Razorpay keys, SMS provider)
     systemctl restart $SERVICE
  2. Update config.json in your GitHub repo:
       "api": "https://$DOMAIN",
       "ws":  "wss://$DOMAIN/ws"
  3. Razorpay webhook URL: https://$DOMAIN/billing/webhook
DONE
