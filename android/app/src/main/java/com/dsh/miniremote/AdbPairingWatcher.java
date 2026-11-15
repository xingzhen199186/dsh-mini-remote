package com.dsh.miniremote;

import android.content.Context;

/**
 * 自连 ADB 的配对流程（2026-11-15）。
 *
 * 顺序是被真机逼出来的：
 *   1. 用户点「准备配对」→ App 去**后台**等端口，同时弹一条带输入框的通知；
 *   2. 用户去系统里打开「使用配对码配对设备」——对话框**不能离开**，一走就关；
 *   3. 用户在**通知里**填 6 位码（不离开对话框）；
 *   4. 端口与码都到齐，后台立刻配对，结果写回界面与通知。
 *
 * 为什么不能"先拿码再找端口"：端口只在对话框开着时存在，码也只在那时可见，
 * 两者必须同时持有。
 */
final class AdbPairingWatcher {

    private static final long PORT_WINDOW_MS = 180_000;
    private static final long CODE_WINDOW_MS = 180_000;

    private static Thread worker;
    private static volatile boolean running;
    private static volatile String phase = "idle";
    private static volatile String message = "还没开始";
    private static volatile String pendingCode = null;
    private static volatile Context appContext = null;

    private AdbPairingWatcher() {
    }

    static synchronized void begin(Context context) {
        if (running) return;
        final Context app = context.getApplicationContext();
        appContext = app;
        running = true;
        pendingCode = null;
        phase = "waiting-port";
        message = "等着配对端口出现：现在去开发者选项里打开「使用配对码配对设备」";
        AdbPairingNotify.show(app);
        worker = new Thread(new Runnable() {
            @Override
            public void run() {
                long start = System.currentTimeMillis();
                long lastScan = 0;
                try {
                    String host = "";
                    int port = 0;
                    while (running) {
                        long now = System.currentTimeMillis();
                        if (port == 0) {
                            if (now - start > PORT_WINDOW_MS) {
                                phase = "timeout";
                                message = "三分钟没看到配对端口：确认那个对话框还开着，再来一次";
                                break;
                            }
                            if (now - lastScan > 4000) {
                                AdbDiscover.refresh(app);
                                lastScan = now;
                            }
                            // **只认配对服务**，并且要和"连接服务"的端口区分开：
                            // 两者都开着时，连错就会得到 CNXN（首字节 0x43）而不是配对的帧。
                            int pairingPort = 0;
                            int connectPort = 0;
                            String pairingHost = "";
                            for (AdbDiscover.Endpoint one : AdbDiscover.snapshot()) {
                                if (AdbDiscover.PAIRING.equals(one.type)) {
                                    pairingPort = one.port;
                                    pairingHost = one.host;
                                } else if (AdbDiscover.CONNECT.equals(one.type)) {
                                    connectPort = one.port;
                                }
                            }
                            if (pairingPort != 0 && pairingPort != connectPort) {
                                host = pairingHost;
                                port = pairingPort;
                                phase = "waiting-code";
                                message = "看到配对口 " + port + " 了：在通知里填 6 位配对码";
                            }
                            Thread.sleep(600);
                            continue;
                        }
                        String code = pendingCode;
                        if (code == null) {
                            if (now - start > CODE_WINDOW_MS) {
                                phase = "timeout";
                                message = "没收到配对码：通知里点「填写配对码」再试";
                                break;
                            }
                            Thread.sleep(300);
                            continue;
                        }
                        phase = "pairing";
                        message = "正在配对（端口 " + port + "）……";
                        android.util.Log.i("MiniBridge", "开始配对 端口=" + port + " 码位数=" + code.length());
                        AdbPairing.Result result = AdbPairing.pair(app, host, port, code);
                        android.util.Log.i("MiniBridge", "配对结果 ok=" + result.ok + " " + result.error + result.peer);
                        if (result.ok) {
                            // 记住"配过了"，以后 phone_shell 会优先走这条通道。
                            ShellBackend.markPaired(app, host, port);
                            phase = "ok";
                            message = "配对成功" + (result.peer.isEmpty() ? "" : "：" + result.peer);
                        } else {
                            phase = "failed";
                            message = result.error;
                        }
                        break;
                    }
                } catch (Exception err) {
                    phase = "failed";
                    message = err.getMessage() == null ? "内部错误" : err.getMessage();
                } finally {
                    running = false;
                    AdbPairingNotify.done(app, message);
                }
            }
        }, "mini-adb-pairing");
        worker.start();
    }

    /** 通知里填的码送进来。 */
    static void submitCode(Context context, String code) {
        String trimmed = code == null ? "" : code.trim();
        if (!trimmed.matches("\\d{6}")) {
            message = "配对码要是 6 位数字，刚才那个不算";
            return;
        }
        pendingCode = trimmed;
        if (!running) {
            // 用户先填了码、后来才点「准备配对」：记下来，开始等他开对话框。
            begin(context);
        }
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
            // 已配对时告诉界面：现在扫不扫得到连接口（无线调试开没开）。
            if (appContext != null && ShellBackend.paired(appContext)) {
                out.put("paired", true);
                AdbDiscover.Endpoint connect = AdbShell.connectEndpoint(appContext);
                out.put("connectPort", connect == null ? 0 : connect.port);
            }
        } catch (Exception ignored) {
        }
        return out.toString();
    }
}
