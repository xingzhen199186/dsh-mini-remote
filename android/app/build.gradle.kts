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
        versionCode = 1
        versionName = "0.1.0"
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

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // 扫码要一个解码库：相机预览 + 二维码识别自己做是几百行，还要对付各家 ROM 的相机差异。
    // 这是本项目唯一的第三方依赖，只用来读二维码；其余仍是 Java 标准库 + android.jar。
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    // 扫码库内部用 ContextCompat 申请相机权限，但它把 androidx.core 声明成了可选依赖——
    // 不显式加，编译能过，一开扫码头就崩（2026-11-06 真机日志：ClassNotFoundException）。
    implementation("androidx.core:core:1.13.1")
}
