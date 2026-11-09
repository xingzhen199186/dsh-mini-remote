package com.dsh.miniremote;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.SocketTimeoutException;
import java.net.URL;

/** 只基于 HttpURLConnection 的 JSON 请求小封装。所有方法都必须在后台线程调用。 */
public final class Net {
    private static final int CONNECT_TIMEOUT_MS = 5000;
    private static final int READ_TIMEOUT_MS = 8000;

    private Net() {
    }

    /** 内置 Tailscale 的本地代理；装了它才走隧道，没装就直连。 */
    private static volatile java.net.Proxy tailnetProxy;

    /** 当前有没有挂内置隧道的代理（诊断用）。 */
    static boolean hasTailnetProxy() {
        return tailnetProxy != null;
    }

    static void setTailnetProxy(java.net.Proxy proxy) {
        tailnetProxy = proxy;
    }

    /**
     * 这条地址是不是只能从 tailnet 里到达：100.64.0.0/10 的地址，或者 MagicDNS 的
     * *.ts.net 名字（它要靠内核解析成 100.x，手机自己不认这个名字）。
     */
    public static boolean isTailnetAddress(String baseUrl) {
        if (baseUrl == null) {
            return false;
        }
        try {
            String host = java.net.URI.create(baseUrl).getHost();
            if (host == null) {
                return false;
            }
            if (host.endsWith(".ts.net")) {
                return true;
            }
            if (!host.startsWith("100.")) {
                return false;
            }
            String[] parts = host.split("\\.");
            if (parts.length < 2) {
                return false;
            }
            int second = Integer.parseInt(parts[1]);
            return second >= 64 && second <= 127;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * tailnet 地址必须走本地代理，别的地址直连。
     *
     * 网页那边由 WebView 的代理接管；这里管的是应用自己的请求（线路探测、
     * 长连接、分享上传）。少了这一步，tailnet 线路明明能用，清单上的圆点却是红的
     * ——因为探测根本没走隧道（2026-11-08 用户反馈「Tailscale 线路连不上」）。
     */
    static HttpURLConnection open(String url) throws IOException {
        java.net.Proxy proxy = tailnetProxy;
        if (proxy != null && isTailnetAddress(url)) {
            return (HttpURLConnection) new URL(url).openConnection(proxy);
        }
        return (HttpURLConnection) new URL(url).openConnection();
    }

    public static final class Response {
        public final int status;
        public final String body;
        /** 只有 getStream 会给；调用方读完后自己关。 */
        public final InputStream stream;

        Response(int status, String body) {
            this(status, body, null);
        }

        Response(int status, String body, InputStream stream) {
            this.status = status;
            this.body = body;
            this.stream = stream;
        }

        public boolean isSuccess() {
            return status >= 200 && status < 300;
        }

        public String chineseError() {
            if (status == 400) {
                return "请求格式不正确，请升级客户端和服务端后再试。";
            }
            if (status == 401 || status == 403) {
                return "设备凭据无效，请重新配对。";
            }
            if (status == 404) {
                return "服务端没有提供这个接口。";
            }
            if (status == 409) {
                return "这项请求已在别处处理。";
            }
            if (status >= 500) {
                return "服务端暂时出错（HTTP " + status + "），请稍后重试。";
            }
            return "请求失败（HTTP " + status + "）。";
        }
    }

    /**
     * 把一份**二进制**（安装包）下载到文件里（2026-11-09）。
     *
     * `get()` 返回的是字符串——用来接 APK 会把字节弄坏。这里直接流式写盘。
     * 返回是否成功；失败时文件删掉，别留一个半截的包让安装器去装。
     */
    /** 下载进度：给上层报"已经收了多少字节"，界面拿它算百分比。 */
    interface Progress {
        void onBytes(long written);
    }

    static boolean download(String url, String deviceCredential, java.io.File out, Progress progress) throws IOException {
        HttpURLConnection connection = open(url);
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        // 安装包大，读超时给足（默认 8 秒对几十兆不够用）。
        connection.setReadTimeout(120_000);
        connection.setUseCaches(false);
        connection.setInstanceFollowRedirects(false);
        if (deviceCredential != null && !deviceCredential.isEmpty()) {
            connection.setRequestProperty("X-Mini-Device", deviceCredential);
        }
        try {
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                return false;
            }
            java.io.File parent = out.getParentFile();
            if (parent != null && !parent.exists() && !parent.mkdirs()) {
                return false;
            }
            try (java.io.InputStream in = connection.getInputStream();
                 java.io.OutputStream os = new java.io.FileOutputStream(out)) {
                byte[] buf = new byte[64 * 1024];
                long written = 0;
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    written += n;
                    if (progress != null) {
                        // 每写一块报一次：26MB 大约 400 次，够用了，不必再节流。
                        progress.onBytes(written);
                    }
                }
            }
            return true;
        } catch (IOException err) {
            if (out.exists() && !out.delete()) {
                // 删不掉就算了：下次下载会覆盖它。
            }
            throw err;
        } finally {
            connection.disconnect();
        }
    }

