// 自连 ADB 的配对：一条原生实现（2026-11-15）
//
// 为什么放在原生：配对这一步有三样东西必须"字节级正确"——
//   TLS 的通道绑定值（exporter）、SPAKE2 的曲线运算、AES-128-GCM 的封包。
//   Java 侧无法拿到 TLS exporter，自己实现 SPAKE2 又要和 BoringSSL 逐位对齐；
//   而 BoringSSL 三个都自带。所以：Java 负责找端口、给证书和私钥、报结果，
//   原生负责握手、认证、交换公钥。
//
// 协议要点（对照 AOSP packages/modules/adb 与公开协议笔记）：
//   口令 = 6 位配对码的 ASCII || TLS exporter("adb-label\0", 64 字节)
//   SPAKE2 身份串 = "adb pair client\0" / "adb pair server\0"（含结尾 NUL，16 字节）
//   帧 = version(1)=1 || type(1) || 长度(4, 大端) || 载荷；type 0=SPAKE2，1=PEER_INFO
//   认证后双方各用 AES-128-GCM 加密自己的 PeerInfo（类型 0=RSA 公钥），
//   nonce = 小端 64 位序号 + 4 个 0，收发各自从 0 开始；客户端先发。

#include <jni.h>
#include <stdint.h>
#include <stdbool.h>
#include <android/log.h>
#include <string.h>
#include <stdlib.h>
#include <stdio.h>
#include <errno.h>
#include <unistd.h>
#include <netdb.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/time.h>

#include <openssl/ssl.h>
#include <openssl/err.h>
#include <openssl/evp.h>
#include <openssl/x509.h>
#include <openssl/hkdf.h>
#include <openssl/curve25519.h>
#include <openssl/rsa.h>
#include <openssl/bn.h>

#define LOG_TAG "MiniAdb"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, LOG_TAG, __VA_ARGS__)
#define PEER_INFO_SIZE 8192
#define ADB_RSA_PUB_KEY 0
#define HEADER_SIZE 6
#define PAIRING_VERSION 1
#define TYPE_SPAKE2 0
#define TYPE_PEER_INFO 1
#define EXPORTER_LEN 64
// 通道绑定值的标签：协议里带结尾 NUL，长度按"含 NUL"计。
static const char kExporterLabel[] = "adb-label\0";
#define EXPORTER_LABEL_LEN 10
static const char kClientName[] = "adb pair client";
static const char kServerName[] = "adb pair server";
#define NAME_LEN 16  // sizeof(...) 含结尾 NUL

static void set_error(char *buf, size_t len, const char *fmt, ...) {
    if (buf == NULL || len == 0) return;
    va_list args;
    va_start(args, fmt);
    vsnprintf(buf, len, fmt, args);
    va_end(args);
}

static int tcp_connect(const char *host, int port, int timeout_ms, char *err, size_t errlen) {
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    char port_text[16];
    snprintf(port_text, sizeof(port_text), "%d", port);
    struct addrinfo *list = NULL;
    int rc = getaddrinfo(host, port_text, &hints, &list);
    if (rc != 0 || list == NULL) {
        set_error(err, errlen, "解析地址失败：%s", gai_strerror(rc));
        return -1;
    }
    int fd = -1;
    for (struct addrinfo *one = list; one != NULL; one = one->ai_next) {
        fd = socket(one->ai_family, one->ai_socktype, one->ai_protocol);
        if (fd < 0) continue;
        int flags = fcntl(fd, F_GETFL, 0);
        fcntl(fd, F_SETFL, flags | O_NONBLOCK);
        rc = connect(fd, one->ai_addr, one->ai_addrlen);
        if (rc != 0 && errno != EINPROGRESS) {
            close(fd);
            fd = -1;
            continue;
        }
        struct pollfd waiting;
        waiting.fd = fd;
        waiting.events = POLLOUT;
        waiting.revents = 0;
        rc = poll(&waiting, 1, timeout_ms);
        int so_error = 0;
        socklen_t so_len = sizeof(so_error);
        getsockopt(fd, SOL_SOCKET, SO_ERROR, &so_error, &so_len);
        if (rc > 0 && so_error == 0) {
            fcntl(fd, F_SETFL, flags);
            break;
        }
        close(fd);
        fd = -1;
    }
    freeaddrinfo(list);
    if (fd < 0) set_error(err, errlen, "连不上 %s:%d", host, port);
    return fd;
}

// **握手之后必须走 TLS**：直接用 send/recv 会写出明文垃圾，
// 而读回来的前几个字节是 TLS 记录头（0x17 就是"应用数据"），
// 上一版就是栽在这里（2026-11-15 真机：首字节 0x17）。
static int write_all(SSL *ssl, const uint8_t *data, size_t len) {
    size_t done = 0;
    while (done < len) {
        int n = SSL_write(ssl, data + done, (int) (len - done));
        if (n <= 0) return -1;
        done += (size_t) n;
    }
    return 0;
}

static int read_all(SSL *ssl, uint8_t *data, size_t len) {
    size_t done = 0;
    while (done < len) {
        int n = SSL_read(ssl, data + done, (int) (len - done));
        if (n <= 0) return -1;
        done += (size_t) n;
    }
    return 0;
}

static void put_be32(uint8_t *out, uint32_t value) {
    out[0] = (uint8_t) (value >> 24);
    out[1] = (uint8_t) (value >> 16);
    out[2] = (uint8_t) (value >> 8);
    out[3] = (uint8_t) value;
}

static uint32_t get_be32(const uint8_t *in) {
    return ((uint32_t) in[0] << 24) | ((uint32_t) in[1] << 16) | ((uint32_t) in[2] << 8) | (uint32_t) in[3];
}

static int send_frame(SSL *ssl, int type, const uint8_t *payload, size_t len) {
    uint8_t header[HEADER_SIZE];
    header[0] = PAIRING_VERSION;
    header[1] = (uint8_t) type;
    put_be32(header + 2, (uint32_t) len);
    if (write_all(ssl, header, sizeof(header)) != 0) return -1;
    if (len > 0 && write_all(ssl, payload, len) != 0) return -1;
    return 0;
}

