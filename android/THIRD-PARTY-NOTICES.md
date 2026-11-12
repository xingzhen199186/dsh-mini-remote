# 第三方组件与许可

## 已移除：Termux 的终端模块

2026-11-12 曾内置 `terminal-emulator` 与 `terminal-view`（Apache 2.0）来做一个真 PTY 的全屏终端页。
**同日按用户决定移除**：只保留后台的 `phone_sh` 能力（直接调系统 `/system/bin/sh`），不再提供终端界面。

需要恢复时：在 git 历史里找提交 `51cdb94`，那是这两个模块完整可用的状态（含预编译的 `libtermux.so`）。

## 其他

- **toybox**：安卓系统自带（0BSD），我们只是调用，不打包。
- **androidx.documentfile**：Apache License 2.0，用于 SAF 选文件夹。
- **/system/bin/sh + toybox**：系统自带，直接调用，不打包。
