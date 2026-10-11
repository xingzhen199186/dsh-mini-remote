<div align="center">

# 极简遥控器 · dsh-mini-remote

<p align="center">
  <img src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/promo.webp" alt="极简遥控器：手机上只留你的指令和它的结论，过程想看的时候再调出来" width="720" />
</p>

**专为 DeepSeek Harness（DSH）桌面端用户打造的轻量级移动端遥控插件，解决外出离机时查看 Agent 运行状态与下发指令时界面冗余、注意力被大量中间过程绑架的痛点。**

[![npm](https://img.shields.io/npm/v/dsh-mini-remote)](https://www.npmjs.com/package/dsh-mini-remote)
[![Node.js](https://img.shields.io/badge/node-%5E22.19.0%20%7C%7C%20%3E%3D24.0.0-brightgreen)](https://nodejs.org/)
[![DSH](https://img.shields.io/badge/DSH-%3E%3D0.1.5--rc.2%20%3C0.3.0-blue)](https://github.com/deepseek-ai/DeepSeek-Harness)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

[English](README.en.md) · [简体中文](README.md)

</div>

<p align="center">
  <a href="#背景与痛点">背景与痛点</a> ·
  <a href="#核心特性">核心特性</a> ·
  <a href="#效果预览">效果预览</a> ·
  <a href="#快速上手">快速上手</a> ·
  <a href="#使用示例与配置">使用示例与配置</a> ·
  <a href="#路线图">路线图</a> ·
  <a href="#贡献指南">贡献指南</a> ·
  <a href="#开源协议">开源协议</a>
</p>

---

## 背景与痛点

在日常使用桌面端 Agent 执行复杂工程任务时，一次交互往往涉及数分钟的深度思考、几十次文件读写与密集的工具链调用。现有的移动端远程方案通常选择将桌面端界面完整映射至手机屏，引发以下实际问题：

- **信息密度失衡**：大量原始推理细节、工具调用入参以及代码差异充满小屏，关键结论被淹没。
- **注意力过度消耗**：外出通勤、就餐或离机休憩时，用户核心诉求仅为确认当前轮次是否结束，并下达下一阶段指令，无暇逐行审查中间步骤。
- **网络与权限适配单一**：纯内网方案出差无法访问，中心化云端转发则引入额外的凭据托管风险。

**极简遥控器**由此设计：手机界面默认仅保留「你的输入」与「AI 最终结论」，彻底屏蔽执行噪声；同时支持随时展开完整轨迹，将注意力支配权交还给用户。

---

## 核心特性

- 🎛️ **三档按需呈现模式**：提供「单帧」（整屏仅留最新结论，极度清爽）、「聊天」（常规气泡对话流）与「完整」（按原有时序就地展开工具调用与文件差异，支持关键词检索）三档视图，随时无缝切换。
- 🌐 **多通路安全连接**：内置本地局域网（LAN）、Tailscale 私网（支持 MagicDNS 与 HTTPS 证书）以及 Cloudflare 公网隧道（无公网 IP 场景）三种模式，各通道并存且独立提供二维码与访问口令。
- 🐬 **拟人化轻量状态流**：提取步骤之间的关键旁白由鲸鱼娘气泡念出，实时呈现队列刻度尺与计时进度，彻底过滤底层原始推理块。
- 💬 **飞书长连接双向遥控**：基于飞书开放平台 WebSocket 长连接直连桌面端，无需公网 IP 即可实现纯文本交互、选择题回复以及 `/会话` 切换。
- 🗂️ **移动端就地会话治理**：在移动端支持会话重命名、置顶排序、安全归档以及从指定轮次派生新会话（Fork），并明确提示待审批与待回答事件。
- 🔒 **严格的安全与防御边界**：所有接口均实施定长字符串口令校验，防范时序侧信道攻击；配置防暴力破解阈值（1 分钟内试错 5 次锁定 1 分钟）；严禁移动端跨目录读取任意文件；配对信息仅限电脑本机回路读取。

---

## 效果预览

### 对话界面（单帧 / 聊天）

移动端页面使用原生 JavaScript 开发，无前端构建负担，支持深海墨蓝（深色）与冰蓝宝蓝（浅色）两套高对比度主题：

<div align="center">
  <img width="290" alt="深色：一段对话，一来一回排成气泡，手机上只留你的指令和它的结论" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/screen-dark.png" />
  <img width="290" alt="浅色：同一段对话，色调跟宣传图那张画统一" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/screen-light.png" />
</div>

### 设置面板与外观切换

通过右上角设置随时切换呈现模式、外观主题与网络重连控制：

<div align="center">
  <img width="290" alt="设置（深色）：显示模式三选一、外观选中深色" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/settings-dark.png" />
  <img width="290" alt="设置（浅色）：选中态和主按钮都跟着换成宝蓝" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/settings-light.png" />
</div>

### 真机执行状态

任务运行中动态展示拟人化跑动状态、耗时计时器与排队刻度尺，消除不可知等待：

<div align="center">
  <img width="290" alt="执行中（深色，手机实拍）：鲸鱼娘正在跑、已计时 15 秒" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/running-dark-phone.jpg" />
  <img width="290" alt="执行中（浅色，手机实拍）：鲸鱼娘正在跑、已计时 7 分 43 秒、队列排着一条" src="https://raw.githubusercontent.com/xingzhen199186/dsh-mini-remote/main/docs/running-light-phone.jpg" />
</div>

---

## 快速上手

### 环境依赖

安装前请确认宿主环境满足以下依赖规范：

- **Node.js**：`^22.19.0 || >=24.0.0`
- **DSH（DeepSeek Harness）**：`>=0.1.5-rc.2 <0.3.0`
- **操作系统**：Windows、macOS 或 Linux

> ⚠️ **注意**：DSH 处于活跃迭代期，本插件核心功能在 `0.1.5-rc.2`、`0.1.7-rc.2`、`0.2.0-rc.1` 及 `0.2.0-rc.2` 上完成全量验证。对于低于 `0.1.5` 的历史版本未作兼容承诺；高于 `0.3.0` 的版本存在上游底层接口破坏风险。

### 安装步骤

在终端中执行对应的安装命令。命令中的 `web` 为 DSH 默认 Profile 名称，若使用自定义配置档，请替换为对应名称：

#### 途径一：从官方 npm 注册表安装（推荐）

```powershell
dsh plugin --profile web add dsh-mini-remote
```

#### 途径二：从 GitHub 仓库直接安装

```powershell
dsh plugin --profile web add github:xingzhen199186/dsh-mini-remote
```

#### 途径三：本地目录安装（开发者调试）

```powershell
dsh plugin --profile web add C:\path\to\dsh-mini-remote
```

### 启动与服务确认

1. 重启 DSH 服务（关闭当前 `dsh web` 窗口并重新运行）。
2. 查看控制台启动日志，插件将输出初始化就绪信息、本机监听端口与动态访问令牌：
   ```text
   [dsh-mini-remote] 已启动：http://127.0.0.1:3090/mini?token=xxxxxxxxxxxx
   ```
3. 打开 DSH 桌面端界面，进入「设置」→ 左侧导航选择「手机遥控」，即可查看配对二维码与连接详情。

---

## 使用示例与配置

### 连接通道对比与选型

依据当前网络拓扑选择最合适的接入通路：

| 通道类型 | 适用场景 | 依赖条件 | 特性与代价 |
| :--- | :--- | :--- | :--- |
| **局域网（LAN）** | 手机与电脑处于同一 Wi-Fi 子网 | 无额外客户端 | 配置即用；脱离当前局域网后立即断开 |
| **Tailscale** | 跨地域移动访问，要求网络地址稳定 | 电脑与手机均安装并登录 Tailscale | 固定私网 IP；可额外申请 Tailscale HTTPS 证书 |
| **公网隧道** | 无公网 IP 且不便安装任何额外客户端 | 需开启 Cloudflare 隧道开关 | 每次重启 DSH 自动更换临时二级域名；初次开启下载约 50 MB 运行组件 |
| **飞书长连接** | 仅依赖企业 IM，完全脱离浏览器 | 配置飞书自建应用机器人凭据 | 无需公网暴露，通过长连接双向收发，支持移动审批 |

### 移动端页面操作指引

- **指令发送与排队**：在底部输入框输入文字并发送。若 Agent 正处于执行中，后续消息自动进入有序队列，并在刻度尺中高亮展示。
- **斜杠指令交互**：输入 `/` 呼出当前会话绑定的系统级指令列表，支持按键过滤与参数提示。
- **多选提问与确认**：当 Agent 发起选项询问时，页面弹出答题卡，支持点选、改选或自定义输入补充文本。
- **回到底部**：在长文本翻阅时，右下角自动浮出「回到底部」悬浮球（单帧模式下不触发）。
- **权限档位切换**：点击顶栏状态区，可在「仅可查看（read-only）」、「工作区内修改（workspace-write）」与「完全权限（danger-full-access）」之间切换。

> ⚠️ **注意**：
> 1. 将权限档位提升至「完全权限」意味着 Agent 具备任意文件与系统级指令执行能力，请务必谨慎操作。
> 2. 系统底层触发的危险命令权限审批弹窗属于宿主桌面端安全边界，手机端无法直接签署放行，必须返回电脑端核准。

### 进阶设置：内嵌桌面端界面

在设置面板中开启「进阶设置」后，将新增「电脑端界面」入口。点击后可在手机端以嵌入框架形式加载完整桌面版 Web 界面，以处理插件安装、模型配置修改与底层全量日志审计。

> ⚠️ **注意**：
> 开启电脑端界面将把移动端口令的访问面直接延伸至整个桌面控制台。开启时需完成二次安全确认。若宿主未分配或无法获取桌面端监听端口，该入口将自动熔断隐藏。

### 飞书机器人配置流程

1. 登录 [飞书开放平台](https://open.feishu.cn/) 创建企业自建应用。
2. 记录「凭证与基础信息」中的 `App ID` 与 `App Secret`。
3. 进入「添加应用能力」页面，添加「机器人」能力。
4. 进入「事件与回调」页面，配置事件订阅方式为「使用长连接接收事件」，并添加 `im.message.receive_v1` 事件。
5. 进入「权限管理」页面，检索并开通以下 3 项权限：
   - 接收消息（`im:message:receive_v1`）
   - 以应用身份发消息（`im:message:send_as_bot`）
   - 获取与发送单聊、群组消息（`im:message.group_at_msg:readonly` 等对应集合）
6. 创建并**发布应用版本**。
7. 返回 DSH 桌面端「设置」→「手机遥控」→「飞书」栏目，填入凭证并启用开关。首次交互机器人将在单聊中返回用户的 `open_id`，将其复制填入白名单保存后即可正常通讯。

### 核心配置参数表

配置项支持在 DSH 标准配置文件中声明，亦可通过桌面端「手机遥控」界面配置：

| 参数项 | 数据类型 | 默认值 | 生效方式 | 说明 |
| :--- | :--- | :--- | :--- | :--- |
| `port` | `number` | `3090` | 重启生效 | 遥控服务监听的本地 HTTP 端口（冲突时自动顺延） |
| `token` | `string` | *(随机生成)* | 重启生效 | 访问口令（支持手动修改，长度不得低于 12 位） |
| `defaultMode` | `string` | `"minimal"` | 即时生效 | 移动端默认呈现视图：`"minimal"`、`"chat"`、`"full"` |
| `externalNotify` | `boolean` | `true` | 即时生效 | 任务完成时是否触发系统通知音效与设备震动 |
| `tunnel.enabled` | `boolean` | `false` | 重启生效 | 是否启用 Cloudflare 临时公网隧道 |
| `tailscale.serve` | `boolean` | `false` | 重启生效 | 是否尝试配置并监听 Tailscale 专有 HTTPS 证书通道 |
| `feishu.enabled` | `boolean` | `false` | 即时生效 | 是否开启飞书应用长连接双向通道 |

---

## 路线图

- [x] 移动端单文件零依赖原生交互界面（`lib/page.html`）
- [x] 三档视图呈现模型（单帧 / 聊天 / 完整执行轨迹）
- [x] 多网络通道集成（LAN / Tailscale / Cloudflare Tunnel）
- [x] 飞书开放平台 WebSocket 长连接双向打通
- [x] 移动端会话全生命周期治理（Fork、重命名、置顶、归档）
- [x] 进阶桌面端全功能界面受控内嵌
- [x] 宿主升级自检脚本（`tools/structure-check.mjs`）
- [ ] 飞书通道富媒体交互卡片支持
- [ ] 飞书通道文件与多模态图片收发支持
- [ ] 移动端全局搜索与过滤体系增强

---

## 贡献指南

欢迎参与项目的演进。提交改动前请遵守以下协作规范：

### 提交流程

1. **Fork 本仓库** 到个人 GitHub 空间。
2. **新建特性分支**：
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **编写代码与规范说明**：确保修改范围聚焦，严格杜绝无关代码格式调整。
4. **运行本地工程校验**：
   ```bash
   npm test
   node client/verify.mjs
   ```
   提交前请确认自动化测试与客户端插槽校验全数通过。
5. **提交 Pull Request**：详细描述改动动因、实现方案与验证手段，等待代码审查合并。

### 维护者检查工具

在跟踪 DSH 宿主版本升级时，请在桌面端活跃状态下运行界面结构比对检查：

```bash
node tools/structure-check.mjs
```

该工具将自动比对活体 DOM 标记与 `tools/structure-deps.mjs` 中登记的依赖项；若发生结构漂移将以非零状态码退出并打印排查依据。

---

## 开源协议

本项目采用 [MIT 许可证](LICENSE) 进行开源。

### 相关文档与资源索引

- [立绘与动画工艺规范](docs/character.md)：记录图像生成工具、共享提示词模板、规格尺寸与验收标准。
- [立绘基准帧定义（2026-09-28 定稿）](docs/art-refs/2026-09-28/)：归档标准帧原图与全量提示词基线。
- [版本变更历史](CHANGELOG.md)：记录各阶段版本详细演进与问题修复依据。
- [项目代码仓库](https://github.com/xingzhen199186/dsh-mini-remote)：GitHub 官方主页。

### 致谢

本项目在通道交互与配对界面设计上，参考了 [dsh-pocket](https://www.npmjs.com/package/dsh-pocket)（作者 @shaobeichen）在多路径独立二维码呈现方面的工程构思。
