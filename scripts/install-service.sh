#!/usr/bin/env bash
# Installs (or removes) the proxy as a systemd service that starts on boot and
# restarts automatically if it crashes. ./install.sh at the top of the repository / release archive is the entry
# point (it also sets up Node.js) and passes its options on to this script; both accept the options below.
#
#   sudo ./scripts/install-service.sh                       # install or update the code, then (re)start
#   sudo ./scripts/install-service.sh --auto-update         # same, and turn on automatic updates
#   sudo ./scripts/install-service.sh --enable-auto-update  # turn automatic updates on for an existing install
#   sudo ./scripts/install-service.sh --disable-auto-update # turn them off again
#   sudo ./scripts/install-service.sh --check-update        # is a newer release available? (report only; also --check)
#   sudo ./scripts/install-service.sh --update-now          # install the latest release now
#   sudo ./scripts/install-service.sh --uninstall [--purge] # stop + remove service, updater and code (--purge: also config)
#   sudo ./scripts/install-service.sh --module ID=OWNER/REPO  # first install: put this module in config.json (repeatable)
#   sudo ./scripts/install-service.sh --set-admin-password  # (re)set the password of the administration page
#   sudo ./scripts/install-service.sh --set-notify          # (re)enter the update-notification e-mail settings
#   sudo ./scripts/install-service.sh --admin-web           # admin page in the browser on https://<host>:8788/
#   sudo ./scripts/install-service.sh --no-admin-web        # admin page only on this machine again
#
# Layout (the config survives code updates; re-running this script never overwrites it):
#   /opt/foundry-release-proxy/                   code (replaced on every run)
#   /opt/foundry-release-proxy.prev/              previous code, kept by the updater for rollback
#   /etc/foundry-release-proxy/config.json        module id -> repo mapping (600, owned by the service user, which
#                                                 rewrites it when modules are changed on the administration page)
#   /etc/foundry-release-proxy/admin.json         admin page password hash + notification e-mail settings (600, owned
#                                                 by the service user)
#   /etc/foundry-release-proxy/env                GITHUB_TOKEN, PORT, ... (chmod 600, owned by the service user)
#   /etc/foundry-release-proxy/admin-tls.crt/.key self-signed certificate of the admin port (root:service user, 644/640)
#   /etc/foundry-release-proxy/auto-update.conf   auto-update on/off and which token it uses (root, 600)
#   /etc/foundry-release-proxy/updater-token      only if the updater has its own token (root, 600)
#
# Automatic updates are off unless asked for. The tokens are taken from a prompt or from the environment
# (FOUNDRY_PROXY_GITHUB_TOKEN for the proxy, UPDATER_GITHUB_TOKEN for the updater, INSTALL_GITHUB_TOKEN from the
# one-line installer as a candidate updater token), never from the command line. The same goes for the admin page
# password (FOUNDRY_PROXY_ADMIN_PASSWORD) and the SMTP password (FOUNDRY_PROXY_SMTP_PASSWORD).
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

