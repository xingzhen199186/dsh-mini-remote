# 第三方组件与许可

## Termux 的终端模块（Apache License 2.0）

`android/terminal-emulator/` 与 `android/terminal-view/` 两个模块来自
[termux/termux-app](https://github.com/termux/termux-app)（版本 0.118 系），
按 **Apache License 2.0** 授权使用，用于在 App 内提供**真正的终端**（PTY + 终端仿真 + 渲染）。

- 来源：<https://github.com/termux/termux-app>（`terminal-emulator`、`terminal-view`）
- 上游这两个模块的许可：Apache License 2.0（见上游仓库 `LICENSE.md` 的 Exceptions 一节）
- 我们对源码做了**最小改动**：去掉发布插件与本地 maven 配置、把 SDK 版本写死、ABI 只保留 arm64-v8a、
  `libtermux.so` 改为预编译放入 `src/main/jniLibs/arm64-v8a/`。
- 许可证全文见 `android/licenses/APACHE-2.0.txt`。

**未使用**的部分：`termux-app` 主模块（`app/`）与 `termux-shared` 中的 `com.termux.shared.termux.*`
属于 **GPLv3**，本项目**没有**引入。

## 其他

- **toybox**：安卓系统自带（0BSD），我们只是调用，不打包。
- **androidx.documentfile**：Apache License 2.0，用于 SAF 选文件夹。
