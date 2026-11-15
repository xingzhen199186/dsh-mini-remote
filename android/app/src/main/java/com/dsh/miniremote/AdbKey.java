package com.dsh.miniremote;

import android.content.Context;
import android.util.Base64;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.security.spec.PKCS8EncodedKeySpec;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;

/**
 * 自连 ADB 用的那把钥匙和那张自签证书（2026-11-15）。
 *
 * 为什么需要证书：配对那条 TLS 是**双向**的——手机要客户端也出示证书。
 * 证书内容不重要（协议不校验证书链，信任来自 SPAKE2），但**必须是一张格式合法的
 * 自签 X.509**，而且**它的公钥要和后面连接端口用的那把是同一个**，否则手机认不出你。
 *
 * 这里不引第三方库，自己拼 DER：一张最小可用证书不到 200 行，
 * 比为了生成证书往包里塞几兆的加密库划算；拼完立刻用系统的 CertificateFactory
 * 解一遍，解不开就当生成失败——**不拿一张坏证书去连**。
 */
final class AdbKey {

    static final String KEY_FILE = "adb_private.der";
    static final String CERT_FILE = "adb_cert.der";

    /** 上次失败的原因（给界面说人话用；成功时为 null）。 */
    private static volatile String lastError = null;

    static String lastError() {
        return lastError == null ? "" : lastError;
    }

    private AdbKey() {
    }

    /** 读出来；没有就生成一对并落盘。失败返回 null（调用方如实说原因）。 */
    static synchronized Keys loadOrCreate(Context context) {
        File dir = context.getFilesDir();
        File keyFile = new File(dir, KEY_FILE);
        File certFile = new File(dir, CERT_FILE);
        if (keyFile.exists() && certFile.exists()) {
            Keys old = read(keyFile, certFile);
            if (old != null) return old;
            // 存着但读不出来（版本坏了/被清过）：重新生成，不让它变成永久故障。
            keyFile.delete();
            certFile.delete();
        }
        try {
            Keys made = create(keyFile == null ? context : context, keyFile, certFile);
            lastError = null;
            return made;
        } catch (Exception err) {
            // **把真实原因记下来**：昨天那版只说"内部错误"，等于让用户对着黑箱。
            lastError = err.getClass().getSimpleName()
                    + (err.getMessage() == null ? "" : "：" + err.getMessage());
            android.util.Log.w("MiniBridge", "生成 adb 钥匙失败：" + lastError);
            return null;
        }
    }

    /** 一对钥匙：私钥 + 自签证书。 */
    static final class Keys {
        final PrivateKey key;
        final X509Certificate cert;

        Keys(PrivateKey key, X509Certificate cert) {
            this.key = key;
            this.cert = cert;
        }
    }

    private static Keys read(File keyFile, File certFile) {
        try {
            byte[] keyBytes = readAll(keyFile);
            byte[] certBytes = readAll(certFile);
            PrivateKey key = KeyFactory.getInstance("RSA")
                    .generatePrivate(new PKCS8EncodedKeySpec(keyBytes));
            X509Certificate cert = (X509Certificate) CertificateFactory.getInstance("X.509")
                    .generateCertificate(new ByteArrayInputStream(certBytes));
            cert.checkValidity();
            return new Keys(key, cert);
        } catch (Exception err) {
            return null;
        }
    }

    private static Keys create(Context context, File keyFile, File certFile) throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        KeyPair pair = gen.generateKeyPair();
        byte[] tbs = tbsCertificate(pair);
        byte[] certDer = certificate(tbs, pair);

        // **先验再用**：自己拼的 DER 必须能被系统的解析器接受。
        X509Certificate cert = (X509Certificate) CertificateFactory.getInstance("X.509")
                .generateCertificate(new ByteArrayInputStream(certDer));
        cert.checkValidity();