# Print the option list (common set first, then this installer's own options).
print_usage() {
    cat <<'USAGE'
Usage: sudo ./install.sh [options]      (or: sudo ./scripts/install-service.sh [options])

  (no options)             install or upgrade in place, interactive (asks for what it needs)
  --yes, -y                non-interactive: no questions; missing required settings -> clear error
  --auto-update            turn automatic updates on as part of this install
  --no-auto-update         turn automatic updates off as part of this install
  --enable-auto-update     turn automatic updates on for an existing install, nothing else
  --disable-auto-update    turn automatic updates off for an existing install, nothing else
  --check-update           only check: exit 0 = up to date, 10 = newer release available, other = error
                           (75 = could not check now: another update run holds the lock)
  --update-now             install the latest release now (same path as the daily updater)
  --uninstall [--purge]    remove (keep / also delete settings and data)
  --help, -h               this list

Options of this installer:
  --module ID=OWNER/REPO   first install: put this module in config.json (repeatable)
  --install-node           (install.sh) download the official Node.js 22 without asking if none is usable
  --no-install-node        (install.sh) never download Node.js
  --check                  same as --check-update
  --upgrade                non-interactive re-install that keeps every setting (used by the updater)
  --set-admin-password     (re)set the password of the administration page (http://localhost:8787/_admin/)
  --set-notify             (re)enter the e-mail settings for update notifications (also editable on the admin page)
  --admin-web              serve the admin page to browsers on other computers: https://<this host>:8788/ (port:
                           FOUNDRY_PROXY_ADMIN_PORT; public address: FOUNDRY_PROXY_ADMIN_PUBLIC_URL)
  --no-admin-web           serve the admin page only on this machine again (http://localhost:8787/_admin/)
  --renew-admin-cert       make a new self-signed certificate for the admin port

Environment (tokens are never taken as arguments and never logged):
  FOUNDRY_PROXY_GITHUB_TOKEN  the proxy's token (Contents: read-only on the module repositories);
                              needed with --yes on a first install
  UPDATER_GITHUB_TOKEN        a separate token for the updater (Contents: read-only on this repository)
  INSTALL_GITHUB_TOKEN        set by the one-line installer; stored as the updater token when automatic updates
                              are turned on (asked first when interactive)
  FOUNDRY_PROXY_ADMIN_PASSWORD  password of the administration page (at least 8 characters; first install or
                              --set-admin-password; without one the page stays off)
  FOUNDRY_PROXY_NOTIFY_EMAILS   update-notification recipients, comma separated (first install or --set-notify)
  FOUNDRY_PROXY_SMTP_HOST, FOUNDRY_PROXY_SMTP_PORT, FOUNDRY_PROXY_SMTP_SECURITY (starttls|tls|none),
  FOUNDRY_PROXY_SMTP_USER, FOUNDRY_PROXY_SMTP_PASSWORD, FOUNDRY_PROXY_SMTP_FROM
                              the mail server for those e-mails
  FOUNDRY_PROXY_ADMIN_WEB       yes = first install: serve the admin page to other computers (like --admin-web)
  FOUNDRY_PROXY_ADMIN_PORT      port of that browser admin page (default 8788)
  FOUNDRY_PROXY_ADMIN_PUBLIC_URL  the address it is reached at from outside, e.g. https://proxy.example.com:8788
  NODE_BIN                    the node binary to use
USAGE
}

# Print the option list to stderr and exit with status 2 (bad usage).
usage() {
    print_usage >&2
    exit 2
}

orig_args=("$@")
action=install
auto_update=""     # yes/no when asked for on the command line, empty = keep the current choice
upgrade=no         # --upgrade: non-interactive, used by the updater
assume_yes=no      # --yes: non-interactive, missing required settings are an error
purge=no           # --purge (with --uninstall): also delete the settings and the service user
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
        --yes | -y) assume_yes=yes ;;
        --enable-auto-update) action=enable ;;
        --disable-auto-update) action=disable ;;
        --check | --check-update) action=check ;;
        --update-now) action=update ;;
        --uninstall) action=uninstall ;;
        --set-admin-password) action=admin-password ;;
        --set-notify) action=notify ;;
        --admin-web) action=admin-web ;;
        --no-admin-web) action=no-admin-web ;;
        --renew-admin-cert) action=renew-cert ;;
        --purge) purge=yes ;;
        -h | --help) print_usage; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; usage ;;
    esac
done
if [[ "$purge" == yes && "$action" != uninstall ]]; then
    echo "--purge only goes with --uninstall" >&2
    usage
fi

if [[ $EUID -ne 0 ]]; then
    echo "Please run with sudo: sudo $0 ${orig_args[*]}" >&2
    exit 1
fi

# Return success only for a terminal session outside an unattended upgrade or --yes.
interactive() { [[ "$upgrade" == no && "$assume_yes" == no && -t 0 ]]; }

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
    if [[ "$purge" == yes ]]; then
        rm -rf "$CONF_DIR"
        if id "$SERVICE_USER" >/dev/null 2>&1; then userdel "$SERVICE_USER" 2>/dev/null || true; fi
        echo "Purged $CONF_DIR (config and token) and the '$SERVICE_USER' user."
    else
        echo "Kept $CONF_DIR (config and token) and the '$SERVICE_USER' user; add --purge to delete them too."
    fi
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
    export SERVICE_NAME SERVICE_USER APP_DIR CONF_DIR NODE_BIN
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

