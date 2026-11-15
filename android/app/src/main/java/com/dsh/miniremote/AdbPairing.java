package com.dsh.miniremote;

/**
 * 配对的原生入口（2026-11-15）。
 *
 * 真正干活的是 libadb_pairing.so 里的 BoringSSL：TLS 通道绑定 → SPAKE2 → AES 交换公钥。
 * 这里只做三件事：拿到自己的钥匙和证书、把参数递过去、把结果翻成人话。
 */
final class AdbPairing {

    private static boolean loaded = false;

    private AdbPairing() {
    }

    static synchronized boolean load() {
        if (loaded) return true;
        try {
            System.loadLibrary("adb_pairing");
            loaded = true;
        } catch (Throwable err) {
            android.util.Log.w("MiniBridge", "加载配对库失败：" + err.getMessage());
        }
        return loaded;
    }

    /** 一次配对尝试的结果。 */
    static final class Result {
        boolean ok;
        String peer = "";
        String error = "";
    }

    static Result pair(android.content.Context context, String host, int port, String code) {
        Result out = new Result();
        if (!load()) {
            out.error = "配对库没有加载（这个安装包可能不含 arm64 的原生库）";
            return out;
        }
        AdbKey.Keys keys = AdbKey.loadOrCreate(context);
        if (keys == null) {
            out.error = "生成钥匙失败：" + AdbKey.lastError();
            return out;
        }
        try {
            byte[] cert = keys.cert.getEncoded();
            byte[] key = keys.key.getEncoded();
            String json = nativePair(host, port, code, cert, key);
            org.json.JSONObject parsed = new org.json.JSONObject(json);
            out.ok = parsed.optBoolean("ok", false);
            out.peer = parsed.optString("peer", "");
            out.error = parsed.optString("error", "");
        } catch (Throwable err) {
            out.error = err.getMessage() == null ? err.getClass().getSimpleName() : err.getMessage();
        }
        return out;
    }

    private static native String nativePair(String host, int port, String code,
                                            byte[] certDer, byte[] keyPkcs8);
}
