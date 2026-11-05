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

    public static Response get(String url, String deviceCredential) throws IOException {
        return request("GET", url, null, deviceCredential);
    }

    public static Response postJson(String url, String json, String deviceCredential) throws IOException {
        return request("POST", url, json, deviceCredential);
    }

    /**
     * 服务器推送（SSE）用的长连接。
     *
     * 和普通请求的区别：读超时关掉（服务端可能很久才发一帧，设 15 秒会被当成断线），
     * 也不在这里读 body、不 disconnect——一断就收不到后面的消息了。谁来关流？
     * 调用方（前台服务）在停止时关。
     */
    public static Response getStream(String url, String deviceCredential) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
        connection.setReadTimeout(0);
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
            connection = (HttpURLConnection) new URL(url).openConnection();
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