static int read_frame(SSL *ssl, int *type, uint8_t *payload, size_t cap, size_t *len,
                      uint8_t *first_byte) {
    uint8_t header[HEADER_SIZE];
    if (read_all(ssl, header, sizeof(header)) != 0) return -1;
    if (first_byte != NULL) *first_byte = header[0];
    if (header[0] != PAIRING_VERSION) return -2;
    *type = header[1];
    uint32_t size = get_be32(header + 2);
    if (size > cap) return -3;
    if (size > 0 && read_all(ssl, payload, size) != 0) return -1;
    *len = size;
    return 0;
}

// ---- ADB 的 RSA 公钥结构（524 字节，全小端）----
// uint32 len; uint32 n0inv; uint8 n[256]; uint8 rr[256]; uint32 exponent
static int build_android_pubkey(EVP_PKEY *key, uint8_t out[524]) {
    const RSA *rsa = EVP_PKEY_get0_RSA(key);
    if (rsa == NULL) return -1;
    const BIGNUM *n = NULL;
    const BIGNUM *e = NULL;
    RSA_get0_key(rsa, &n, &e, NULL);
    if (n == NULL || e == NULL) return -1;

    memset(out, 0, 524);
    // **第一个字段是"模数的字数"，不是总字节数**（2026-11-15 真机踩到的）：
    // AOSP android_pubkey.cpp 里 checks `modulus_size_words != ANDROID_PUBKEY_MODULUS_SIZE_WORDS`，
    // 也就是 256/4 = 64。写成 524 的话解码直接失败，手机就不会把我们的钥匙存下来，
    // 配对看起来"成功"，但之后连上来只会收到 CERTIFICATE_UNKNOWN。
    uint32_t modulus_words = 64;
    memcpy(out, &modulus_words, 4);
    // n0inv = -1 / n mod 2^32
    BN_CTX *ctx = BN_CTX_new();
    BIGNUM *mod = BN_new();
    BIGNUM *inv = BN_new();
    BIGNUM *r32 = BN_new();
    BIGNUM *tmp = BN_new();
    BIGNUM *big_r = BN_new();
    BIGNUM *rr = BN_new();
    int ok = 0;
    do {
        if (!BN_set_bit(mod, 32)) break;
        if (!BN_mod(inv, n, mod, ctx)) break;
        if (!BN_mod_inverse(inv, inv, mod, ctx)) break;
        if (!BN_sub(inv, mod, inv)) break;                 // -1/n mod 2^32
        uint32_t n0inv = 0;
        BN_bn2binpad(inv, (uint8_t *) &n0inv, 4);
        memcpy(out + 4, &n0inv, 4);

        if (BN_bn2lebinpad(n, out + 8, 256) != 256) break;  // modulus，小端
        // rr = 2^4096 mod n
        if (!BN_set_bit(big_r, 4096)) break;
        if (!BN_mod(rr, big_r, n, ctx)) break;
        if (BN_bn2lebinpad(rr, out + 8 + 256, 256) != 256) break;
        // exponent（小端 4 字节）
        uint32_t exponent = 0;
        if (!BN_bn2lebinpad(e, (uint8_t *) &exponent, 4)) break;
        memcpy(out + 8 + 512, &exponent, 4);
        ok = 1;
    } while (0);
    BN_clear_free(mod);
    BN_clear_free(inv);
    BN_clear_free(r32);
    BN_clear_free(tmp);
    BN_clear_free(big_r);
    BN_clear_free(rr);
    BN_CTX_free(ctx);
    return ok ? 0 : -1;
}

// BoringSSL 没有 base64 的 BIO（那是 OpenSSL 的东西），自己按标准字母表编。
static char *base64_encode(const uint8_t *data, size_t len) {
    static const char kAlphabet[] =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t out_len = ((len + 2) / 3) * 4;
    char *out = (char *) malloc(out_len + 1);
    if (out == NULL) return NULL;
    size_t at = 0;
    for (size_t i = 0; i < len; i += 3) {
        uint32_t block = (uint32_t) data[i] << 16;
        if (i + 1 < len) block |= (uint32_t) data[i + 1] << 8;
        if (i + 2 < len) block |= data[i + 2];
        out[at++] = kAlphabet[(block >> 18) & 0x3F];
        out[at++] = kAlphabet[(block >> 12) & 0x3F];
        out[at++] = (i + 1 < len) ? kAlphabet[(block >> 6) & 0x3F] : '=';
        out[at++] = (i + 2 < len) ? kAlphabet[block & 0x3F] : '=';
    }
    out[at] = '\0';
    return out;
}

// AES-128-GCM：nonce = 小端 64 位序号 + 4 个 0；输出 = 密文 || 16 字节 tag
static int aes_gcm_seal(const uint8_t *key16, uint64_t seq, const uint8_t *in, size_t len,
                        uint8_t *out, size_t *out_len) {
    uint8_t nonce[12];
    memset(nonce, 0, sizeof(nonce));
    for (int i = 0; i < 8; i++) nonce[i] = (uint8_t) (seq >> (8 * i));
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (ctx == NULL) return -1;
    int ok = 0;
    int written = 0;
    do {
        if (!EVP_EncryptInit_ex(ctx, EVP_aes_128_gcm(), NULL, key16, nonce)) break;
        if (!EVP_EncryptUpdate(ctx, out, &written, in, (int) len)) break;
        int total = written;
        if (!EVP_EncryptFinal_ex(ctx, out + total, &written)) break;
        total += written;
        uint8_t tag[16];
        if (!EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_GET_TAG, 16, tag)) break;
        memcpy(out + total, tag, 16);
        *out_len = (size_t) total + 16;
        ok = 1;
    } while (0);
    EVP_CIPHER_CTX_free(ctx);
    return ok ? 0 : -1;
}

static int aes_gcm_open(const uint8_t *key16, uint64_t seq, const uint8_t *in, size_t len,
                        uint8_t *out, size_t *out_len) {
    if (len < 16) return -1;
    size_t body = len - 16;
    uint8_t nonce[12];
    memset(nonce, 0, sizeof(nonce));
    for (int i = 0; i < 8; i++) nonce[i] = (uint8_t) (seq >> (8 * i));
    EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
    if (ctx == NULL) return -1;
    int ok = 0;
    int written = 0;
    do {
        if (!EVP_DecryptInit_ex(ctx, EVP_aes_128_gcm(), NULL, key16, nonce)) break;
        if (!EVP_DecryptUpdate(ctx, out, &written, in, (int) body)) break;
        int total = written;
        uint8_t tag[16];
        memcpy(tag, in + body, 16);
        if (!EVP_CIPHER_CTX_ctrl(ctx, EVP_CTRL_GCM_SET_TAG, 16, tag)) break;
        if (EVP_DecryptFinal_ex(ctx, out + total, &written) <= 0) break;
        *out_len = (size_t) total + (size_t) written;
        ok = 1;
    } while (0);
    EVP_CIPHER_CTX_free(ctx);
    return ok ? 0 : -1;
}

