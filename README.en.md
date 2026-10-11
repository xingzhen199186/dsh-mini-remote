<div align="center">

# Minimal Remote · dsh-mini-remote

<p align="center">
  <img src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/promo.webp" alt="Minimal Remote: the phone keeps your instruction and its conclusion, and shows you the process only when you ask for it" width="720" />
</p>

**A lightweight mobile remote plugin crafted for DeepSeek Harness (DSH) users, resolving screen clutter and process fatigue when checking Agent status and dispatching instructions away from the desk.**

[![npm](https://img.shields.io/npm/v/dsh-mini-remote)](https://www.npmjs.com/package/dsh-mini-remote)
[![Node.js](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen)](https://nodejs.org/)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.2%20%3C0.3.0-blue)](https://github.com/deepseek-ai/DeepSeek-Harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.en.md) · [简体中文](README.md)

</div>

<p align="center">
  <a href="#background--pain-points">Background & Pain Points</a> ·
  <a href="#core-features">Core Features</a> ·
  <a href="#ui-preview">UI Preview</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#usage--configuration">Usage & Configuration</a> ·
  <a href="#license">License</a>
</p>

---

## Background & Pain Points

When running complex engineering tasks with desktop AI agents, a single turn often involves several minutes of deep reasoning, dozens of file operations, and intensive tool executions. Existing mobile remote setups typically mirror the full desktop workspace onto the phone screen, causing practical friction:

- **Imbalanced Information Density**: Raw reasoning traces, verbose tool parameters, and large unified diffs overwhelm small displays, burying the primary conclusion.
- **Attention Overload**: During commutes, meals, or brief breaks away from the keyboard, the primary goal is simply checking whether a round finished and dispatching the next instruction, without dissecting every intermediate step.
- **Inflexible Connectivity**: Pure LAN routes disconnect as soon as you step outside, while centralised cloud relays introduce external credential custody risks.

**Minimal Remote** was built to solve this: by default, the mobile view presents only your input and the AI's final answer, filtering out execution noise while allowing you to drill down into the full trace on demand.

---

## Core Features

- 🎛️ **Three On-Demand Presentation Modes**: Switch instantly between "Single frame" (the cleanest view, keeping only the latest conclusion), "Chat" (standard conversation bubbles), and "Full" (inline tool calls and file diffs with keyword search).
- 🌐 **Multi-Route Secure Connectivity**: Connect via LAN, Tailscale private network (supporting MagicDNS and HTTPS certificates), or Cloudflare Tunnel (for environments without public IPs). All routes coexist with dedicated QR codes and tokens.
- 🐬 **Lightweight Anthropomorphic Feedback**: Inter-step narrations are spoken aloud by the whale girl sprite in speech bubbles; execution progress and queued instructions are visualized on an exact scale, filtering out raw reasoning blocks.
- 💬 **Feishu Long-Connection Remote**: Direct bidirectional communication through the Feishu Open Platform WebSocket long connection without public ports, supporting text dialogue, multiple-choice responses, and the `/会话` switch command.
- 🗂️ **In-Place Mobile Session Management**: Rename, pin, archive, or fork sessions from the most recent completed turn directly on your phone, with clear indicators for pending approvals and questions.
- 🔒 **Rigorous Security Boundaries**: All API routes enforce constant-time token comparison to prevent timing side-channel attacks; built-in rate limiting locks out sources after 5 failed attempts in 1 minute; pairing data is accessible solely from the host loopback interface.

---

## UI Preview

### Conversation Screen (Single Frame / Chat)

The mobile client is built with zero-dependency vanilla JavaScript and supports both high-contrast Dark and Light themes:

<div align="center">
  <img width="290" alt="Dark: one conversation laid out as back-and-forth bubbles, carrying only your instruction and the conclusion" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/screen-dark.png" />
  <img width="290" alt="Light: the same conversation, in the palette taken from the promo artwork" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/screen-light.png" />
</div>

### Settings Panel & Appearance

Switch presentation modes, color themes, or trigger manual reconnects from the settings overlay:

<div align="center">
  <img width="290" alt="Settings (dark): three display modes, appearance set to dark" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/settings-dark.png" />
  <img width="290" alt="Settings (light): the selected states and the primary button turn royal blue too" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/settings-light.png" />
</div>

### Running State on Device

During task execution, the view presents an animated running state, elapsed timer, and queued task scale without unverified progress guesses:

<div align="center">
  <img width="290" alt="Running (dark, photographed on a phone): the whale girl running, 15s elapsed" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/running-dark-phone.jpg" />
  <img width="290" alt="Running (light, photographed on a phone): the whale girl running, 7m43s elapsed, one instruction queued" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/running-light-phone.jpg" />
</div>

---

## Quick Start

### Prerequisites

Confirm that your host environment satisfies the following requirements:

- **Node.js**: `^22.19.0 || >=24.0.0`
- **DSH (DeepSeek Harness)**: `>=0.1.5-rc.2 <0.3.0`
- **OS**: Windows, macOS, or Linux

> ⚠️ **Notice**: DSH is in active development. This plugin is verified across `0.1.5-rc.2`, `0.1.7-rc.2`, `0.2.0-rc.1`, and `0.2.0-rc.2`. Versions below `0.1.5` are untested, and versions above `0.3.0` risk breaking changes in upstream host interfaces.

### Installation

Execute the installation command in your terminal. Replace `web` with your custom profile name if you are not using the default profile:

#### Option 1: Install from npm (Recommended)

```powershell
dsh plugin --profile web add dsh-mini-remote
```

#### Option 2: Install from GitHub

```powershell
dsh plugin --profile web add github:xingzhen199186/dsh-mini-remote
```

#### Option 3: Install from Local Directory

```powershell
dsh plugin --profile web add C:\path\to\dsh-mini-remote
```

### Starting the Service

1. Restart the DSH service (close the active `dsh web` window and launch it again).
2. Check the console log for the listening port and pairing token:
   ```text
   [dsh-mini-remote] 已启动：http://127.0.0.1:3090/mini?token=xxxxxxxxxxxx
   ```
3. Open the DSH desktop UI, navigate to "Settings" → "Phone Remote" in the left sidebar, and view the pairing QR codes and links.

---

## Usage & Configuration

### Connection Route Matrix

Select the route that matches your current networking environment:

| Route | Scenario | Prerequisites | Trade-offs |
| :--- | :--- | :--- | :--- |
| **LAN** | Phone and computer on the same Wi-Fi subnet | None | Ready immediately; disconnects upon leaving Wi-Fi |
| **Tailscale** | Stable remote access across locations | Tailscale installed and logged in on both devices | Fixed private IP; optional HTTPS certificate support |
| **Public Tunnel** | No public IP and no third-party client installation | Enable Cloudflare Tunnel in settings | Temporary URL rotates on each DSH restart; initial setup downloads ~50 MB binary |
| **Feishu Long Connection** | Direct enterprise IM messaging without browser | Feishu custom bot credentials configured | No inbound ports required; bidirectional mobile approvals |

### Mobile Interface Guide

- **Sending & Queuing**: Enter instructions in the bottom input box. When an agent is busy, subsequent messages queue up sequentially and appear on the scale.
- **Slash Commands**: Type `/` to bring up available session commands with parameter guidance and search filtering.
- **Interactive Questions**: When the agent requests clarification or user choice, an interactive card pops up for one-tap answers or custom replies.
- **Back to Bottom**: When scrolling through long message histories, a floating "Back to bottom" button appears in the lower-right corner (disabled in Single frame mode).
- **Permission Switching**: Tap the top status bar to cycle between View Only (`read-only`), Workspace Write (`workspace-write`), and Full Access (`danger-full-access`).

> ⚠️ **Notice**:
> 1. Elevating permissions to "Full Access" permits the agent to run arbitrary system commands and modify files across the machine. Proceed with caution.
> 2. System-level confirmation dialogs for dangerous commands belong to the host security perimeter and cannot be signed off remotely from the phone; they must be confirmed on the desktop host.

### Advanced Settings: Embedded Desktop Interface

Enabling "Advanced settings" in the mobile settings drawer exposes the "Desktop interface" action. Tapping it loads the full desktop DSH web UI inside an iframe, allowing plugin management, model parameter adjustments, and full transcript audits on mobile.

> ⚠️ **Notice**:
> Enabling the desktop interface extends the mobile access token's scope to the entire desktop management plane. A secondary confirmation is required. If the host cannot determine the desktop listening port, this option is hidden automatically.

### Feishu Bot Setup Guide

1. Log in to the [Feishu Open Platform](https://open.feishu.cn/) and create a custom enterprise application.
2. Record the `App ID` and `App Secret` under Credentials & Basic Info.
3. Navigate to "Add Capabilities" and add the "Bot" capability.
4. Navigate to "Events & Callbacks", set the subscription mode to "Receive events over a long connection", and subscribe to `im.message.receive_v1`.
5. Under "Permissions", grant the following 3 scopes:
   - Receive messages (`im:message:receive_v1`)
   - Send messages as bot (`im:message:send_as_bot`)
   - Read and send single/group chat messages (`im:message.group_at_msg:readonly` suite)
6. Create and **publish an application version**.
7. Return to DSH desktop "Settings" → "Phone Remote" → "Feishu", paste the credentials, and turn the toggle on. The first time you message the bot, it replies with your `open_id`. Add this ID to the allow-list to finish onboarding.

### Configuration Parameters

Settings can be managed either via the desktop "Phone Remote" panel or declared directly in the standard DSH profile:

| Parameter | Type | Default | Lifecycle | Description |
| :--- | :--- | :--- | :--- | :--- |
| `port` | `number` | `3090` | Restart required | Local HTTP port for the remote service (auto-increments on conflict) |
| `token` | `string` | *(generated)* | Restart required | Access token (must be at least 12 characters if customized) |
| `defaultMode` | `string` | `"minimal"` | Immediate | Default view mode on mobile: `"minimal"`, `"chat"`, `"full"` |
| `externalNotify` | `boolean` | `true` | Immediate | Play chimes and vibrate on task completion |
| `tunnel.enabled` | `boolean` | `false` | Restart required | Enable Cloudflare temporary public tunnel |
| `tailscale.serve` | `boolean` | `false` | Restart required | Enable Tailscale HTTPS certificate listener |
| `feishu.enabled` | `boolean` | `false` | Immediate | Enable Feishu WebSocket long connection |

---

## License

This project is licensed under the [MIT License](LICENSE).

### Documentation & Reference Links

- [Sprites and Animation Guide](docs/character.md) (Chinese): Image tool pipelines, shared prompt templates, dimensions, and acceptance criteria.
- [Sprite Reference Frames (Frozen 2026-09-28)](docs/art-refs/2026-09-28/) (Chinese): Reference frames and prompt baselines.
- [Changelog](CHANGELOG.md): Historical evolution and bug fix records.
- [Repository](https://github.com/xingzhen199186/dsh-mini-remote): Official GitHub home.

### Credits

Special thanks to [dsh-pocket](https://www.npmjs.com/package/dsh-pocket) by @shaobeichen for inspiring the multi-path independent QR pairing layout.