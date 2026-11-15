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

    private static native String nativeShell(String host, int port, String command,
                                             byte[] certDer, byte[] keyPkcs8);
}