/**
 * 配对一次。返回 0 成功；负数见 err。
 * peer_name 输出：手机端在 PEER_INFO 里回给我们的名字（可能为空），用于界面显示。
 */
static int do_pair(const char *host, int port, const char *code,
                   const uint8_t *cert_der, size_t cert_len,
                   const uint8_t *key_pkcs8, size_t key_len,
                   char *peer_name, size_t peer_name_len,
                   char *err, size_t errlen) {
    int result = -1;
    int fd = -1;
    SSL_CTX *ssl_ctx = NULL;
    SSL *ssl = NULL;
    SPAKE2_CTX *spake = NULL;
    EVP_PKEY *pkey = NULL;
    X509 *cert = NULL;
    uint8_t *peer_msg = NULL;
    uint8_t *peer_info = NULL;
    uint8_t *plain = NULL;

    do {
        ssl_ctx = SSL_CTX_new(TLS_method());
        if (ssl_ctx == NULL) {
            set_error(err, errlen, "创建 TLS 上下文失败");
            break;
        }
        SSL_CTX_set_min_proto_version(ssl_ctx, TLS1_3_VERSION);
        SSL_CTX_set_verify(ssl_ctx, SSL_VERIFY_NONE, NULL);

        const uint8_t *p = key_pkcs8;
        pkey = d2i_AutoPrivateKey(NULL, &p, (long) key_len);
        if (pkey == NULL) {
            set_error(err, errlen, "私钥解析失败");
            break;
        }
        const uint8_t *c = cert_der;
        cert = d2i_X509(NULL, &c, (long) cert_len);
        if (cert == NULL) {
            set_error(err, errlen, "证书解析失败");
            break;
        }
        if (SSL_CTX_use_certificate(ssl_ctx, cert) != 1) {
            set_error(err, errlen, "装上自己的证书失败");
            break;
        }
        if (SSL_CTX_use_PrivateKey(ssl_ctx, pkey) != 1) {
            set_error(err, errlen, "装上自己的私钥失败");
            break;
        }

        fd = tcp_connect(host, port, 6000, err, errlen);
        if (fd < 0) break;
        struct timeval tv;
        tv.tv_sec = 8;
        tv.tv_usec = 0;
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

        ssl = SSL_new(ssl_ctx);
        if (ssl == NULL) {
            set_error(err, errlen, "创建 TLS 连接失败");
            break;
        }
        SSL_set_tlsext_host_name(ssl, "adb");
        SSL_set_fd(ssl, fd);
        if (SSL_connect(ssl) != 1) {
            unsigned long e = ERR_get_error();
            char reason[128] = "";
            if (e != 0) ERR_error_string_n(e, reason, sizeof(reason));
            set_error(err, errlen, "TLS 握手失败%s%s", reason[0] ? "：" : "", reason);
            break;
        }

        // 通道绑定：把这条 TLS 连接的特性掺进口令，防中间人转发。
        uint8_t exporter[EXPORTER_LEN];
        if (SSL_export_keying_material(ssl, exporter, sizeof(exporter),
                                       kExporterLabel, EXPORTER_LABEL_LEN, NULL, 0, 0) != 1) {
            set_error(err, errlen, "取不到通道绑定值");
            break;
        }

        // 口令 = 配对码 || 通道绑定值
        uint8_t password[6 + EXPORTER_LEN];
        memcpy(password, code, 6);
        memcpy(password + 6, exporter, EXPORTER_LEN);
        size_t password_len = sizeof(password);

        spake = SPAKE2_CTX_new(spake2_role_alice, (const uint8_t *) kClientName, NAME_LEN,
                               (const uint8_t *) kServerName, NAME_LEN);
        if (spake == NULL) {
            set_error(err, errlen, "创建认证上下文失败");
            break;
        }
        uint8_t out_msg[128];
        size_t out_len = 0;
        if (!SPAKE2_generate_msg(spake, out_msg, &out_len, sizeof(out_msg), password, password_len)) {
            set_error(err, errlen, "生成认证消息失败");
            break;
        }
        if (send_frame(ssl, TYPE_SPAKE2, out_msg, out_len) != 0) {
            set_error(err, errlen, "发送认证消息失败（长度 %zu）", out_len);
            break;
        }

        peer_msg = (uint8_t *) malloc(PEER_INFO_SIZE);
        if (peer_msg == NULL) {
            set_error(err, errlen, "内存不足");
            break;
        }
        int type = -1;
        size_t peer_len = 0;
        uint8_t first_byte = 0;
        int rf = read_frame(ssl, &type, peer_msg, PEER_INFO_SIZE, &peer_len, &first_byte);
        if (rf != 0) {
            // 首字节也是证据：0x43（'C'）说明对面在说 adb 的 CNXN——
            // 也就是我们连到的是**连接口**，不是配对口。
            set_error(err, errlen, "读认证回包失败（%d，%s，首字节 0x%02x%s）", rf,
                      rf == -1 ? "连接被关闭" : (rf == -2 ? "版本号不符" : "包太长"),
                      first_byte,
                      first_byte == 0x43 ? "——这是 adb 连接口，端口选错了" : "");
            break;
        }
        if (type != TYPE_SPAKE2) {
            set_error(err, errlen, "对方的包类型不对（收到 %d，期望 %d）", type, TYPE_SPAKE2);
            break;
        }

        uint8_t spake_key[64];
        size_t spake_len = 0;
        if (!SPAKE2_process_msg(spake, spake_key, &spake_len, sizeof(spake_key), peer_msg, peer_len)) {
            set_error(err, errlen, "认证失败（多半是配对码不对）");
            break;
        }

        // HKDF-SHA256 → AES-128 的钥匙
        uint8_t aes_key[16];
        const char *info = "adb pairing_auth aes-128-gcm key";
        if (!HKDF(aes_key, sizeof(aes_key), EVP_sha256(), spake_key, spake_len,
                  NULL, 0, (const uint8_t *) info, strlen(info))) {
            set_error(err, errlen, "派生加密钥匙失败");
            break;
        }

        // 自己的 PeerInfo：类型 0 + ADB 格式公钥（base64 + 注释 + NUL）
        peer_info = (uint8_t *) calloc(1, PEER_INFO_SIZE);
        plain = (uint8_t *) calloc(1, PEER_INFO_SIZE + 32);
        if (peer_info == NULL || plain == NULL) {
            set_error(err, errlen, "内存不足");
            break;
        }
        uint8_t android_key[524];
        if (build_android_pubkey(pkey, android_key) != 0) {
            set_error(err, errlen, "转换公钥格式失败");
            break;
        }
        char *b64 = base64_encode(android_key, sizeof(android_key));
        if (b64 == NULL) {
            set_error(err, errlen, "公钥编码失败");
            break;
        }
        peer_info[0] = ADB_RSA_PUB_KEY;
        int written = snprintf((char *) peer_info + 1, PEER_INFO_SIZE - 1, "%s dsh-everywhere", b64);
        free(b64);
        if (written <= 0) {
            set_error(err, errlen, "公钥写入失败");
            break;
        }

        // 加密后发送：客户端先发（序号 0）
        size_t sealed_len = 0;
        if (aes_gcm_seal(aes_key, 0, peer_info, PEER_INFO_SIZE, plain, &sealed_len) != 0) {
            set_error(err, errlen, "加密公钥失败");
            break;
        }
        if (send_frame(ssl, TYPE_PEER_INFO, plain, sealed_len) != 0) {
            set_error(err, errlen, "发送公钥失败");
            break;
        }

        // 读对方回的公钥：能解开就说明两边口令一致（配对了）
        memset(plain, 0, PEER_INFO_SIZE + 32);
        uint8_t *incoming = (uint8_t *) malloc(PEER_INFO_SIZE + 64);
        if (incoming == NULL) {
            set_error(err, errlen, "内存不足");
            break;
        }
        int peer_type = -1;
        size_t incoming_len = 0;
        rf = read_frame(ssl, &peer_type, incoming, PEER_INFO_SIZE + 64, &incoming_len, NULL);
        if (rf != 0 || peer_type != TYPE_PEER_INFO) {
            free(incoming);
            set_error(err, errlen, "对方没有回公钥（配对未完成）");
            break;
        }
        size_t dec_len = 0;
        int opened = aes_gcm_open(aes_key, 0, incoming, incoming_len, plain, &dec_len);
        free(incoming);
        if (opened != 0) {
            set_error(err, errlen, "配对被拒绝：配对码不对");
            break;
        }
        if (peer_name != NULL && peer_name_len > 0) {
            peer_name[0] = '\0';
            if (dec_len > 1) {
                size_t copy = dec_len - 1 < peer_name_len - 1 ? dec_len - 1 : peer_name_len - 1;
                memcpy(peer_name, plain + 1, copy);
                peer_name[copy] = '\0';
            }
        }
        result = 0;
    } while (0);

    if (ssl != NULL) {
        SSL_shutdown(ssl);
        SSL_free(ssl);
    }
    if (fd >= 0) close(fd);
    if (spake != NULL) SPAKE2_CTX_free(spake);
    if (cert != NULL) X509_free(cert);
    if (pkey != NULL) EVP_PKEY_free(pkey);
    if (ssl_ctx != NULL) SSL_CTX_free(ssl_ctx);
    free(peer_msg);
    free(peer_info);
    free(plain);
    return result;
}

