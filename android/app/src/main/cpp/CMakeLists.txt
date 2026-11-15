cmake_minimum_required(VERSION 3.18)
project(adb_pairing C)

# 自连 ADB 的配对（2026-11-15）
#
# BoringSSL 是**预编好的静态库**放在 boringssl/ 下（arm64-v8a）。
# 为什么不在 App 构建里现编：BoringSSL 的构建要 Go 生成代码，
# 要求每个开发者/每台机器都装 Go 不合理；库是一次性产物，编好放这里即可。
#
# 只链接用得到的部分：链接器会按 --gc-sections 把没引用的对象丢掉，
# 装进 APK 的只有实际用到的那些符号。

add_library(adb_pairing SHARED adb_pairing.c)

set(BORINGSSL_DIR ${CMAKE_CURRENT_SOURCE_DIR}/boringssl)

target_include_directories(adb_pairing PRIVATE ${BORINGSSL_DIR}/include)
target_link_libraries(adb_pairing
        ${BORINGSSL_DIR}/${ANDROID_ABI}/libssl.a
        ${BORINGSSL_DIR}/${ANDROID_ABI}/libcrypto.a
        c++_shared
        log)
target_compile_options(adb_pairing PRIVATE -ffunction-sections -fdata-sections -Wall)
target_link_options(adb_pairing PRIVATE -Wl,--gc-sections)
