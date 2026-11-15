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

    // ------------------------------------------------------------------
    // 后台任务（2026-11-15）：自连通道也能跑长任务，不用退回 Termux。
    //
    // 思路：用 setsid 把命令放到新会话里跑，输出与进程号都写进
    // /data/local/tmp/.dsh_adb_jobs/；查看就是读那个文件，停止就是杀进程组。
    // 实测（2026-11-15）：setsid / nohup / 直接 sh -c '&' 都能让子进程在
    // adb shell 退出后活下来（PPID 变成 1），但 setsid 最干净。
    // ------------------------------------------------------------------

    private static final String ADB_JOB_DIR = "/data/local/tmp/.dsh_adb_jobs";

    /**
     * 发起一条后台命令，立刻返回。
     *
     * @return JSON：{ok:true, jobId, backend:"adb"}；失败返回 null（交给 Termux）。
     */
    static String startJob(Context context, String jobId, String command, String workdir) {
        if (!paired(context)) return null;
        if (!AdbPairing.load()) return null;

        // 同名 jobId 已存在时换一个，不覆盖别人正在跑的任务。
        String effectiveId = jobId;
        String check = "if [ -f " + ADB_JOB_DIR + "/" + effectiveId + ".pid ]; then "
                + "echo exists; else echo free; fi";
        AdbShell.Result checkResult = runAdb(context, check);
        if (checkResult != null && checkResult.ok && checkResult.output.contains("exists")) {
            effectiveId = jobId + "-" + System.currentTimeMillis() % 10000;
        }

        String dir = workdir == null || workdir.trim().isEmpty() ? "" : "cd " + shellQuote(workdir.trim()) + " ; ";
        // 超过 24 小时的旧文件顺手清掉，目录不会越堆越多。
        String script = "mkdir -p " + ADB_JOB_DIR + " ; "
                + "find " + ADB_JOB_DIR + " -name '*.out' -o -name '*.pid' | xargs -r ls -lt 2>/dev/null | awk '{if (systime() - $6 > 86400) print $NF}' | xargs -r rm -f 2>/dev/null ; "
                + "setsid sh -c '" + dir + command + "' > " + ADB_JOB_DIR + "/" + effectiveId + ".out 2>&1 & "
                + "echo $! > " + ADB_JOB_DIR + "/" + effectiveId + ".pid ; "
                // **必须留一点时间让它真的脱离会话**（2026-11-15 真机）：连接一断，
                // adbd 会把这个 shell 的会话收掉；setsid 还没来得及换会话的孩子会被一起带走，
                // 表现就是"任务起了、文件 0 字节"。等 2 秒再收工，任务就活下来了。
                + "sleep 2 ; echo started";
        AdbShell.Result result = runAdb(context, script);
        if (result == null || !result.ok) return null;
        return "{\"ok\":true,\"jobId\":\"" + effectiveId + "\",\"backend\":\"adb\"}";
    }

    /** 看一个后台任务：还在跑吗、输出了什么。 */
    static String jobOutput(Context context, String jobId) {
        if (!paired(context)) return null;
        String out = ADB_JOB_DIR + "/" + jobId + ".out";
        String pid = ADB_JOB_DIR + "/" + jobId + ".pid";
        // 只回最后两万字节：一次塞太多会被系统截断。
        String script = "if [ ! -f " + out + " ]; then echo \"__DSH_NOJOB__\" ; exit 0 ; fi ; "
                + "tail -c 20000 " + out + " ; "
                + "if [ -f " + pid + " ] && kill -0 \"$(cat " + pid + ")\" 2>/dev/null ; "
                + "then echo \"__DSH_RUNNING__\" ; fi";
        AdbShell.Result result = runAdb(context, script);
        if (result == null || !result.ok) return null;
        String output = result.output;
        boolean running = output.contains("__DSH_RUNNING__");
        boolean noJob = output.contains("__DSH_NOJOB__");
        output = output.replace("__DSH_RUNNING__", "").replace("__DSH_NOJOB__", "").trim();
        StringBuilder json = new StringBuilder();
        json.append("{\"ok\":true,\"backend\":\"adb\",\"running\":").append(running);
        json.append(",\"output\":\"").append(escape(output)).append("\"");
        if (noJob) json.append(",\"note\":\"任务不存在\"");
        json.append("}");
        return json.toString();
    }

    /** 停掉一个后台任务（按进程组停，停完回读确认）。 */
    static String stopJob(Context context, String jobId) {
        if (!paired(context)) return null;
        String pid = ADB_JOB_DIR + "/" + jobId + ".pid";
        String out = ADB_JOB_DIR + "/" + jobId + ".out";
        // setsid 起的进程组 ID 就是 PID，杀 -PID 停整组；停完回读确认。
        String script = "if [ ! -f " + pid + " ] ; then echo \"__DSH_NOJOB__\" ; exit 0 ; fi ; "
                + "p=\"$(cat " + pid + ")\" ; "
                + "kill -9 -- -\"$p\" 2>/dev/null || kill -9 \"$p\" 2>/dev/null ; sleep 1 ; "
                + "if kill -0 \"$p\" 2>/dev/null ; then echo \"__DSH_STILL_RUNNING__\" ; else echo \"__DSH_STOPPED__\" ; fi ; "
                + "rm -f " + pid + " " + out;
        AdbShell.Result result = runAdb(context, script);
        if (result == null || !result.ok) return null;
        String output = result.output;
        boolean stopped = output.contains("__DSH_STOPPED__");
        boolean noJob = output.contains("__DSH_NOJOB__");
        StringBuilder json = new StringBuilder();
        json.append("{\"ok\":true,\"backend\":\"adb\",\"stopped\":").append(stopped);
        if (noJob) json.append(",\"note\":\"任务不存在\"");
        else if (!stopped) json.append(",\"note\":\"没停下来\"");
        json.append("}");
        return json.toString();
    }

    /** 走自连通道跑一条命令；成功返回 Result，失败返回 null。 */
    private static AdbShell.Result runAdb(Context context, String command) {
        AdbDiscover.Endpoint endpoint = rememberPort(context);
        AdbShell.Result result = null;
        if (endpoint != null) {
            result = AdbShell.run(context, endpoint.host, endpoint.port, command);
            if (result.ok) {
                rememberSuccess(context, endpoint);
                return result;
            }
        }
        // 端口每次都可能变：缓存那次失败就现扫一次。
        AdbDiscover.Endpoint fresh = AdbShell.connectEndpoint(context);
        if (fresh == null) return null;
        result = AdbShell.run(context, fresh.host, fresh.port, command);
        if (!result.ok) return null;
        rememberSuccess(context, fresh);
        return result;
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

    // ------------------------------------------------------------------
    // 界面状态（2026-11-15）：「手机终端」那一行要显示"现在走的是哪条通道"。
    //
    // 硬线：这个接口会被界面每 3 秒调一次，**绝对不能重扫 mDNS、不能 sleep、
    // 不能调 AdbShell.connectEndpoint()**（它内部会 refresh + sleep 900）。
    // 只读现成结果：ShellBackend.paired()、AdbDiscover.snapshot()、
    // PackageManager 与 checkSelfPermission。
    // ------------------------------------------------------------------

    /**
     * 当前会走哪条通道，以及为什么。
     *
     * @return JSON：{backend, paired, adbReady, termuxInstalled, termuxPermitted}
     *   backend: "adb"（已配对且能搜到连接口）/ "termux"（已装且已授权）/ "none"（都没有）；
     *   paired: 有没有配对过自连通道；
     *   adbReady: 现在能不能走自连（paired 且 snapshot 里有 CONNECT 类型）；
     *   termuxInstalled / termuxPermitted: Termux 装没装、授权没有。
     */
    static String backendState(Context context) {
        boolean paired = paired(context);
        boolean adbReady = false;
        if (paired) {
            // 只读现成结果：snapshot() 是内存里的缓存，不触发扫描。
            for (AdbDiscover.Endpoint one : AdbDiscover.snapshot()) {
                if (AdbDiscover.CONNECT.equals(one.type)) {
                    adbReady = true;
                    break;
                }
            }
        }
        boolean termuxInstalled = true;
        try {
            context.getPackageManager().getPackageInfo("com.termux", 0);
        } catch (Exception err) {
            termuxInstalled = false;
        }
        boolean termuxPermitted = context.checkSelfPermission("com.termux.permission.RUN_COMMAND")
                == android.content.pm.PackageManager.PERMISSION_GRANTED;

        String backend;
        if (adbReady) {
            backend = "adb";
        } else if (termuxInstalled && termuxPermitted) {
            backend = "termux";
        } else {
            backend = "none";
        }

        org.json.JSONObject out = new org.json.JSONObject();
        try {
            out.put("backend", backend);
            out.put("paired", paired);
            out.put("adbReady", adbReady);
            out.put("termuxInstalled", termuxInstalled);
            out.put("termuxPermitted", termuxPermitted);
            // 兼容旧字段：paintTermux 里 how.hidden 还要用 st.installed。
            out.put("installed", termuxInstalled);
            out.put("permitted", termuxPermitted);
        } catch (Exception ignored) {
        }
        return out.toString();
    }
}
