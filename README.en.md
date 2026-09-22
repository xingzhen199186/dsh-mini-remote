# dsh-mini-remote

> A [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH) plugin that puts a **minimal remote control** on your mobile device — only the instruction you send and the AI's final conclusion reach it. Tool calls, file reads and writes, sub-agent dispatch, and reasoning traces all stay on the computer.

![DSH plugin](https://img.shields.io/badge/DSH_plugin-dsh--plugin-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[中文说明 →](README.md)

**To use this plugin on mobile, switch the DSH session page on your PC to Full Access（完全权限）**

---

## Why I built this plugin

The idea came from this: an agent task often takes a long time to finish, and if you step out, you need the phone to drive it remotely.

But the phone clients that exist show the PC's execution steps in faithful detail. You send one instruction; it may think for several minutes, read dozens of files, call tools a few times, and only then give you a conclusion. If you're out, or busy away from the computer, you simply don't have the time to watch the phone that closely.

I don't think that approach is bad. It's complete and controllable, and if you're going to do serious work, it's the right one.

But when I'm out, what I want is something else — **a lighter way to interact that asks less of my attention**. The phone screen is small, and so is the attention I have to spare when I'm out. Most of the time I only need one thing: **this round is done, time to send the next instruction.** And even at my desk, I rarely read the AI's running commentary while it works.

So the interface here is deliberately crude: it drops the PC's execution steps entirely and puts only the AI's final conclusion in front of you.

**In a sense, it exists so that you look at it less.**

So you can spend your time more freely — instead of being stuck in that small screen while you're playing with your daughter or out on a trip.

---

## Install

```powershell
dsh plugin --profile web add dsh-mini-remote
```

Or straight from GitHub, if you would rather pin the source:

```powershell
dsh plugin --profile web add github:xingzhen199186/dsh-mini-remote
```

If you already have the source on disk, you can point it at the folder:

```powershell
dsh plugin --profile web add <the folder you put the source in>
```

**You must restart DSH once after installing**, or nothing new shows up in the settings page. After the restart a "Phone Remote" entry appears in the left column, and the startup log prints the phone URL and password.

---

## Configuration: three routes, pick what you need

All three connection methods **exist at the same time**. Pick one, or leave several on.

Open DSH settings (bottom of the sidebar) → "Phone Remote" in the left column. Every route on that page has a QR code and a link, and the small text under each QR code says **when to use that route**. That's all you need to read.

### 1. LAN: at home only

When the phone and the computer are on the same Wi-Fi, scan the "LAN" code and you're in. **Nothing extra to install** — the least fuss of the three.

The cost is that it stops working the moment you leave: the phone switches to mobile data and this route is gone.

### 2. Tailscale: works outside, and the address stays fixed

Install [Tailscale](https://tailscale.com) on both the computer and the phone, sign in to the same account, and this route appears on the pairing page by itself. The address is fixed — set it up once and forget it.

The cost is an app on each side. If you don't mind installing it, **this is the steadiest route when you're out**.

### 3. Public access: nothing to install

There's a switch at the bottom of the pairing page. Turn it on and Cloudflare hands you a public URL. The phone can reach it on any network, **with nothing installed**.

Two costs, worth knowing before you decide:

- **The address changes every time you restart DSH.** When it does, come back and scan the new code.
- **The first time is slow** — it's downloading a component of about 50 MB, and only that once. While it does, the status line reads "opening…", which is normal, not a hang. Registration occasionally fails; the plugin retries three times on its own.

Once it's on, **wait half a minute before scanning.** Cloudflare needs a moment to publish the address. Scanning too early reports that it can't be opened — that's not breakage, it's just too soon.

---

<img width="1314" height="2186" alt="screenshot_20260922_233535_com huawei hmos brows" src="https://github.com/user-attachments/assets/8befa186-3e20-4c0e-8efc-8ea523f77648" />


## What the mobile side does

Open the link and that's the whole interface: one input box, and the latest reply.

**Send instructions.** Type and send; the AI starts working on the computer.

**Wait for the conclusion.** While it runs, the page shows "running…". You can keep sending during that time — instructions queue up. When the task ends, the conclusion appears on the page, and the phone chimes and buzzes.

**Two display modes.** Tap the ⚙ in the top right to switch. "Single frame" (the default) keeps only the newest reply on screen — good for "I just want to see how this one turned out". "Chat" is a back-and-forth bubble list — good for several rounds of follow-up questions. Use it for a while and you'll know which you prefer.

**You're reading conclusions, not the process.** There's no tool-call chain, no file diff, no approval dialog on the page — **anything that needs your confirmation cannot be confirmed from the phone**; you have to go back to the computer. Nor will it start new sessions, switch models, or change configuration for you. It's a remote control: the TV still has to be on for the remote to be any use.

---

## FAQ

**The QR code scans but the page won't open.**
First check that the phone and the computer are on the same Wi-Fi.

**Scanning the "public" route from outside won't open.**
Wait half a minute and try again. If it still won't, the pairing page shows the reason directly. The most common one is **a proxy or VPN running on the computer** — the "TUN mode" in tools like Clash cuts the tunnel's connections; the process looks fine while not a single connection has actually been established. Turn it off and try again. Another possibility: that network simply can't reach Cloudflare (it's intermittent in mainland China, and not something you misconfigured). If so, don't burn time on the public route — **switch to the Tailscale route**.

**It says "disconnected".**
This happens often after the phone has been in the background. The page reconnects by itself; give it a few seconds. If that doesn't work, open settings and tap "Reconnect".

**The reply arrives but there's no sound.**
Audio only plays after you've touched the page once. Tap it.

**The phone keeps asking for a password.**
That means the link you opened didn't carry one — for example, you typed the address by hand. Go back to the computer and scan the QR code again.

**I want a password I can remember.**
Change it in the password section of "Settings → Phone Remote". **At least 12 characters.** A DSH restart is required afterwards, and the phone has to scan a new code.

---

## Security

**The pairing page carries the password — don't screenshot it and send it around.** The password is encoded straight into the QR code so you never have to type it. That's convenient, and the price is that whoever holds that image can get in.

Beyond that: every endpoint requires the password; password comparison is constant-time; five wrong attempts from one source blocks that source for a minute; pairing information is **readable only from the local machine**, so other devices on the same Wi-Fi can't get it; the public tunnel is off by default and you have to turn it on yourself in the settings page; and the phone has no access to your filesystem.

---

## Credits

This plugin's design draws on [dsh-pocket](https://www.npmjs.com/package/dsh-pocket) by shaobeichen — in particular the shape of the configuration page, where each connection route gets its own link, its own QR code, and its own password.

## License

MIT
