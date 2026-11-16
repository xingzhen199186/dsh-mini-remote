# 安卓客户端（源码目录）

这里是 `dsh-mini-remote` 的安卓客户端源码。**只放客户端，不放插件**；插件本体在仓库根目录的 `lib/`、`client/`。

方案见 [`../docs/RFC-安卓客户端与设备桥-V3.1.md`](../docs/RFC-安卓客户端与设备桥-V3.1.md)。这一版按 RFC 分成两个构建版本，同一个工程、同一份代码：

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

## 现在的状态

**2026-11-16 起随插件 0.3.0 在 GitHub Releases 提供正式签名安装包。** 用户下载与安装说明见
[`../docs/DSH-Everywhere.md`](../docs/DSH-Everywhere.md)；下面保留的是 2026-11-05 首次构建时的历史记录。

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
| 无障碍（实验版） | 已实现并通过真机验证；仅 `bridge` 构建声明 |

## 构建（两条路，选一条）

### 一、Android Studio（图形化，适合改界面）

1. 装 Android Studio，安装向导里勾选 **Android SDK**（默认路径即可）。
2. 打开本目录（`android/`）作为工程；wrapper 已经生成（Gradle 8.9），第一次会下载依赖。
3. 构建或直接跑：两个变体是 `standard`（普通版）和 `bridge`（实验版）。

用 Studio 时有两处要手动调一次（2026-11-06 实测，Rabbit 2 / 2026.2.2）：

- **Gradle JDK 选 17 或 21**（Settings → Build Tools → Gradle → Gradle JDK）。
  Studio 自带的 JBR 是 25，Gradle 8.9 跑不了，同步会报 “Unsupported class file major version”。
  本机已经装了 Temurin 21，选它即可。
- **别点 “Upgrade AGP / compileSdk” 的提示**：工程固定 `compileSdk = 34`、AGP 8.5.2，
  跟 Studio 自带 SDK（android-37）不是一回事；升上去要连带改 Gradle 和依赖，不属于现在这一步。

### 二、命令行（不装 Android Studio，2026-11-05 实测）

1. 装 JDK 17+（本机是 21）。
2. 下载 Android command-line tools，用 `sdkmanager` 装三样：
   `platform-tools`、`platforms;android-34`、`build-tools;34.0.0`（首次会要求 `--licenses`）。
3. 工程自带 wrapper（`gradlew.bat`，Gradle 8.9），不需要另装 Gradle。
4. 在 `android/` 目录下执行：

   ```bat
   set ANDROID_HOME=D:\Android\Sdk
   gradlew.bat assembleStandardDebug
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

## 内置 Tailscale（不用在手机上装 Tailscale）

Tailscale 那条线路现在可以走「应用内自带」的节点：手机不装 Tailscale，由 App 里的
Go 内核在进程内跑一个 Tailscale 节点，在本地开 `127.0.0.1:1055` 的代理（SOCKS5 与
HTTP 共用），WebView 的请求经它进入隧道。

入口在「连接 → Tailscale → 内置 Tailscale（不装 App 也能连）」：

- **主路径：点「登录 Tailscale 账号」**。App 会把登录页交给**手机默认浏览器**，用你
  已有的账号登录一次，登录完自动连上。不内嵌网页，也不套一层 Custom Tab：Google 会把
  内嵌的页面当成「新设备」，反而多出一道验证；默认浏览器里本来就登着账号，一次就过。
- **备选：粘贴授权密钥**（电脑后台生成的那种），适合不想在手机上登录、或要自动化的场合。
- **扫码**：电脑端设置页可以生成「接入码」二维码，手机扫一下同时带地址和密钥。

登录/密钥都只存在应用私有偏好里。

### 两个产物不进版本库

`app/libs/appctr.aar` 与 `app/src/main/jniLibs/arm64-v8a/libtailscale.so` 合起来近
40MB，已经写进 `.gitignore`。要重新生成：

```
# 1. Go + NDK + gomobile
go install golang.org/x/mobile/cmd/gomobile@latest
go install golang.org/x/mobile/cmd/gobind@latest

# 2. 取 TailSocks 的 Go 内核（BSD-3），打它自带的补丁（含安卓网络切换、TUN 里的 DNS）
git clone --depth 1 https://github.com/bropines/tailsocks.git
cd tailsocks/appctr && ./build.sh          # 产物在 appctr/tmp/appctr.aar

# 3. 把 appctr/tmp/appctr.aar 放到 app/libs/，
#    appctr/tailscale_src/tmp/libtailscale_arm64.so 放到 app/src/main/jniLibs/arm64-v8a/libtailscale.so
```

注意三件事，踩过：

- 守护进程必须是**安装时解压出来的可执行文件**（`android:extractNativeLibs="true"`
  + `useLegacyPackaging = true`）；放在应用数据目录里执行会被拒（安卓 10 起 noexec）。
- 内核把 socket 所在目录当工作目录（`chdir`），目录得先建好，否则启动即崩。
- 可执行文件不能叫 `tailscaled`：内核会在同目录建同名软链，名字撞上就成了自己指自己的死链。

许可证：TailSocks 为 BSD-3-Clause，见 `third_party/tailsocks-LICENSE.txt`；它内部又用了
Tailscale（同为 BSD-3-Clause）。
