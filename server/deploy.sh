#!/usr/bin/env bash
# Otaku Sync — one-shot setup for a RackNerd (or any Ubuntu 22.04/24.04) VPS.
#
#   sudo bash deploy.sh api.yourdomain.com [admin.yourdomain.com]
#
# Installs Node, Caddy (HTTPS), the API + room relay, and the admin panel.
# Both run as systemd services, so they survive reboots and SSH disconnects.
#
# Before running: point A records for those hostnames at this server's IP.
# The admin hostname is optional — without it the panel is still installed,
# but stays on localhost and is reached through an SSH tunnel:
#   ssh -L 3310:127.0.0.1:3310 root@YOUR_SERVER

set -euo pipefail

API_DOMAIN="${1:-}"
ADMIN_DOMAIN="${2:-}"
if [[ -z "$API_DOMAIN" ]]; then
  echo "Usage: sudo bash deploy.sh api.yourdomain.com [admin.yourdomain.com]"
  exit 1
fi

APP_DIR=/opt/otaku-sync/server
SERVICE=otaku-sync
ADMIN_SERVICE=otaku-admin
RUN_USER=otakusync

check_dns() {
  local name="$1"
  local resolved
  resolved=$(getent hosts "$name" | awk '{print $1}' | head -1 || true)
  echo "    $name -> ${resolved:-nothing}"
  if [[ -z "$resolved" ]]; then
    echo "!!  $name does not resolve. Add the A record and re-run."
    exit 1
  fi
  if [[ -n "$MYIP" && "$MYIP" != "?" && "$resolved" != "$MYIP" ]]; then
    echo "!!  Warning: $name points elsewhere. Certificate issuance will fail."
    read -rp "    Continue anyway? [y/N] " ok
    [[ "$ok" == "y" ]] || exit 1
  fi
}

