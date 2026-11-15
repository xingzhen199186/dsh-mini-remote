package com.dsh.miniremote;

/**
 * 自连 ADB 的第三步：**用这把钥匙跑一条命令**（2026-11-15）。
 *
 * 走的是原生的同一条通道：明文 CNXN → STLS → TLS → 签名认证 → shell。
 * 这里只负责递参数与翻结果；真正的协议在 adb_pairing.c。
 */
final class AdbShell {

    private AdbShell() {
    }

    static final class Result {
        boolean ok;
        String output = "";
        String error = "";
    }

    static Result run(android.content.Context context, String host, int port, String command) {
        Result out = new Result();
        if (!AdbPairing.load()) {
            out.error = "配对库没有加载";
            return out;
        }
        AdbKey.Keys keys = AdbKey.loadOrCreate(context);
        if (keys == null) {
            out.error = "生成钥匙失败：" + AdbKey.lastError();
            return out;
        }
        try {
            String json = nativeShell(host, port, command,
                    keys.cert.getEncoded(), keys.key.getEncoded());
            org.json.JSONObject parsed = new org.json.JSONObject(json);
            out.ok = parsed.optBoolean("ok", false);
            out.output = parsed.optString("output", "");
            out.error = parsed.optString("error", "");
        } catch (Throwable err) {
            out.error = err.getMessage() == null ? err.getClass().getSimpleName() : err.getMessage();
        }
        return out;
    }

    /** 找当前的连接口（配对之后才有意义）。 */
    static AdbDiscover.Endpoint connectEndpoint(android.content.Context context) {
        AdbDiscover.refresh(context);
        try {
            Thread.sleep(900);
        } catch (InterruptedException ignored) {
        }
        for (AdbDiscover.Endpoint one : AdbDiscover.snapshot()) {
            if (AdbDiscover.CONNECT.equals(one.type)) return one;
        }
        return null;
    }

    // ---- 连接复用（2026-11-15）----
    //
    // 每条命令重新握手有明显开销，所以留住一条会话反复开 shell 流。
    // 同一时刻只跑一条命令（加锁）；闲置太久、端口变了、或出错就丢掉重连——
    // 会话复用最容易出的问题是"连接看着在、其实早断了"，所以出错一律重建，不做修补。

    private static final long IDLE_CLOSE_MS = 60_000;
    private static volatile Reuse current = null;

    private static final class Reuse {
        private long handle;
        private final String host;
        private final int port;
        private long lastUsed;

        Reuse(String host, int port, long handle) {
            this.host = host;
            this.port = port;
            this.handle = handle;
            this.lastUsed = System.currentTimeMillis();
        }

        boolean matches(String host, int port) {
            return handle != 0 && this.host.equals(host) && this.port == port;
        }

        boolean tooOld() {
            return System.currentTimeMillis() - lastUsed > IDLE_CLOSE_MS;
        }

        synchronized Result exec(String command) {
            Result out = new Result();
            if (handle == 0) {
                out.error = "会话已关闭";
                return out;
            }
            try {
                org.json.JSONObject json = new org.json.JSONObject(nativeSessionExec(handle, command));
                out.ok = json.optBoolean("ok", false);
                out.output = json.optString("output", "");
                out.error = json.optString("error", "");
                lastUsed = System.currentTimeMillis();
            } catch (Throwable err) {
                out.error = err.getMessage() == null ? "会话执行失败" : err.getMessage();
            }
            return out;
        }

        synchronized void close() {
            if (handle != 0) {
                try {
                    nativeSessionClose(handle);
                } catch (Throwable ignored) {
                }
                handle = 0;
            }
        }
    }

    /** 闲置太久就把会话关掉：不能让它一直占着手机的调试连接。 */
    static void closeIdle() {
        Reuse reuse = current;
        if (reuse != null && reuse.tooOld()) {
            reuse.close();
            current = null;
        }
    }

    /** 复用（必要时新建）一条会话跑命令；失败就丢掉会话，交给调用方退回。 */
    static Result execReusing(android.content.Context context, String host, int port, String command) {
        Result failed = new Result();
        if (!AdbPairing.load()) {
            failed.error = "配对库没有加载";
            return failed;
        }
        AdbKey.Keys keys = AdbKey.loadOrCreate(context);
        if (keys == null) {
            failed.error = "生成钥匙失败：" + AdbKey.lastError();
            return failed;
        }
        Reuse reuse = current;
        if (reuse != null && (!reuse.matches(host, port) || reuse.tooOld())) {
            reuse.close();
            current = null;
            reuse = null;
        }
        if (reuse == null) {
            long handle = 0;
            try {
                handle = nativeSessionOpen(host, port, keys.cert.getEncoded(), keys.key.getEncoded());
            } catch (Throwable err) {
                failed.error = err.getMessage() == null ? "开会话失败" : err.getMessage();
                return failed;
            }
            if (handle == 0) {
                failed.error = "开不了会话（端口或钥匙不对）";
                return failed;
            }
            reuse = new Reuse(host, port, handle);
            current = reuse;
        }
        Result result = reuse.exec(command);
        if (!result.ok) {
            reuse.close();
            current = null;
        }
        return result;
    }

    private static native long nativeSessionOpen(String host, int port, byte[] certDer, byte[] keyPkcs8);

    private static native String nativeSessionExec(long handle, String command);

    private static native void nativeSessionClose(long handle);

    private static native String nativeShell(String host, int port, String command,
                                             byte[] certDer, byte[] keyPkcs8);
}
