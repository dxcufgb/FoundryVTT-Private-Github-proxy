#!/usr/bin/env bash
# Installs (or removes) the proxy as a systemd service that starts on boot and
# restarts automatically if it crashes.
#
#   sudo ./scripts/install-service.sh                       # install or update the code, then (re)start
#   sudo ./scripts/install-service.sh --auto-update         # same, and turn on automatic updates
#   sudo ./scripts/install-service.sh --enable-auto-update  # turn automatic updates on for an existing install
#   sudo ./scripts/install-service.sh --disable-auto-update # turn them off again
#   sudo ./scripts/install-service.sh --check               # is a newer release available? (report only)
#   sudo ./scripts/install-service.sh --update-now          # install the latest release now
#   sudo ./scripts/install-service.sh --uninstall           # stop + remove service, updater and code (keeps /etc config)
#   sudo ./scripts/install-service.sh --module ID=OWNER/REPO  # first install: put this module in config.json (repeatable)
#
# Layout (the config survives code updates; re-running this script never overwrites it):
#   /opt/foundry-release-proxy/                   code (replaced on every run)
#   /opt/foundry-release-proxy.prev/              previous code, kept by the updater for rollback
#   /etc/foundry-release-proxy/config.json        module id -> repo mapping
#   /etc/foundry-release-proxy/env                GITHUB_TOKEN, PORT, ... (chmod 600, owned by the service user)
#   /etc/foundry-release-proxy/auto-update.conf   auto-update on/off and which token it uses (root, 600)
#   /etc/foundry-release-proxy/updater-token      only if the updater has its own token (root, 600)
#
# Automatic updates are off unless asked for. The tokens are taken from a prompt or from the environment
# (FOUNDRY_PROXY_GITHUB_TOKEN for the proxy, UPDATER_GITHUB_TOKEN for the updater), never from the command line.
# ./install.sh in the repository root wraps this script and also sets up Node.js when the system has none.
#
# Logs:    journalctl -u foundry-release-proxy -f      (updates: journalctl -u foundry-release-proxy-update)
# Control: sudo systemctl {start|stop|restart|status} foundry-release-proxy
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-foundry-release-proxy}"
SERVICE_USER="${SERVICE_USER:-foundry-proxy}"
APP_DIR="${APP_DIR:-/opt/${SERVICE_NAME}}"
CONF_DIR="${CONF_DIR:-/etc/${SERVICE_NAME}}"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
UPDATE_UNIT="/etc/systemd/system/${SERVICE_NAME}-update.service"
UPDATE_TIMER="/etc/systemd/system/${SERVICE_NAME}-update.timer"
AUTO_CONF="$CONF_DIR/auto-update.conf"
UPDATER_TOKEN_FILE="$CONF_DIR/updater-token"
UPDATE_REPO="dxcufgb/FoundryVTT-Private-Github-proxy"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Print command usage to stderr and exit with status 2.
usage() {
    sed -n '4,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
    exit 2
}

orig_args=("$@")
action=install
auto_update=""     # yes/no when asked for on the command line, empty = keep the current choice
upgrade=no         # --upgrade: non-interactive, used by the updater
modules=()         # ID=OWNER/REPO entries for a new config.json
while [[ $# -gt 0 ]]; do
    arg="$1"
    shift
    case "$arg" in
        --module)
            [[ $# -gt 0 ]] || { echo "--module needs ID=OWNER/REPO" >&2; usage; }
            modules+=("$1")
            shift
            ;;
        --auto-update) auto_update=yes ;;
        --no-auto-update) auto_update=no ;;
        --upgrade) upgrade=yes ;;
        --enable-auto-update) action=enable ;;
        --disable-auto-update) action=disable ;;
        --check) action=check ;;
        --update-now) action=update ;;
        --uninstall) action=uninstall ;;
        -h | --help) usage ;;
        *) echo "Unknown option: $arg" >&2; usage ;;
    esac
done

if [[ $EUID -ne 0 ]]; then
    echo "Please run with sudo: sudo $0 ${orig_args[*]}" >&2
    exit 1
fi

# Return success only for a terminal session outside an unattended upgrade.
interactive() { [[ "$upgrade" == no && -t 0 ]]; }

# KEY=value from auto-update.conf without sourcing it.
setting() {
    [[ -f "$AUTO_CONF" ]] || return 0
    sed -n "s/^$1=//p" "$AUTO_CONF" | tail -n 1
}

# Stop and disable the update timer, then remove its service and timer unit files.
remove_updater_units() {
    systemctl disable --now "${SERVICE_NAME}-update.timer" 2>/dev/null || true
    rm -f "$UPDATE_UNIT" "$UPDATE_TIMER"
}

