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
  <a href="#overview">Overview</a> ·
  <a href="#preview">Preview</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#phone-connection-and-use">Phone Connection</a> ·
  <a href="#pc-remote-window">Remote Window</a> ·
  <a href="#using-computer-b-from-computer-a">Using B from A</a> ·
  <a href="#b-projects">B Projects</a> ·
  <a href="#remote-settings">Remote Settings</a> ·
  <a href="#troubleshooting">Troubleshooting</a> ·
  <a href="#security-boundaries">Security Boundaries</a> ·
  <a href="#development-and-verification">Development & Verification</a>
</p>

---

**Minimal Remote** adapts to a wide range of usage scenarios: when away from the computer, operate the DSH on this computer through the mobile web interface; on another computer, operate the core computer's complete DSH interface through Remote Window, and configure A/B cross-computer tasks, where A's DSH operates on B's files and commands within granted limits, avoiding reconfiguring DSH and its plugins on the second computer.

## Overview

- 🎛️ **Three conversation views**: **Single frame** keeps only the latest conclusion, **Chat** arranges history as bubbles, and **Full** restores tool calls and file diffs in their original order with search over loaded execution traces.
- 📱 **Direct use in a phone browser**: Scan a QR code to open the interface; no app installation or account registration is required. The page can be added to the home screen. Changing phones or clearing browser data requires pairing again.
- 🌐 **Multiple connection routes**: LAN, Tailscale private networking with optional HTTPS, Cloudflare Tunnel, and Feishu long connection. Each route has a different network boundary; see **Security Boundaries**.
- 🐬 **Lightweight status feedback**: Key narration, elapsed time, and queued instructions are visible, while raw reasoning is kept out of the phone conversation.
- 🗂️ **Mobile session management**: Rename, pin, archive, or fork a session, with indicators for pending approvals and unanswered questions.
- 🖥️ **Use Computer B from Computer A**: The conversation and model stay on A. Within A's conversation, only `b_*` tools operate on B; B locally decides its authorized directories, write access, folder management, and command permission.
- 🗂️ **B Projects**: Register a real B directory as a workspace entry on A, with a B file panel and a project-specific **New B Session** action.
- 💻 **Remote Window**: Embed this computer's complete DSH interface in another computer's DSH desktop. This is a separate feature from the A-to-B file workflow; see **PC Remote Window**.
- 💬 **Bidirectional Feishu remote**: Text exchange, question and approval replies, and `/会话` switching through the Feishu WebSocket long connection.
- 🔒 **Device-level access control**: Phones and computers are registered separately and can be revoked individually. Pairing data is readable only on the host, and passphrase attempts are rate-limited. High-privilege features and public exposure still carry material risks and do not constitute a public-deployment security guarantee.

---

### Preview

#### Conversation views (Single frame / Chat / Full)

The phone page is built with vanilla JavaScript and has no front-end build step. It provides two high-contrast themes: deep ocean blue (dark) and ice blue with royal blue (light). One conversation can be read three ways: Single frame leaves only the latest conclusion on screen, Chat arranges history as bubbles, and Full puts each turn's execution trail back in place:

<div align="center">
  <img width="290" alt="Chat (dark): turns arranged as back-and-forth bubbles, with several visible at once" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/screen-chat-dark.png" />
  <img width="290" alt="Chat (light): the same conversation in the light theme" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/screen-chat-light.png" />
</div>

#### Settings and appearance

Use the settings button in the upper-right corner to switch presentation mode and theme or control network reconnection:

<div align="center">
  <img width="290" alt="Settings (dark): three display modes with dark appearance selected" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/settings-dark.png" />
  <img width="290" alt="Settings (light): selected states and the primary button use royal blue" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/settings-light.png" />
</div>

#### Execution status

During a task, the page shows the animated running state, an elapsed timer, and the queue scale without inventing progress that is not known:

<div align="center">
  <img width="290" alt="Running (dark): the whale mascot running, 14 seconds elapsed, one instruction on the queue scale" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/running-dark-phone.jpg" />
  <img width="290" alt="Running (light): the same run in the light theme, 14 seconds elapsed, one instruction queued" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/running-light-phone.jpg" />
</div>

---

## Installation

### Requirements

Confirm that the computer meets the following requirements before installation:

- **Node.js**: `^22.19.0 || >=24.0.0`
- **DSH (DeepSeek Harness)**: `>=0.1.5-rc.2 <0.3.0`
- **Operating system**: Windows, macOS, or Linux

> ⚠️ **Version notice**: DSH is under active development. Core features of this plugin have been fully verified on `0.1.5-rc.2`, `0.1.7-rc.2`, `0.2.0-rc.1`, and `0.2.0-rc.2`. The 0.2.5 release record also includes a compatibility check on **DSH `0.2.1-rc.3`** (result: `COMPATIBLE`), host self-check and B-side preset registration, and tests run with that version's `dsh-tools`. Versions below `0.1.5` are not covered by a compatibility commitment. Versions at or above `0.3.0` risk upstream interface breakage. The plugin declares `<0.3.0` as its upper bound; confirm plugin support before upgrading DSH.

