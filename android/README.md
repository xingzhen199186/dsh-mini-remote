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

**2026-11-05 已能构建**：本机用命令行工具链（JDK 21 + Android SDK 34 + Gradle 8.9，没装 Android Studio）
编出了两个变体——`standard` 与 `bridge`，各约 688 KB。**尚未在真机上跑过**，下面的“能力”一栏
从“未编译”改成“已编译、待真机”。

| 能力 | 状态 |
|---|---|
| WebView 壳、按地址写设备 Cookie、地址池探测与切换 | 已编译，待真机 |
| 配对：粘贴链接 / 扫二维码（ZXing）→ 换设备凭据 | 已编译，待真机 |
| 待审批通知：前台轮询 + 通知栏「批准 / 拒绝」 | 已编译，待真机 |
| 锁屏也能收：退到后台时开一条前台服务保持推送连接 | 已编译，待真机（Android 15 起 dataSync 每天最多 6 小时） |
| 服务端两个接口（换凭据、地址池）与待办清单 | 已实现并测过 |
| 无障碍（实验版） | 空壳，P3 才填 |

## 构建（两条路，选一条）

### 一、Android Studio（图形化，适合改界面）

1. 装 Android Studio，安装向导里勾选 **Android SDK**（默认路径即可）。
2. 打开本目录（`android/`）作为工程；第一次会下载 Gradle 和依赖，需要联网。
3. 构建或直接跑：两个变体是 `standard`（普通版）和 `bridge`（实验版）。

### 二、命令行（不装 Android Studio，2026-11-05 实测）

1. 装 JDK 17+（本机是 21）。
2. 下载 Android command-line tools，用 `sdkmanager` 装三样：
   `platform-tools`、`platforms;android-34`、`build-tools;34.0.0`（首次会要求 `--licenses`）。
3. 下载 Gradle 8.9（AGP 8.5.2 要求 8.7+），解开即可，不需要 wrapper。
4. 在 `android/` 目录下执行：

   ```bat
   set ANDROID_HOME=D:\Android\Sdk
   D:\Android\gradle-8.9\bin\gradle.bat assembleStandardDebug
   ```

5. 包在 `app/build/outputs/apk/standard/debug/app-standard-debug.apk`；
   `assembleBridgeDebug` 出实验版，路径同理。

两个与本机有关的备注：

- 工作区在中文路径下，AGP 会拦一条“非 ASCII 路径”的警告；`gradle.properties` 里已经写了
  `android.overridePathCheck=true`，实测能出包。换到纯英文路径时这一行可以删掉。
- SDK 与 Gradle 装在哪都行，只要 `ANDROID_HOME` 指对、`gradle.bat` 找得到。

## 明文 HTTP 的边界

内网与 Tailscale 默认就是 `http`，所以 `network_security_config.xml` 放开了明文流量
（系统这份配置不支持按网段放行）。边界由代码守：`Net` 只请求配对链接和地址池里的地址，
WebView 只导航到 `isPairedOrigin()` 认可的源。用固定地址/自建中继那些 `https` 时不需要改配置。

## 为什么不放在插件仓库外面

- 两边改动经常要一起看（WebView 加载的页面就在 `../lib/page.html`），同一个仓库里跳转最省事；
- 插件的 npm 包有白名单（`package.json` 的 `files`），这个目录**不会被打进 npm 包**，用户装插件时不会多下载几百 KB 源码；
- 分发靠 GitHub Release，源码在仓库里、APK 在 Release 里，互不干扰。
