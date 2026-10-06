#!/usr/bin/env bash
# Installs (or removes) the proxy as a systemd service that starts on boot and
# restarts automatically if it crashes.
#
#   sudo ./scripts/install-service.sh              # install or update the code, then (re)start
#   sudo ./scripts/install-service.sh --uninstall  # stop + remove service and code (keeps /etc config)
#
# Layout (the config survives code updates; re-running this script never overwrites it):
#   /opt/foundry-release-proxy/           code (replaced on every run)
#   /etc/foundry-release-proxy/config.json  module id -> repo mapping
#   /etc/foundry-release-proxy/env          GITHUB_TOKEN, PORT, ... (chmod 600, owned by the service user)
#
# Logs:    journalctl -u foundry-release-proxy -f
# Control: sudo systemctl {start|stop|restart|status} foundry-release-proxy
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-foundry-release-proxy}"
SERVICE_USER="${SERVICE_USER:-foundry-proxy}"
APP_DIR="${APP_DIR:-/opt/${SERVICE_NAME}}"
CONF_DIR="${CONF_DIR:-/etc/${SERVICE_NAME}}"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
    echo "Please run with sudo: sudo $0 $*" >&2
    exit 1
fi

if [[ "${1:-}" == "--uninstall" ]]; then
    systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$UNIT_FILE"
    rm -rf "$APP_DIR"
    systemctl daemon-reload
    echo "Removed $SERVICE_NAME and $APP_DIR."
    echo "Kept $CONF_DIR (config and token) and the '$SERVICE_USER' user; delete them by hand if wanted."
    exit 0
fi

NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
    echo "node not found in PATH. Install Node.js (>= 18) or run: sudo NODE_BIN=/path/to/node $0" >&2
    exit 1
fi
NODE_BIN="$(readlink -f "$NODE_BIN")"
if [[ "$NODE_BIN" == /home/* || "$NODE_BIN" == /root/* ]]; then
    echo "Node at $NODE_BIN is inside a home directory (nvm?) which the service user cannot use." >&2
    echo "Install a system-wide Node.js (e.g. NodeSource or apt) or set NODE_BIN to one." >&2
    exit 1
fi

# Dedicated unprivileged user.
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    echo "Created system user $SERVICE_USER."
fi

# Code: replaced on each run so updating = pull + re-run this script.
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR"
cp -r "$SRC_DIR/src" "$SRC_DIR/package.json" "$APP_DIR/"
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

# Config + env: created once, never overwritten.
install -d -m 750 -o root -g "$SERVICE_USER" "$CONF_DIR"
if [[ ! -f "$CONF_DIR/config.json" ]]; then
    install -m 640 -o root -g "$SERVICE_USER" "$SRC_DIR/config.example.json" "$CONF_DIR/config.json"
    echo "Wrote example config $CONF_DIR/config.json - edit it to list your modules."
fi
if [[ ! -f "$CONF_DIR/env" ]]; then
    token="REPLACE_ME"
    if [[ -t 0 ]]; then
        read -rsp "GitHub token (fine-grained, Contents: read-only; Enter to fill in later): " input || true
        echo
        [[ -n "${input:-}" ]] && token="$input"
    fi
    umask 077
    {
        echo "GITHUB_TOKEN=${token}"
        echo "CONFIG_FILE=${CONF_DIR}/config.json"
        echo "HOST=127.0.0.1"
        echo "PORT=8787"
        echo "PUBLIC_BASE_URL=http://localhost:8787"
    } > "$CONF_DIR/env"
    echo "Wrote $CONF_DIR/env."
fi
chown "$SERVICE_USER:$SERVICE_USER" "$CONF_DIR/env"
chmod 600 "$CONF_DIR/env"

cat > "$UNIT_FILE" <<UNIT
[Unit]
Description=Foundry VTT private-release proxy
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
EnvironmentFile=${CONF_DIR}/env
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/src/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
if grep -q '^GITHUB_TOKEN=REPLACE_ME' "$CONF_DIR/env"; then
    echo "Service enabled but NOT started: put your token in $CONF_DIR/env, then run:"
    echo "  sudo systemctl restart $SERVICE_NAME"
else
    systemctl restart "$SERVICE_NAME"
    echo "Installed $UNIT_FILE (user: $SERVICE_USER, code: $APP_DIR, config: $CONF_DIR)."
fi
echo "Status:  systemctl status $SERVICE_NAME"
echo "Logs:    journalctl -u $SERVICE_NAME -f"
