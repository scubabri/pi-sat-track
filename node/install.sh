#!/usr/bin/env bash
# install-node-web.sh
# Installs nginx + Node.js LTS on Raspberry Pi OS and configures
# nginx as a reverse proxy to a Node app listening on localhost:3000.
#
# Intended for the planned Node.js version of Pi Sat Track
# (browser UI on :3000, nginx on :80).
#
# Usage:
#   chmod +x install-node-web.sh
#   sudo ./install-node-web.sh
#
# After running:
#   - Put your Node app in /opt/sat-tracker (or change APP_DIR below)
#   - npm install && npm start   (or use pm2 / systemd)
#   - Browse to http://<pi-ip>/

set -euo pipefail

# ---------- configuration ----------
NODE_MAJOR=22                    # NodeSource LTS line (22.x)
APP_DIR="/opt/sat-tracker"       # where the Node app will live
NGINX_SITE="sat-tracker"         # sites-available / sites-enabled name
PROXY_PORT=3000                  # Node listens here
# -----------------------------------

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root:  sudo $0"
  exit 1
fi

echo "==> Updating package lists"
apt-get update -qq

echo "==> Installing nginx and common build tools"
apt-get install -y --no-install-recommends \
  nginx \
  curl \
  ca-certificates \
  gnupg \
  build-essential \
  python3

# ---------- Node.js via NodeSource ----------
if ! command -v node >/dev/null 2>&1 || \
   [[ $(node -v 2>/dev/null | cut -d. -f1 | tr -d v) -lt $NODE_MAJOR ]]; then
  echo "==> Installing Node.js ${NODE_MAJOR}.x LTS (NodeSource)"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
else
  echo "==> Node.js already present: $(node -v)"
fi

echo "    node  $(node -v)"
echo "    npm   $(npm -v)"

# ---------- directory for the app ----------
echo "==> Creating application directory ${APP_DIR}"
mkdir -p "${APP_DIR}"
chown "${SUDO_USER:-pi}:${SUDO_USER:-pi}" "${APP_DIR}"

# ---------- nginx reverse-proxy site ----------
echo "==> Writing nginx site config: /etc/nginx/sites-available/${NGINX_SITE}"

cat > "/etc/nginx/sites-available/${NGINX_SITE}" <<EOF
# Pi Sat Track – Node UI reverse proxy
# Node app is expected to listen on 127.0.0.1:${PROXY_PORT}

server {
    listen 80 default_server;
    listen [::]:80 default_server;

    server_name _;

    # Optional: serve static assets directly if you later put them here
    # root ${APP_DIR}/public;
    # index index.html;

    location / {
        proxy_pass         http://127.0.0.1:${PROXY_PORT};
        proxy_http_version 1.1;

        # WebSocket support (needed if the UI uses ws)
        proxy_set_header   Upgrade \$http_upgrade;
        proxy_set_header   Connection "upgrade";

        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;

        # Reasonable timeouts for long-lived connections
        proxy_read_timeout  86400;
        proxy_send_timeout  86400;
    }

    # Deny access to hidden files
    location ~ /\. {
        deny all;
    }
}
EOF

# Enable the site and disable the stock default if it exists
echo "==> Enabling site ${NGINX_SITE}"
ln -sf "/etc/nginx/sites-available/${NGINX_SITE}" \
       "/etc/nginx/sites-enabled/${NGINX_SITE}"

if [[ -e /etc/nginx/sites-enabled/default ]]; then
  rm -f /etc/nginx/sites-enabled/default
fi

# Test and reload
echo "==> Testing nginx configuration"
nginx -t

echo "==> Reloading nginx"
systemctl enable nginx
systemctl reload nginx

# ---------- summary ----------
cat <<EOF

============================================================
  Installation complete
============================================================

  nginx          : listening on port 80
  Node.js        : \$(node -v)  (npm \$(npm -v))
  App directory  : ${APP_DIR}
  Proxy target   : http://127.0.0.1:${PROXY_PORT}

Next steps:

  1. Place the Node.js application in ${APP_DIR}
       (package.json, server.js / index.js, etc.)

  2. Install dependencies and start it, for example:

       cd ${APP_DIR}
       npm install
       # development:
       npm start
       # or production with pm2:
       #   sudo npm install -g pm2
       #   pm2 start server.js --name sat-tracker
       #   pm2 save && pm2 startup

  3. Open a browser to:
       http://\$(hostname -I | awk '{print \$1}')/

  The nginx config already includes the Upgrade headers
  required for WebSocket connections from the browser UI.

EOF
