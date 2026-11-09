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

    /**
     * 分段下载（2026-11-09）。
     *
     * **为什么不是一个请求拉完**：这条通路对"一次传一大块、连接活很久"的响应会卡住，
     * 手机点下载后一直没动静就是它；而短请求一直是好的。所以每段只要 CHUNK 字节，
     * 传完立刻断，再来下一段——把长连接拆成一串短连接。
     *
     * `total` 来自电脑端报的大小；每段都用 Range 要，服务端回 206。
     * 任何一段失败就**如实返回失败**，不留半截文件去装。
     */
    /**
     * 先整块传，卡住就自动改分段（2026-11-09 用户要求"先试老机制"）。
     *
     * 老机制（一个请求传完）在真机上曾整块卡死过，但那是另一种可能：也许只是慢。
     * 所以这里给它一次机会——**但必须有止损**：15 秒内一个字节都没进来，就判定卡住，
     * 立刻改用分段。这样"试老办法"不会变成"干等"。
     *
     * `onSwitch` 用来告诉界面"换了方式"，别让用户以为重头开始。
     */
    interface Switch {
        void onSwitchToChunked();
    }

    static boolean downloadPreferWhole(String url, String credential, java.io.File out, long total,
                                       Progress progress, Switch onSwitch) throws IOException {
        try {
            boolean ok = downloadWhole(url, credential, out, total, progress);
            if (ok) {
                return true;
            }
        } catch (IOException err) {
            // 超时/断流都落在这里：当作"卡住"，继续走分段。
        }
        if (onSwitch != null) {
            onSwitch.onSwitchToChunked();
        }
        return download(url, credential, out, total, progress);
    }

    /** 整块传：一个请求，从 0 到 total。15 秒没数据就算失败。 */
    static boolean downloadWhole(String url, String deviceCredential, java.io.File out, long total,
                                 Progress progress) throws IOException {
        java.io.File parent = out.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            return false;
        }
        HttpURLConnection connection = open(url);
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        // 15 秒：整块传如果连数据都不来，就不必再等。
        connection.setReadTimeout(15_000);
        connection.setUseCaches(false);
        connection.setInstanceFollowRedirects(false);
        if (deviceCredential != null && !deviceCredential.isEmpty()) {
            connection.setRequestProperty("X-Mini-Device", deviceCredential);
        }
        try {
            int status = connection.getResponseCode();
            if (status != 200) {
                return false;
            }
            long written = 0;
            try (java.io.InputStream in = connection.getInputStream();
                 java.io.OutputStream os = new java.io.FileOutputStream(out, false)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    os.write(buf, 0, n);
                    written += n;
                    if (progress != null) {
                        progress.onBytes(written);
                    }
                }
            }
            return written > 0 && (total <= 0 || written == total);
        } finally {
            connection.disconnect();
        }
    }

    static boolean download(String url, String deviceCredential, java.io.File out, long total, Progress progress) throws IOException {
        final long chunk = 2L * 1024 * 1024;
        java.io.File parent = out.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            return false;
        }
        long offset = 0;
        try (java.io.OutputStream os = new java.io.FileOutputStream(out, false)) {
            while (true) {
                long end = (total > 0 ? Math.min(offset + chunk, total) : offset + chunk) - 1;
                HttpURLConnection connection = open(url);
                connection.setRequestMethod("GET");
                connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                // 每段很短，20 秒还不来就是真的卡住了：早点失败，别让用户干等。
                connection.setReadTimeout(20_000);
                connection.setUseCaches(false);
                connection.setInstanceFollowRedirects(false);
                if (deviceCredential != null && !deviceCredential.isEmpty()) {
                    connection.setRequestProperty("X-Mini-Device", deviceCredential);
                }
                if (total > 0) {
                    connection.setRequestProperty("Range", "bytes=" + offset + "-" + end);
                }
                try {
                    int status = connection.getResponseCode();
                    if (status == 416) {
                        // 要过了头：说明已经收全了。
                        break;
                    }
                    if (status != 206 && status != 200) {
                        return false;
                    }
                    long got = 0;
                    try (java.io.InputStream in = connection.getInputStream()) {
                        byte[] buf = new byte[64 * 1024];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            os.write(buf, 0, n);
                            got += n;
                            offset += n;
                            if (progress != null) {
                                progress.onBytes(offset);
                            }
                        }
                    }
                    if (got == 0) {
                        break;
                    }
                    if (status == 200) {
                        // 服务端不认 Range，一次把整份给了：到此为止。
                        break;
                    }
                } finally {
                    connection.disconnect();
                }
                if (total > 0 && offset >= total) {
                    break;
                }
            }
        } catch (IOException err) {
            if (out.exists() && !out.delete()) {
                // 删不掉也没关系：下次会覆盖。
            }
            throw err;
        }
        return out.length() > 0 && (total <= 0 || out.length() == total);
    }

    /**
     * 读超时更长的 GET（2026-11-09）。
     *
     * 手机桥是**长轮询**：服务端会有意压住 25 秒再回。普通 8 秒的超时会把它当成失败，
     * 于是客户端会一直重连、一直显示离线。这里单独给一条能等得起的通道。
     */
    public static Response getLong(String url, String deviceCredential, int readTimeoutMs) throws IOException {
        HttpURLConnection connection = null;
        try {
            connection = open(url);
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(readTimeoutMs);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            if (deviceCredential != null && !deviceCredential.isEmpty()) {
                connection.setRequestProperty("X-Mini-Device", deviceCredential);
            }
            int status = connection.getResponseCode();
            java.io.InputStream stream = status >= 200 && status < 300
                    ? connection.getInputStream() : connection.getErrorStream();
            String body = stream == null ? "" : readUtf8(stream);
            return new Response(status, body);
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
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