        writeAll(keyFile, pair.getPrivate().getEncoded());
        writeAll(certFile, certDer);
        return new Keys(pair.getPrivate(), cert);
    }

    // ------------------------------------------------------------------
    // 最小 X.509：tbsCertificate + 签名，够 BoringSSL 收下就行
    // ------------------------------------------------------------------

    private static byte[] tbsCertificate(KeyPair pair) throws Exception {
        Der tbs = new Der();
        // version [0] EXPLICIT INTEGER 2（v3）
        Der version = new Der();
        version.integer(BigInteger.valueOf(2));
        tbs.tagged(0xA0, version.bytes());
        tbs.integer(BigInteger.valueOf(System.currentTimeMillis()));
        // signature: sha256WithRSAEncryption + NULL
        tbs.raw(sha256AlgId());
        byte[] name = name();
        tbs.raw(name);                      // issuer
        tbs.raw(validity());                // validity
        tbs.raw(name);                      // subject
        tbs.raw(pair.getPublic().getEncoded()); // subjectPublicKeyInfo（已有 DER）
        return tbs.wrapSequence();
    }

    private static byte[] certificate(byte[] tbs, KeyPair pair) throws Exception {
        Signature signer = Signature.getInstance("SHA256withRSA");
        signer.initSign(pair.getPrivate());
        signer.update(tbs);
        byte[] signature = signer.sign();

        Der cert = new Der();
        cert.raw(tbs);
        cert.raw(sha256AlgId());
        Der bits = new Der();
        bits.bitString(signature);
        cert.raw(bits.bytes());
        return cert.wrapSequence();
    }

    private static byte[] sha256AlgId() {
        Der one = new Der();
        one.oid(new int[]{1, 2, 840, 113549, 1, 1, 11});
        one.nullValue();
        return one.wrapSequence();
    }

    private static byte[] name() {
        Der atv = new Der();
        atv.oid(new int[]{2, 5, 4, 3});                 // commonName
        atv.utf8("dsh-everywhere");
        Der rdn = new Der();
        rdn.raw(atv.wrapSequence());
        Der name = new Der();
        name.raw(rdn.wrapSet());
        return name.wrapSequence();
    }

    private static byte[] validity() {
        SimpleDateFormat fmt = new SimpleDateFormat("yyMMddHHmmss'Z'", Locale.US);
        fmt.setTimeZone(TimeZone.getTimeZone("UTC"));
        long now = System.currentTimeMillis();
        Der one = new Der();
        one.utcTime(fmt.format(new Date(now - 24L * 3600 * 1000)));
        one.utcTime(fmt.format(new Date(now + 3650L * 24 * 3600 * 1000)));
        return one.wrapSequence();
    }

    // ------------------------------------------------------------------

    private static byte[] readAll(File file) throws Exception {
        try (FileInputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    private static void writeAll(File file, byte[] data) throws Exception {
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(data);
        }
    }

    /** 一个只够用的 DER 写入器：长度、整数、OID、时间、位串。 */
    private static final class Der {
        private final ByteArrayOutputStream out = new ByteArrayOutputStream();

        byte[] bytes() {
            return out.toByteArray();
        }

        void raw(byte[] data) {
            out.write(data, 0, data.length);
        }

        void integer(BigInteger value) {
            byte[] body = value.toByteArray();
            header(0x02, body.length);
            raw(body);
        }

        void utf8(String text) {
            byte[] body = text.getBytes(StandardCharsets.UTF_8);
            header(0x0C, body.length);
            raw(body);
        }

        void utcTime(String text) {
            byte[] body = text.getBytes(StandardCharsets.US_ASCII);
            header(0x17, body.length);
            raw(body);
        }

        void oid(int[] parts) {
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            body.write(parts[0] * 40 + parts[1]);
            for (int i = 2; i < parts.length; i++) {
                int v = parts[i];
                if (v < 128) {
                    body.write(v);
                } else {
                    byte[] tmp = new byte[5];
                    int n = 0;
                    tmp[n++] = (byte) (v & 0x7F);
                    v >>>= 7;
                    while (v > 0) {
                        tmp[n++] = (byte) ((v & 0x7F) | 0x80);
                        v >>>= 7;
                    }
                    while (n > 0) body.write(tmp[--n]);
                }
            }
            byte[] data = body.toByteArray();
            header(0x06, data.length);
            raw(data);
        }

        void nullValue() {
            header(0x05, 0);
        }

        void bitString(byte[] data) {
            header(0x03, data.length + 1);
            out.write(0);                    // 0 个未用位
            raw(data);
        }

        void sequence(byte[] body) {
            header(0x30, body.length);
            raw(body);
        }

        byte[] wrapSequence() {
            byte[] body = bytes();
            Der one = new Der();
            one.sequence(body);
            return one.bytes();
        }

        byte[] wrapSet() {
            byte[] body = bytes();
            Der one = new Der();
            one.header(0x31, body.length);
            one.raw(body);
            return one.bytes();
        }

        void tagged(int tag, byte[] body) {
            header(tag, body.length);
            raw(body);
        }

        private void header(int tag, int length) {
            out.write(tag);
            if (length < 0x80) {
                out.write(length);
            } else if (length <= 0xFF) {
                out.write(0x81);
                out.write(length);
            } else if (length <= 0xFFFF) {
                out.write(0x82);
                out.write((length >> 8) & 0xFF);
                out.write(length & 0xFF);
            } else {
                out.write(0x83);
                out.write((length >> 16) & 0xFF);
                out.write((length >> 8) & 0xFF);
                out.write(length & 0xFF);
            }
        }
    }

    /** 诊断用：公钥指纹（顺手也能贴到界面上让用户对一眼）。 */
    static String fingerprint(X509Certificate cert) {
        try {
            byte[] digest = java.security.MessageDigest.getInstance("SHA-256")
                    .digest(cert.getPublicKey().getEncoded());
            return Base64.encodeToString(digest, Base64.NO_WRAP);
        } catch (Exception err) {
            return "";
        }
    }
}
