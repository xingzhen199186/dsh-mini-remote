package com.dsh.miniremote;

import android.content.Context;

/**
 * 命令执行后端的选择（2026-11-15）。
 *
 * 两条件路：**自连 ADB**（shell 身份，不需要 Termux）与 **Termux**（老路）。
 * 选择规则，按优先级：
 *   1. 没配对过、或现在没有无线调试连接口 → Termux；
 *   2. 要喂 stdin、或要跑后台长任务 → Termux（自连通道目前只做"跑一条、等它结束"）；
 *   3. 其余一律先走自连通道；它失败就**如实退回** Termux，并把两边的情况写在结果里。
 *
 * 为什么这样接：电脑那边（phone_shell）只认 {ok, stdout, stderr, exitCode} 这一份约定，
 * 换后端不该让它知道——用户看到的应当只是"能跑"。
 */
final class ShellBackend {

    private static final String PREFS = "mini-adb";
    private static final String KEY_PAIRED = "paired";
    private static final String KEY_PORT = "connectPort";
    private static final String KEY_HOST = "connectHost";

    private ShellBackend() {
    }

    /** 配对成功后调用：记住"配过了"，下次直接试自连。 */
    static void markPaired(Context context, String host, int port) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putBoolean(KEY_PAIRED, true)
                .putString(KEY_HOST, host)
                .putInt(KEY_PORT, port)
                .apply();
    }

    static boolean paired(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_PAIRED, false);
    }

    /** 上一次用过的连接口（端口每次开无线调试都可能变，所以只是"先试一下"）。 */
    private static AdbDiscover.Endpoint rememberPort(Context context) {
        android.content.SharedPreferences prefs =
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String host = prefs.getString(KEY_HOST, "");
        int port = prefs.getInt(KEY_PORT, 0);
        if (host.isEmpty() || port == 0) return null;
        return new AdbDiscover.Endpoint(AdbDiscover.CONNECT, host, port);
    }

    private static void rememberSuccess(Context context, AdbDiscover.Endpoint endpoint) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_HOST, endpoint.host)
                .putInt(KEY_PORT, endpoint.port)
                .apply();
    }

    /**
     * 跑一条命令，返回与 TermuxRun 相同的 JSON 形状：{ok, stdout, stderr, exitCode}。
     */
    static String exec(Context context, String command, int timeoutSeconds, String workdir, String stdin) {
        if (command == null || command.trim().isEmpty()) {
            return "{\"ok\":false,\"error\":\"命令是空的\"}";
        }
        String reasonToSkip = "";
        if (!paired(context)) {
            reasonToSkip = "还没配对";
        } else if (stdin != null && !stdin.isEmpty()) {
            reasonToSkip = "自连通道还不支持喂输入";
        }
        if (reasonToSkip.isEmpty()) {
            String viaAdb = tryAdb(context, command, workdir);
            if (viaAdb != null) return viaAdb;
        }
        // 退回 Termux：如果这就是原来的行为，用户不该察觉差别。
        String termux = TermuxRun.exec(context, command, timeoutSeconds, workdir, stdin);
        if (reasonToSkip.isEmpty()) return termux;
        return termux.replaceFirst("\\}\\s*$",
                ",\"backend\":\"termux\",\"note\":\"" + reasonToSkip + "，走的是 Termux\"}");
    }

    /** 走自连通道；成功返回结果 JSON，失败返回 null（交给 Termux）。 */
    private static String tryAdb(Context context, String command, String workdir) {
        if (!AdbPairing.load()) return null;
        String effective = command;
        if (workdir != null && !workdir.trim().isEmpty()) {
            // 我们的通道是"一条命令、一个 shell"，工作目录用 cd 表达最直观。
            effective = "cd " + shellQuote(workdir.trim()) + " && " + command;
        }
        AdbDiscover.Endpoint endpoint = rememberPort(context);
        AdbShell.Result result = null;
        if (endpoint != null) {
            result = AdbShell.run(context, endpoint.host, endpoint.port, effective);
            if (result.ok) {
                rememberSuccess(context, endpoint);
            }
        }
        if (result == null || !result.ok) {
            // 端口每次都可能变：缓存那次失败就现扫一次。
            AdbDiscover.Endpoint fresh = AdbShell.connectEndpoint(context);
            if (fresh == null) return null;
            result = AdbShell.run(context, fresh.host, fresh.port, effective);
            if (!result.ok) return null;
            rememberSuccess(context, fresh);
        }
        StringBuilder json = new StringBuilder();
        json.append("{\"ok\":true,\"backend\":\"adb\",\"exitCode\":0,\"stderr\":\"\",\"stdout\":\"");
        json.append(escape(result.output)).append("\"}");
        return json.toString();
    }

    private static String shellQuote(String text) {
        return "'" + text.replace("'", "'\\''") + "'";
    }

    private static String escape(String text) {
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            switch (ch) {
                case '"':
                    out.append("\\\"");
                    break;
                case '\\':
                    out.append("\\\\");
                    break;
                case '\n':
                    out.append("\\n");
                    break;
                case '\r':
                    break;
                case '\t':
                    out.append("\\t");
                    break;
                default:
                    if (ch < 0x20) {
                        out.append(String.format("\\u%04x", (int) ch));
                    } else {
                        out.append(ch);
                    }
            }
        }
        return out.toString();
    }
}
