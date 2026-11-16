plugins {
    id("com.android.application")
}

android {
    namespace = "com.dsh.miniremote"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.dsh.miniremote"
        minSdk = 28
        targetSdk = 34

        // 两个 flavor 都继承这里的版本号；禁止给 bridge 单独设置更高的号段。
        // 可用 -PappVersionName/-PappVersionCode 生成测试包；默认值就是正式发布版。
        versionCode = providers.gradleProperty("appVersionCode").orElse("10").get().toInt()
        versionName = providers.gradleProperty("appVersionName").orElse("0.1.0").get()

        // 正式版的应用内更新直接读公开更新清单，不再依赖电脑上的开发产物；
        // 清单里给出正式签名包的地址、大小和 SHA-256（2026-11-16）。
        buildConfigField(
            "String",
            "APP_UPDATE_MANIFEST",
            "\"https://pub-d07b53ae593c42e295ea5482d0860d37.r2.dev/app-update.json\"",
        )
    }

    flavorDimensions += "distribution"
    productFlavors {
        create("standard") {
            dimension = "distribution"
            // 标准版使用 main 清单，不合并无障碍服务。
        }
        create("bridge") {
            dimension = "distribution"
            // 实验版仅额外合并 src/bridge 的无障碍声明与资源。
        }
    }

    // 自连 ADB 的配对要走原生（2026-11-15）：TLS 通道绑定、SPAKE2、AES 都在 BoringSSL 里，
    // Java 侧拿不到这些。只编 arm64 —— 目标机器是 arm64，别的 ABI 编了也用不上。
    ndkVersion = "27.0.12077973"
    defaultConfig {
        ndk {
            abiFilters += "arm64-v8a"
        }
        externalNativeBuild {
            cmake {
                arguments += "-DANDROID_STL=c++_shared"
                cppFlags += "-std=c11"
            }
        }
    }
    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
        }
    }

    buildFeatures {
        // 更新检查要告诉电脑「我是哪个版本」（standard / bridge），
        // 否则实验版会被标准版覆盖（2026-11-09）。
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        // 内置 Tailscale 的守护进程是一个可执行文件（jniLibs 里的 libtailscale.so），
        // 必须让系统在安装时把它解压成磁盘上的可执行文件；安卓 10 起应用数据目录
        // 是 noexec，放在那儿执行会被拒（2026-11-07 实测）。
        jniLibs {
            useLegacyPackaging = true
        }
    }
}

dependencies {
    // 扫码要一个解码库：相机预览 + 二维码识别自己做是几百行，还要对付各家 ROM 的相机差异。
    // 这是本项目唯一的第三方依赖，只用来读二维码；其余仍是 Java 标准库 + android.jar。
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // 扫码库内部用 ContextCompat 申请相机权限，但它把 androidx.core 声明成了可选依赖——
    // 不显式加，编译能过，一开扫码头就崩（2026-11-06 真机日志：ClassNotFoundException）。
    implementation("androidx.core:core:1.13.1")
    // 内置 Tailscale：Go 内核（TailSocks appctr）编出来的 AAR；守护进程本体在 jniLibs。
    implementation(files("libs/appctr.aar"))
    // WebView 的代理只能通过 androidx.webkit 的 ProxyController 设置。
    implementation("androidx.webkit:webkit:1.11.0")
    // 选工作文件夹要用 SAF 的 DocumentFile（系统原生选择器，商店认可的做法）。
    implementation("androidx.documentfile:documentfile:1.0.1")
}