if [[ "$action" == uninstall ]]; then
    remove_updater_units
    systemctl disable --now "$SERVICE_NAME" 2>/dev/null || true
    rm -f "$UNIT_FILE"
    rm -rf "$APP_DIR" "${APP_DIR}.prev"
    rm -f "$AUTO_CONF" "$UPDATER_TOKEN_FILE" "/run/lock/${SERVICE_NAME}-update.lock"
    systemctl daemon-reload
    echo "Removed $SERVICE_NAME, its updater and $APP_DIR."
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
BASH_BIN="$(readlink -f "$(command -v bash)")"

# Run the installed updater with mode $1 and the configured paths; return its exit status.
run_updater() {
    if [[ ! -f "$APP_DIR/scripts/auto-update.sh" ]]; then
        echo "$APP_DIR has no updater; install this version first: sudo $0" >&2
        exit 1
    fi
    local rc=0
    export SERVICE_NAME APP_DIR CONF_DIR NODE_BIN
    "$BASH_BIN" "$APP_DIR/scripts/auto-update.sh" "$1" || rc=$?
    return "$rc"
}

if [[ "$action" == check ]]; then
    rc=0
    run_updater --check || rc=$?
    exit "$rc"
fi
if [[ "$action" == update ]]; then
    run_updater --apply
    exit 0
fi

# Chooses the updater's token: UPDATER_GITHUB_TOKEN, a prompt, or the proxy's own GITHUB_TOKEN from env.
choose_updater_token() {
    local current token="" answer=""
    current="$(setting TOKEN_FILE)"
    if [[ -n "${UPDATER_GITHUB_TOKEN:-}" ]]; then
        token="$UPDATER_GITHUB_TOKEN"
    elif [[ -n "$current" && -f "$current" ]]; then
        echo "$current"
        return
    elif interactive; then
        echo "The updater needs a GitHub token that can read releases of $UPDATE_REPO." >&2
        echo "The proxy's own GITHUB_TOKEN works if you also give it Contents: read-only on that repository." >&2
        read -rp "Use the proxy's GITHUB_TOKEN from $CONF_DIR/env? [Y/n] " answer || true
        if [[ "$answer" =~ ^[Nn] ]]; then
            read -rsp "Updater token (fine-grained, Contents: read-only on $UPDATE_REPO): " token || true
            echo >&2
        fi
    fi
    if [[ -n "$token" ]]; then
        (umask 077 && printf '%s\n' "$token" > "$UPDATER_TOKEN_FILE")
        chown root:root "$UPDATER_TOKEN_FILE"
        chmod 600 "$UPDATER_TOKEN_FILE"
        echo "$UPDATER_TOKEN_FILE"
    else
        echo "$CONF_DIR/env"
    fi
}

# Persist enabled state $1 and token path $2 in a root-owned, mode-600 settings file.
write_auto_conf() {
    (umask 077 && printf 'AUTO_UPDATE=%s\nTOKEN_FILE=%s\n' "$1" "$2" > "$AUTO_CONF")
    chown root:root "$AUTO_CONF"
    chmod 600 "$AUTO_CONF"
}

# Write hardened daily update units, reload systemd and enable the update timer.
install_updater_units() {
    local parent
    parent="$(dirname "$APP_DIR")"
    cat > "$UPDATE_UNIT" <<UNIT
[Unit]
Description=Update ${SERVICE_NAME} from its latest GitHub release
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
Environment=SERVICE_NAME=${SERVICE_NAME} APP_DIR=${APP_DIR} CONF_DIR=${CONF_DIR} NODE_BIN=${NODE_BIN}
ExecStart=${BASH_BIN} ${APP_DIR}/scripts/auto-update.sh --apply
TimeoutStartSec=15min
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=${parent} ${CONF_DIR} /etc/systemd/system /run/lock
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
UNIT
    cat > "$UPDATE_TIMER" <<UNIT
[Unit]
Description=Daily update check for ${SERVICE_NAME}

[Timer]
OnCalendar=daily
RandomizedDelaySec=6h
Persistent=true

[Install]
WantedBy=timers.target
UNIT
    systemctl daemon-reload
    systemctl enable --now "${SERVICE_NAME}-update.timer" >/dev/null
}

# Save the token choice, enable daily updates and check access unless upgrading unattended.
enable_auto_update() {
    local token_file
    token_file="$(choose_updater_token)"
    write_auto_conf yes "$token_file"
    install_updater_units
    echo "Automatic updates on: daily check (randomized time) of $UPDATE_REPO, token from $token_file."
    if [[ "$upgrade" == no ]]; then
        local rc=0
        run_updater --check >/dev/null 2>&1 || rc=$?
        if [[ $rc -ne 0 && $rc -ne 10 ]]; then
            echo "Warning: the update check failed; make sure the token in $token_file can read $UPDATE_REPO." >&2
            echo "Try it with: sudo $0 --check" >&2
        fi
    fi
}

# Remove update units and the separate token, then persist the disabled state.
disable_auto_update() {
    remove_updater_units
    systemctl daemon-reload
    rm -f "$UPDATER_TOKEN_FILE"
    write_auto_conf no ""
    echo "Automatic updates off."
}