### Installation steps

#### Option 1: Install through the DSH desktop UI (recommended)

1. Click **Plugins** in the DSH top navigation bar to open the plugin manager.
2. Click **Add Plugin** in the upper-right corner.
3. Enter the package name `dsh-mini-remote`. The GitHub source `github:xingzhen199186/dsh-mini-remote` and a local directory path are also accepted. Keep the default **npm official registry**.
4. Click **Install** at the bottom of the dialog.

> ⚠️ **Notice**:
> 1. **Verify the source**: Plugins run with the current user's full privileges. A plugin from an untrusted source can damage DeepSeek Harness or read and leak sensitive data.
> 2. **No automatic updates**: Installed plugins do not update automatically. To upgrade, uninstall the current version before installing the new one.

#### Option 2: Install from the official npm registry (command line)

Run the following command in a terminal. `web` is the default DSH profile name; replace it when using a custom profile:

```powershell
dsh plugin --profile web add dsh-mini-remote
```

#### Option 3: Install directly from GitHub

```powershell
dsh plugin --profile web add github:xingzhen199186/dsh-mini-remote
```

#### Option 4: Install from a local directory (developer testing)

```powershell
dsh plugin --profile web add C:\path\to\dsh-mini-remote
```

### Starting the service

1. Restart the DSH service by closing the current `dsh web` window and starting it again.
2. Check the console output for initialization information, the listening port, and the access token:
   ```text
   [dsh-mini-remote] 已启动：http://127.0.0.1:3090/mini?token=xxxxxxxxxxxx
   ```
3. Open the DSH desktop UI and go to **Settings** → **Remote Settings** to view the pairing QR codes and connection details.

> **The phone client is a web page only.** Scan the code and open it in a browser; there is no standalone app or mini-program. The page can be added to the home screen and opens full-screen from the icon, but it is still running in the browser. Changing phones or clearing browser data requires pairing again.
>
> The same address also works in a PC browser. After enabling **Advanced Settings**, the complete DSH desktop interface is available in that page as well; see **Advanced Settings: Embedded Desktop Interface**.
>
> **How to confirm startup**: **Remote Settings** appears with connection addresses and QR codes, and the console prints a line beginning with `[dsh-mini-remote] 已启动`. If the console is ready but the settings page is empty, refresh or restart DSH, then inspect **Self-check**.

---

## Phone Connection and Use

### Choosing a connection route

Select the route that matches the current network topology:

