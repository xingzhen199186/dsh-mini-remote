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
    static String startBlocking(Context context) {
        Context app = context.getApplicationContext();
        String key = authKey(app);
        if (key.isEmpty()) {
            return "还没有填授权密钥。";
        }
        try {
            File nativeLib = new File(app.getApplicationInfo().nativeLibraryDir, "libtailscale.so");
            if (!nativeLib.exists()) {
                return "这个安装包里没有内置内核（可能装错了版本）。";
            }
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
            options.setAuthKey(key);

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
                    return null;
                }
                if ("Stopped".equals(state)) {
                    return "内核停住了：" + lastCoreLog();
                }
                Thread.sleep(500);
            }
            return "还没连上（" + backendState() + "）：" + lastCoreLog();
        } catch (Throwable e) {
            Log.w(TAG, "启动失败", e);
            return "启动失败：" + e.getClass().getSimpleName();
        }
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