JNIEXPORT jstring JNICALL
Java_com_dsh_miniremote_AdbPairing_nativePair(JNIEnv *env, jclass clazz,
                                              jstring host, jint port, jstring code,
                                              jbyteArray cert, jbyteArray key) {
    char err[256];
    err[0] = '\0';
    const char *host_text = (*env)->GetStringUTFChars(env, host, NULL);
    const char *code_text = (*env)->GetStringUTFChars(env, code, NULL);
    jsize cert_len = (*env)->GetArrayLength(env, cert);
    jsize key_len = (*env)->GetArrayLength(env, key);
    jbyte *cert_bytes = (*env)->GetByteArrayElements(env, cert, NULL);
    jbyte *key_bytes = (*env)->GetByteArrayElements(env, key, NULL);
    char peer_name[256];
    peer_name[0] = '\0';

    int rc = do_pair(host_text, (int) port, code_text,
                     (const uint8_t *) cert_bytes, (size_t) cert_len,
                     (const uint8_t *) key_bytes, (size_t) key_len,
                     peer_name, sizeof(peer_name), err, sizeof(err));

    (*env)->ReleaseByteArrayElements(env, cert, cert_bytes, JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, key, key_bytes, JNI_ABORT);
    (*env)->ReleaseStringUTFChars(env, host, host_text);
    (*env)->ReleaseStringUTFChars(env, code, code_text);

    char out[512];
    if (rc == 0) {
        snprintf(out, sizeof(out), "{\"ok\":true,\"peer\":\"%s\"}", peer_name);
    } else {
        snprintf(out, sizeof(out), "{\"ok\":false,\"error\":\"%s\"}",
                 err[0] ? err : "配对失败（原因未知）");
    }
    return (*env)->NewStringUTF(env, out);
}

// ======================================================================
// 第三步：连上去，跑一条命令（2026-11-15）
//
// 顺序（对照 AOSP packages/modules/adb）：
//   明文 CNXN → 收 STLS → 回 STLS → TLS 握手（同一把钥匙）→ 再发 CNXN
//   → 收 AUTH(token) → 用钥匙签（SHA1）→ 回 AUTH(signature) → 收 CNXN（认证通过）
//   → OPEN "shell:<命令>" → 收 WRTE 拼输出 → 收 CLSE 结束
// ======================================================================

#define A_CNXN 0x4e584e43u
#define A_AUTH 0x48545541u
#define A_STLS 0x534c5453u
#define A_OPEN 0x4e45504fu
#define A_OKAY 0x59414b4fu
#define A_WRTE 0x45545257u
#define A_CLSE 0x45534c43u
#define A_VERSION 0x01000000u
#define AUTH_TOKEN 1u
#define AUTH_SIGNATURE 2u
#define PKT_HEADER 24
#define ADB_MAXDATA 4096  // 官方客户端首包用 MAX_PAYLOAD_V1，见 adb.cpp 的 send_connect

