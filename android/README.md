# 安卓客户端（源码目录）

这里是 `dsh-mini-remote` 的安卓客户端源码。**只放客户端，不放插件**；插件本体在仓库根目录的 `lib/`、`client/`。

方案见 [`../docs/RFC-安卓客户端与设备桥-V3.md`](../docs/RFC-安卓客户端与设备桥-V3.md)。这一版按 RFC 分成两个构建版本，同一个工程、同一份代码：

| 构建版本 | 说明 | 高危权限 |
| --- | --- | --- |
| `standard` | 给普通用户：WebView 壳、扫码配对、通知与快捷审批、系统分享 | **不声明**无障碍 |
| `bridge` | 实验版：在 standard 之上多一个无障碍服务，供 P3 的“电脑操控手机”使用 | 声明无障碍 |

## 目录约定

```
android/
  app/                 主模块（Kotlin + WebView）
  docs/                客户端自己的说明（安装步骤、常见问题）
  build.gradle.kts     工程构建脚本
  settings.gradle.kts
  gradle/              wrapper（提交，保证谁拉下来都能构建）
  local.properties     不进 git（本机 SDK 路径）
```

约定三条：

1. `app/src/main/` 里放正式代码；实验性的探针 Demo 放 `app/src/exp/`，不混进主代码。
2. 构建产物、签名文件、本机配置一律不进 git（见 `.gitignore`）。
3. 客户端的版本号独立于插件，从 `0.1.0` 起；协议兼容性看 `bridgeProtocol`，不比版本号字符串。

## 现在是什么状态

工程骨架已经能读：Gradle 配置、清单、8 个 Java 类、资源和两个构建变体都在。
**还没编译过**——本机只有 JDK 和 adb，没有 Android SDK / Gradle。

已经写好的部分：

| 能力 | 状态 |
|---|---|
| WebView 壳、按地址写设备 Cookie、地址池探测与切换 | 代码就绪，未编译 |
| 配对：粘贴链接 / 扫二维码（ZXing）→ 换设备凭据 | 代码就绪，未编译 |
| 待审批通知：前台轮询 + 通知栏「批准 / 拒绝」 | 代码就绪，未编译 |
| 锁屏也能收：退到后台时开一条前台服务保持推送连接 | 代码就绪，未编译（Android 15 起 dataSync 每天最多 6 小时） |
| 服务端两个接口（换凭据、地址池）与待办清单 | 已实现并测过 |
| 无障碍（实验版） | 空壳，P3 才填 |

## 第一次构建（需要装一次 Android Studio）

1. 装 Android Studio，安装向导里勾选 **Android SDK**（默认路径即可）。
2. 打开本目录（`android/`）作为工程；第一次会下载 Gradle 和依赖，需要联网。
3. 出来的两个变体：`standard`（普通版）、`bridge`（实验版）。
4. 命令行出包：

```
gradlew.bat assembleStandardDebug
```

包在 `app/build/outputs/apk/standard/debug/`。

**已知风险**：以上代码一行都没在真实工具链里编译过，第一次构建大概率会有报错要修；这是预期内的，不是坏了。

## 为什么不放在插件仓库外面

- 两边改动经常要一起看（WebView 加载的页面就在 `../lib/page.html`），同一个仓库里跳转最省事；
- 插件的 npm 包有白名单（`package.json` 的 `files`），这个目录**不会被打进 npm 包**，用户装插件时不会多下载几百 KB 源码；
- 分发靠 GitHub Release，源码在仓库里、APK 在 Release 里，互不干扰。