if [[ "$action" == enable || "$action" == disable ]]; then
    if [[ ! -f "$APP_DIR/src/updater.js" ]]; then
        echo "$APP_DIR is not installed (or too old for auto-update); run: sudo $0 --auto-update" >&2
        exit 1
    fi
    "${action}_auto_update"
    exit 0
fi

# Write a config.json for the ID=OWNER/REPO entries $2.. to file $1 and check it with the proxy's own validation.
write_modules_config() {
    local out="$1"
    shift
    "$NODE_BIN" -e '
        const fs = require("node:fs");
        const config = {};
        for (const entry of process.argv.slice(3)) {
            const i = entry.indexOf("=");
            if (i < 1) { console.error("--module needs ID=OWNER/REPO, got: " + entry); process.exit(1); }
            config[entry.slice(0, i)] = { repo: entry.slice(i + 1) };
        }
        const text = JSON.stringify(config, null, 2) + "\n";
        try { require(process.argv[1]).parseConfig(text, "--module"); }
        catch (err) { console.error(err.message); process.exit(1); }
        fs.writeFileSync(process.argv[2], text);
    ' "$SRC_DIR/src/server.js" "$out" "$@"
}

# Dedicated unprivileged user.
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
    echo "Created system user $SERVICE_USER."
fi

# Code: replaced on each run so updating = pull + re-run this script (or let the updater do it).
if [[ "$SRC_DIR" != "$(readlink -f "$APP_DIR" 2>/dev/null || echo "$APP_DIR")" ]]; then
    rm -rf "$APP_DIR"
    mkdir -p "$APP_DIR"
    cp -r "$SRC_DIR/src" "$SRC_DIR/scripts" "$SRC_DIR/package.json" "$APP_DIR/"
    for f in README.md config.example.json .env.example; do
        if [[ -f "$SRC_DIR/$f" ]]; then cp "$SRC_DIR/$f" "$APP_DIR/"; fi
    done
    chown -R root:root "$APP_DIR"
    chmod -R go-w "$APP_DIR"
fi

# Config + env: created once, never overwritten.
install -d -m 750 -o root -g "$SERVICE_USER" "$CONF_DIR"
if [[ ! -f "$CONF_DIR/config.json" ]]; then
    if [[ ${#modules[@]} -gt 0 ]]; then
        config_tmp="$(mktemp)"
        write_modules_config "$config_tmp" "${modules[@]}"
        install -m 640 -o root -g "$SERVICE_USER" "$config_tmp" "$CONF_DIR/config.json"
        rm -f "$config_tmp"
        echo "Wrote $CONF_DIR/config.json with: ${modules[*]}"
    else
        install -m 640 -o root -g "$SERVICE_USER" "$SRC_DIR/config.example.json" "$CONF_DIR/config.json"
        echo "Wrote example config $CONF_DIR/config.json - edit it to list your modules."
    fi
elif [[ ${#modules[@]} -gt 0 ]]; then
    echo "Keeping the existing $CONF_DIR/config.json; ignoring --module (edit the file to add modules)." >&2
fi
if [[ ! -f "$CONF_DIR/env" ]]; then
    token="REPLACE_ME"
    if [[ -n "${FOUNDRY_PROXY_GITHUB_TOKEN:-}" ]]; then
        token="$FOUNDRY_PROXY_GITHUB_TOKEN"
    elif interactive; then
        read -rsp "GitHub token (fine-grained, Contents: read-only; Enter to fill in later): " input || true
        echo
        [[ -n "${input:-}" ]] && token="$input"
    fi
    (
        umask 077
        {
            echo "GITHUB_TOKEN=${token}"
            echo "CONFIG_FILE=${CONF_DIR}/config.json"
            echo "HOST=127.0.0.1"
            echo "PORT=8787"
            echo "PUBLIC_BASE_URL=http://localhost:8787"
        } > "$CONF_DIR/env"
    )
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

# Automatic updates: the command line wins, then the saved choice, then (first install only) a prompt.
saved="$(setting AUTO_UPDATE)"
if [[ -z "$auto_update" ]]; then
    if [[ -n "$saved" ]]; then
        auto_update="$saved"
    elif interactive; then
        read -rp "Turn on automatic updates (daily check for new releases of this proxy)? [y/N] " answer || true
        if [[ "${answer:-}" =~ ^[Yy] ]]; then auto_update=yes; else auto_update=no; fi
    else
        auto_update=no
    fi
fi
if [[ "$auto_update" == yes ]]; then
    enable_auto_update
elif [[ "$saved" == yes || -f "$UPDATE_TIMER" ]]; then
    disable_auto_update
elif [[ -z "$saved" ]]; then
    write_auto_conf no ""
fi

echo "Status:  systemctl status $SERVICE_NAME"
echo "Logs:    journalctl -u $SERVICE_NAME -f"
