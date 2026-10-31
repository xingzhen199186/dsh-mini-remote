<div align="center">

# 极简遥控器 · dsh-mini-remote

<p align="center">
  <img src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/promo.webp" alt="极简遥控器：在手机上按需查看指令、结论与执行过程" width="720" />
</p>

**把 DeepSeek Harness 带到手机上，也带到另一台电脑上。**

[![npm](https://img.shields.io/npm/v/dsh-mini-remote)](https://www.npmjs.com/package/dsh-mini-remote)
[![Node.js](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen)](https://nodejs.org/)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.2%20%3C0.3.0-blue)](https://github.com/deepseek-ai/DeepSeek-Harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.en.md) · [简体中文](README.md)

</div>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#ai-配置向导">AI 配置</a> ·
  <a href="#连接方式">连接方式</a> ·
  <a href="#核心能力">核心能力</a> ·
  <a href="#设置页">设置页</a> ·
  <a href="#排障">排障</a> ·
  <a href="#安全边界">安全边界</a> ·
  <a href="#文档">文档</a>
</p>

---

## 这是什么

极简遥控器是一个运行在 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/DeepSeek-Harness) 里的插件。它主要解决三件事：

- **手机遥控**：在手机浏览器里查看会话、发送指令、回答问题或处理审批，不必把整个桌面界面挤进小屏。
- **远程窗口**：在另一台电脑的 DSH 桌面端直接打开这台电脑的完整界面。
- **A/B 跨机协作**：A 端保留会话和模型，通过 `b_*` 工具读写 B 端文件、执行命令；B 端本地决定授权范围。

连接方式可以从内网、Tailscale 一路扩展到固定地址和自建中继。不熟悉网络配置时，可以让插件内置的 AI 向导带着走。本文对应当前 `0.2.6` 仓库。

---

## 快速开始

### 环境

- **Node.js**：`^22.19.0 || >=24.0.0`
- **DSH**：`>=0.1.5-rc.2 <0.3.0`
- **系统**：Windows、macOS 或 Linux

当前版本在 DSH `0.2.1-rc.5` 上复核过，并适配 rc.5 的 `getOrigin()` 端口回退。各版本改了什么，见 [CHANGELOG.md](CHANGELOG.md)。

### 安装

#### 途径一：DSH 桌面端图形化安装（推荐）

1. 点击 DSH 顶部导航栏的「插件」按钮进入插件管理页面。
2. 点击页面右上角的「添加插件」按钮打开对话框。
3. 在输入框中输入插件包名 `dsh-mini-remote`。也可输入 GitHub 仓库地址 `github:xingzhen199186/dsh-mini-remote` 或本地目录路径；安装源保持默认的「npm 官方源」。
4. 点击对话框底部的「安装」按钮完成安装。

> ⚠️ **注意**：
> 1. **确认来源可信**：插件在本机以当前用户的完整权限运行，来源不明的插件可能损坏 DeepSeek Harness，或读取和泄露敏感数据。
> 2. **暂不支持自动更新**：插件安装后暂不支持自动更新。升级版本前，先卸载当前版本，再安装新版本。

#### 途径二：从官方 npm 注册表安装（命令行）

在终端中执行对应命令。`web` 为 DSH 默认 Profile 名称；使用自定义配置档时替换为对应名称：

```powershell
dsh plugin --profile web add dsh-mini-remote
```

#### 途径三：从 GitHub 仓库直接安装

```powershell
dsh plugin --profile web add github:xingzhen199186/dsh-mini-remote
```

#### 途径四：本地目录安装（开发者调试）

```powershell
dsh plugin --profile web add C:\path\to\dsh-mini-remote
```

### 启动与服务确认

1. 重启 DSH 服务（关闭当前 `dsh web` 窗口并重新运行）。
2. 查看控制台启动日志。插件会输出初始化信息、本机监听端口与访问口令：

   ```text
   [dsh-mini-remote] 已启动：http://127.0.0.1:3090/mini?token=xxxxxxxxxxxx
   ```

3. 打开 DSH 桌面端界面，进入「设置」→ 左侧导航选择「遥控设置」，查看配对二维码与连接详情。

> **手机端只有浏览器网页这一种形态。** 扫码并用浏览器打开即可，没有独立 App 或小程序。页面可以「添加到主屏幕」，图标打开时为全屏显示，实际仍由浏览器运行。更换手机或清除浏览器数据后，需要重新扫码配对。
>
> 同一地址也能在 PC 浏览器中打开；开启「进阶设置」后，还可在其中使用完整的 DSH 电脑端界面。
>
> **怎样确认启动成功**：设置页出现「遥控设置」标题、连接地址与二维码；控制台出现 `[dsh-mini-remote] 已启动` 行。若只有控制台输出而设置页为空，先刷新或重启 DSH，再检查「诊断与高级」里的自检。

### 连接手机

1. 打开 DSH「设置」→「遥控设置」。顶部的「手机连接」始终显示。
2. 手机与电脑在同一 Wi-Fi 时，直接扫描「内网」二维码。
3. 不确定该选哪条路时，点击顶部的「让 AI 带我配置」，按提示操作。
4. 手机页面能打开会话列表，且「电脑与设备」里出现这台手机，即连接成功。

> **地址等同于凭据。** 二维码和复制出的地址包含入场口令，持有者可以登记设备并操作这台电脑。不要截图外发、投屏或粘贴到公开位置。撤销设备后，需要重新扫码。

---

## 效果预览

<div align="center">
  <img width="290" alt="手机聊天界面（深色）：按气泡排列历史" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/screen-chat-dark.png" />
  <img width="290" alt="手机聊天界面（浅色）：同一段对话在浅色主题下按气泡排列" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/screen-chat-light.png" />
  <img width="290" alt="手机完整模式：工具调用与对话按时间顺序展开" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/screen-full-dark.png" />
</div>

<div align="center">
  <img width="680" alt="远程窗口：在另一台电脑的 DSH 面板中嵌入完整界面" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/remote-window.png" />
</div>

---

## AI 配置向导

插件包内已经带有 `dsh-mini-remote-setup` 技能和 [docs/guide/](docs/guide/) 知识库，**不需要单独安装技能**。

1. 在「遥控设置」顶部点击「让 AI 带我配置」。插件会打开新会话，并把配置提示词填进输入框；按发送后向导才开始工作。
2. 也可以直接在会话里说「帮我配置手机遥控」，或描述「手机连不上」「要固定地址」等具体问题。
3. 向导会先调用只读工具 `mini_remote_status`，查看端口、地址、隧道与中继状态，再判断场景并**一次只问一个问题**。
4. 每一步都会说明要点的位置和做完后应看到的结果。当前环境不能自动打开新会话时，按钮会复制提示词，粘贴到新会话即可。

覆盖范围包括：手机连接与密码、所有连接方式、电脑与设备、A/B 端协作、B 项目、飞书、自检与进阶设置、远程窗口，以及参数生效方式。

向导优先读取随插件版本发布的 `docs/guide/`，只有本地文档不可用时才以 GitHub 仓库兜底。

**安全边界**：不读取或复述密码、token、frp token 和设备凭据；不自动重启 DSH；不删除设备、不撤销租户、不删除服务器资源；不修改 Cloudflare、防火墙、DNS 或域名解析。高风险操作只提供步骤，由用户自己确认。

---

## 连接方式

先选一条能走通的，再考虑固定地址。手机和电脑在同一 Wi-Fi 时用内网；其余场景按是否需要安装客户端、是否需要固定网址来选择。

| 方式 | 适合 | 前提与代价 | 详情 |
| :--- | :--- | :--- | :--- |
| **内网** | 同一 Wi-Fi | 无额外依赖；明文 HTTP，离开局域网即失效 | [01-内网](docs/guide/01-内网.md) |
| **Tailscale** | 出门也要用，能装客户端 | 两端登录同一账号；可选 HTTPS，加密地址依赖 MagicDNS | [02-Tailscale](docs/guide/02-Tailscale.md) |
| **Cloudflare 公网** | 临时使用，或用自己的域名做固定地址 | 临时地址每次重启变化；固定地址需要 Cloudflare 账号和域名；流量经 Cloudflare | [03-公网隧道](docs/guide/03-公网隧道.md) |
| **共享固定地址** | 要固定网址，但不想维护服务器 | 需要快速隧道和服务方邀请码；流量经共享中继，不是端到端加密 | [04-共享固定地址](docs/guide/04-共享固定地址.md) |
| **专属固定地址（B 中继）** | 服务方分配固定域名或开放自服务 | 一次性激活码；服务方代建命名隧道，停止不会自动删除服务端资源 | [05-专属固定地址](docs/guide/05-专属固定地址.md) |
| **自建中继（单用户）** | 有自己的服务器和域名 | 两个域名、frp token；地址固定，服务器和证书自行维护 | [06-自建中继](docs/guide/06-自建中继.md) |
| **自建多用户中继** | 多人各自使用 | 管理员部署 `relay-multi` 并发邀请票；流量只经过管理员服务器 | [07-自建多用户中继](docs/guide/07-自建多用户中继.md) |
| **飞书** | 只通过企业 IM 使用 | 配置飞书自建应用；不需要公网入站，当前只处理单聊和审批 | [13-飞书通知](docs/guide/13-飞书通知.md) |

> 「B 中继」指服务方的 B 控制面，不是 A/B 端协作里的 B 端电脑。完整的选路逻辑见 [00-先选一条路](docs/guide/00-先选一条路.md)。

---

## 核心能力

- **手机页面**：单帧、聊天、完整三种视图；支持队列、斜杠指令、选择题、审批和会话管理。详见 [09-手机连接与密码](docs/guide/09-手机连接与密码.md)。
- **远程窗口**：在另一台电脑的 DSH 桌面端打开本机完整界面。详见 [15-远程窗口](docs/guide/15-远程窗口.md)。
- **A/B 端协作**：A 端使用 `b_*` 操作 B；B 端本地控制目录、写入、文件夹管理和命令权限。重新配对会按 `machine-id` 复用原记录。详见 [11-A/B 端协作](docs/guide/11-A-B端协作.md)。
- **B 项目**：把 B 端真实目录登记为 A 端工作区，不复制文件；提供 B 文件面板和「新建 B 会话」。详见 [12-B 项目](docs/guide/12-B项目.md)。
- **飞书双向遥控**：通过长连接收发文本、回答选择题和审批。详见 [13-飞书通知](docs/guide/13-飞书通知.md)。
- **设备管理**：手机和电脑分别登记，可改名、撤销、清理 30 天未使用；撤销后必须重新扫码。详见 [10-电脑与设备](docs/guide/10-电脑与设备.md)。

---

## 设置页

顶部「手机连接」始终显示；下方五个分组默认收起，组内小分类（例如「连接与固定地址」里的各个入口）也默认收起。

| 区域 | 主要内容 |
| :--- | :--- |
| **手机连接** | 地址、二维码、密码 |
| **连接与固定地址** | Tailscale、公网访问、共享固定、专属固定、自建中继、自建多用户中继、Tailscale HTTPS |
| **电脑与设备** | 允许别的电脑连接、设备名单、其他电脑 |
| **A/B 端协作** | 作为 A 端、作为 B 端、B 项目 |
| **通知与集成** | 飞书、凭据、白名单、配置指引 |
| **诊断与高级** | 自检、最近错误 |

所有复制入口统一显示短暂的「已复制」反馈。多用户中继的「清空本地配置」只清理本机身份和 frpc 配置，不释放服务器上的租户或固定地址；需要彻底回收时由管理员在后台处理。设置项的完整说明见 [14-自检与进阶设置](docs/guide/14-自检与进阶设置.md) 与 [16-参数与生效方式](docs/guide/16-参数与生效方式.md)。

---

## 排障

| 现象 | 先检查 |
| :--- | :--- |
| B 端显示「还没连上 A」 | 等待一个 5 秒刷新周期，再按 `Ctrl+F5`；仍不成功时检查 A 的地址、开关和端口 |
| 远程窗口返回 HTTP 502 | 在 A 端执行 `tailscale serve status`，代理应指向当前手机服务端口；默认是 `3090`，不是旧 `3091` |
| 固定地址或中继连不上 | 查看状态、邀请票/激活码是否已用过，以及服务端资源是否仍在 |
| 手机页面被撤销后进不去 | 设备授权已被移除，需要回到「遥控设置」重新扫码 |

`tailscale serve status` 的代理目标应类似：

```text
https://<机器名>.<tailnet>.ts.net
  -> http://127.0.0.1:3090
```

如果 `3090` 被占用，以「诊断与高级」→「自检」显示的「在听端口」为准。修改后，在 A 端「连接与固定地址」将「Tailscale HTTPS」关闭再开启即可重新配置。

更完整的症状表和检查步骤见 [08-连不上怎么办](docs/guide/08-连不上怎么办.md)。

---

## 安全边界

- **地址与设备**：地址含入场口令；撤销设备后必须重新扫码。不要公开二维码、密码或带口令的地址。
- **公网与第三方**：Cloudflare、共享固定中继和 B 专属固定都会让流量经过第三方；临时域名变化不是安全边界。自建和多用户中继也会让服务器运营者看到明文。
- **插件权限**：插件以当前用户权限运行，只应安装可信来源的包；来源不明的插件可能读取文件或泄露凭据。
- **完整界面**：「进阶设置」和远程窗口会暴露完整 DSH 管理面，包括模型配置、凭据、插件和会话记录，只应对可信设备开放。
- **命令执行**：手机「完全权限」和 B 端命令权限都能执行系统命令；模型层 `confirm` 不是人工审批，真正的边界是本地权限开关。
- **资源回收**：停止连接或清空本地配置不等于删除服务器资源；固定地址、租户和隧道需要按对应文档单独回收。
- **公网承诺**：本插件不承诺公网部署安全。启用公网或第三方中继前，应自行评估网络环境、访问控制和主机安全。

---

## 开发与验证

```bash
npm test
node client/verify.mjs
```

- `npm test`：离线测试，不要求 DSH 正在运行。当前 **1293 通过，0 失败**。
- `node client/verify.mjs`：验证客户端模块、设置页、两级折叠、远程窗口和 B 项目面板。当前 **162 通过，0 失败**。
- 发布前可运行 `npm pack --dry-run` 检查打包内容。

详细变更见 [CHANGELOG.md](CHANGELOG.md)，发版流程见 [发版清单](docs/发版清单.md)。

---

## 文档

- **完整指南**：[docs/guide/](docs/guide/)（00–16）。连接、密码、设备、A/B、B 项目、飞书、自检、远程窗口和参数都在这里。
- **AI 向导**：[SKILL.md](SKILL.md)。
- **自建中继服务器**：[relay-server/README.md](relay-server/README.md)。
- **多用户中继服务器**：[relay-multi/README.md](relay-multi/README.md)。
- **项目主页**：[github.com/xingzhen199186/dsh-mini-remote](https://github.com/xingzhen199186/dsh-mini-remote)。
- **问题反馈**：[Issues](https://github.com/xingzhen199186/dsh-mini-remote/issues)。

---

## 开源协议

本项目采用 [MIT 许可证](LICENSE) 开源。

### 致谢

本项目在通道交互和配对界面设计上参考了 [dsh-pocket](https://www.npmjs.com/package/dsh-pocket)（作者 @shaobeichen）的多路径独立二维码构思。