    public static Response get(String url, String deviceCredential) throws IOException {
        return request("GET", url, null, deviceCredential);
    }

    public static Response postJson(String url, String json, String deviceCredential) throws IOException {
        return request("POST", url, json, deviceCredential);
    }

    /** 原始字节上传：系统分享的图片/文件走这条，服务端按流落盘。 */
    public static Response postBytes(String url, byte[] bytes, String deviceCredential) throws IOException {
        HttpURLConnection connection = open(url);
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Content-Type", "application/octet-stream");
            if (deviceCredential != null && !deviceCredential.isEmpty()) {
                connection.setRequestProperty("X-Mini-Device", deviceCredential);
            }
            connection.setFixedLengthStreamingMode(bytes.length);
            connection.setDoOutput(true);
            OutputStream output = connection.getOutputStream();
            try {
                output.write(bytes);
            } finally {
                output.close();
            }
            int status = connection.getResponseCode();
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String body = input == null ? "" : readUtf8(input);
            return new Response(status, body);
        } catch (SocketTimeoutException e) {
            throw new IOException("连接服务器超时，请检查网络后重试。", e);
        } catch (MalformedURLException e) {
            throw new IOException("服务器地址格式不正确。", e);
        } finally {
            connection.disconnect();
        }
    }

    /**
     * 服务器推送（SSE）用的长连接。
     *
     * 和普通请求的区别：读超时关掉（服务端可能很久才发一帧，设 15 秒会被当成断线），
     * 也不在这里读 body、不 disconnect——一断就收不到后面的消息了。谁来关流？
     * 调用方（前台服务）在停止时关。
     */
    public static Response getStream(String url, String deviceCredential) throws IOException {
        return getStream(url, deviceCredential, 0);
    }

    /** readTimeoutMs = 0 表示不设读超时（长期挂着等事件）。 */
    static Response getStream(String url, String deviceCredential, int readTimeoutMs) throws IOException {
        HttpURLConnection connection = open(url);
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(readTimeoutMs);
        connection.setUseCaches(false);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestProperty("Accept", "text/event-stream");
        if (deviceCredential != null && !deviceCredential.isEmpty()) {
            connection.setRequestProperty("X-Mini-Device", deviceCredential);
        }
        int status = connection.getResponseCode();
        if (status >= 400) {
            InputStream error = connection.getErrorStream();
            String body = error == null ? "" : readUtf8(error);
            connection.disconnect();
            return new Response(status, body);
        }
        return new Response(status, "", connection.getInputStream());
    }

    private static Response request(String method, String url, String json, String deviceCredential)
            throws IOException {
        HttpURLConnection connection = null;
        try {
            connection = open(url);
            connection.setRequestMethod(method);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setUseCaches(false);
            // 不把设备凭据随重定向交给另一台服务器。
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "application/json");
            connection.setRequestProperty("Charset", "UTF-8");
            if (deviceCredential != null && !deviceCredential.isEmpty()) {
                connection.setRequestProperty("X-Mini-Device", deviceCredential);
            }
            if (json != null) {
                byte[] bytes = json.getBytes("UTF-8");
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
                connection.setFixedLengthStreamingMode(bytes.length);
                OutputStream output = connection.getOutputStream();
                try {
                    output.write(bytes);
                } finally {
                    output.close();
                }
            }
            int status = connection.getResponseCode();
            InputStream input = status >= 400 ? connection.getErrorStream() : connection.getInputStream();
            String body = input == null ? "" : readUtf8(input);
            return new Response(status, body);
        } catch (SocketTimeoutException e) {
            throw new IOException("连接服务器超时，请检查网络后重试。", e);
        } catch (MalformedURLException e) {
            throw new IOException("服务器地址格式不正确。", e);
        } catch (IOException e) {
            throw new IOException("无法连接服务器，请检查网络以及电脑端服务是否在线。", e);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String readUtf8(InputStream input) throws IOException {
        try {
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            byte[] buffer = new byte[4096];
            int count;
            while ((count = input.read(buffer)) != -1) {
                output.write(buffer, 0, count);
            }
            return new String(output.toByteArray(), "UTF-8");
        } finally {
            input.close();
        }
    }
}
