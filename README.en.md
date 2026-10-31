<div align="center">

# Minimal Remote · dsh-mini-remote

<p align="center">
  <img src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/promo.webp" alt="Minimal Remote: view instructions, conclusions, and execution details on your phone when you need them" width="720" />
</p>

**Bring DeepSeek Harness to your phone, and to another computer.**

[![npm](https://img.shields.io/npm/v/dsh-mini-remote)](https://www.npmjs.com/package/dsh-mini-remote)
[![Node.js](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen)](https://nodejs.org/)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.2%20%3C0.3.0-blue)](https://github.com/deepseek-ai/DeepSeek-Harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.en.md) · [简体中文](README.md)

</div>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#ai-setup-guide">AI Setup</a> ·
  <a href="#connection-routes">Connection Routes</a> ·
  <a href="#core-capabilities">Core Capabilities</a> ·
  <a href="#settings">Settings</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#security-boundaries">Security Boundaries</a> ·
  <a href="#documentation">Documentation</a>
</p>

---

## What It Is

Minimal Remote is a plugin for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/DeepSeek-Harness). It solves three problems:

- **Phone control**: view sessions, send instructions, answer questions, and handle approvals in a phone browser without squeezing the full desktop interface onto a small screen.
- **Remote Window**: open this computer's complete DSH interface inside another computer's DSH desktop.
- **A/B cross-computer work**: A keeps the session and model, and uses `b_*` tools to read or write files and run commands on B. B decides locally which directories, writes, folder operations, and commands are allowed.

Connection routes range from LAN and Tailscale to fixed addresses and self-hosted relays. If network setup is unfamiliar, the built-in AI guide can walk you through it. This document corresponds to the current `0.2.6` checkout.

---

## Quick Start

### Requirements

- **Node.js**: `^22.19.0 || >=24.0.0`
- **DSH**: `>=0.1.5-rc.2 <0.3.0`
- **Operating system**: Windows, macOS, or Linux

This version was checked on DSH `0.2.1-rc.5` and includes the `getOrigin()` port fallback for rc.5. See [CHANGELOG.md](CHANGELOG.md) for release history.

### Installation

#### Option 1: DSH desktop UI (recommended)

1. Click **Plugins** in the DSH top navigation bar to open the plugin manager.
2. Click **Add Plugin** in the upper-right corner.
3. Enter the package name `dsh-mini-remote`. You can also enter the GitHub repository `github:xingzhen199186/dsh-mini-remote` or a local directory path. Keep the default **npm official registry**.
4. Click **Install** at the bottom of the dialog.

> **Notice**
> 1. **Verify the source.** Plugins run with the current user's full privileges. A plugin from an untrusted source can damage DSH or read and leak sensitive data.
> 2. **No automatic updates.** Installed plugins do not update automatically. Uninstall the current version before installing a new one.

#### Option 2: Official npm registry (command line)

Run the following command in a terminal. `web` is the default DSH profile; replace it when using a custom profile:

```powershell
dsh plugin --profile web add dsh-mini-remote
```

#### Option 3: Install directly from GitHub

```powershell
dsh plugin --profile web add github:xingzhen199186/dsh-mini-remote
```

#### Option 4: Local directory (developer testing)

```powershell
dsh plugin --profile web add C:\path\to\dsh-mini-remote
```

### Start and Confirm the Service

1. Restart the DSH service: close the current `dsh web` window and start it again.
2. Check the console for initialization output, the listening port, and the access token:

   ```text
   [dsh-mini-remote] 已启动：http://127.0.0.1:3090/mini?token=xxxxxxxxxxxx
   ```

3. Open the DSH desktop UI and go to **Settings** → **Remote Settings** to see the pairing QR codes and connection details.

> **The phone client is a web page only.** Scan the code and open it in a browser; there is no standalone app or mini-program. You can add it to the home screen; it opens full-screen from the icon but still runs in the browser. Changing phones or clearing browser data requires pairing again.
>
> The same address also works in a PC browser. After enabling **Advanced Settings**, the complete DSH desktop interface is available there as well.
>
> **How to confirm startup:** **Remote Settings** shows a title, connection addresses, and QR codes, and the console prints a line beginning with `[dsh-mini-remote] 已启动`. If the console is ready but the settings page is empty, refresh or restart DSH, then check **Diagnostics & Advanced** → **Self-check**.

### Connect a Phone

1. Open DSH **Settings** → **Remote Settings**. The **Phone Connection** section at the top is always visible.
2. If the phone and computer are on the same Wi-Fi, scan the **LAN** QR code.
3. If you are not sure which route to use, click **Let AI guide me** at the top and follow the prompts.
4. The phone page opens the session list, and the phone appears under **Computers & Devices** on the computer: the connection is working.

> **The address is a credential.** The QR code and copied address contain an entry passphrase. Anyone who holds them can enroll a device and operate this computer. Do not send screenshots, project the page, or paste the address in public. After a device is revoked, scan again.

---

## Preview

<div align="center">
  <img width="240" alt="Phone chat view (dark): history arranged as bubbles" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/screen-chat-dark.png" />
  <img width="240" alt="Phone chat view (light): the same conversation history as bubbles in the light theme" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/screen-chat-light.png" />
</div>

<div align="center">
  <img width="240" alt="Phone full view: tool calls and conversation in chronological order" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/screen-full-dark.png" />
</div>

<div align="center">
  <img width="680" alt="Remote Window: the complete interface embedded in another computer's DSH panel" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/remote-window.png" />
</div>

---

## AI Setup Guide

The plugin package already contains the `dsh-mini-remote-setup` skill and the [docs/guide/](docs/guide/) knowledge base. **No separate skill installation is needed.**

1. In **Remote Settings**, click **Let AI guide me** at the top. The plugin opens a new session and fills in the setup prompt; the guide starts after you press Send.
2. You can also say **“Help me set up phone control”** in any session, or describe a concrete problem such as **“My phone cannot connect”** or **“I need a fixed address.”**
3. The guide first calls the read-only `mini_remote_status` tool to inspect ports, addresses, tunnels, and relay states. It then picks a route and **asks one question at a time**.
4. Each step tells you where to click and what you should see afterwards. If the current environment cannot open a new session, the button copies the prompt so you can paste it into a new session.

It covers phone connection and passphrases, every connection route, computers and devices, A/B collaboration, B projects, Feishu, self-check and advanced settings, Remote Window, and configuration timing.

The guide prefers the version-matched local `docs/guide/`; it falls back to the GitHub repository only when local documentation is unavailable.

**Safety boundaries:** it does not read or repeat passphrases, tokens, frp tokens, or device credentials; it does not restart DSH; it does not delete devices, revoke tenants, or delete server resources; and it does not modify Cloudflare, firewalls, DNS, or domain records. High-risk actions are described as steps for you to confirm.

---

## Connection Routes

Pick one route that works before adding a fixed address. Use LAN when the phone and computer share a Wi-Fi network; for other cases, choose based on whether you can install a client and whether you need a fixed address.

| Route | Best for | Requirements and trade-offs | Details |
| :--- | :--- | :--- | :--- |
| **LAN** | Same Wi-Fi network | No extra dependency; plain HTTP; stops working when you leave the network | [01-LAN](docs/guide/01-内网.md) |
| **Tailscale** | Remote use with a client installed | Both devices sign in to the same account; optional HTTPS depends on MagicDNS | [02-Tailscale](docs/guide/02-Tailscale.md) |
| **Cloudflare public** | Temporary access, or a fixed address with your own domain | Temporary address changes after each restart; a fixed address needs a Cloudflare account and domain; traffic goes through Cloudflare | [03-Public Tunnel](docs/guide/03-公网隧道.md) |
| **Shared fixed address** | A fixed URL without running a server | Requires a quick tunnel and a provider invite code; traffic goes through a shared relay and is not end-to-end encrypted | [04-Shared Fixed Address](docs/guide/04-共享固定地址.md) |
| **Dedicated fixed address (B relay)** | A provider assigns a fixed domain or enables self-service | One-time activation code; the provider creates a named tunnel; stopping does not delete server resources | [05-Dedicated Fixed Address](docs/guide/05-专属固定地址.md) |
| **Self-hosted relay (single user)** | You have your own server and domain | Two domains and an frp token; fixed address; you maintain the server and certificate | [06-Self-hosted Relay](docs/guide/06-自建中继.md) |
| **Self-hosted multi-user relay** | Several people each need access | An administrator deploys `relay-multi` and issues invite tickets; traffic goes only through that server | [07-Multi-user Relay](docs/guide/07-自建多用户中继.md) |
| **Feishu** | Control through enterprise IM only | Configure a Feishu custom app; no inbound public port; currently text and approvals in direct messages | [13-Feishu](docs/guide/13-飞书通知.md) |

> “B relay” means the provider's B control plane, not the B computer in A/B collaboration. See [00-Choose a Route](docs/guide/00-先选一条路.md) for the full decision logic.

---

## Core Capabilities

- **Phone page**: Single frame, Chat, and Full views; queueing, slash commands, question cards, approvals, and session management. See [09-Phone Connection and Passphrase](docs/guide/09-手机连接与密码.md).
- **Remote Window**: Open this computer's complete DSH interface inside another computer's DSH desktop. See [15-Remote Window](docs/guide/15-远程窗口.md).
- **A/B collaboration**: A uses `b_*` tools on B; B controls directories, writes, folder operations, and command permission locally. Re-pairing reuses the existing record via `machine-id`. See [11-A/B Collaboration](docs/guide/11-A-B端协作.md).
- **B projects**: Register a real B directory as an A workspace without copying files; includes a B file panel and **New B Session**. See [12-B Projects](docs/guide/12-B项目.md).
- **Bidirectional Feishu**: Text, question, and approval replies over the long connection. See [13-Feishu](docs/guide/13-飞书通知.md).
- **Device management**: Phones and computers are registered separately; rename, revoke, or clean up records unused for 30 days. Revoked devices must scan again. See [10-Computers and Devices](docs/guide/10-电脑与设备.md).

---

## Settings

**Phone Connection** at the top is always visible. The five groups below are collapsed by default, and so are their inner sections (for example, each route under **Connection & Fixed Addresses**).

| Area | Main contents |
| :--- | :--- |
| **Phone Connection** | Addresses, QR codes, passphrase |
| **Connection & Fixed Addresses** | Tailscale, public access, shared fixed, dedicated fixed, self-hosted relay, multi-user relay, Tailscale HTTPS |
| **Computers & Devices** | Allow other computers, device list, other computers |
| **A/B Collaboration** | As A, as B, B projects |
| **Notifications & Integrations** | Feishu, credentials, allowlists, setup guide |
| **Diagnostics & Advanced** | Self-check, recent errors |

All copy actions use the same short **Copied** feedback. The multi-user relay's **Clear local configuration** removes only this computer's identity and frpc configuration; it does not release the server tenant or fixed address. An administrator must reclaim those in the backend. For full settings details, see [14-Self-check and Advanced Settings](docs/guide/14-自检与进阶设置.md) and [16-Parameters and Timing](docs/guide/16-参数与生效方式.md).

---

## Troubleshooting

| Symptom | Check first |
| :--- | :--- |
| B says it is not connected to A | Wait for one 5-second refresh cycle, then press `Ctrl+F5`; if it still fails, check A's address, switches, and port |
| Remote Window returns HTTP 502 | On A, run `tailscale serve status`; the proxy should target the current phone-service port, normally `3090`, not the old `3091` |
| A fixed address or relay will not connect | Check the status, whether the invite ticket or activation code was already used, and whether the server resource still exists |
| The phone page is inaccessible after revocation | The device authorization was removed; scan again from **Remote Settings** |

`tailscale serve status` should show a target similar to:

```text
https://<machine>.<tailnet>.ts.net
  -> http://127.0.0.1:3090
```

If `3090` is occupied, use the listening port shown under **Diagnostics & Advanced** → **Self-check**. To reconfigure, turn **Tailscale HTTPS** off and on again under **Connection & Fixed Addresses**.

See [08-When It Will Not Connect](docs/guide/08-连不上怎么办.md) for the full symptom table and checks.

---

## Security Boundaries

- **Addresses and devices**: the address contains an entry passphrase; revoked devices must scan again. Do not publish QR codes, passphrases, or addresses containing the passphrase.
- **Public and third-party routes**: Cloudflare, the shared fixed relay, and the dedicated B relay send traffic through a third party; a changing temporary hostname is not a security boundary. Self-hosted and multi-user relays also let the server operator see plaintext.
- **Plugin permissions**: the plugin runs with the current user's privileges. Install only packages from trusted sources; an untrusted plugin can read files or leak credentials.
- **Full interface**: **Advanced Settings** and Remote Window expose the complete DSH management plane, including model configuration, credentials, plugins, and session history. Enable them only for trusted devices.
- **Command execution**: phone **Full access** and B-side command permission can run system commands. The model-level `confirm` is not a human approval; the real boundary is the local permission switch.
- **Resource cleanup**: stopping a connection or clearing local configuration does not delete server resources. Fixed addresses, tenants, and tunnels must be reclaimed according to the relevant guide.
- **Public deployment**: this plugin does not promise a secure public deployment. Assess the network, access control, and host security before enabling public or third-party relay access.

---

## Development & Verification

```bash
npm test
node client/verify.mjs
```

- `npm test`: offline tests; DSH does not need to be running. Currently **1293 passed, 0 failed**.
- `node client/verify.mjs`: verifies the client module, settings page, two-level collapsing, Remote Window, and B project panel. Currently **162 passed, 0 failed**.
- Run `npm pack --dry-run` before release to inspect the package contents.

See [CHANGELOG.md](CHANGELOG.md) for detailed changes and [docs/发版清单.md](docs/发版清单.md) for the release checklist.

---

## Documentation

- **Full guide**: [docs/guide/](docs/guide/) (00–16). Connection, passphrases, devices, A/B, B projects, Feishu, self-check, Remote Window, and parameters are all here.
- **AI guide**: [SKILL.md](SKILL.md).
- **Self-hosted relay server**: [relay-server/README.md](relay-server/README.md).
- **Multi-user relay server**: [relay-multi/README.md](relay-multi/README.md).
- **Project home**: [github.com/xingzhen199186/dsh-mini-remote](https://github.com/xingzhen199186/dsh-mini-remote).
- **Issues**: [GitHub Issues](https://github.com/xingzhen199186/dsh-mini-remote/issues).

---

## License

This project is released under the [MIT License](LICENSE).

### Acknowledgements

The multi-route QR-code approach was inspired by [dsh-pocket](https://www.npmjs.com/package/dsh-pocket) by @shaobeichen.
