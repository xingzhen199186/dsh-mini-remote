# 预编的 BoringSSL（arm64-v8a）

`libssl.a` / `libcrypto.a` 是按安卓 arm64 编好的静态库，配 `include/openssl` 一起用。
**不放进构建流程里现编**：BoringSSL 的构建要 Go 生成代码，不该要求每台机器都装 Go。

## 重新编的办法

```bash
# 1. 工具链（一次性）
#    Go 1.27+ 解压到任意目录并进 PATH；cmake 与 ninja 可用 pip 装
python -m pip install cmake ninja

# 2. 取源码（GitHub 直连不通时用 API 下载）
gh api repos/google/boringssl/tarball/master > bs.tgz

# 3. 配置与构建
cmake -G Ninja -S boringssl -B build-android \
  -DCMAKE_MAKE_PROGRAM=<ninja.exe> \
  -DCMAKE_TOOLCHAIN_FILE=<NDK>/build/cmake/android.toolchain.cmake \
  -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-28 \
  -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_TESTING=OFF
cmake --build build-android --target crypto ssl

# 4. 拷回来
cp build-android/libssl.a build-android/libcrypto.a <这里>/arm64-v8a/
cp -r boringssl/include/openssl <这里>/include/
```

## 为什么单独预编

配对那一步要三样东西**字节级正确**：TLS 的通道绑定值、SPAKE2 的曲线运算、AES-128-GCM 的封包。
这三样都在 BoringSSL 里，Java 侧拿不到；用它自己的实现，就不必和它逐位对齐。

许可：BoringSSL 是 OpenSSL/ISC 混合许可，**非传染**，可随闭源产品分发。