# Asks for the updater's token on the terminal and prints it, or prints nothing for "use the proxy's GITHUB_TOKEN".
# An EOF or read error never yields a token: it means "use the proxy's GITHUB_TOKEN".
ask_updater_token() {
    local answer="" token=""
    echo "The updater needs a GitHub token that can read releases of $UPDATE_REPO." >&2
    echo "The proxy's own GITHUB_TOKEN works if you also give it Contents: read-only on that repository." >&2
    read -rp "Use the proxy's GITHUB_TOKEN from $CONF_DIR/env? [Y/n] " answer || return 0
    if [[ "$answer" =~ ^[Nn] ]]; then
        if read -rsp "Updater token (fine-grained, Contents: read-only on $UPDATE_REPO): " token; then
            printf '%s' "$token"
        fi
        echo >&2
    fi
}

# Chooses the updater's token: UPDATER_GITHUB_TOKEN, the token already configured, INSTALL_GITHUB_TOKEN (the one the
# one-line installer downloaded this release with; asked first when interactive, and only an explicit answer other
# than "n" stores it: an EOF stores nothing and asks nothing more), a prompt, or the proxy's own GITHUB_TOKEN from env.
choose_updater_token() {
    local current token="" answer=""
    current="$(setting TOKEN_FILE)"
    if [[ -n "${UPDATER_GITHUB_TOKEN:-}" ]]; then
        token="$UPDATER_GITHUB_TOKEN"
    elif [[ -n "$current" && -f "$current" ]]; then
        echo "$current"
        return
    elif [[ -n "${INSTALL_GITHUB_TOKEN:-}" ]] && ! interactive; then
        token="$INSTALL_GITHUB_TOKEN"
    elif [[ -n "${INSTALL_GITHUB_TOKEN:-}" ]]; then
        if read -rp "Use the GitHub token this release was downloaded with for automatic updates? [Y/n] " answer; then
            if [[ "$answer" =~ ^[Nn] ]]; then
                token="$(ask_updater_token)"
            else
                token="$INSTALL_GITHUB_TOKEN"
            fi
        fi
    elif interactive; then
        token="$(ask_updater_token)"
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
Environment=SERVICE_NAME=${SERVICE_NAME} SERVICE_USER=${SERVICE_USER} APP_DIR=${APP_DIR} CONF_DIR=${CONF_DIR} NODE_BIN=${NODE_BIN}
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
        if [[ $rc -eq 75 ]]; then
            echo "Another update run is in progress; check later with: sudo $APP_DIR/scripts/install-service.sh --check-update" >&2
        elif [[ $rc -ne 0 && $rc -ne 10 ]]; then
            echo "Warning: the update check failed; make sure the token in $token_file can read $UPDATE_REPO." >&2
            echo "Try it with: sudo $APP_DIR/scripts/install-service.sh --check-update" >&2
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

# Asks for a new admin page password (twice, hidden) and prints it; prints nothing for "no password".
ask_admin_password() {
    local pw="" again=""
    while true; do
        read -rsp "Password for the administration page (at least 8 characters; Enter = page off): " pw || pw=""
        echo >&2
        [[ -z "$pw" ]] && return 0
        if [[ ${#pw} -lt 8 ]]; then
            echo "Too short; use at least 8 characters." >&2
            continue
        fi
        read -rsp "Repeat the password: " again || again=""
        echo >&2
        if [[ "$pw" == "$again" ]]; then
            printf '%s' "$pw"
            return 0
        fi
        echo "The passwords do not match; try again." >&2
    done
}

# Asks for the notification e-mail settings and exports them as FOUNDRY_PROXY_* variables for src/admin.js setup.
ask_notify() {
    local value=""
    echo "The proxy can e-mail you when it has updated itself or an automatic update failed." >&2
    read -rp "E-mail addresses for these notifications (comma separated; Enter = none): " value || value=""
    [[ -z "$value" ]] && return 0
    export FOUNDRY_PROXY_NOTIFY_EMAILS="$value"
    read -rp "SMTP server (e.g. smtp.gmail.com): " value || value=""
    export FOUNDRY_PROXY_SMTP_HOST="$value"
    read -rp "SMTP security, starttls / tls / none [starttls]: " value || value=""
    export FOUNDRY_PROXY_SMTP_SECURITY="${value:-starttls}"
    local port=587
    [[ "$FOUNDRY_PROXY_SMTP_SECURITY" == tls ]] && port=465
    [[ "$FOUNDRY_PROXY_SMTP_SECURITY" == none ]] && port=25
    read -rp "SMTP port [$port]: " value || value=""
    export FOUNDRY_PROXY_SMTP_PORT="${value:-$port}"
    read -rp "SMTP user name (Enter = no login): " value || value=""
    export FOUNDRY_PROXY_SMTP_USER="$value"
    if [[ -n "$value" ]]; then
        read -rsp "SMTP password: " value || value=""
        echo >&2
        export FOUNDRY_PROXY_SMTP_PASSWORD="$value"
    fi
    read -rp "Sender address (From): " value || value=""
    export FOUNDRY_PROXY_SMTP_FROM="$value"
}

# Creates or updates admin.json through src/admin.js (secrets go through the environment only), owned by the service
# user with mode 600. $1: first = new file (asks for everything when interactive), password / notify = change that part.
configure_admin() {
    local what="$1" file="$CONF_DIR/admin.json" pw=""
    if interactive; then
        if [[ "$what" != notify && -z "${FOUNDRY_PROXY_ADMIN_PASSWORD:-}" ]]; then
            pw="$(ask_admin_password)"
            [[ -n "$pw" ]] && export FOUNDRY_PROXY_ADMIN_PASSWORD="$pw"
        fi
        if [[ "$what" != password && -z "${FOUNDRY_PROXY_NOTIFY_EMAILS:-}" ]]; then ask_notify; fi
    fi
    if [[ "$what" == password && -z "${FOUNDRY_PROXY_ADMIN_PASSWORD:-}" ]]; then
        echo "No password given (set FOUNDRY_PROXY_ADMIN_PASSWORD or run this in a terminal); nothing changed." >&2
        exit 1
    fi
    if [[ "$what" == password ]]; then
        # only the password: notification variables from the caller's environment stay out
        unset FOUNDRY_PROXY_NOTIFY_EMAILS FOUNDRY_PROXY_SMTP_HOST FOUNDRY_PROXY_SMTP_PORT FOUNDRY_PROXY_SMTP_SECURITY \
            FOUNDRY_PROXY_SMTP_USER FOUNDRY_PROXY_SMTP_PASSWORD FOUNDRY_PROXY_SMTP_FROM
    elif [[ "$what" == notify ]]; then
        unset FOUNDRY_PROXY_ADMIN_PASSWORD
    fi
    (umask 077 && "$NODE_BIN" "$SRC_DIR/src/admin.js" setup "$file")
    chown "$SERVICE_USER:$SERVICE_USER" "$file"
    chmod 600 "$file"
    unset FOUNDRY_PROXY_ADMIN_PASSWORD FOUNDRY_PROXY_SMTP_PASSWORD
}

ADMIN_CERT="$CONF_DIR/admin-tls.crt"
ADMIN_KEY="$CONF_DIR/admin-tls.key"

# Value of KEY in the env file (the last line wins; empty when not set). Read as text, never sourced.
env_value() {
    [[ -f "$CONF_DIR/env" ]] || return 0
    sed -n "s/^$1=//p" "$CONF_DIR/env" | tail -n 1
}

# Set KEY=VALUE in the env file, or remove KEY when VALUE is empty; the file stays 600 and owned by the service user.
set_env_value() {
    local key="$1" value="$2" tmp
    tmp="$(mktemp "$CONF_DIR/.env.XXXXXX")"
    grep -v "^${key}=" "$CONF_DIR/env" > "$tmp" || true
    if [[ -n "$value" ]]; then printf '%s=%s\n' "$key" "$value" >> "$tmp"; fi
    chown "$SERVICE_USER:$SERVICE_USER" "$tmp"
    chmod 600 "$tmp"
    mv -f "$tmp" "$CONF_DIR/env"
}

# Succeeds when admin.json holds a password (the admin page is on).
admin_on() { "$NODE_BIN" "$SRC_DIR/src/admin.js" check "$CONF_DIR/admin.json" >/dev/null 2>&1; }

# Self-signed certificate for the admin port (made once; $1 = force makes a new one). root-owned, so the service
# reads it but cannot change it.
make_admin_cert() {
    if [[ -f "$ADMIN_CERT" && -f "$ADMIN_KEY" && "${1:-}" != force ]]; then return 0; fi
    local public host=""
    public="$(env_value ADMIN_PUBLIC_URL)"
    if [[ -n "$public" ]]; then
        host="$("$NODE_BIN" -e 'console.log(new URL(process.argv[1]).hostname)' "$public" 2>/dev/null || true)"
    fi
    (umask 077 && "$NODE_BIN" "$SRC_DIR/src/selfsigned.js" "$ADMIN_CERT" "$ADMIN_KEY" ${host:+"$host"})
    chown "root:$SERVICE_USER" "$ADMIN_CERT" "$ADMIN_KEY"
    chmod 644 "$ADMIN_CERT"
    chmod 640 "$ADMIN_KEY"
}

# Serve the admin page to other computers: ADMIN_PORT (FOUNDRY_PROXY_ADMIN_PORT, the current one or 8788) on
# ADMIN_HOST (kept if set, else all addresses), HTTPS with the self-signed certificate unless ADMIN_TLS=off.
enable_admin_web() {
    local port proxy_port
    port="${FOUNDRY_PROXY_ADMIN_PORT:-$(env_value ADMIN_PORT)}"
    port="${port:-8788}"
    proxy_port="$(env_value PORT)"
    proxy_port="${proxy_port:-8787}"
    if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1 || port > 65535 )) || [[ "$port" == "$proxy_port" ]]; then
        echo "Invalid admin port '$port' (1-65535, not the proxy's port $proxy_port)." >&2
        exit 1
    fi
    if [[ -n "${FOUNDRY_PROXY_ADMIN_PUBLIC_URL:-}" ]]; then
        if ! "$NODE_BIN" -e 'new URL(process.argv[1])' "$FOUNDRY_PROXY_ADMIN_PUBLIC_URL" 2>/dev/null; then
            echo "FOUNDRY_PROXY_ADMIN_PUBLIC_URL is not a URL: $FOUNDRY_PROXY_ADMIN_PUBLIC_URL" >&2
            exit 1
        fi
        set_env_value ADMIN_PUBLIC_URL "$FOUNDRY_PROXY_ADMIN_PUBLIC_URL"
    fi
    set_env_value ADMIN_PORT "$port"
    if [[ -z "$(env_value ADMIN_HOST)" ]]; then set_env_value ADMIN_HOST 0.0.0.0; fi
    if [[ ! "$(env_value ADMIN_TLS)" =~ ^(off|0|false|no)$ ]]; then make_admin_cert; fi
}

# The proxy's systemd unit. An admin port below 1024 (e.g. 443) gets CAP_NET_BIND_SERVICE and nothing else.
write_unit() {
    local caps="" admin_port
    admin_port="$(env_value ADMIN_PORT)"
    if [[ "$admin_port" =~ ^[0-9]+$ ]] && (( admin_port < 1024 )); then
        caps=$'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE'
    fi
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
# the admin page rewrites these two files (and nothing else under /etc)
ReadWritePaths=-${CONF_DIR}/config.json -${CONF_DIR}/admin.json
ProtectHome=true
PrivateTmp=true
${caps}

[Install]
WantedBy=multi-user.target
UNIT
}

# Where the admin page is, for the end of a run.
print_admin_info() {
    local port admin_port scheme public
    port="$(env_value PORT)"
    port="${port:-8787}"
    if ! admin_on; then
        echo "Admin:   page off; turn it on with: sudo $APP_DIR/scripts/install-service.sh --set-admin-password"
        return 0
    fi
    admin_port="$(env_value ADMIN_PORT)"
    if [[ -z "$admin_port" ]]; then
        echo "Admin:   http://localhost:$port/_admin/ (on this machine; for other computers: --admin-web)"
        return 0
    fi
    scheme=https
    if [[ "$(env_value ADMIN_TLS)" =~ ^(off|0|false|no)$ ]]; then scheme=http; fi
    echo "Admin:   $scheme://$(uname -n):$admin_port/ in a browser on any computer here, or:"
    for ip in $(hostname -I 2>/dev/null); do
        if [[ "$ip" == *:* ]]; then echo "         $scheme://[$ip]:$admin_port/"; else echo "         $scheme://$ip:$admin_port/"; fi
    done
    public="$(env_value ADMIN_PUBLIC_URL)"
    if [[ -n "$public" ]]; then echo "         $public (public address)"; fi
    if [[ "$scheme" == https && -f "$ADMIN_CERT" ]]; then
        echo "         self-signed certificate: the browser warns once; its SHA-256 fingerprint is"
        echo "         $("$NODE_BIN" -e 'console.log(new (require("crypto").X509Certificate)(require("fs").readFileSync(process.argv[1])).fingerprint256)' "$ADMIN_CERT")"
    fi
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
        echo "         the ufw firewall is on: allow the port with: sudo ufw allow $admin_port/tcp"
    fi
}

if [[ "$action" == admin-web || "$action" == no-admin-web || "$action" == renew-cert ]]; then
    if [[ ! -f "$APP_DIR/src/selfsigned.js" || ! -f "$CONF_DIR/env" ]]; then
        echo "The proxy is not installed (or too old for this); install it first: sudo $0" >&2
        exit 1
    fi
    SRC_DIR="$APP_DIR"
    case "$action" in
        admin-web) enable_admin_web ;;
        no-admin-web) set_env_value ADMIN_PORT "" ;;
        renew-cert) make_admin_cert force ;;
    esac
    write_unit
    systemctl daemon-reload
    systemctl restart "$SERVICE_NAME"
    echo "Restarted $SERVICE_NAME."
    if [[ "$action" == admin-web ]] && ! admin_on; then
        echo "Note: the admin page has no password yet; set one with: sudo $0 --set-admin-password" >&2
    fi
    print_admin_info
    exit 0
