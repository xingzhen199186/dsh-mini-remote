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
    /** 换了下载方式时告诉界面，别让用户以为进度归零是卡住了。 */
    interface Switch {
        void onSwitchToChunked();
    }

    /**
     * 下载结果（2026-11-11）。
     *
     * 失败要分两种：**完全连不上**和**下到一半断了**。用户在外面用流量，
     * 前者该换网络/检查电脑，后者只要信号回稳再点一次就行——一句话说错，
     * 他就会去折腾本来没坏的东西。
     */
    static final class DownloadOutcome {
        final boolean ok;
        /** 已经落盘的字节数；失败时用它告诉用户下到了哪儿。 */
        final long written;
        /** 是否收到过任何字节。false 表示从头到尾没连上。 */
        final boolean connected;

        DownloadOutcome(boolean ok, long written, boolean connected) {
            this.ok = ok;
            this.written = written;
            this.connected = connected;
        }
    }

    /** 整块传的读超时。流量下 27MB 的尾部停顿超过 15 秒很常见，别把「慢」当成「死」。 */
    private static final int WHOLE_READ_TIMEOUT_MS = 45_000;
    /** 单段读超时：每段只有 2MB，20 秒还不来就是真的卡住了。 */
    private static final int SEGMENT_READ_TIMEOUT_MS = 20_000;
    /** 同一段连续失败几次才放弃。 */
    private static final int SEGMENT_RETRIES = 3;
    /** 整块传断尾后，最多补几轮。 */
    private static final int RESUME_ROUNDS = 3;

    /**
     * 先整块传，断在尾部就接着下，最后才退到分段（2026-11-09 起，2026-11-11 修）。
     *
     * 原来的毛病：整块传到 100% 只是收尾读超时，却被判定失败，然后分段从 0 重来；
     * 27MB 白下两遍，流量用户直接被劝退。现在的顺序是：
     * 整块传 → 有部分字节就从断点用 Range 补（最多 3 轮）→ 真的连不上才分段。
     */
    static DownloadOutcome downloadPreferWhole(String url, String credential, java.io.File out, long total,
                                               Progress progress, Switch onSwitch) throws IOException {
        DownloadOutcome whole = downloadWhole(url, credential, out, total, progress);
        if (whole.ok) {
            return whole;
        }
        // 整块传拿到了部分字节：从断点接着要剩下的，绝不从头再来。
        long offset = total > 0 ? whole.written : 0;
        if (offset > 0 && (total <= 0 || offset < total)) {
            for (int round = 1; round <= RESUME_ROUNDS; round++) {
                DownloadOutcome resumed = download(url, credential, out, total, progress, offset, 1);
                if (resumed.ok) {
                    return resumed;
                }
                if (!resumed.connected) {
                    return resumed;
                }
                offset = resumed.written;
                if (total > 0 && offset >= total) {
                    break;
                }
            }
            if (total > 0 && offset >= total) {
                return new DownloadOutcome(true, offset, true);
            }
        }
        // 走到这儿说明整块传这条路走不通：告诉界面换了方式，然后分段继续（同样从已有字节接）。
        if (onSwitch != null) {
            onSwitch.onSwitchToChunked();
        }
        long start = total > 0 ? Math.min(out.exists() ? out.length() : 0, total) : out.exists() ? out.length() : 0;
        if (whole.connected && whole.written > start) {
            start = whole.written;
        }
        return download(url, credential, out, total, progress, start, SEGMENT_RETRIES);
    }

    /** 整块传：一个请求，从 0 到 total。45 秒没有新数据才算断。 */
    static DownloadOutcome downloadWhole(String url, String deviceCredential, java.io.File out, long total,
                                         Progress progress) throws IOException {
        java.io.File parent = out.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            return new DownloadOutcome(false, 0, false);
        }
        HttpURLConnection connection = open(url);
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        // 45 秒（2026-11-11 真机）：15 秒太短，27MB 在 5G 上尾部停顿一次就被判死，
        // 于是整份白下、再从 0 分段重来。宁肯多等一会儿，也不要重下 27MB。
        connection.setReadTimeout(WHOLE_READ_TIMEOUT_MS);
        connection.setUseCaches(false);
        connection.setInstanceFollowRedirects(false);
        if (deviceCredential != null && !deviceCredential.isEmpty()) {
            connection.setRequestProperty("X-Mini-Device", deviceCredential);
        }
        long written = 0;
        try {
            int status = connection.getResponseCode();
            if (status != 200) {
                return new DownloadOutcome(false, 0, false);
            }
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
            return new DownloadOutcome(written > 0 && (total <= 0 || written == total), written, written > 0);
        } catch (IOException err) {
            // 读到一半断了：把已落盘的字节数带回去，让上层从断点接，而不是从 0 重来。
            return new DownloadOutcome(false, written, written > 0);
        } finally {
            connection.disconnect();
        }
    }

    /**
     * 分段下载（2026-11-09 起，2026-11-11 加重试）。
     *
     * 每段失败就**从当前断点**再要一次，不是从这一段的起点重来：字节是顺序追加的，
     * 从断点接才不会把同一段写两遍（那会让整个包错位）。同一段连续三次都失败才报错。
     */
    static DownloadOutcome download(String url, String deviceCredential, java.io.File out, long total,
                                    Progress progress, long startOffset, int segmentRetries) throws IOException {
        final long chunk = 2L * 1024 * 1024;
        java.io.File parent = out.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            return new DownloadOutcome(false, startOffset, startOffset > 0);
        }
        long offset = Math.max(0, startOffset);
        boolean connected = offset > 0;
        try (java.io.OutputStream os = new java.io.FileOutputStream(out, offset > 0)) {
            while (total <= 0 || offset < total) {
                long end = (total > 0 ? Math.min(offset + chunk, total) : offset + chunk) - 1;
                long segmentStart = offset;
                boolean advanced = false;
                boolean finished = false;
                IOException last = null;
                for (int attempt = 1; attempt <= Math.max(1, segmentRetries); attempt++) {
                    HttpURLConnection connection = open(url);
                    try {
                        connection.setRequestMethod("GET");
                        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
                        connection.setReadTimeout(SEGMENT_READ_TIMEOUT_MS);
                        connection.setUseCaches(false);
                        connection.setInstanceFollowRedirects(false);
                        if (deviceCredential != null && !deviceCredential.isEmpty()) {
                            connection.setRequestProperty("X-Mini-Device", deviceCredential);
                        }
                        if (total > 0) {
                            connection.setRequestProperty("Range", "bytes=" + offset + "-" + end);
                        }
                        int status = connection.getResponseCode();
                        if (status == 416) {
                            // 要过了头：说明已经收全了。
                            finished = true;
                            break;
                        }
                        if (status == 200 && offset > 0) {
                            // 服务端不认续传，回了一整份：接着写会把前面的字节写重、整包错位。
                            // 宁可如实失败，也不交付一个坏包裹。
                            last = new IOException("服务器不支持断点续传");
                            break;
                        }
                        if (status != 206 && status != 200) {
                            last = new IOException("下载失败（HTTP " + status + "）");
                            continue;
                        }
                        try (java.io.InputStream in = connection.getInputStream()) {
                            byte[] buf = new byte[64 * 1024];
                            int n;
                            while ((n = in.read(buf)) > 0) {
                                os.write(buf, 0, n);
                                offset += n;
                                advanced = true;
                                connected = true;
                                if (progress != null) {
                                    progress.onBytes(offset);
                                }
                            }
                        }
                        if (status == 200) {
                            // 服务端不认 Range（offset 还是 0），一次把整份给了：到此为止。
                            finished = true;
                            break;
                        }
                        last = null;
                        break;
                    } catch (IOException err) {
                        // 这一段断了：下面从**当前 offset** 重试，接着写。
                        last = err;
                        if (offset > segmentStart) {
                            advanced = true;
                        }
                        // 抖一下就立刻重连，多半还是会失败；给网络一点回稳的时间。
                        if (attempt < Math.max(1, segmentRetries)) {
                            try {
                                Thread.sleep(400L * attempt);
                            } catch (InterruptedException stop) {
                                Thread.currentThread().interrupt();
                                return new DownloadOutcome(false, offset, connected);
                            }
                        }
                    } finally {
                        connection.disconnect();
                    }
                }
                if (finished) {
                    break;
                }
                if (last != null) {
                    // 三次都失败：把已下了多少带回去，上层据此告诉用户是断了还是没连上。
                    return new DownloadOutcome(false, offset, connected);
                }
                if (!advanced) {
                    // 一点字节都没进来，再转下去也是空转。
                    return new DownloadOutcome(false, offset, connected);
                }
                if (total > 0 && offset >= total) {
                    break;
                }
            }
        } catch (IOException err) {
            return new DownloadOutcome(false, offset, connected);
        }
        long length = out.exists() ? out.length() : 0;
        boolean ok = length > 0 && (total <= 0 || length == total);
        return new DownloadOutcome(ok, Math.max(offset, length), connected);
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
