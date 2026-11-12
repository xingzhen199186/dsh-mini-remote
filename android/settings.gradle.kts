pluginManagement {
    repositories {
        google()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "dsh-mini-remote"
include(":app")
// Termux 的两个 Apache-2.0 模块（终端仿真 + 渲染），见 THIRD-PARTY-NOTICES.md
include(":terminal-emulator")
include(":terminal-view")
