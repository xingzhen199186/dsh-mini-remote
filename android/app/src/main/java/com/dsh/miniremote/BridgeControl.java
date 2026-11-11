package com.dsh.miniremote;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 手机桥授权的唯一写入口。
 *
 * 设置页与无障碍胶囊都可能停止桥；把本机撤权、轮询停止和远端通知收在这里，
 * 才能让两个入口具有完全相同的结果。网络只负责通知，决定手机是否停用的仍是本机开关。
 */
final class BridgeControl {
    private static final String PREFS = "mini_ui_prefs";
    private static final String ARMED = "mini_bridge_armed";
    private static final Object LOCK = new Object();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    /** 同一进程内按操作顺序通知电脑，避免旧的“开启”晚于新的“停止”到达。 */
    private static final java.util.concurrent.ExecutorService ARM_REQUESTS =
            java.util.concurrent.Executors.newSingleThreadExecutor();
    private static long armSeq;
    private static ArmedListener stopOverlayListener;

    interface ArmedListener {
        void onArmedChanged(boolean armed);
    }

    interface OnFailure {
        void onFailure(String message);
    }

    private BridgeControl() {
    }

    static boolean isArmed(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(ARMED, false);
    }

    /** “读取授权→启停轮询”与撤权共用一把锁，旧启动动作不能落在停止之后。 */
    static void syncPoller(Context context, BridgePoller poller, String baseUrl, String credential) {
        synchronized (LOCK) {
            if (isArmed(context) && baseUrl != null && credential != null) {
                poller.start(baseUrl, credential);
            } else {
                poller.stop();
            }
        }
    }

    static void setStopOverlayListener(ArmedListener listener) {
        stopOverlayListener = listener;
    }

    static void clearStopOverlayListener(ArmedListener listener) {
        if (stopOverlayListener == listener) stopOverlayListener = null;
    }

    /**
     * 先落本机决定，再通知电脑；旧请求即使晚到也不能改变较新的决定。
     * onFailure 只用于界面解释失败，不承担停止动作本身。
     */
    static void setArmed(Context context, boolean armed, String baseUrl, String credential,
                         OnFailure onFailure) {
        final Context app = context.getApplicationContext();
        final long seq;
        final List<String[]> activeRoutes;
        synchronized (LOCK) {
            seq = ++armSeq;
            writeLocalArmed(app, armed);
        }
        if (armed) {
            activeRoutes = new ArrayList<>();
        } else {
            // 活跃轮询可能在界面或后台服务里；撤权时两边都必须停，不能只停当前页面。
            activeRoutes = BridgePoller.stopAll();
            // 等待确认也属于在途动作：停止桥时不能只清电脑队列而留下手机上的卡。
            ConfirmationControl.cancelAll(app);
        }
        List<String[]> routes = routesToNotify(app, armed, baseUrl, credential, activeRoutes);
        if (routes.isEmpty()) return;
        ARM_REQUESTS.execute(() -> {
            String failure = null;
            for (String[] route : routes) {
                try {
                    Net.Response response = Net.postJson(route[0] + "/mini/api/bridge/arm",
                            "{\"armed\":" + armed + "}", route[1]);
                    if (!response.isSuccess()) failure = "HTTP " + response.status;
                } catch (Exception err) {
                    failure = err.getMessage() == null ? err.getClass().getSimpleName() : err.getMessage();
                }
            }
            if (failure == null) return;
            synchronized (LOCK) {
                if (seq != armSeq) return;
                // 开启失败不能留下一个假授权；停止失败则保持本机已经停止。
                if (armed) {
                    writeLocalArmed(app, false);
                    BridgePoller.stopAll();
                }
            }
            android.util.Log.w("MiniBridge", "武装状态提交失败：" + failure);
            if (onFailure != null) onFailure.onFailure(failure);
        });
    }

    /** 电脑忘记手机后的补报也走同一队列；撤权后排在前面的旧补报不能把桥重新打开。 */
    static void rearm(Context context, String baseUrl, String credential) {
        Context app = context.getApplicationContext();
        if (!isArmed(app)) return;
        ARM_REQUESTS.execute(() -> {
            if (!isArmed(app)) return;
            try {
                Net.Response response = Net.postJson(baseUrl + "/mini/api/bridge/arm",
                        "{\"armed\":true}", credential);
                if (response.isSuccess()) {
                    android.util.Log.i("MiniBridge", "电脑端不记得这台手机了，已补发一次武装");
                } else {
                    android.util.Log.w("MiniBridge", "补发武装失败：HTTP " + response.status);
                }
            } catch (Exception err) {
                android.util.Log.w("MiniBridge", "补发武装失败：" + err.getMessage());
            }
        });
    }

    /** 只写本机状态并通知浮层；远端是否可达不改变这个决定。 */
    private static void writeLocalArmed(Context app, boolean armed) {
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ARMED, armed).apply();
        ArmedListener listener = stopOverlayListener;
        if (listener == null) return;
        if (Looper.myLooper() == Looper.getMainLooper()) {
            listener.onArmedChanged(armed);
        } else {
            MAIN.post(() -> listener.onArmedChanged(armed));
        }
    }

    /** 优先使用正在跑的地址；没有活跃轮询时才退回用户保存的线路。 */
    private static List<String[]> routesToNotify(Context app, boolean armed,
                                                  String baseUrl, String credential,
                                                  List<String[]> activeRoutes) {
        Map<String, String[]> routes = new LinkedHashMap<>();
        if (baseUrl != null && credential != null) {
            routes.put(baseUrl + "\n" + credential, new String[]{baseUrl, credential});
        }
        if (!armed) {
            for (String[] route : activeRoutes) {
                routes.putIfAbsent(route[0] + "\n" + route[1], route);
            }
            if (routes.isEmpty()) {
                try {
                    PairingStore.Credentials saved = new PairingStore(app).load();
                    String savedCredential = saved == null ? null : saved.deviceCredential();
                    String savedBase = Connections.preferred(app);
                    if ((savedBase == null || savedBase.isEmpty()) && saved != null && !saved.addresses.isEmpty()) {
                        savedBase = saved.addresses.get(0).baseUrl;
                    }
                    if (savedBase != null && !savedBase.isEmpty() && savedCredential != null) {
                        routes.put(savedBase + "\n" + savedCredential,
                                new String[]{savedBase, savedCredential});
                    }
                } catch (Exception err) {
                    android.util.Log.w("MiniBridge", "停止通知找不到保存的线路：" + err.getMessage());
                }
            }
        }
        return new ArrayList<>(routes.values());
    }
}