static uint32_t crc32_of(const uint8_t *data, size_t len) {
    uint32_t crc = 0xFFFFFFFFu;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++) {
            crc = (crc >> 1) ^ (0xEDB88320u & (uint32_t) (-(int32_t) (crc & 1)));
        }
    }
    return ~crc;
}

static void put_le32(uint8_t *out, uint32_t value) {
    out[0] = (uint8_t) value;
    out[1] = (uint8_t) (value >> 8);
    out[2] = (uint8_t) (value >> 16);
    out[3] = (uint8_t) (value >> 24);
}

static uint32_t get_le32(const uint8_t *in) {
    return (uint32_t) in[0] | ((uint32_t) in[1] << 8) | ((uint32_t) in[2] << 16) | ((uint32_t) in[3] << 24);
}

// files 传 NULL 表示不用 TLS（STLS 之前是明文）。
static int packet_write(SSL *ssl, int fd, uint32_t command, uint32_t arg0, uint32_t arg1,
                        const void *data, uint32_t len) {
    uint8_t header[PKT_HEADER];
    put_le32(header + 0, command);
    put_le32(header + 4, arg0);
    put_le32(header + 8, arg1);
    put_le32(header + 12, len);
    put_le32(header + 16, data == NULL ? 0 : crc32_of((const uint8_t *) data, len));
    put_le32(header + 20, command ^ 0xFFFFFFFFu);
    LOGI("写包 %08x 长度 %u", command, len);
    if (ssl != NULL) {
        if (write_all(ssl, header, sizeof(header)) != 0) return -1;
        if (len > 0 && write_all(ssl, (const uint8_t *) data, len) != 0) return -1;
    } else {
        size_t done = 0;
        while (done < sizeof(header)) {
            ssize_t n = send(fd, header + done, sizeof(header) - done, 0);
            if (n <= 0) return -1;
            done += (size_t) n;
        }
        done = 0;
        while (done < len) {
            ssize_t n = send(fd, (const uint8_t *) data + done, len - done, 0);
            if (n <= 0) return -1;
            done += (size_t) n;
        }
    }
    return 0;
}

static int g_read_ssl_error = 0;
static int g_read_errno = 0;
static char g_read_reason[160] = "";

static int packet_read(SSL *ssl, int fd, uint32_t *command, uint32_t *arg0, uint32_t *arg1,
                       uint8_t **payload, uint32_t *len) {
    uint8_t header[PKT_HEADER];
    size_t done = 0;
    while (done < sizeof(header)) {
        int n;
        if (ssl != NULL) {
            n = SSL_read(ssl, header + done, (int) (sizeof(header) - done));
        } else {
            n = (int) recv(fd, header + done, sizeof(header) - done, 0);
        }
        if (n <= 0) {
            g_read_errno = errno;
            g_read_ssl_error = ssl != NULL ? SSL_get_error(ssl, n) : 0;
            g_read_reason[0] = '\0';
            unsigned long e = ERR_get_error();
            if (e != 0) ERR_error_string_n(e, g_read_reason, sizeof(g_read_reason));
            return -1;
        }
        done += (size_t) n;
    }
    *command = get_le32(header + 0);
    LOGI("读到包 %08x", *command);
    *arg0 = get_le32(header + 4);
    *arg1 = get_le32(header + 8);
    *len = get_le32(header + 12);
    if ((*command ^ 0xFFFFFFFFu) != get_le32(header + 20)) return -1;
    if (*len > ADB_MAXDATA * 2) return -1;
    *payload = NULL;
    if (*len > 0) {
        uint8_t *buffer = (uint8_t *) malloc(*len);
        if (buffer == NULL) return -1;
        size_t got = 0;
        while (got < *len) {
            int n;
            if (ssl != NULL) {
                n = SSL_read(ssl, buffer + got, (int) (*len - got));
            } else {
                n = (int) recv(fd, buffer + got, *len - got, 0);
            }
            if (n <= 0) {
                free(buffer);
                return -1;
            }
            got += (size_t) n;
        }
        *payload = buffer;
    }
    return 0;
}

