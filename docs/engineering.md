# 工程说明

给「以后要改这个项目」的人看的一份说明书：代码怎么排、怎么跑、改哪里会影响什么。

- 给**使用者**看的（装什么、怎么连手机、安全说明）：`README.md`
- 立绘与动画那套工艺、验收口径：`docs/character.md`；定稿的基准帧和提示词：`docs/art-refs/2026-09-28/`
- 版本变更记录：`CHANGELOG.md`（面向使用者，用白话写"改了什么、为什么"）

## 一、它是什么、分两侧跑

`dsh-mini-remote` 是 DSH（DeepSeek Harness）的一个插件，代码同时管着两侧：

- **插件端**（跑在 DSH 进程里）：起一个轻量 HTTP 服务（默认 3090 端口），把会话的
  「你发出去的指令」和「AI 的最终回复」推到手机；中间的思考、工具调用、日志都不推。
- **网页端**（跑在 DSH 的 Web 界面里）：`client/client.js` 往设置页挂一个「手机遥控」标签，
  用来生成二维码、选连接方式。

手机打开的是 `/mini` 这一页，页面本体是 `lib/page.html`（单文件，结构、样式、前端逻辑都在里面）。

## 二、目录与各模块的职责

各模块开头都有一句自述，这里照抄，改之前先读那一句：

    lib/index.js        插件端入口：注册服务、装配其它模块、声明设置项
    lib/server.js       插件自带的轻量 HTTP 服务
    lib/page.js         把单文件页面读进来、注入启动常量；另外负责读立绘
    lib/page.html       手机页本体（HTML/CSS/JS 全在里面）
    lib/serve.js        用 Tailscale 自带的 HTTPS 地址，把本机服务暴露给 tailnet
    lib/build.js        构建指纹：把插件几个源文件的内容揉成一个短哈希
    lib/store.js        插件端状态：最新一条回复、历史记录、会话绑定、手机在线状态
    lib/events.js       从 DSH 会话事件流里只捞出要推给手机的那两样
    lib/history.js      把一个会话已跑完的历史重放成手机上显示的那一串
    lib/log-tail.js     只读会话日志的尾部若干事件（手机端读历史的上限在这里）
    lib/tree.js         工作区 → 会话 的树，给手机左侧导航栏用
    lib/browse.js       电脑目录浏览，给手机挑工作区用
    lib/commands.js     斜杠指令：手机作为「发起指令的界面」，问 DSH 自己的指令账本
    lib/permissions.js  手机端切换权限档位
    lib/pairing.js      配对信息：手机该扫哪个码、点哪条链接
    lib/net.js          网卡识别：只挑真正能用、也真正该让手机连的地址
    lib/tunnel.js       起一条 cloudflared 快速隧道，把手机服务暴露到公网网址
    lib/cloudflared.js  找到（或下载）cloudflared 可执行文件
    lib/notify.js       手机锁屏/浏览器挂起时的外部推送（WebSocket、SSE 都不靠不住时兜底）
    lib/sw.js           Service Worker，只为让手机能发系统通知
    lib/art/            九张立绘 ＋ 展示用的 out-* 动图
    client/client.js    Web 界面里的客户端插件（入口、二维码、设置页）
    test/               单测（node --test，见第五节）
    tools/              开发与出图的小工具（不随插件发布）
    docs/               文档、截图、立绘基准帧

## 三、跑起来

    npm test                        单测
    node tools/live-check.mjs       问"现在跑的是哪一版代码"
    node tools/fake-phone.mjs       不开手机，用命令行模拟手机端
    node tools/e2e-tunnel.mjs       公网隧道的端到端自测（真往返一次）

改完代码必须**重启 DSH** 才生效。本机只允许用 `I:\DSH\restart-dsh.mjs` 重启：把"期望的构建
指纹"传给它，它重启后核对，不一致会写进 `I:\DSH\restart-dsh.log`。

## 四、构建指纹（最容易踩的一处）

`lib/build.js` 在插件加载时算一个短哈希，手机页把它带在图片地址上做长缓存。它覆盖：
`lib/*.js`、`lib/*.html`、`client/client.js`，以及 `lib/art/*.webp` 的**文件名**。由此：

- **改了立绘必须重启**，否则手机拿的还是旧图——地址没变，缓存不会失效。
- 名字以 `out-` 开头的展示图**不计入**指纹：它们是给人看的展示品，不该让"改张展示图就得重启"。
- 改 `docs/`、`test/`、`tools/` 不影响指纹，不需要重启。

自检只有一句话：`node tools/live-check.mjs` 会输出「进程报 X，本地是 Y」，两者一致才算生效。

## 五、测试与验收

`npm test` 跑 `test/*.test.mjs`（Node 自带测试器，没有额外框架），当前 551 个断言全过。
测试按模块分文件（`page` / `serve` / `build` / `permissions` / `tunnel` / `ui` / `smoke`…），
改了哪块先跑对应那份，最后整跑一遍。

手机上能不能用，只能靠人验：`tools/fake-phone.mjs` 走主要流程，真机再看一眼。立绘另有一套
可量的验收口径，写在 `docs/character.md` 第四节。

## 六、约定与坑

- **不能破的两条**：手机页上的文字一律中文；思考过程不推给手机（只推指令与最终回复）。
- 手机端显示图片有三种写法（外链 / 裸名字 / 电脑上的路径），细节在 README 的「手机上能做什么」。
- 本机的代理（TUN + fake-ip）会把 `*.trycloudflare.com` 解析成 `198.18.1.127`，隧道自测失败
  时先怀疑它；但**不要用一次失败下结论**，判据是 `tools/e2e-tunnel.mjs` 的真往返结果。
- Node 需要 >= 22；运行时依赖只有 `qrcode` 一个。
- 发布流程：改 `CHANGELOG.md` → 升 `package.json` 的 `version` → `npm publish`。

## 七、动手之前

这个插件的全部取舍都建立在一条边界上：**只推指令和最终回复**。任何"把中间过程也推上去"的
改动，都会推翻用户当初要它的理由（不被过程刷屏）。要越这条线，先确认，再动。
