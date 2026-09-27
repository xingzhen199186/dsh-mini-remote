# Minimal Remote · dsh-mini-remote

[![npm](https://img.shields.io/npm/v/dsh-mini-remote)](https://www.npmjs.com/package/dsh-mini-remote)
![DSH plugin](https://img.shields.io/badge/DSH_plugin-dsh--plugin-blue)
![License](https://img.shields.io/badge/license-MIT-green)

[中文说明](README.md)

![Minimal Remote: only your instruction and the AI's conclusion reach the phone; everything in between stays on the computer](https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/promo.webp)

**You send one line; the phone gets one conclusion.**

Tool calls, file reads and writes, sub-agent dispatch, and the body of the reasoning trace never reach the phone. This plugin exists for one situation: you're out, and all you want to do is send an instruction and read the result — a phone, one input box, the latest reply.

[What it is](#what-it-is) ・ [When you'd use it](#when-youd-use-it) ・ [Install](#install) ・ [Connecting your phone](#connecting-your-phone-three-routes-pick-one) ・ [What the phone can do](#what-the-phone-can-do) ・ [FAQ](#faq) ・ [Security](#security) ・ [Why I built this](#why-i-built-this-plugin)

---

## What it is

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH, a plugin-extensible AI agent framework). Once installed:

- a web page opens on your phone with exactly one input box and the latest reply;
- instructions you send from the phone go straight to the session already running on your computer;
- everything in between — tool calls, files read and written, sub-agents, the reasoning trace itself — **is never pushed to the phone**;
- the only thing that "talks" is the whale girl: the line the model mutters between steps, spoken in her speech bubble.

Here is what the interface looks like — dark and light, switchable in settings (rendered at a phone size of 390×844):

<img width="290" alt="Dark: one conversation, carrying only your instruction and the conclusion" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/screen-dark.png" /> <img width="290" alt="Light: the same conversation, in the palette taken from the promo artwork" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/screen-light.png" />

It is **not** a second screen for the desktop interface. Approval dialogs, file diffs and tool-call chains exist on the computer and nowhere on the phone — deliberately. It does very little.

Other phone clients copy the computer's execution process over to the phone in full. This one does the opposite: **it sends only the two lines you asked for.** That is the single biggest difference between it and them.

## When you'd use it

- **You're out and a task is still running.** The computer is at your desk mid-round; you just want to glance at the phone to see whether it finished, and hand it the next line while you're at it.
- **You're with your kid, eating, or out for a walk.** You don't want to touch the computer, but an idea shows up and you'd like it working on that already.
- **The computer is in the study and you're in the living room.** Not worth walking back, and not worth pulling that whole screen of process onto the phone.

---

## Install

```powershell
dsh plugin --profile web add dsh-mini-remote
```

**You must restart DSH once after installing** (close the `dsh web` window and start it again), or "Phone Remote" will not appear in the left column. The startup log then prints the phone URL and password.

The `web` in that command is a DSH **profile name** — the folder under `~/.dsh/profiles/`. Most people's default profile is called `web`; if yours isn't, use your own name instead.

<details>
<summary>Installing from GitHub source, from a local folder, and which DSH versions it fits</summary>

Or straight from GitHub, if you would rather pin the source:

```powershell
dsh plugin --profile web add github:xingzhen199186/dsh-mini-remote
```

If you already have the source on disk, you can point it at the folder:

```powershell
dsh plugin --profile web add <the folder you put the source in>
```

**Which DSH versions it fits.** This plugin was developed on DSH **0.1.5-rc.2** and re-checked item by item on **0.1.7-rc.2** (every interface it uses was unchanged); **versions below 0.1.5 have not been tried**. `rc` is the tag the project puts on preview builds, and DSH as a whole is still a developer preview — minor versions may break things, so versions newer than 0.1.7 are not guaranteed either. If it ever does hit an incompatibility, the usual symptom is one entry point going missing (the model line at the top, say) while everything else keeps working: the plugin is written so that a missing service switches off that one feature rather than the whole thing.

Settings follow the same rule: the settings are declared the standard DSH way, and on the 0.1.5-era library that ability does not exist yet — the plugin **still installs and works exactly as before**, it just loses the "applies immediately" behaviour mentioned below. On the **0.1.7 generation** that ability is fully there.

</details>

---

## Connecting your phone: three routes, pick one

All three connection methods **exist at the same time**. Pick one, or leave several on.

| Route | When to use it | What you install | What it costs |
| --- | --- | --- | --- |
| **LAN** | Phone and computer on the same Wi-Fi — at home only | Nothing at all | It stops the moment you leave the house |
| **Tailscale** | You need it outside, and you want the address to stay fixed | Tailscale on the computer and on the phone | An app on both sides |
| **Public tunnel** | Nothing installed, reachable on any network | Nothing at all | The address changes on every restart; the first run downloads a ~50 MB component |

Open DSH settings (bottom of the sidebar) → "Phone Remote" in the left column. Every route on that page has a QR code and a link, and the small text under each QR code says **when to use that route**. That's all you need to read.

The plugin's own settings (default mode, external notifications, port, password and so on) also have a standard declaration, so writing them in DSH's standard configuration works too. If the same item is set in both places, **the standard configuration wins**. One difference worth knowing: **"default mode" and "external notifications" apply immediately, with no plugin restart**; port, bind address, tunnel, password and history length make the plugin restart and the phone reconnect once — those genuinely need to re-bind or rebuild, and the plugin says so instead of pretending they can be changed live.

### 1. LAN: at home only

When the phone and the computer are on the same Wi-Fi, scan the "LAN" code and you're in. **Nothing extra to install** — the least fuss of the three. The cost is that it stops working the moment you leave: the phone switches to mobile data and this route is gone.

### 2. Tailscale: works outside, and the address stays fixed

Install [Tailscale](https://tailscale.com) on both the computer and the phone, sign in to the same account, and this route appears on the pairing page by itself. The address is fixed — set it up once and forget it. The cost is an app on each side; if you don't mind installing it, **this is the steadiest route when you're out**.

There's a switch on the pairing page that gets you an encrypted address as well (shaped like `https://your-machine.your-tailnet.ts.net/`). It is **the same computer over the same tunnel** as the entry above; the only difference is that the connection is encrypted. It is not a fourth route — the plain `http://` entry keeps working and keeps showing.

The first time, you have to confirm it in Tailscale's admin console: it is a tailnet-wide switch, and the plugin cannot click it for you. So the pairing page puts the exact link Tailscale hands out right in front of you — one click and you're there. If this computer isn't signed in to Tailscale yet, it says so and gives you a sign-in link instead.

### 3. Public tunnel: nothing to install

There's a switch at the bottom of the pairing page. Turn it on and Cloudflare hands you a public URL (shaped like `https://random-words.trycloudflare.com/`). The phone can reach it on any network, **with nothing installed**.

Two costs, worth knowing before you decide:

- **The address changes every time you restart DSH.** When it does, come back and scan the new code.
- **The first time is slow** — it's downloading a component of about 50 MB, and only that once. While it does, the status line reads "opening…", which is normal, not a hang. Registration occasionally fails; the plugin retries three times on its own.

Once it's on, **wait half a minute before scanning.** Cloudflare needs a moment to publish the address. Scanning too early reports that it can't be opened — that's not breakage, it's just too soon.

### About that "encrypted address"

Two of the routes above can hand you an `https://` address, and what encryption covers is **the connection itself**: the address bar shows the https padlock, and what travels the wire is encrypted. That does not depend on which route you pick — both give the same thing.

The difference is who can resolve the name. The Tailscale one uses a name shaped like `your-machine.your-tailnet.ts.net`, and **that name only resolves inside your Tailscale network**, via MagicDNS on the phone's client. **But some clients don't have that capability** — MeshArc, the third-party client for HarmonyOS, states in its own README that you should use Tailscale IP addresses instead; on such a phone this encrypted route simply won't work, and it isn't a matter of a setting being switched off. The tunnel route uses a Cloudflare name that resolves for anyone and doesn't care about the phone; its cost is that the address changes on every restart.

---

## What the phone can do

Open the link and that's the whole interface: one input box, and the latest reply.

**Send instructions.** Type and send; the AI starts working on the computer.

**Wait for the conclusion.** While it runs, the page shows "running…". You can keep sending during that time — instructions queue up. When the task ends, the conclusion appears on the page, and the phone chimes and buzzes.

**She speaks up while she works.** On the computer, the model often mutters a line between steps ("let me look at this file first"). That line is now spoken by the whale girl through her speech bubble — the talking pose is a newly drawn sprite, the rotation pauses for it, and afterwards picks up from where it stopped. It stays **in the bubble** and never bleeds into the answer area below. Only the line it deliberately writes *for a human reader* is spoken; its own working thoughts — often English, often a whole paragraph — never reach the phone at all. Should that one narration line itself be in English, it is shown as-is, untranslated (translating would mean putting words in its mouth).

**Two appearances, switchable anytime.** Settings has an "Appearance" row: **Dark** (the default), **Light**, and **Follow system**. Dark is deep-sea navy; the light palette is taken from the promo artwork — near-white ice blue for the ground, deep royal blue for the text, and the same royal blue on primary buttons. Your choice is stored on the phone, so it is still there next time you open the page.

<img width="290" alt="Settings (dark): display mode and appearance" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/settings-dark.png" /> <img width="290" alt="Settings (light): the selected states and the primary button turn royal blue too" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/settings-light.png" />

**Two display modes.** Tap the ⚙ in the top right to switch. "Single frame" (the default) keeps only the newest reply on screen — good for "I just want to see how this one turned out". "Chat" is a back-and-forth bubble list — good for several rounds of follow-up questions. Use it for a while and you'll know which you prefer.

**Open a session and you see what was said in it before.** Switch to a session that has existed for a while and Chat mode lists every earlier round (the instructions you sent, the conclusion of each round); Single frame shows only the last conclusion. **Very large sessions show only the most recent stretch**: reading one of those in full — tens of thousands of events — would drag the DSH process on your computer down, so the plugin reads just the tail and says so at the top ("this is not everything, only the most recent stretch"). That line is not boilerplate; it is the truth.

**Slash commands work from the phone too.** Type a `/` in the input box and the commands available in this session appear above it; keep typing to filter by name, tap one to run it, and commands that take arguments get filled in for you along with a note on what they expect. The list is DSH's own on your computer (whatever plugins are installed), and a command's result gets its own row in the chat, visually distinct from what the AI said. A mistyped or unknown command is refused with an explanation — it is **not** sent as a message. When the session is not running there are no commands to list, and the page says so. **Commands cannot carry attachments** in this version: files you have attached stay put and go out with your next ordinary message.

**Answer questions from the phone.** When the AI asks you to pick something (choose one of several plans, say), the question is pushed to the phone and a tap answers it — **one at a time, revisable if you change your mind, and you can type your own answer** when none of the options fit. If nobody is at the phone (locked, page closed, network gone), the question goes straight back to the computer and the dialog pops up there as usual.

**Three things you can change in passing.** Tap the line at the top to switch the current session's model and reasoning effort; switch the permission preset (View Only / Workspace Write / Full Access); browse the computer's folders to register a new workspace and start a session in it.

**You're reading conclusions, not the process.** There's no tool-call chain and no file diff on the page. The one exception is the line the whale girl says out loud — it goes into her bubble, never into the answer area (see above). **System-level confirmation dialogs cannot be answered from the phone** (approving a dangerous command, for instance) — those still need the computer. What the phone can answer is the multiple-choice question the AI puts to you; the two are not the same thing. It's a remote control: the TV still has to be on for the remote to be any use.

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

Beyond that: every endpoint requires the password; password comparison is constant-time; five wrong attempts from one source blocks that source for a minute; pairing information is **readable only from the local machine**, so other devices on the same Wi-Fi can't get it; the public tunnel is off by default and you have to turn it on yourself in the settings page; the phone sees no file contents — when you pick a workspace it lists folder names only, and never lists or reads files. **The one exception is images**: when something the AI wants to show you includes a picture (an interface screenshot, say), that image is placed under the plugin's `lib/art/` directory with a name starting with `out-`, and the page fetches it over the same password-protected image route the sprites use. Only that one class of file — an image, with that prefix — can be fetched; message bodies, configuration files and everything else stay unreadable, and directories still cannot be listed. **One thing worth stating plainly: the phone can switch the agent's permission preset.** On Full Access, the agent can then modify any file on this computer. That path is open.

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

## Credits

This plugin's design draws on [dsh-pocket](https://www.npmjs.com/package/dsh-pocket) by shaobeichen — in particular the shape of the configuration page, where each connection route gets its own link, its own QR code, and its own password.

## License

MIT
