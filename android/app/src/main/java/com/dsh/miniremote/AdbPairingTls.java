package com.dsh.miniremote;

import java.io.InputStream;
import java.net.InetSocketAddress;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.cert.X509Certificate;

import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * 自连 ADB 的第二步，第一层：**把 TLS 建起来**（2026-11-15）。
 *
 * 为什么先只做这一层：配对那条连接是「TCP → TLS 1.3 双向证书 → SPAKE2 交换」。
 * 只有 TLS 这一层可以单独验证——连上、看到协议版本和对面证书，就说明钥匙、
 * 证书、双向认证都对；这一层不通，后面写 SPAKE2 全是白搭。
 *
 * 注意：**这里不做任何业务包**，连上就断。配对端口是一次性的，
 * 乱发半截数据的副作用比"只握手"大得多。
 */
final class AdbPairingTls {

    private AdbPairingTls() {
    }

    /** 结果要么成功（带协议/套件/对面证书摘要），要么带一句人话的原因。 */
    static final class Result {
        boolean ok;
        String protocol = "";
        String cipher = "";
        String peer = "";
        String error = "";

        String describe() {
            if (!ok) return "没连上：" + error;
            return "TLS 已建立（" + protocol + " / " + cipher + "），对面证书：" + peer;
        }
    }

    static Result probe(android.content.Context context, String host, int port, int timeoutMs) {
        Result out = new Result();
        AdbKey.Keys keys = AdbKey.loadOrCreate(context);
        if (keys == null) {
            out.error = "生成钥匙失败：" + AdbKey.lastError();
            return out;
        }
        SSLSocket socket = null;
        try {
            SSLContext ssl = SSLContext.getInstance("TLS");
            // 客户端证书：手机不校验证书链，但**必须出示**，否则配对连接会直接断。
            KeyStore store = KeyStore.getInstance("PKCS12");
            store.load(null, null);
            store.setKeyEntry("adb", keys.key, new char[0], new X509Certificate[]{keys.cert});
            KeyManagerFactory keysFactory = KeyManagerFactory.getInstance(KeyManagerFactory.getDefaultAlgorithm());
            keysFactory.init(store, new char[0]);
            ssl.init(keysFactory.getKeyManagers(), new TrustManager[]{TRUST_ALL}, new java.security.SecureRandom());

            socket = (SSLSocket) ssl.getSocketFactory().createSocket();
            socket.connect(new InetSocketAddress(host, port), timeoutMs);
            socket.setSoTimeout(timeoutMs);
            socket.setUseClientMode(true);
            socket.startHandshake();

            out.ok = true;
            out.protocol = socket.getSession().getProtocol();
            out.cipher = socket.getSession().getCipherSuite();
            java.security.cert.Certificate[] chain = socket.getSession().getPeerCertificates();
            if (chain != null && chain.length > 0 && chain[0] instanceof X509Certificate) {
                X509Certificate peer = (X509Certificate) chain[0];
                String subject = peer.getSubjectX500Principal().getName();
                out.peer = subject + "（" + shortDigest(peer) + "）";
            }
        } catch (Exception err) {
            out.error = err.getMessage() == null ? err.getClass().getSimpleName() : err.getMessage();
        } finally {
            if (socket != null) {
                try {
                    socket.close();
                } catch (Exception ignored) {
                }
            }
        }
        return out;
    }

    private static String shortDigest(X509Certificate cert) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(cert.getEncoded());
            StringBuilder text = new StringBuilder();
            for (int i = 0; i < 4 && i < digest.length; i++) {
                text.append(String.format("%02x", digest[i]));
            }
            return text.toString();
        } catch (Exception err) {
            return "";
        }
    }

    /**
     * **故意全放行**：配对协议靠 SPAKE2 认证双方，不靠 CA 链。
     * 将来连接端口那边要改成"只认配对时钉住的那张证书"，不能一直接受任何证书。
     */
    private static final X509TrustManager TRUST_ALL = new X509TrustManager() {
        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) {
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) {
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    };
}