/** 跑一条命令，输出写进 out（截断），返回 0 成功。 */
static int do_shell(const char *host, int port, const char *command,
                    const uint8_t *cert_der, size_t cert_len,
                    const uint8_t *key_pkcs8, size_t key_len,
                    char *out, size_t out_len, char *err, size_t errlen) {
    int result = -1;
    int fd = -1;
    SSL_CTX *ctx = NULL;
    SSL *ssl = NULL;
    EVP_PKEY *pkey = NULL;
    X509 *cert = NULL;
    uint8_t *payload = NULL;
    size_t written = 0;

    do {
        ctx = SSL_CTX_new(TLS_method());
        if (ctx == NULL) {
            set_error(err, errlen, "创建 TLS 上下文失败");
            break;
        }
        SSL_CTX_set_min_proto_version(ctx, TLS1_3_VERSION);
        SSL_CTX_set_verify(ctx, SSL_VERIFY_NONE, NULL);
        const uint8_t *p = key_pkcs8;
        pkey = d2i_AutoPrivateKey(NULL, &p, (long) key_len);
        const uint8_t *c = cert_der;
        cert = d2i_X509(NULL, &c, (long) cert_len);
        if (pkey == NULL || cert == NULL) {
            set_error(err, errlen, "钥匙或证书解析失败");
            break;
        }
        SSL_CTX_use_certificate(ctx, cert);
        SSL_CTX_use_PrivateKey(ctx, pkey);

        fd = tcp_connect(host, port, 6000, err, errlen);
        if (fd < 0) break;
        struct timeval tv;
        tv.tv_sec = 10;
        tv.tv_usec = 0;
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

        const char banner[] = "host::";
        if (packet_write(NULL, fd, A_CNXN, A_VERSION, ADB_MAXDATA, banner, sizeof(banner)) != 0) {
            set_error(err, errlen, "发送 CNXN 失败");
            break;
        }

        uint32_t cmd = 0, a0 = 0, a1 = 0, len = 0;
        if (packet_read(NULL, fd, &cmd, &a0, &a1, &payload, &len) != 0) {
            set_error(err, errlen, "连上后没收到 STLS（对方不像是无线调试的连接口）");
            break;
        }
        free(payload);
        payload = NULL;
        if (cmd != A_STLS) {
            set_error(err, errlen, "期待 STLS，收到命令 0x%08x", cmd);
            break;
        }
        if (packet_write(NULL, fd, A_STLS, A_VERSION, 0, NULL, 0) != 0) {
            set_error(err, errlen, "回应 STLS 失败");
            break;
        }

        ssl = SSL_new(ctx);
        SSL_set_fd(ssl, fd);
        if (SSL_connect(ssl) != 1) {
            unsigned long e = ERR_get_error();
            char reason[128] = "";
            if (e != 0) ERR_error_string_n(e, reason, sizeof(reason));
            set_error(err, errlen, "TLS 握手失败%s%s", reason[0] ? "：" : "", reason);
            break;
        }

        // **TLS 之后：只读对方的 CNXN，绝对不要再回一个自己的。**
        //
        // 依据 AOSP adb.cpp 的 handle_new_connection：收到 CNXN 的第一件事是
        // handle_offline(t)（把传输置为离线并关掉所有流），然后因为 use_tls 为真，
        // 会再回一个 A_STLS 要求重新握手。于是我们后面发的 OPEN 撞上
        // `if (!t->online || arg0 == 0) break;` —— 静默丢弃，既不回 OKAY 也不回 CLSE。
        //
        // 无线的 TLS 连接在握手完成的那一刻就已经 online（adbd_wifi_secure_connect
        // 里 handle_online + send_connect），它发来的 CNXN 是"开始干活吧"，不是"请回一句"。
        // 另外：证书认证过的连接**没有 AUTH**。
        if (packet_read(ssl, fd, &cmd, &a0, &a1, &payload, &len) != 0) {
            set_error(err, errlen, "握手后没收到对方的 CNXN（ssl=%d errno=%d%s%s）",
                      g_read_ssl_error, g_read_errno,
                      g_read_reason[0] != '\0' ? "：" : "", g_read_reason);
            break;
        }
        free(payload);
        payload = NULL;
        if (cmd == A_STLS) {
            set_error(err, errlen, "对方又要求握手一次（说明我们多发了 CNXN）");
            break;
        }
        if (cmd != A_CNXN) {
            set_error(err, errlen, "期待对方的 CNXN，收到 0x%08x", cmd);
            break;
        }

        // 打开一个 shell 流
        char destination[512];
        snprintf(destination, sizeof(destination), "shell:%s", command);
        uint32_t local_id = 1;
        // adbd 是按**我们**的 banner 判断 delayed_ack 的（我们没报能力＝不支持），arg1 固定 0。
        if (packet_write(ssl, fd, A_OPEN, local_id, 0, destination,
                         (uint32_t) strlen(destination) + 1) != 0) {
            set_error(err, errlen, "打开 shell 失败");
            break;
        }

        out[0] = '\0';
        for (;;) {
            if (packet_read(ssl, fd, &cmd, &a0, &a1, &payload, &len) != 0) {
                set_error(err, errlen, "读命令输出失败v7（已收 %zu 字节，ssl=%d errno=%d%s%s）",
                          written, g_read_ssl_error, g_read_errno,
                          g_read_reason[0] != '\0' ? "：" : "", g_read_reason);
                break;
            }
            if (cmd == A_OKAY && written == 0) {
                // 只是流建立确认，继续读输出。
                free(payload);
                payload = NULL;
                continue;
            }
            if (cmd == A_WRTE) {
                for (uint32_t i = 0; i < len && written + 1 < out_len; i++) {
                    out[written++] = (char) payload[i];
                }
                out[written] = '\0';
                free(payload);
                payload = NULL;
                packet_write(ssl, fd, A_OKAY, a1, a0, NULL, 0);
            } else if (cmd == A_CLSE) {
                free(payload);
                payload = NULL;
                result = 0;
                break;
            } else {
                free(payload);
                payload = NULL;
            }
        }
    } while (0);

    if (payload != NULL) free(payload);
    if (ssl != NULL) {
        SSL_shutdown(ssl);
        SSL_free(ssl);
    }
    if (fd >= 0) close(fd);
    if (ctx != NULL) SSL_CTX_free(ctx);
    if (cert != NULL) X509_free(cert);
    if (pkey != NULL) EVP_PKEY_free(pkey);
    return result;
}

JNIEXPORT jstring JNICALL
Java_com_dsh_miniremote_AdbShell_nativeShell(JNIEnv *env, jclass clazz,
                                             jstring host, jint port, jstring command,
                                             jbyteArray cert, jbyteArray key) {
    char err[256];
    err[0] = '\0';
    char *out = (char *) calloc(1, 64 * 1024);
    if (out == NULL) return (*env)->NewStringUTF(env, "{\"ok\":false,\"error\":\"内存不足\"}");
    const char *host_text = (*env)->GetStringUTFChars(env, host, NULL);
    const char *command_text = (*env)->GetStringUTFChars(env, command, NULL);
    jsize cert_len = (*env)->GetArrayLength(env, cert);
    jsize key_len = (*env)->GetArrayLength(env, key);
    jbyte *cert_bytes = (*env)->GetByteArrayElements(env, cert, NULL);
    jbyte *key_bytes = (*env)->GetByteArrayElements(env, key, NULL);

    int rc = do_shell(host_text, (int) port, command_text,
                      (const uint8_t *) cert_bytes, (size_t) cert_len,
                      (const uint8_t *) key_bytes, (size_t) key_len,
                      out, 64 * 1024, err, sizeof(err));

    (*env)->ReleaseByteArrayElements(env, cert, cert_bytes, JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, key, key_bytes, JNI_ABORT);
    (*env)->ReleaseStringUTFChars(env, host, host_text);
    (*env)->ReleaseStringUTFChars(env, command, command_text);

    // 结果拼成 JSON；输出里的引号、换行要转义，否则前端解不开。
    size_t cap = 64 * 1024 * 2 + 512;
    char *json = (char *) malloc(cap);
    if (json == NULL) {
        free(out);
        return (*env)->NewStringUTF(env, "{\"ok\":false,\"error\":\"内存不足\"}");
    }
    size_t at = 0;
    at += (size_t) snprintf(json + at, cap - at, "{\"ok\":%s,\"output\":\"", rc == 0 ? "true" : "false");
    if (at >= cap) at = cap - 1;
    for (size_t i = 0; out[i] != '\0' && at + 8 < cap; i++) {
        unsigned char ch = (unsigned char) out[i];
        if (ch == '"' || ch == '\\') {
            json[at++] = '\\';
            json[at++] = (char) ch;
        } else if (ch == '\n') {
            json[at++] = '\\';
            json[at++] = 'n';
        } else if (ch == '\r') {
            json[at++] = '\\';
            json[at++] = 'r';
        } else if (ch < 0x20) {
            at += (size_t) snprintf(json + at, cap - at, "\\u%04x", ch);
            if (at >= cap) at = cap - 1;
        } else {
            json[at++] = (char) ch;
        }
    }
    if (rc == 0) {
        at += (size_t) snprintf(json + at, cap - at, "\"}");
    } else {
        at += (size_t) snprintf(json + at, cap - at, "\",\"error\":\"%s\"}", err[0] ? err : "命令没跑成功");
    }
    if (at >= cap) at = cap - 1;
    json[at < cap ? at : cap - 1] = '\0';
    jstring result = (*env)->NewStringUTF(env, json);
    free(json);
    free(out);
    return result;
}

