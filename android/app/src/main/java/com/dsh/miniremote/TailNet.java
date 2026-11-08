package com.dsh.miniremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.io.File;

/**
 * 应用内自带的 Tailscale（2026-11-08）。
 *
 * 手机不装 Tailscale 也能连回电脑：内核（TailSocks 的 Go 核心）在进程里跑一个
 * Tailscale 节点，并在本地开一个「SOCKS5 + HTTP」合用的代理端口；WebView 的代理
 * 指向它，页面请求就会走进隧道。
 *
 * 这里只做三件事：启动/停止内核、记住授权密钥、报告状态。界面与代理的接线在
 * MainActivity / LineConfigActivity 里。
 */
final class TailNet {
    private static final String TAG = "MiniTailNet";
    private static final String PREFERENCES = "mini_tailnet";
    private static final String KEY_AUTH = "auth_key";
    /** 本地代理端口：SOCKS5 与 HTTP 共用，WebView 用后者。 */
    static final String PROXY_HOST = "127.0.0.1";
    static final int PROXY_PORT = 1055;

    private static boolean startedOnce;

    private TailNet() {
    }

    /** 记下来的授权密钥；没有就是空串。 */
    static String authKey(Context context) {
        return preferences(context).getString(KEY_AUTH, "");
    }

    static void setAuthKey(Context context, String key) {
        preferences(context).edit().putString(KEY_AUTH, key == null ? "" : key.trim()).apply();
    }

    static boolean hasAuthKey(Context context) {
        return !authKey(context).isEmpty();
    }

    /**
     * 启动内核并等它连上（阻塞，必须在后台线程调用）。
     *
     * 返回 null 表示成功；否则是给用户看的一句话。
     */
    /** 启动参数：登录流程和密钥流程共用同一套，只有授权方式不同。 */
    private static appctr.StartOptions buildOptions(Context app, String key) {
        File nativeLib = new File(app.getApplicationInfo().nativeLibraryDir, "libtailscale.so");
        File socketFile = new File(app.getFilesDir(), "run/tailscaled.sock");
        File socketDir = socketFile.getParentFile();
        if (socketDir != null) {
            // 内核把它当工作目录，目录不在就直接崩，只能我们先建好。
            socketDir.mkdirs();
        }
        appctr.StartOptions options = new appctr.StartOptions();
        options.setExecPath(nativeLib.getAbsolutePath());
        options.setStatePath(new File(app.getFilesDir(), "state").getAbsolutePath());
        options.setSocketPath(socketFile.getAbsolutePath());
        // 两个参数指向同一个地址时，内核在一个监听口上分流 SOCKS 与 HTTP。
        options.setSocks5Server(PROXY_HOST + ":" + PROXY_PORT);
        options.setHttpProxy(PROXY_HOST + ":" + PROXY_PORT);
        if (key != null && !key.isEmpty()) {
            options.setAuthKey(key);
        }
        options.setHostname(deviceName());
        options.setOsVersion(android.os.Build.VERSION.RELEASE);
        options.setDeviceModel(android.os.Build.MODEL == null ? "android" : android.os.Build.MODEL);
        return options;
    }

    /**
     * 账号登录（2026-11-08）：不预置密钥，让内核发起一次交互式登录，拿到一个
     * 授权网址；用户在浏览器里登录后，内核自己会变成已连接。
     *
     * 返回 null 表示拿不到网址，成功时网址放在 {@link #pendingLoginUrl()} 里。
     */
    static String beginLogin(Context context) {
        Context app = context.getApplicationContext();
        try {
            File nativeLib = new File(app.getApplicationInfo().nativeLibraryDir, "libtailscale.so");
            if (!nativeLib.exists()) {
                return "这个安装包里没有内置内核（可能装错了版本）。";
            }
            appctr.StartOptions options = buildOptions(app, "");
            Log.i(TAG, "登录：启动内核");
            appctr.Appctr.setExternalSocketPath("");
            appctr.Appctr.start(options);
            for (int i = 0; i < 40 && !appctr.Appctr.isRunning(); i++) {
                Thread.sleep(500);
            }
            if (!appctr.Appctr.isRunning()) {
                return "内核没有起来：" + lastCoreLog();
            }
            if ("Running".equals(backendState())) {
                return null; // 已经登录过，直接可用。
            }
            appctr.Appctr.loginInteractive();
            String url = "";
            for (int i = 0; i < 40; i++) {
                url = safeLoginUrl();
                if (!url.isEmpty()) {
                    break;
                }
                Thread.sleep(500);
            }
            if (url.isEmpty()) {
                return "拿不到登录网址：" + lastCoreLog();
            }
            pendingLoginUrl = url;
            Log.i(TAG, "登录网址已就绪");
            return null;
        } catch (Throwable e) {
            Log.w(TAG, "登录启动失败", e);
            return "启动登录失败：" + e.getClass().getSimpleName();
        }
    }

