# Foundry release proxy

[![Latest release](https://img.shields.io/github/v/release/dxcufgb/FoundryVTT-Private-Github-proxy?label=release&color=ff6400)](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/dxcufgb/FoundryVTT-Private-Github-proxy/total?label=downloads&color=blue)](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/releases)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-support-FF5E5B?logo=kofi&logoColor=white)](https://ko-fi.com/dxcufgb)\
[![CI](https://img.shields.io/github/actions/workflow/status/dxcufgb/FoundryVTT-Private-Github-proxy/ci.yml?branch=main&label=CI)](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/actions/workflows/ci.yml)
[![License](https://img.shields.io/github/license/dxcufgb/FoundryVTT-Private-Github-proxy)](LICENSE)

<a href="https://dxcufgb.github.io/FVTT-dev-showcase/"><img src="https://dxcufgb.github.io/FVTT-dev-showcase/assets/img/workshop-badge.png" alt="Dxcufgb's Workshop: every Foundry VTT project, video and changelog in one place" width="650"></a>

A tiny HTTP proxy that lets a self-hosted **Foundry VTT** server install and update modules whose releases live in
**private GitHub repositories**. Foundry cannot authenticate to GitHub, so the proxy holds a read-only token, serves
the module manifest, and passes the zip through from a short-lived GitHub URL with the module's own `module.json`
pointed at the proxy, so that Foundry's update checks come back to it. Node.js only, no npm dependencies. Runs as a systemd service on Linux (e.g. a Raspberry Pi) or as a
scheduled task on Windows, and can optionally keep itself up to date from this repository's releases (and e-mail you
when it did). A password-protected **administration page** (`/_admin/`) lists the modules, adds, edits and deletes them,
copies a module's link for Foundry, and manages the notification e-mail addresses.

## Installation

Linux (including a Raspberry Pi):

```bash
curl -fsSL https://raw.githubusercontent.com/dxcufgb/install/main/install.sh | sudo bash -s foundry-release-proxy
```

Windows: download and run `foundry-release-proxy-setup.exe` from the
[latest release](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/releases/latest).

Create the GitHub token first, and see the wiki for everything else: [Create the GitHub Token](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Create-the-GitHub-Token),
[Install on Linux](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Install-on-Linux), [Install on Windows](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Install-on-Windows),
[Foundry in Docker](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Foundry-in-Docker).

## Documentation

The full guide is in the [wiki](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki):

- [Create the GitHub Token](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Create-the-GitHub-Token): a fine-grained, read-only token, and rotating it
- [Install on Linux](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Install-on-Linux): installer options, unattended install, updating and removing
- [Install on Windows](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Install-on-Windows): setup wizard, silent install, PowerShell install
- [Foundry in Docker](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Foundry-in-Docker): host networking or the Docker bridge address
- [Install a Module in Foundry](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Install-a-Module-in-Foundry): the manifest URL, and how zips are patched for updates
- [Adding Another Private Module](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Adding-Another-Private-Module): on the admin page or by hand
- [Admin Page](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Admin-Page): modules, GitHub token, notifications, password, security
- [Admin Page in Your Browser](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Admin-Page-in-Your-Browser), [Trusting the Certificate](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Trusting-the-Certificate)
  and [Admin Page on a Public Address](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Admin-Page-on-a-Public-Address): the admin page from other computers
- [Notifications and Daily Check](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Notifications-and-Daily-Check): e-mails about setup problems and updates
- [Automatic Updates](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Automatic-Updates): opt-in daily updates, the updater's token, **Update now**
- [How the Proxy Works](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/How-the-Proxy-Works): every request and its result
- [Configuration Reference](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Configuration-Reference): `config.json`, `env` and the environment variables
- [Troubleshooting](https://github.com/dxcufgb/FoundryVTT-Private-Github-proxy/wiki/Troubleshooting)

## License

[MIT](LICENSE), Copyright (c) 2026 Dxcufgb.