// ======================================================================
// 连接复用（2026-11-15）：一条 TLS+ADB 会话跑多条命令
//
// 之前每条命令都要重做一遍 TCP→CNXN→STLS→TLS→CNXN，连续调用有明显开销。
// 这里把连接留住，用 ADB 的"流"机制在同一条连接上反复开 shell：
//   每次执行：A_OPEN(新的 local-id, "shell:<cmd>") → 收 OKAY/WRTE → 收 CLSE。
// 同一条会话**同一时刻只跑一条命令**（Java 侧加锁），协议本身支持多流，这里不需要。
// 老的一次性路径（do_shell）保留不动：新路出问题可以退回去。
// ======================================================================

typedef struct {
    int fd;
    SSL *ssl;
    SSL_CTX *ctx;
    EVP_PKEY *pkey;
    X509 *cert;
    uint32_t next_id;
} AdbSession;

static AdbSession *g_session = NULL;   // 只支持一条会话（单用户场景够用）

static void session_release(AdbSession *session) {
    if (session == NULL) return;
    if (session->ssl != NULL) {
        SSL_shutdown(session->ssl);
        SSL_free(session->ssl);
    }
    if (session->fd >= 0) close(session->fd);
    if (session->ctx != NULL) SSL_CTX_free(session->ctx);
    if (session->cert != NULL) X509_free(session->cert);
    if (session->pkey != NULL) EVP_PKEY_free(session->pkey);
    free(session);
}