    private static volatile String pendingLoginUrl = "";

    static String pendingLoginUrl() {
        return pendingLoginUrl == null ? "" : pendingLoginUrl;
    }

    /** 等用户登录完成：返回 null 表示连上了，否则是一句给用户看的说明。 */
    static String waitLoggedIn(long timeoutMs) {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if ("Running".equals(backendState())) {
                pendingLoginUrl = "";
                return null;
            }
            try {
                Thread.sleep(1000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return "等待登录被打断。";
            }
        }
        return "还没等到登录完成（" + backendState() + "）。";
    }

    private static String safeLoginUrl() {
        try {
            String url = String.valueOf(appctr.Appctr.getLoginURL());
            return "null".equals(url) ? "" : url.trim();
        } catch (Throwable e) {
            return "";
        }
    }

    static String startBlocking(Context context) {
        Context app = context.getApplicationContext();
        String key = authKey(app);
        if (key.isEmpty()) {
            return "还没有登录 Tailscale 账号。";
        }
        try {
            File nativeLib = new File(app.getApplicationInfo().nativeLibraryDir, "libtailscale.so");
            if (!nativeLib.exists()) {
                return "这个安装包里没有内置内核（可能装错了版本）。";
            }
            appctr.StartOptions options = buildOptions(app, key);

            if (appctr.Appctr.isRunning() && "Running".equals(backendState())) {
                Log.i(TAG, "内核已在运行，直接复用");
                return null; // 已经在跑，直接复用。
            }

            appctr.Appctr.setExternalSocketPath("");
            Log.i(TAG, "启动内核 exec=" + options.getExecPath());
            appctr.Appctr.start(options);
            startedOnce = true;

            for (int i = 0; i < 20 && !appctr.Appctr.isRunning(); i++) {
                Thread.sleep(500);
            }
            if (!appctr.Appctr.isRunning()) {
                return "内核没有起来：" + lastCoreLog();
            }

            if (!"Running".equals(backendState())) {
                appctr.Appctr.login(key);
            }

            Log.i(TAG, "已启动，等待连上；当前=" + backendState());
            for (int i = 0; i < 40; i++) {
                String state = backendState();
                if ("Running".equals(state)) {
                    Log.i(TAG, "已连上，用时约 " + (i * 500) + "ms");
                    return null;
                }
                if ("Stopped".equals(state)) {
                    return "内核停住了：" + lastCoreLog();
                }
                Thread.sleep(500);
            }
            Log.w(TAG, "等不到 Running，当前=" + backendState() + " 日志=" + lastCoreLog());
            return "还没连上（" + backendState() + "）：" + lastCoreLog();
        } catch (Throwable e) {
            Log.w(TAG, "启动失败", e);
            return "启动失败：" + e.getClass().getSimpleName();
        }
    }

    /** tailnet 里的设备名：只留字母数字和连字符，别的都换成 -。 */
    private static String deviceName() {
        String model = android.os.Build.MODEL == null ? "" : android.os.Build.MODEL;
        String cleaned = model.toLowerCase(java.util.Locale.ROOT).replaceAll("[^a-z0-9]+", "-");
        cleaned = cleaned.replaceAll("^-+", "").replaceAll("-+$", "");
        if (cleaned.isEmpty()) {
            return "dsh-mini-remote";
        }
        return cleaned.length() > 40 ? cleaned.substring(0, 40) : cleaned;
    }

    static String backendState() {
        try {
            return String.valueOf(appctr.Appctr.getBackendState());
        } catch (Throwable e) {
            return "unknown";
        }
    }

    static boolean isConnected() {
        try {
            return appctr.Appctr.isRunning() && "Running".equals(backendState());
        } catch (Throwable e) {
            return false;
        }
    }

    /** 内核自己的日志尾巴：出错时给用户看最后一句，别再让人猜。 */
    private static String lastCoreLog() {
        try {
            String logs = String.valueOf(appctr.Appctr.getLogs());
            String trimmed = logs.trim();
            int cut = trimmed.lastIndexOf('\n');
            String last = cut >= 0 ? trimmed.substring(cut + 1) : trimmed;
            return last.length() > 160 ? last.substring(0, 160) : last;
        } catch (Throwable e) {
            return "";
        }
    }

    static void stop() {
        try {
            appctr.Appctr.stop();
        } catch (Throwable e) {
            Log.w(TAG, "停止内核失败", e);
        }
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }
}