| Route | Use case | Requirements | Trade-offs |
| :--- | :--- | :--- | :--- |
| **LAN** | Phone and computer on the same Wi-Fi subnet | No extra client | Ready after configuration; disconnects when leaving the LAN |
| **Tailscale** | Remote access across networks with a stable address | Install and sign in to [Tailscale](https://tailscale.com/download) on both devices | Stable private IP; optional Tailscale HTTPS certificate |
| **Public tunnel** | No public IP and no additional client desired | Enable the Cloudflare Tunnel switch | The temporary hostname changes after every DSH restart; the first start downloads roughly 50 MB |
| **Feishu long connection** | Enterprise IM control without a browser | A custom Feishu app and bot credentials | No inbound public port; bidirectional text and mobile approvals |

### Connecting a phone for the first time

1. Install and enable the plugin on the computer, then restart DSH.
2. Open **Settings** → **Remote Settings**. The **Phone Connection** group at the top is expanded by default and lists the addresses currently available for this computer, such as **This machine**, **LAN**, **Tailscale**, **Tailscale (encrypted)**, and **Public access**. The exact list depends on which routes are installed and enabled.
3. Choose a route the phone can reach. Prefer **LAN** when the phone and computer are on the same Wi-Fi; use Tailscale or the public tunnel when access crosses networks.
4. Scan the matching QR code with the phone browser, or copy the address and open it in the phone browser.
5. After the page opens, use the browser menu to add it to the home screen for later access.
6. On the computer, return to **Remote Settings** → **Computers & Devices**, expand the **Devices** list, and confirm that the phone was registered.

**How to confirm success**: The phone page leaves the connecting or passphrase-entry state and shows the session list and current session. The computer's device list gains a record for the phone. A device is registered automatically on its first scan; later visits do not require scanning again.

An address looks like this:

```text
http://192.168.1.2:3090/mini?token=xxxxxxxxxxxx
```

Every address in Remote Settings has a fixed **160×160** QR code. The address field and the **Copy** button occupy the same row, and focusing the address field selects the whole address.

> ⚠️ **The address contains an entry passphrase.** Anyone who obtains it can enroll a device and operate this computer. Do not send screenshots or paste the address in public. The browser switches to a device credential after pairing, but the address itself must still be protected as a credential. After changing the passphrase, restart DSH and scan again.

The phone page supports:

- **Sending and queueing**: Send a message from the bottom input field. If the Agent is running, later messages enter an ordered queue and appear on the queue scale.
- **Slash commands**: Type `/` to open the current session's command list, with filtering and parameter hints.
- **Questions and approvals**: A question card appears when the Agent asks for a choice; options can be selected, changed, or supplemented with text. When a tool or command needs confirmation, an approval card offers **Approve** and **Deny**.
- **Back to bottom**: After scrolling through long output, a **Back to bottom** control appears at the lower right. It is absent in Single frame mode.
- **Permission levels**: Switch among **View only** (`read-only`), **Workspace write** (`workspace-write`), and **Full access** (`danger-full-access`). Full access requires a second confirmation.
- **Session management**: Rename, pin, archive, and fork sessions.

> ⚠️ **Notice**:
> 1. **Full access** lets the Agent modify arbitrary files and run system commands. Enable it only with a clear understanding of the consequences.
> 2. The phone can handle approvals already delivered to the page. Approvals that were not delivered, have expired, or need more context must still be handled on the computer.
> 3. If the phone disconnects or the page closes, an approval may return to the computer. Follow the message shown on the page or the computer.

### Advanced Settings: Embedded Desktop Interface (phone or PC browser)

The phone page also opens in a PC browser, though the layout is designed for a phone screen. Enabling **Advanced Settings** provides the complete DSH desktop interface in the same page, without starting a separate `dsh web`.

Steps:

1. Open the page settings in the upper-right corner and locate **Advanced Settings**, described as **Open the DSH interface on the computer and change settings that are unavailable on the phone**.
2. Switch it on and confirm again when prompted. This feature requires two confirmations.
3. Expand the section and click **Open** next to **Desktop interface**.
4. The complete DSH desktop interface appears in the page, including plugin installation, model configuration, session history, and full logs. The top bar returns to the phone page.

**This is the same DSH instance, not a second environment.** Configuration changes and conversations started here apply to the current DSH; the desktop app and this page share one state. The plugin server authenticates once through the official entry, then forwards requests to the local interface in real time, including live interface updates. The phone does not receive the official credentials.

> ⚠️ **Notice**:
> 1. **This is a permission switch, not a cosmetic preference.** Enabling it extends the current access credential from the phone page to the entire desktop management plane, including model configuration, credentials, plugin installation, and session history. It is off by default and requires two confirmations.
> 2. The embedded view is the original desktop interface, adapted for narrow phone screens and unchanged in a PC browser. Disabling the switch removes access to the complete interface.

## PC Remote Window

Remote Window opens Computer A's complete DSH interface directly inside Computer B's DSH desktop. There is no need to switch between browser windows or use a remote-desktop tool. It is for viewing and operating A's interface, not for the A-to-B file and command workflow described below.

### Interface

No window switching and no remote desktop: click **Remote Window** in the DSH desktop sidebar to embed another computer's DSH interface in the main panel. The top bar shows **← Back to list**, the computer name, and **Try again**. It collapses automatically while the interface is healthy and slides out when the pointer reaches the top edge.

<div align="center">
  <img width="720" alt="Remote Window: another computer's DSH interface embedded in the main panel, with Remote Window selected in the left sidebar" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/remote-window.png" />
</div>

### How it works

1. On B, click **Remote Window** in the DSH desktop sidebar. The main panel lists the computers already paired with B.
2. Click a row to embed A's complete DSH interface in the current panel.
3. The top bar contains **← Back to list**, the current computer name, and **Try again**. While the interface is healthy, the bar hides automatically and reappears when the pointer reaches the top edge. It remains visible while connecting, after an error, or whenever the interface has not opened.
4. Click **Remote Window** in the sidebar again to exit and return to the previous panel. The top bar also provides a way back to the list.

### Security boundaries

- When the window opens, A issues a **one-time ticket valid for 30 seconds and redeemable once**. The access passphrase and long-lived credentials never enter the browser.
- Cross-site embedding is denied by default and allowed only for a page carrying a valid ticket.
- After A revokes B in its device list, B's already-open window fails on its next request.
- Restarting DSH on A invalidates the existing ticket. Click Remote Window again to obtain a new one.
- Remote Window exposes A's complete management plane, including conversations, model configuration, and plugin management. Enable **Allow other computers to connect** only for trusted computers.

### Act as A (the computer being viewed)

1. Open **Settings** → **Remote Settings** → **Computers & Devices** and enable **Allow other computers to connect**. It is off by default; while off, A rejects both pairing and ticket requests.
2. Copy the access passphrase under **Phone Connection** so B can pair with A.

### Act as B (the connecting computer)

1. Open **Settings** → **Remote Settings** → **Computers & Devices** → **Other computers**, then click **Add a computer**.
2. Enter A's address and access passphrase, and give the computer a recognizable name. If the name is left blank, the address is used instead.
3. Click **Confirm add**. A's **Devices** list gains a record for B, and B's **Other computers** list gains a record for A.
4. Click that row, or select A through **Remote Window** in the sidebar.

**Other computers** and **Devices** describe opposite directions: **Devices** records which computers may connect to this machine, while **Other computers** records which computers this machine may connect to. Disconnecting an **Other computers** entry removes only the local record; it does not revoke A's authorization for B.

### Which address to enter

- Use a connection address from A's **Remote Settings** page, **without `/mini` or any trailing parameters**. Do not use the address that opens A's DSH interface on A itself.
- A cross-machine address must use `https://`. Loopback addresses `127.0.0.1`, `localhost`, and `[::1]` are exceptions and may use `http://` for local testing.
- Tailscale HTTPS is recommended. On A, enable **HTTPS address (Tailscale)** under **External Access**, then enter `https://<machine>.<tailnet>.ts.net` on B. No port is needed, and the address is more stable.
- The public tunnel address changes after every DSH restart and is not suitable as a stable cross-machine entry.

### How to confirm success

After B clicks A in the list, the panel should show **A's complete DSH interface**, not a blank page or a frame stuck at `Loading plugins…`. If the frame is blank or never finishes loading, use **Troubleshooting** to check the address, ticket, and Tailscale Serve configuration.

### How to revoke access

On A, open **Settings** → **Remote Settings** → **Computers & Devices** → **Devices**, find B, then click **Revoke** and confirm. Revocation takes effect immediately: B's already-open window is rejected on its next request, and B must pair again before it can reconnect.

## Using Computer B from Computer A

This workflow differs from both the phone page and Remote Window: **Computer A runs the conversation and model, and its Agent operates on real files on Computer B through `b_*` tools.** Both computers must have this plugin installed.

### The two roles

A and B describe the direction of a cross-machine collaboration. They are not mutually exclusive packages, and the computers do not have to choose one role permanently.

| Role | Entry in Remote Settings | Responsibilities | Not responsible for |
| :--- | :--- | :--- | :--- |
| **Computer A** | **A/B Collaboration** → **Act as A** | Keeps the conversation, model, and plugins; starts B-side tasks; displays online state and authorized directories | Cannot choose B's directories or expand its permissions; does not copy B's files to A |
| **Computer B** | **A/B Collaboration** → **Act as B** | Accepts tasks from A and provides local file, folder, and command capabilities | Does not receive A's conversations or model; authorized directories, write access, folder management, and command permission are decided locally on B |

**Key distinction**: Local tools in A's conversation — `read`, `write`, `edit`, `bash`, and similar — operate on **Computer A**. Only `b_list`, `b_read`, `b_write`, `b_shell`, and the other `b_*` tools operate on **Computer B**. When a task targets B, state the `b_*` tool and the B path explicitly.

### First pairing and verification

**On Computer A**

1. Install the plugin and restart DSH.
2. Open **Settings** → **Remote Settings** → **A/B Collaboration**, expand **Act as A**, and enable the main switch.
3. Under **Address to enter on B**, choose an address reachable from B. The default service port is `3090`, and the address must not include `/mini`.
4. Click **Generate pairing code**. The six-digit code is valid for 10 minutes and can be used once.
5. Leave write, folder-management, and command permissions off until the read-only test succeeds.

**On Computer B**

1. Install the same plugin version and restart DSH.
2. Open **Settings** → **Remote Settings** → **A/B Collaboration** → **Act as B**.
3. Enter A's address and the six-digit code, then add one absolute B path per line under **Folders authorized for A**. For the first test, use a dedicated test directory rather than an entire disk.
4. Keep **Allow A to write to these folders**, **Allow A to create, move, copy, and delete folders**, and **Allow A to run commands on this computer** switched off.
5. Click **Pair and enable**.

**How to confirm pairing**

- On B, **Act as B** shows **Connected to A; waiting for tasks** and the latest successful poll time. The page refreshes this state every 5 seconds; no manual refresh is needed after pairing.
- On A, the **Act as A** list contains the B computer with status **Online**, and its authorized directories match those entered on B.
- If B still shows **Not connected to A yet**, press `Ctrl+F5` to force a refresh. If the problem persists, use **Troubleshooting** to check the address, master switches, port, and network.

### Running B-side file tasks from A

Start with a read-only test. Send a prompt like this in any A conversation:

```text
Use b_list to list the files under D:\b-agent-test on Computer B, then use b_read to read one text file and report its name and contents.
```

The expected result lists B's directory and returns the contents of a B file. To verify that A's local file is not being read, use a file with the same name but different contents on A and B.

After the read-only result is correct, enable B-side permissions only as needed:

| B-side switch | Permitted `b_*` operations | Risk boundary |
| :--- | :--- | :--- |
| Authorized directories (required) | `b_list`, `b_read`, and paths within authorized directories | Paths must stay inside authorized directories; `..` and links pointing outside are not allowed |
| Allow A to write to these folders | `b_write` | Can modify existing files inside authorized directories |
| Allow A to create, move, copy, and delete folders | `b_mkdir`, `b_copy`, `b_move`, `b_delete` | Can change the directory structure; deletion is irreversible |
| Allow A to run commands on this computer | `b_shell`, `b_terminal_*` | **The effect is not limited to authorized directories**; this grants A's Agent command execution on the entire B computer |

Delete and move operations require a model-supplied `confirm` argument. That is a model-level second confirmation, not human approval. The actual authorization boundary remains the local switches on B. A cannot change these switches on B's behalf.

After enabling write access, a write test can use:

```text
Use b_write to create D:\b-agent-test\b-test.txt on Computer B with the text "written from A", then read it back to confirm.
```

Confirm that the file appears on B's disk with the correct contents and that no file is created at the same path on A. Disable write or command permission when it is no longer needed.

> ⚠️ **Multiple B computers**: With only one B online, `b_*` may omit the target argument. With several online, the tool may require a target. The current settings list shows name, online state, and authorized directories but does not expose a copyable manual id. During verification, keep only the intended B online, or disconnect the others so a task cannot reach the wrong computer.
>
> **Revoking collaboration**: Revoking a B computer from A's **Act as A** list requires generating a new pairing code on A and pairing again. Turning off A's **Act as A** master switch stops both pairing and task acceptance.

### B-side identity and re-pairing

B creates and stores a `machine-id` in its plugin data directory. During re-pairing, B presents this stable identifier to A. A reuses the existing record: the device name, authorized directories, and permissions are updated for the new pairing, **the old token is invalidated immediately, and no duplicate record is added**.

- If the original data directory survives a plugin upgrade or reinstall, `machine-id` is reused. If the data directory is deleted, the identifier disappears and A treats the computer as a new device.
- Records created by older versions without `machine-id` cannot be matched automatically, even when they belong to the same B computer. Revoke the stale record manually from A's **Act as A** list.
- When B's authorized directories or permissions change, pair again rather than guessing or entering B paths on A.

---

## B Projects

A B Project registers a real directory on B as a DSH workspace on A. A stores only a **marker workspace** and a path mapping; **B files are not copied**. The real files remain on B.

The native file tree on A shows the marker directory, not B's file contents. Use the B file panel or the project's B session to inspect and modify B project files.

### Creating a project and selecting a B directory

Prerequisites: **Act as A** is enabled on A, **Act as B** is online on B, and B has at least one authorized directory.

1. On A, open **Settings** → **Remote Settings** → **A/B Collaboration** → **B Projects**.
2. Click **New B Project**. The creation form is collapsed by default; expand it and enter a project name.
3. Click **Choose B folder**. The picker starts from B's authorized roots, keeps the current path visible at the top, and allows navigation into subdirectories. The full path appears at the lower left, and **Use this folder** is at the lower right.
4. To create a directory, use **+ New folder**. This requires folder-management permission on B; alternatively, create the directory on B first.
5. With the directory selected, click **Create B Project**.

**How to confirm creation**: The B Projects list shows the project and its full B path, and A's workspace list gains **B · project-name**. If the workspace does not appear immediately, refresh DSH. A does not copy B files, and creating the project does not mean the files have been synchronized.

> ⚠️ A B directory can belong to only one B Project. Creation fails when the B directory does not exist and A lacks folder-management permission. Removing a B Project deletes only the marker and workspace on A; **it does not delete B's real files**.

### Creating a B session

1. Find the target project in the **B Projects** list.
2. Click **New B Session**.
3. The session opens automatically when possible. If it does not, open it from the **B · project-name** workspace in the left sidebar.
4. The session uses the **B-side Execution** preset from creation. Local file and command tools are removed from the project session, and file operations must use `b_*`.
5. The project root is the default working directory. If no path is supplied, work starts at the project root; relative paths resolve against it, and absolute paths outside the project are rejected.

**How to confirm the session**: The session appears under **B · project-name** with the **B-side Execution** preset. When the Agent lists the project root, the result must come from B, not from A's marker directory.

### Browsing B files

1. Click **Browse B Files** in the B Projects list.
2. The panel lists B directories and files from the project root and shows file sizes.
3. Click a directory to enter it, or a text file to view its contents. The top actions are **Refresh**, **Reload file**, and **Close file panel**.
4. The file panel is for browsing and reading only. To write, call `b_write` explicitly from a B session after enabling write permission on B.

> ⚠️ The B file panel and B sessions can access only paths inside the project root. A path outside the project requires another B Project and cannot be reached through `..` or an absolute path.

---

## Remote Settings

The entry is **Settings** → **Remote Settings** in DSH. Starting with 0.2.5, the page is organized into six groups:

| Group | Main contents | Default state |
| :--- | :--- | :--- |
| **Phone Connection** | Addresses, QR codes, access passphrase | Expanded |
| **External Access** | Tailscale, HTTPS address, public tunnel | Expanded |
| **Computers & Devices** | Allow other computers, device list, other computers | Group expanded; device list collapsed |
| **A/B Collaboration** | Act as A, Act as B, B Projects | Collapsed |
| **Feishu** | Bot credentials, allow-lists, setup guide | Collapsed; the setup guide is also collapsed |
| **Self-check** | Version, routes, switches, recent errors | Collapsed; placed last on the page |

Collapsing a group changes only what is visible in the current settings session. It does not disable the feature or act as a permission switch.

### Phone Connection and External Access

- Every connection address has a 160×160 QR code, with the address field and **Copy** button on the same row.
- **Phone Connection** manages local addresses and the access passphrase. **External Access** manages Tailscale, the Tailscale HTTPS address, and the Cloudflare public tunnel.
- The Tailscale HTTPS address and the ordinary Tailscale address point to the same service; only the connection encryption differs. The public tunnel hostname changes after every DSH restart.
- Changing the passphrase takes effect after DSH restarts. Phones must scan again afterward.

### Computers and Devices

- **Allow other computers to connect**: Off by default. While off, A rejects both pairing and ticket requests from other computers.
- **Devices**: Collapsed by default. Expand to view registered phones and computers, rename an entry, or revoke it. Revocation requires a second confirmation, and the revoked device must scan again.
- **Clean up 30-day unused**: Removes only records whose creation time **and** last-used time are both older than 30 days. Duplicate devices seen within the last 30 days are not removed and must be checked manually. Removed devices must scan again.
- **Other computers**: Lists computers this machine can connect to, the opposite direction from **Devices**. **Devices** answers who may connect to this machine; **Other computers** answers which machines this one can reach. Disconnecting an **Other computers** entry removes only the local record; the other computer retains its authorization until the corresponding device is revoked there.

For the complete Remote Window tutorial, address requirements, and security boundaries, see [PC Remote Window](#pc-remote-window).

---

### A/B Collaboration

- The **A/B Collaboration** group is collapsed by default. Expanded, it contains **Act as A**, **Act as B**, and **B Projects**, in that order.
- B refreshes its local status every 5 seconds, so a successful pairing does not require a manual refresh.
- If B still shows **Not connected to A yet**, the page suggests `Ctrl+F5` to force a refresh. After one successful poll, the status becomes **Connected to A; waiting for tasks**.
- When B pairs again, A prefers the persistent `machine-id` and reuses the existing record. The old token is invalidated immediately. Records created by older versions without `machine-id` must be revoked manually on A.
- The **New B Project** form is collapsed by default and closes only after creation succeeds.

### Feishu Bot Setup

The Feishu group and its **Setup guide (six steps in the Feishu console)** are both collapsed by default.

1. Sign in to the [Feishu Open Platform](https://open.feishu.cn/) and create a custom enterprise app.
2. Obtain the `App ID` and `App Secret` from **Credentials & Basic Info**.
3. Add the **Bot** capability under **Add Capabilities**.
4. Under **Events & Callbacks**, choose **Receive events over a long connection** and subscribe to `im.message.receive_v1`.
5. Under **Permissions** → **App identity permissions**, grant these three scopes:
   - Receive messages sent to the bot: `im:message:receive_as_bot`
   - Send messages as the bot: `im:message:send_as_bot`
   - Reply to messages: `im:message`
6. Create and **publish an app version**. Publish again after changing capabilities, permissions, or events.
7. Return to **Settings** → **Remote Settings** → **Feishu**, enter the `App ID` and `App Secret`, save, then enable the switch.
8. Send a direct message to the bot. When both allow-lists are empty, no source is accepted. The page or the bot replies with the sender's `open_id` and possibly a `chat_id`.
9. Put the `open_id` in **Allowed open_id** and save. Send another message to begin normal use.

> ⚠️ This version handles direct messages only, not group chats. `App Secret` is never displayed again after saving; leaving it blank keeps the stored value. An empty allow-list denies every source by default.

### Configuration Reference

Settings can be declared in the standard DSH configuration or changed through the desktop **Remote Settings** interface:

| Parameter | Type | Default | Lifecycle | Description |
| :--- | :--- | :--- | :--- | :--- |
| `port` | `number` | `3090` | Restart required | Local HTTP port for the remote service; increments on conflict |
| `token` | `string` | *(generated)* | Restart required | Access passphrase; manual values must be at least 12 characters |
| `defaultMode` | `string` | `"minimal"` | Immediate | Default phone view: `"minimal"`, `"chat"`, or `"full"` |
| `externalNotify` | `boolean` | `true` | Immediate | Play a notification sound and vibrate when a task completes |
| `tunnel.enabled` | `boolean` | `false` | Restart required | Enable the temporary Cloudflare public tunnel |
| `tailscale.serve` | `boolean` | `false` | Restart required | Configure and listen on the Tailscale HTTPS certificate route |
| `feishu.enabled` | `boolean` | `false` | Immediate | Enable the Feishu WebSocket long-connection channel |

### Self-check

Self-check appears last on the settings page, is collapsed by default, and is readable only on the host. It never includes passphrases or keys. Expanding it shows:

- Plugin version, host process start time, and code file time; a warning appears when the process is older than the code.
- Registered routes and their current mount state.
- Whether the phone service is listening, and its actual port.
- Switch states such as **Allow other computers to connect**.
- A recent-error summary, newest first, up to 20 entries and cleared on restart.

**Criteria**: The version matches the installed build, the phone service is listening, and required routes are not marked as currently absent. If the process started before the code was last modified, restart DSH.

---

## Troubleshooting

Work from symptom to check to recovery criterion. Identify the failing layer before changing configuration; repeated pairing usually does not fix a network problem and may leave stale records.

### B still shows "Not connected to A yet"

1. Wait at least 5 seconds. B refreshes its status every 5 seconds, and the pairing response describes only the moment when **Pair and enable** was clicked.
2. Press `Ctrl+F5` to force-refresh the B page or DSH window and discard an old page snapshot.
3. Verify that B contains the exact address shown under **Address to enter on B** on A, without `/mini`, and that the port matches the actual port reported by A's self-check.
4. On B, open A's phone page or minimal access address in a browser to test network reachability.
5. Check A's **Act as A** master switch, B's **Act as B** switch, and whether A's firewall blocks the Tailscale or LAN address.
6. Inspect B's **Last error** and A's **Self-check** → **Recent errors**.

**Recovery criterion**: B shows **Connected to A; waiting for tasks** with a new successful poll time, and A's list shows B as **Online**.

### B remains offline in A's list

- Confirm that DSH is running on B and that **Act as B** is still enabled.
- Check whether B's last error concerns the network, the address, or credential revocation.
- If A's master switch is off, B was revoked, or the network is down, tasks report that B is offline. They are not silently redirected to A.
- After recovery, A's list should show **Online** again. If B was just revoked, generate a new pairing code on A and pair again.

### HTTP 502 or Remote Window will not open

Check the Tailscale Serve target on A first. The default phone service port is `3090`; an old version or old configuration may still point to `3091`.

Run on A:

```powershell
tailscale serve status
```

The proxy target should resemble:

```text
https://<machine>.<tailnet>.ts.net
  -> http://127.0.0.1:3090
```

Checks:

1. The proxy target must be the port the phone service is actually using, `3090` by default. A target of `3091` points to the old service.
2. If another program occupies `3090`, the plugin increments its port. Use the listening port shown in **Self-check**; do not force the mapping to `3090` blindly.
3. To change the mapping, confirm that the phone service is running, then on A open **External Access** and turn **HTTPS address (Tailscale)** off and on again so the plugin configures the current port.
4. A local administrator may alternatively run `tailscale serve --bg 3090` and verify with `tailscale serve status`. Do not use `serve reset`, which removes other Serve configuration on the machine.
5. Confirm that **Allow other computers to connect** is enabled on A, the phone service is listening, and B uses an `https://` address.

**Recovery criterion**: `tailscale serve status` targets the current phone service port, the **Tailscale (encrypted)** address reappears in A's **Remote Settings**, and Remote Window loads after B clicks the entry again.

> The embedded official **New Workspace** button opens a system directory dialog on A's screen, which B cannot reach. The request may end in `HTTP 502` or a timeout. Use **New Workspace** in the Remote Window top bar instead, letting B list A's directories and register one.
>
> If the interface stays at `Loading plugins…`, the browser may be blocking the cross-site credential required by the window. Allow cross-site cookies for the site and retry, or use a browser without strict blocking. This credential belongs to the window session and is not the access passphrase.

### Phone page will not open or keeps disconnecting

- A LAN address works only on the same network. Switch to Tailscale after leaving that network.
- The first public-tunnel start downloads a component and takes about 30 seconds for the hostname to become active. The hostname changes after every DSH restart.
- If a Tailscale address is unreachable, confirm that both machines are signed in to the same tailnet, then check the listening address in A's self-check and the firewall.
- A revoked page cannot recover on its own; scan again.

### B-side file tasks are refused

| Error or symptom | Check first | Recovery criterion |
| :--- | :--- | :--- |
| `b_read` reports a path outside authorized directories | Whether B's authorized directory and the supplied path use the same disk and directory level; whether the path contains `..` | Reading succeeds after switching to an absolute path inside an authorized directory |
| `b_write` reports no permission | Whether B has enabled **Allow A to write to these folders** | After B comes back online, the write test succeeds |
| `b_mkdir`, `b_copy`, `b_move`, or `b_delete` reports no permission | Whether folder management is enabled on B | The operation succeeds and the real files on B change |
| `b_shell` reports no permission | Command permission is independent of write permission | After enabling it with a clear understanding of the risk, an `echo` test returns exit code 0 |

### Remote Settings does not show A/B Collaboration or B Projects

- Confirm that plugin **0.2.5** or newer is installed and restart DSH.
- An old process may still be running old code. Check the plugin version and process start time in **Self-check**.
- If pairing succeeded but B Projects is unavailable, confirm that at least one B computer is online and has an authorized directory.

---

## Security Boundaries

These boundaries must not be omitted for brevity.

### Network exposure

- LAN and ordinary Tailscale addresses use plain `http://`; other devices on the same network may observe traffic. The Tailscale HTTPS address provides an encrypted connection.
- Cloudflare Tunnel exposes the service to the public internet and relays traffic through Cloudflare. The temporary hostname changes, but that change is not a security boundary.
- The public-tunnel address and QR code contain an entry passphrase. Anyone who obtains the passphrase can enroll a device and operate the host. Do not use or distribute the address on untrusted networks or in public channels.
- The Feishu channel passes through the Feishu Open Platform. Message content and availability are subject to the app's permissions and the platform's policies.
- This plugin makes no security guarantee for public deployment. Public access requires an independent assessment of the network environment, access control, and host security.

### Credentials and devices

- QR codes and copied addresses contain the access passphrase and must be protected like a password. The settings page itself is readable only on the host.
- After first pairing, the phone and computer each hold a device credential that can be revoked individually under **Devices**. Revocation is immediate, but the revoked device must scan again to return.
- Clearing phone browser data or changing phones does not remove the old device record. Revoke it on the computer when appropriate.
- A B-side `machine-id` can reuse an identity only while the same data directory remains. Records from older versions without `machine-id`, and records whose data directory was deleted, may become stale entries that require manual revocation.
- **Clean up 30-day unused** removes only records whose creation and last-used times are both older than 30 days. Duplicate devices seen recently are not removed and must still be reviewed manually.

### Plugin and high-privilege interfaces

- Plugins run with the current user's privileges. An untrusted plugin can damage DSH, read files, or leak credentials; install only packages from trusted sources.
- **Full access** on the phone lets the Agent modify files across directories and run system commands. An approval card for a dangerous command is the final human check, not a substitute for reviewing the task.
- The desktop interface under **Advanced Settings** gives the phone the complete DSH management plane, including model configuration, credentials, plugin installation, and session history. It is off by default and requires two confirmations.
- Remote Window displays A's complete desktop interface. The B computer holding that window can view and operate A's management plane. Enable **Allow other computers to connect** only for trusted computers.

### A/B files and commands

- Authorized directories, write access, folder management, and command permission on B are controlled locally on B. A cannot expand them.
- Command permission is not limited to authorized directories; it grants A's Agent command execution on the entire B computer and is off by default.
- Delete, move, and copy operations may require a model-level `confirm`, but that is not human approval. The real boundaries are B's switches and directory scope.
- B Projects create only a marker and path mapping on A; they do not copy files. Removing a B Project deletes the marker workspace on A but does not delete B files.
- B project sessions and the B file panel can access only paths inside the project root. Paths outside it require another B Project.
- Local tools on A operate on A. B files are accessible only through `b_*` tools; mixing the two selects the wrong target.

### Feishu

- With both allow-lists empty, the bot accepts no source. Add only trusted `open_id` values.
- This version handles direct messages only. Adding the bot to a group may let other participants drive the local session and should be avoided.
- `App Secret` is password-equivalent. Do not screenshot or forward it, and expect the interface not to display it again after saving.

---

## Development and Verification

This repository is a Node.js plugin that runs inside DSH. Documentation changes require no client rebuild; code or page changes require a DSH restart and fresh verification.

### Local checks

```bash
npm test
node client/verify.mjs
```

- `npm test` runs the offline tests in `test/*.test.mjs` and does not require a running DSH instance.
- `node client/verify.mjs` verifies module registration, the settings components, Remote Window, and the B Projects panel in `client/client.js`.
- Before release, `npm pack --dry-run` can inspect the actual package contents and size.

**0.2.5 release verification record**:

- `npm test`: **1190 passed, 0 failed**
- `node client/verify.mjs`: **144 passed, 0 failed**
- On DSH `0.2.1-rc.3`: compatibility check `COMPATIBLE`; host self-check passed; B-side preset registration passed; tests used that version's `dsh-tools`

These figures are the record for the 0.2.5 release. After code changes, use the actual output from the current environment rather than historical numbers.

### Documentation and resources

- [Release checklist](docs/发版清单.md) (Chinese): versioning, tests, packaging, tagging, and publishing.
- [Changelog](CHANGELOG.md): detailed changes and fix rationale for each release.
- [Sprites and animation guide](docs/character.md) (Chinese): image-generation workflow, shared prompt templates, dimensions, and acceptance criteria.
- [Sprite reference frames (frozen 2026-09-28)](docs/art-refs/2026-09-28/) (Chinese): reference frames and full prompt baselines.
- [Source repository](https://github.com/xingzhen199186/dsh-mini-remote): official GitHub home.

---

## License

This project is licensed under the [MIT License](LICENSE).

### Acknowledgements

The channel interaction and pairing interface design were informed by [dsh-pocket](https://www.npmjs.com/package/dsh-pocket) by @shaobeichen, particularly its approach to independent QR codes for multiple routes.