/** 建一条会话；成功返回指针，失败返回 NULL 并写 err。 */
static AdbSession *session_open(const char *host, int port,
                                const uint8_t *cert_der, size_t cert_len,
                                const uint8_t *key_pkcs8, size_t key_len,
                                char *err, size_t errlen) {
    AdbSession *session = (AdbSession *) calloc(1, sizeof(AdbSession));
    if (session == NULL) {
        set_error(err, errlen, "内存不足");
        return NULL;
    }
    session->fd = -1;
    session->next_id = 1;

    session->ctx = SSL_CTX_new(TLS_method());
    if (session->ctx == NULL) {
        set_error(err, errlen, "创建 TLS 上下文失败");
        session_release(session);
        return NULL;
    }
    SSL_CTX_set_min_proto_version(session->ctx, TLS1_3_VERSION);
    SSL_CTX_set_verify(session->ctx, SSL_VERIFY_NONE, NULL);

    const uint8_t *p = key_pkcs8;
    session->pkey = d2i_AutoPrivateKey(NULL, &p, (long) key_len);
    const uint8_t *c = cert_der;
    session->cert = d2i_X509(NULL, &c, (long) cert_len);
    if (session->pkey == NULL || session->cert == NULL) {
        set_error(err, errlen, "钥匙或证书解析失败");
        session_release(session);
        return NULL;
    }
    SSL_CTX_use_certificate(session->ctx, session->cert);
    SSL_CTX_use_PrivateKey(session->ctx, session->pkey);

    session->fd = tcp_connect(host, port, 6000, err, errlen);
    if (session->fd < 0) {
        session_release(session);
        return NULL;
    }
    struct timeval tv;
    tv.tv_sec = 10;
    tv.tv_usec = 0;
    setsockopt(session->fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    const char banner[] = "host::";
    if (packet_write(NULL, session->fd, A_CNXN, A_VERSION, ADB_MAXDATA, banner, sizeof(banner)) != 0) {
        set_error(err, errlen, "发送 CNXN 失败");
        session_release(session);
        return NULL;
    }
    uint32_t cmd = 0, a0 = 0, a1 = 0, len = 0;
    uint8_t *payload = NULL;
    if (packet_read(NULL, session->fd, &cmd, &a0, &a1, &payload, &len) != 0 || cmd != A_STLS) {
        free(payload);
        set_error(err, errlen, "没收到 STLS");
        session_release(session);
        return NULL;
    }
    free(payload);
    if (packet_write(NULL, session->fd, A_STLS, A_VERSION, 0, NULL, 0) != 0) {
        set_error(err, errlen, "回应 STLS 失败");
        session_release(session);
        return NULL;
    }

    session->ssl = SSL_new(session->ctx);
    SSL_set_fd(session->ssl, session->fd);
    if (SSL_connect(session->ssl) != 1) {
        // 把告警原因带上：手机不认钥匙时会回 CERTIFICATE_UNKNOWN，
        // 这是一句能指导用户"去重新配对"的关键信息（2026-11-15）。
        unsigned long e = ERR_get_error();
        char reason[160] = "";
        if (e != 0) ERR_error_string_n(e, reason, sizeof(reason));
        set_error(err, errlen, "TLS 握手失败%s%s", reason[0] != '\0' ? "：" : "", reason);
        session_release(session);
        return NULL;
    }
    // 握手之后**只读对方的 CNXN，不回**（回一个会把自己打回离线，见 do_shell 的注释）。
    payload = NULL;
    if (packet_read(session->ssl, session->fd, &cmd, &a0, &a1, &payload, &len) != 0
        || cmd != A_CNXN) {
        free(payload);
        set_error(err, errlen, "没等到对方的 CNXN");
        session_release(session);
        return NULL;
    }
    free(payload);
    return session;
}

/** 在会话上跑一条命令；0 成功。 */
static int session_exec(AdbSession *session, const char *command,
                        char *out, size_t out_len, char *err, size_t errlen) {
    if (session == NULL || session->ssl == NULL) {
        set_error(err, errlen, "会话不可用");
        return -1;
    }
    uint32_t local_id = session->next_id++;
    if (session->next_id == 0) session->next_id = 1;

    char destination[512];
    snprintf(destination, sizeof(destination), "shell:%s", command);
    if (packet_write(session->ssl, session->fd, A_OPEN, local_id, 0, destination,
                     (uint32_t) strlen(destination) + 1) != 0) {
        set_error(err, errlen, "发送 OPEN 失败");
        return -1;
    }

    size_t written = 0;
    out[0] = '\0';
    uint32_t remote_id = 0;
    for (;;) {
        uint32_t cmd = 0, a0 = 0, a1 = 0, len = 0;
        uint8_t *payload = NULL;
        if (packet_read(session->ssl, session->fd, &cmd, &a0, &a1, &payload, &len) != 0) {
            free(payload);
            set_error(err, errlen, "读输出失败（ssl=%d errno=%d）", g_read_ssl_error, g_read_errno);
            return -1;
        }
        if (cmd == A_OKAY) {
            remote_id = a0;
            free(payload);
            continue;
        }
        if (cmd == A_WRTE) {
            if (a1 == local_id) {
                for (uint32_t i = 0; i < len && written + 1 < out_len; i++) {
                    out[written++] = (char) payload[i];
                }
                out[written] = '\0';
                packet_write(session->ssl, session->fd, A_OKAY, local_id, a0, NULL, 0);
            }
            free(payload);
            continue;
        }
        if (cmd == A_CLSE) {
            bool mine = (a1 == local_id) || (a0 == local_id) || (remote_id != 0 && a0 == remote_id);
            free(payload);
            if (mine) return 0;
            continue;
        }
        free(payload);
    }
}

JNIEXPORT jlong JNICALL
Java_com_dsh_miniremote_AdbShell_nativeSessionOpen(JNIEnv *env, jclass clazz,
                                                   jstring host, jint port,
                                                   jbyteArray cert, jbyteArray key) {
    if (g_session != NULL) {
        session_release(g_session);
        g_session = NULL;
    }
    char err[256];
    err[0] = '\0';
    const char *host_text = (*env)->GetStringUTFChars(env, host, NULL);
    jsize cert_len = (*env)->GetArrayLength(env, cert);
    jsize key_len = (*env)->GetArrayLength(env, key);
    jbyte *cert_bytes = (*env)->GetByteArrayElements(env, cert, NULL);
    jbyte *key_bytes = (*env)->GetByteArrayElements(env, key, NULL);
    g_session = session_open(host_text, (int) port,
                             (const uint8_t *) cert_bytes, (size_t) cert_len,
                             (const uint8_t *) key_bytes, (size_t) key_len,
                             err, sizeof(err));
    (*env)->ReleaseByteArrayElements(env, cert, cert_bytes, JNI_ABORT);
    (*env)->ReleaseByteArrayElements(env, key, key_bytes, JNI_ABORT);
    (*env)->ReleaseStringUTFChars(env, host, host_text);
    if (g_session == NULL) {
        LOGI("会话建立失败：%s", err);
        return 0;
    }
    return (jlong) (intptr_t) g_session;
}

JNIEXPORT jstring JNICALL
Java_com_dsh_miniremote_AdbShell_nativeSessionExec(JNIEnv *env, jclass clazz,
                                                   jlong handle, jstring command) {
    char err[256];
    err[0] = '\0';
    char *out = (char *) calloc(1, 64 * 1024);
    if (out == NULL) return (*env)->NewStringUTF(env, "{\"ok\":false,\"error\":\"内存不足\"}");
    AdbSession *session = (AdbSession *) (intptr_t) handle;
    const char *command_text = (*env)->GetStringUTFChars(env, command, NULL);
    int rc = session_exec(session, command_text, out, 64 * 1024, err, sizeof(err));
    (*env)->ReleaseStringUTFChars(env, command, command_text);

    size_t cap = 64 * 1024 * 2 + 512;
    char *json = (char *) malloc(cap);
    if (json == NULL) {
        free(out);
        return (*env)->NewStringUTF(env, "{\"ok\":false,\"error\":\"内存不足\"}");
    }
    size_t at = 0;
    at += (size_t) snprintf(json + at, cap - at, "{\"ok\":%s,\"output\":\"", rc == 0 ? "true" : "false");
    if (at >= cap) at = cap - 1;
    for (size_t i = 0; out[i] != '\0' && at + 8 < cap; i++) {
        unsigned char ch = (unsigned char) out[i];
        if (ch == '"' || ch == '\\') {
            json[at++] = '\\';
            json[at++] = (char) ch;
        } else if (ch == '\n') {
            json[at++] = '\\';
            json[at++] = 'n';
        } else if (ch == '\r') {
            // 丢掉
        } else if (ch < 0x20) {
            at += (size_t) snprintf(json + at, cap - at, "\\u%04x", ch);
            if (at >= cap) at = cap - 1;
        } else {
            json[at++] = (char) ch;
        }
    }
    if (rc == 0) {
        at += (size_t) snprintf(json + at, cap - at, "\"}");
    } else {
        at += (size_t) snprintf(json + at, cap - at, "\",\"error\":\"%s\"}", err[0] ? err : "命令没跑成功");
    }
    if (at >= cap) at = cap - 1;
    json[at] = '\0';
    jstring result = (*env)->NewStringUTF(env, json);
    free(json);
    free(out);
    return result;
}

JNIEXPORT void JNICALL
Java_com_dsh_miniremote_AdbShell_nativeSessionClose(JNIEnv *env, jclass clazz, jlong handle) {
    (void) env;
    (void) clazz;
    (void) handle;
    if (g_session != NULL) {
        session_release(g_session);
        g_session = NULL;
    }
}
