package com.dsh.miniremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 用 Android Keystore 中的 AES-GCM 密钥加密整份配对凭据，再存入 SharedPreferences。 */
public final class PairingStore {
    private static final String PREFERENCES = "mini_remote_pairing";
    private static final String PAYLOAD = "encrypted_credentials";
    private static final String KEY_ALIAS = "com.dsh.miniremote.pairing.v1";

    private final SharedPreferences preferences;

    public PairingStore(Context context) {
        preferences = context.getApplicationContext()
                .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    /** 返回 null 表示尚未配对；解密或数据校验失败时抛出异常，不静默清除原数据。 */
    public Credentials load() throws GeneralSecurityException, IOException {
        String payload = preferences.getString(PAYLOAD, null);
        if (payload == null || payload.isEmpty()) {
            return null;
        }
        String[] parts = payload.split("\\.", 2);
        if (parts.length != 2) {
            throw new IOException("本机配对数据不完整，请重新配对。");
        }
        final byte[] iv;
        final byte[] encrypted;
        try {
            iv = Base64.decode(parts[0], Base64.NO_WRAP);
            encrypted = Base64.decode(parts[1], Base64.NO_WRAP);
        } catch (IllegalArgumentException e) {
            throw new IOException("本机配对数据无法读取，请重新配对。", e);
        }
        javax.crypto.SecretKey key = getKey(false);
        if (key == null) {
            throw new GeneralSecurityException("本机加密密钥已丢失，请重新配对。");
        }
        javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(javax.crypto.Cipher.DECRYPT_MODE, key, new javax.crypto.spec.GCMParameterSpec(128, iv));
        String json = new String(cipher.doFinal(encrypted), "UTF-8");
        return Credentials.fromJson(json);
    }

    public void save(Credentials credentials) throws GeneralSecurityException, IOException {
        if (credentials == null) {
            throw new IllegalArgumentException("不能保存空凭据。");
        }
        javax.crypto.SecretKey key = getKey(true);
        javax.crypto.Cipher cipher = javax.crypto.Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(javax.crypto.Cipher.ENCRYPT_MODE, key);
        byte[] encrypted = cipher.doFinal(credentials.toJson().getBytes("UTF-8"));
        String payload = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP)
                + "." + Base64.encodeToString(encrypted, Base64.NO_WRAP);
        preferences.edit().putString(PAYLOAD, payload).apply();
    }

    /** 清除密文和对应的 Keystore 密钥；服务器端设备名额需要另行在配对面板撤销。 */
    public void clear() throws GeneralSecurityException {
        try {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            keyStore.deleteEntry(KEY_ALIAS);
        } catch (IOException e) {
            throw new GeneralSecurityException("无法清除本机加密密钥。", e);
        }
        preferences.edit().remove(PAYLOAD).apply();
    }