echo "==> Checking DNS"
MYIP=$(curl -s --max-time 10 https://api.ipify.org || echo "?")
echo "    this server -> $MYIP"
check_dns "$API_DOMAIN"
[[ -n "$ADMIN_DOMAIN" ]] && check_dns "$ADMIN_DOMAIN"

echo "==> Installing packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg sqlite3 ufw build-essential openssl

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
[[ -d "$SRC_DIR/public" ]] && cp -r "$SRC_DIR/public" "$APP_DIR"/
[[ -f "$APP_DIR/.env" ]] || cp "$SRC_DIR/.env.example" "$APP_DIR/.env"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund

id -u "$RUN_USER" >/dev/null 2>&1 || \
  useradd --system --no-create-home --shell /usr/sbin/nologin "$RUN_USER"
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"
chmod 600 "$APP_DIR/.env"

# --- secrets and settings the app needs, filled in only if missing ----------

set_env() {  # set_env KEY VALUE  (adds, or replaces a blank/placeholder value)
  local key="$1" val="$2"
  if grep -qE "^${key}=.+" "$APP_DIR/.env"; then
    return  # already has a real value, leave it alone
  fi
  if grep -qE "^${key}=" "$APP_DIR/.env"; then
    sed -i "s|^${key}=.*|${key}=${val}|" "$APP_DIR/.env"
  else
    echo "${key}=${val}" >> "$APP_DIR/.env"
  fi
}

if grep -q "^JWT_SECRET=change-me" "$APP_DIR/.env" 2>/dev/null; then
  sed -i "s|^JWT_SECRET=.*|JWT_SECRET=$(openssl rand -hex 48)|" "$APP_DIR/.env"
fi
set_env JWT_SECRET "$(openssl rand -hex 48)"
set_env PUBLIC_URL "https://$API_DOMAIN"
set_env ADMIN_PORT "3310"
set_env ADMIN_BIND "127.0.0.1"
set_env ADMIN_USER "yogesh"

# Never leave the shipped default password on a reachable panel.
ADMIN_PASS_GENERATED=""
if ! grep -qE "^ADMIN_PASS=.+" "$APP_DIR/.env" || grep -q "^ADMIN_PASS=pass@shreya" "$APP_DIR/.env"; then
  ADMIN_PASS_GENERATED=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
  if grep -qE "^ADMIN_PASS=" "$APP_DIR/.env"; then
    sed -i "s|^ADMIN_PASS=.*|ADMIN_PASS=${ADMIN_PASS_GENERATED}|" "$APP_DIR/.env"
  else
    echo "ADMIN_PASS=${ADMIN_PASS_GENERATED}" >> "$APP_DIR/.env"
  fi
fi

# PUBLIC_URL may be stale if the domain changed between deploys.
sed -i "s|^PUBLIC_URL=.*|PUBLIC_URL=https://$API_DOMAIN|" "$APP_DIR/.env"
chown "$RUN_USER:$RUN_USER" "$APP_DIR/.env"

echo "==> Writing systemd units"
write_unit() {  # write_unit NAME DESCRIPTION ENTRYPOINT
  cat > "/etc/systemd/system/$1.service" <<UNIT
[Unit]
Description=$2
After=network.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=/usr/bin/node $3
Restart=always
RestartSec=3
Nice=-5
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
UNIT
}

write_unit "$SERVICE" "Otaku Sync API and room relay" "index.js"
write_unit "$ADMIN_SERVICE" "Otaku Sync admin panel" "admin.js"

echo "==> Writing Caddyfile"
{
  cat <<CADDY
$API_DOMAIN {
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

  if [[ -n "$ADMIN_DOMAIN" ]]; then
    cat <<CADDY

$ADMIN_DOMAIN {
	reverse_proxy 127.0.0.1:3310
}
CADDY
  fi
} > /etc/caddy/Caddyfile

echo "==> Firewall"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
# 8080 and 3310 stay closed: Caddy reaches them over localhost.
ufw --force enable >/dev/null || true

echo "==> Starting services"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl enable "$ADMIN_SERVICE" >/dev/null
# restart, not just "enable --now": an already-running service would otherwise
# keep serving the old code even though new files are on disk.
systemctl restart "$SERVICE"
systemctl restart "$ADMIN_SERVICE"
systemctl restart caddy
sleep 4

echo "==> Health check"
if ! curl -fsS "https://$API_DOMAIN/health"; then
  echo
  echo "!!  Health check failed. Look at:"
  echo "    journalctl -u $SERVICE -n 50 --no-pager"
  echo "    journalctl -u caddy -n 30 --no-pager"
  exit 1
fi
echo

if [[ -n "$ADMIN_DOMAIN" ]]; then
  ADMIN_LINE="https://$ADMIN_DOMAIN"
else
  ADMIN_LINE="http://127.0.0.1:3310  (ssh -L 3310:127.0.0.1:3310 root@$MYIP)"
fi

cat <<DONE

Done.

  API     https://$API_DOMAIN
  WS      wss://$API_DOMAIN/ws
  Admin   $ADMIN_LINE

  Logs    journalctl -u $SERVICE -f
          journalctl -u $ADMIN_SERVICE -f
DONE

if [[ -n "$ADMIN_PASS_GENERATED" ]]; then
  cat <<PASS

  ------------------------------------------------------------------
  Admin password generated (shown once — save it now):

      user: $(grep '^ADMIN_USER=' "$APP_DIR/.env" | cut -d= -f2-)
      pass: $ADMIN_PASS_GENERATED

  It is stored in $APP_DIR/.env
  ------------------------------------------------------------------
PASS
fi

cat <<NEXT

Next:
  1. nano $APP_DIR/.env    (Razorpay keys, Google client, mail provider)
     systemctl restart $SERVICE $ADMIN_SERVICE
  2. config.json in GitHub:
       "api": "https://$API_DOMAIN",
       "ws":  "wss://$API_DOMAIN/ws"
  3. Razorpay webhook: https://$API_DOMAIN/billing/webhook
  4. Back up the database on a cron:
     0 3 * * * sqlite3 $APP_DIR/data.sqlite ".backup '/root/otaku-\$(date +\%F).sqlite'"
NEXT