fi

if [[ "$action" == admin-password || "$action" == notify ]]; then
    if [[ ! -f "$APP_DIR/src/admin.js" || ! -f "$CONF_DIR/env" ]]; then
        echo "The proxy is not installed (or too old for the admin page); install it first: sudo $0" >&2
        exit 1
    fi
    SRC_DIR="$APP_DIR"
    if [[ "$action" == admin-password ]]; then configure_admin password; else configure_admin notify; fi
    systemctl restart "$SERVICE_NAME"
    echo "Restarted $SERVICE_NAME."
    exit 0
fi

# --yes: a first install needs the proxy's token from the environment; fail before anything is changed.
if [[ "$assume_yes" == yes && ! -f "$CONF_DIR/env" && -z "${FOUNDRY_PROXY_GITHUB_TOKEN:-}" ]]; then
    echo "--yes: no GitHub token for the proxy. Set FOUNDRY_PROXY_GITHUB_TOKEN (fine-grained, Contents: read-only on the" >&2
    echo "module repositories) and pass it through sudo: sudo --preserve-env=FOUNDRY_PROXY_GITHUB_TOKEN ..." >&2
    exit 1
fi

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
        install -m 600 -o "$SERVICE_USER" -g "$SERVICE_USER" "$config_tmp" "$CONF_DIR/config.json"
        rm -f "$config_tmp"
        echo "Wrote $CONF_DIR/config.json with: ${modules[*]}"
    else
        install -m 600 -o "$SERVICE_USER" -g "$SERVICE_USER" "$SRC_DIR/config.example.json" "$CONF_DIR/config.json"
        echo "Wrote example config $CONF_DIR/config.json - edit it to list your modules."
    fi
