package com.dsh.miniremote;

import android.content.Context;

/**
 * 「我先等着，你去开配对对话框」——自连 ADB 的正确顺序（2026-11-15）。
 *
 * 为什么不能反过来：那个「使用配对码配对设备」的对话框**一离开就关**（真机实测），
 * 端口随之消失。所以不可能"先在 App 里点按钮、再切到设置"。
 *
 * 现在的方式：在 App 里点一下，App 在**后台**盯着 mDNS 两分钟；
 * 你去开对话框，端口一出现，后台这边立刻动手（今天只做 TLS 握手，SPAKE2 是下一步）。
 * 你回来时结果已经在界面上等着了。
 */
final class AdbPairingWatcher {

    private static final long WINDOW_MS = 120_000;
    private static final long STEP_MS = 1_500;

    private static Thread worker;
    private static volatile boolean running;
    private static volatile String phase = "idle";
    private static volatile String message = "还没开始";

    private AdbPairingWatcher() {
    }

    static synchronized void start(Context context) {
        if (running) return;
        final Context app = context.getApplicationContext();
        running = true;
        phase = "waiting";
        message = "等着配对端口出现……现在去开发者选项里打开「使用配对码配对设备」";
        worker = new Thread(new Runnable() {
            @Override
            public void run() {
                long deadline = System.currentTimeMillis() + WINDOW_MS;
                long lastScan = 0;
                try {
                    while (running && System.currentTimeMillis() < deadline) {
                        // 别每隔一秒就重启一次 mDNS 搜索：那样解析永远来不及完成。
                        // 每 8 秒重扫一次，中间只读现有结果（2026-11-15）。
                        long now = System.currentTimeMillis();
                        if (now - lastScan > 8000) {
                            AdbDiscover.refresh(app);
                            lastScan = now;
                        }
                        Thread.sleep(STEP_MS);
                        String host = "";
                        int port = 0;
                        for (AdbDiscover.Endpoint one : AdbDiscover.snapshot()) {
                            if (AdbDiscover.PAIRING.equals(one.type)) {
                                host = one.host;
                                port = one.port;
                                break;
                            }
                        }
                        if (port == 0) continue;
                        phase = "connecting";
                        message = "看到配对端口 " + port + "，正在握手……";
                        AdbPairingTls.Result result = AdbPairingTls.probe(app, host, port, 6000);
                        if (result.ok) {
                            phase = "ok";
                            message = "端口 " + port + " 握手成功：" + result.protocol + " / " + result.cipher;
                        } else {
                            phase = "failed";
                            message = result.error;
                        }
                        return;
                    }
                    if (running) {
                        phase = "timeout";
                        message = "两分钟没看到配对端口：确认对话框还开着，再点一次";
                    }
                } catch (Exception err) {
                    phase = "failed";
                    message = err.getMessage() == null ? "内部错误" : err.getMessage();
                } finally {
                    running = false;
                }
            }
        }, "mini-adb-pairing");
        worker.start();
    }

    static synchronized void stop() {
        running = false;
        if (worker != null) worker.interrupt();
        worker = null;
        phase = "idle";
    }

    static boolean busy() {
        return running;
    }

    static String stateJson() {
        org.json.JSONObject out = new org.json.JSONObject();
        try {
            out.put("running", running);
            out.put("phase", phase);
            out.put("message", message);
        } catch (Exception ignored) {
        }
        return out.toString();
    }
}
