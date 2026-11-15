import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.*;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.TimeZone;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;

public class DerTest {
    public static void main(String[] args) throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(2048);
        KeyPair pair = gen.generateKeyPair();
        byte[] tbs = tbsCertificate(pair);
        byte[] certDer = certificate(tbs, pair);
        X509Certificate cert = (X509Certificate) CertificateFactory.getInstance("X.509")
                .generateCertificate(new ByteArrayInputStream(certDer));
        cert.checkValidity();
        System.out.println("OK 证书长度 " + certDer.length);
        System.out.println(cert.getSubjectX500Principal().getName());
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

}