elif [[ ${#modules[@]} -gt 0 ]]; then
    echo "Keeping the existing $CONF_DIR/config.json; ignoring --module (add modules on the admin page)." >&2
fi
# The proxy rewrites config.json when modules are changed on the admin page (installs before 1.3.0 had it root-owned).
chown "$SERVICE_USER:$SERVICE_USER" "$CONF_DIR/config.json"
chmod 600 "$CONF_DIR/config.json"
# admin.json: created once (asks for the admin password and notification e-mails), never overwritten here.
admin_new=no
if [[ ! -f "$CONF_DIR/admin.json" ]]; then
    configure_admin first
    admin_new=yes
fi
chown "$SERVICE_USER:$SERVICE_USER" "$CONF_DIR/admin.json"
chmod 600 "$CONF_DIR/admin.json"
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

# A new admin page: offer it to the browsers of other computers (like Webmin), once.
if [[ "$admin_new" == yes && -z "$(env_value ADMIN_PORT)" ]] && admin_on; then
    web="${FOUNDRY_PROXY_ADMIN_WEB:-}"
    if [[ -z "$web" ]] && interactive; then
        read -rp "Open the admin page to browsers on other computers (https://$(uname -n):8788/, like Webmin)? [Y/n] " answer || answer=n
        if [[ "${answer:-}" =~ ^[Nn] ]]; then web=no; else web=yes; fi
    fi
    if [[ "$web" =~ ^(yes|1|true)$ ]]; then enable_admin_web; fi
fi
# The certificate of an admin port that was turned on by hand.
if [[ -n "$(env_value ADMIN_PORT)" && ! "$(env_value ADMIN_TLS)" =~ ^(off|0|false|no)$ ]]; then make_admin_cert; fi

write_unit

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
print_admin_info