    private javax.crypto.SecretKey getKey(boolean create) throws GeneralSecurityException {
        try {
            KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
            keyStore.load(null);
            if (keyStore.getKey(KEY_ALIAS, null) instanceof javax.crypto.SecretKey) {
                return (javax.crypto.SecretKey) keyStore.getKey(KEY_ALIAS, null);
            }
        } catch (IOException e) {
            throw new GeneralSecurityException("无法打开 Android Keystore。", e);
        }
        if (!create) {
            return null;
        }
        javax.crypto.KeyGenerator generator = javax.crypto.KeyGenerator.getInstance(
                KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return generator.generateKey();
    }

    /** 与 POST /mini/api/native-pair 的响应字段一一对应。 */
    public static final class Credentials {
        public final String deviceId;
        public final String deviceSecret;
        public final List<AddressPool.Entry> addresses;
        public final String keyId;
        public final String keyFp;

        public Credentials(String deviceId, String deviceSecret, List<AddressPool.Entry> addresses,
                           String keyId, String keyFp) {
            if (deviceId == null || deviceId.isEmpty() || deviceSecret == null || deviceSecret.isEmpty()) {
                throw new IllegalArgumentException("设备凭据不能为空。");
            }
            if (addresses == null || addresses.isEmpty()) {
                throw new IllegalArgumentException("配对地址池不能为空。");
            }
            this.deviceId = deviceId;
            this.deviceSecret = deviceSecret;
            this.addresses = Collections.unmodifiableList(new ArrayList<AddressPool.Entry>(addresses));
            this.keyId = keyId == null ? "" : keyId;
            this.keyFp = keyFp == null ? "" : keyFp;
        }

        /** Cookie 与 X-Mini-Device 共用的 id.密钥格式。 */
        public String deviceCredential() {
            return deviceId + "." + deviceSecret;
        }

        public static Credentials fromJson(String json) throws IOException {
            Object parsed = new JsonParser(json).parse();
            if (!(parsed instanceof Map)) {
                throw new IOException("配对响应不是 JSON 对象。");
            }
            Map<?, ?> root = (Map<?, ?>) parsed;
            String deviceId = requiredString(root, "deviceId");
            String deviceSecret = requiredString(root, "deviceSecret");
            String keyId = optionalString(root, "keyId");
            String keyFp = optionalString(root, "keyFp");
            List<AddressPool.Entry> addresses = readAddresses(root.get("addresses"));
            return new Credentials(deviceId, deviceSecret, addresses, keyId, keyFp);
        }

        private String toJson() {
            StringBuilder json = new StringBuilder(512);
            json.append('{');
            appendField(json, "deviceId", deviceId);
            json.append(',');
            appendField(json, "deviceSecret", deviceSecret);
            json.append(',');
            appendField(json, "keyId", keyId);
            json.append(',');
            appendField(json, "keyFp", keyFp);
            json.append(",\"addresses\":[");
            for (int i = 0; i < addresses.size(); i++) {
                if (i > 0) {
                    json.append(',');
                }
                AddressPool.Entry entry = addresses.get(i);
                json.append('{');
                appendField(json, "url", entry.baseUrl);
                json.append(',');
                appendField(json, "type", entry.type);
                json.append('}');
            }
            json.append("]}");
            return json.toString();
        }

        private static void appendField(StringBuilder json, String name, String value) {
            json.append(jsonQuote(name)).append(':').append(jsonQuote(value));
        }

        private static String requiredString(Map<?, ?> object, String name) throws IOException {
            String value = optionalString(object, name);
            if (value.isEmpty()) {
                throw new IOException("配对响应缺少字段：" + name);
            }
            return value;
        }

        private static String optionalString(Map<?, ?> object, String name) {
            Object value = object.get(name);
            return value instanceof String ? (String) value : "";
        }

        private static List<AddressPool.Entry> readAddresses(Object value) throws IOException {
            if (!(value instanceof List)) {
                throw new IOException("配对响应缺少地址池。");
            }
            List<AddressPool.Entry> result = new ArrayList<AddressPool.Entry>();
            for (Object item : (List<?>) value) {
                String url = null;
                String type = "";
                if (item instanceof String) {
                    url = (String) item;
                } else if (item instanceof Map) {
                    Map<?, ?> entry = (Map<?, ?>) item;
                    url = firstString(entry, "url", "base", "address");
                    type = firstString(entry, "type", "kind");
                }
                if (url == null || url.trim().isEmpty()) {
                    throw new IOException("配对响应里有一条无效地址。");
                }
                try {
                    result.add(new AddressPool.Entry(url, type));
                } catch (IllegalArgumentException e) {
                    throw new IOException("配对响应里有一条无效地址。", e);
                }
            }
            if (result.isEmpty()) {
                throw new IOException("配对响应中的地址池为空。");
            }
            return result;
        }

        private static String firstString(Map<?, ?> object, String... names) {
            for (String name : names) {
                Object value = object.get(name);
                if (value instanceof String) {
                    return (String) value;
                }
            }
            return null;
        }
    }

    /** 供少量原生请求手工构造 JSON 使用。 */
    static String jsonQuote(String value) {
        if (value == null) {
            return "null";
        }
        StringBuilder out = new StringBuilder(value.length() + 2);
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\b':
                    out.append("\\b");
                    break;
                case '\f':
                    out.append("\\f");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    out.append("\\r");
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    if (c < 0x20) {
                        String hex = Integer.toHexString(c);
                        out.append("\\u");
                        for (int padding = hex.length(); padding < 4; padding++) {
                            out.append('0');
                        }
                        out.append(hex);
                    } else {
                        out.append(c);
                    }
            }
        }
        return out.append('"').toString();
    }

    /** 只使用标准 Java 集合的最小 JSON 解析器，支持对象、数组、字符串和基本字面量。 */
    private static final class JsonParser {
        private final String input;
        private int position;

        JsonParser(String input) throws IOException {
            if (input == null) {
                throw new IOException("配对响应为空。");
            }
            this.input = input;
        }

        Object parse() throws IOException {
            Object value = readValue();
            skipWhitespace();
            if (position != input.length()) {
                throw error();
            }
            return value;
        }

        private Object readValue() throws IOException {
            skipWhitespace();
            if (position >= input.length()) {
                throw error();
            }
            char c = input.charAt(position);
            if (c == '{') {
                return readObject();
            }
            if (c == '[') {
                return readArray();
            }
            if (c == '"') {
                return readString();
            }
            if (c == 't') {
                readLiteral("true");
                return Boolean.TRUE;
            }
            if (c == 'f') {
                readLiteral("false");
                return Boolean.FALSE;
            }
            if (c == 'n') {
                readLiteral("null");
                return null;
            }
            if (c == '-' || (c >= '0' && c <= '9')) {
                return readNumber();
            }
            throw error();
        }

        private Map<String, Object> readObject() throws IOException {
            LinkedHashMap<String, Object> object = new LinkedHashMap<String, Object>();
            position++;
            skipWhitespace();
            if (consume('}')) {
                return object;
            }
            while (true) {
                skipWhitespace();
                if (position >= input.length() || input.charAt(position) != '"') {
                    throw error();
                }
                String name = readString();
                skipWhitespace();
                if (!consume(':')) {
                    throw error();
                }
                object.put(name, readValue());
                skipWhitespace();
                if (consume('}')) {
                    return object;
                }
                if (!consume(',')) {
                    throw error();
                }
            }
        }

        private List<Object> readArray() throws IOException {
            List<Object> array = new ArrayList<Object>();
            position++;
            skipWhitespace();
            if (consume(']')) {
                return array;
            }
            while (true) {
                array.add(readValue());
                skipWhitespace();
                if (consume(']')) {
                    return array;
                }
                if (!consume(',')) {
                    throw error();
                }
            }
        }

        private String readString() throws IOException {
            position++;
            StringBuilder value = new StringBuilder();
            while (position < input.length()) {
                char c = input.charAt(position++);
                if (c == '"') {
                    return value.toString();
                }
                if (c == '\\') {
                    if (position >= input.length()) {
                        throw error();
                    }
                    char escaped = input.charAt(position++);
                    switch (escaped) {
                        case '"':
                        case '\\':
                        case '/':
                            value.append(escaped);
                            break;
                        case 'b':
                            value.append('\b');
                            break;
                        case 'f':
                            value.append('\f');
                            break;
                        case 'n':
                            value.append('\n');
                            break;
                        case 'r':
                            value.append('\r');
                            break;
                        case 't':
                            value.append('\t');
                            break;
                        case 'u':
                            if (position + 4 > input.length()) {
                                throw error();
                            }
                            try {
                                value.append((char) Integer.parseInt(
                                        input.substring(position, position + 4), 16));
                            } catch (NumberFormatException e) {
                                throw error();
                            }
                            position += 4;
                            break;
                        default:
                            throw error();
                    }
                } else {
                    if (c < 0x20) {
                        throw error();
                    }
                    value.append(c);
                }
            }
            throw error();
        }

        private String readNumber() throws IOException {
            int start = position;
            while (position < input.length()) {
                char c = input.charAt(position);
                if ((c >= '0' && c <= '9') || c == '-' || c == '+' || c == '.' || c == 'e' || c == 'E') {
                    position++;
                } else {
                    break;
                }
            }
            if (start == position) {
                throw error();
            }
            return input.substring(start, position);
        }

        private void readLiteral(String literal) throws IOException {
            if (!input.regionMatches(position, literal, 0, literal.length())) {
                throw error();
            }
            position += literal.length();
        }

        private boolean consume(char expected) {
            if (position < input.length() && input.charAt(position) == expected) {
                position++;
                return true;
            }
            return false;
        }

        private void skipWhitespace() {
            while (position < input.length()) {
                char c = input.charAt(position);
                if (c == ' ' || c == '\n' || c == '\r' || c == '\t') {
                    position++;
                } else {
                    return;
                }
            }
        }

        private IOException error() {
            return new IOException("配对数据中的 JSON 格式不正确。");
        }
    }
}
