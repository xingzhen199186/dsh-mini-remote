package com.dsh.miniremote;

import android.app.IntentService;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

/**
 * 在手机上的 Termux 里执行命令（2026-11-12）。
 *
 * 为什么走这条路：电脑操作手机原来只有"无障碍点屏幕"，而终端是自绘画布，
 * 控件树里读不到内容。Termux 官方给了 RUN_COMMAND 入口，让外部 App 请它执行命令
 * 并把结果取回来——这样电脑就能在手机上真正跑命令，不用靠点屏幕。
 *
 * 网络因此**自动覆盖所有连接方式**：命令在手机上执行，结果走现有的手机桥回来，
 * 内网、Tailscale、中自建继、隧道哪条线都行，不需要电脑反过来连手机。
 *
 * 结果字段的键名**不硬编码**：Termux 版本之间可能不同，这里按后缀识别
 * （*_STDOUT / *_STDERR / *_EXIT_CODE），拿不到就把原始键值一并带回去给人看。
 */
final class TermuxRun {
    /** Termux 的入口，取自官方 wiki。 */
    private static final String TERMUX_PACKAGE = "com.termux";
    private static final String SERVICE = "com.termux.app.RunCommandService";
    private static final String ACTION = "com.termux.RUN_COMMAND";

    private static final String EXTRA_COMMAND_PATH = "com.termux.RUN_COMMAND_PATH";
    private static final String EXTRA_ARGUMENTS = "com.termux.RUN_COMMAND_ARGUMENTS";
    private static final String EXTRA_WORKDIR = "com.termux.RUN_COMMAND_WORKDIR";
    private static final String EXTRA_BACKGROUND = "com.termux.RUN_COMMAND_BACKGROUND";
    private static final String EXTRA_SESSION_ACTION = "com.termux.RUN_COMMAND_SESSION_ACTION";
    private static final String EXTRA_LABEL = "com.termux.RUN_COMMAND_COMMAND_LABEL";
    private static final String EXTRA_DESCRIPTION = "com.termux.RUN_COMMAND_COMMAND_DESCRIPTION";
    private static final String EXTRA_PENDING_INTENT = "com.termux.RUN_COMMAND_PENDING_INTENT";
    private static final String EXTRA_STDIN = "com.termux.RUN_COMMAND_STDIN";

    /** 后台任务的现场：脚本把输出和进程号写在这里，供"查看"和"停止"用。 */
    private static final String JOB_DIR = "$HOME/.dsh_jobs";

    /** 每次执行一个编号，结果回来时按它对上。 */
    private static final ConcurrentHashMap<Integer, ArrayBlockingQueue<String>> SLOTS = new ConcurrentHashMap<>();
    private static int nextId = 1000;

    private TermuxRun() {
    }

    private static Boolean cachedAvailable;
    private static long cachedAt = 0;

    /**
     * 这条终端路现在能不能用（装了 Termux、也授权了）。
     * 结果缓存几秒，因为它每次心跳都会问一次。
     */
    static boolean available(Context context) {
        long nowMs = System.currentTimeMillis();
        if (cachedAvailable != null && nowMs - cachedAt < 5000) return cachedAvailable;
        boolean ok = false;
        try {
            context.getPackageManager().getPackageInfo(TERMUX_PACKAGE, 0);
            ok = context.checkSelfPermission("com.termux.permission.RUN_COMMAND")
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
        } catch (Exception err) {
            ok = false;
        }
        cachedAvailable = ok;
        cachedAt = nowMs;
        return ok;
    }

    static synchronized int nextExecutionId() {
        return nextId++;
    }

    /**
     * 执行一条命令，等它回话。
     *
     * @return JSON：{ok, stdout, stderr, exitCode, raw?}；失败时带 error。
     */
    static String exec(Context context, String command, int timeoutSeconds) {
        return exec(context, command, timeoutSeconds, null, null);
    }

    /**
     * 执行一条命令（可指定工作目录、可喂 stdin）。
     *
     * @param workdir 工作目录；null 就用 Termux 自己的家目录。
     * @param stdin   喂给命令的内容；null 表示没有。
     */
    static String exec(Context context, String command, int timeoutSeconds, String workdir, String stdin) {
        if (command == null || command.trim().isEmpty()) {
            return "{\"ok\":false,\"error\":\"命令是空的\"}";
        }
        final int id = nextExecutionId();
        final ArrayBlockingQueue<String> slot = new ArrayBlockingQueue<>(1);
        SLOTS.put(id, slot);

        Intent intent = new Intent();
        intent.setClassName(TERMUX_PACKAGE, SERVICE);
        intent.setAction(ACTION);
        // 用 $PREFIX 下的 bash 跑 -c，这样支持管道、重定向这些日常写法。
        intent.putExtra(EXTRA_COMMAND_PATH, "$PREFIX/bin/bash");
        intent.putExtra(EXTRA_ARGUMENTS, new String[]{"-c", command});
        // 不传工作目录：默认就是 Termux 的家目录。传 "~" 会被当成字面量 "/~" 而不存在。
        intent.putExtra(EXTRA_BACKGROUND, true);
        intent.putExtra(EXTRA_SESSION_ACTION, "0");
        if (workdir != null && !workdir.trim().isEmpty()) {
            intent.putExtra(EXTRA_WORKDIR, workdir.trim());
        }
        if (stdin != null) {
            intent.putExtra(EXTRA_STDIN, stdin);
        }
        intent.putExtra(EXTRA_LABEL, "电脑请求执行命令");
        intent.putExtra(EXTRA_DESCRIPTION, "由手机遥控执行");

        Intent back = new Intent(context, TermuxResultService.class);
        back.putExtra(TermuxResultService.EXTRA_EXECUTION_ID, id);
        int flags = android.app.PendingIntent.FLAG_ONE_SHOT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                ? android.app.PendingIntent.FLAG_MUTABLE : 0);
        // requestCode 必须每次不同，否则只有第一次的结果能回来（官方说明）。
        intent.putExtra(EXTRA_PENDING_INTENT,
                android.app.PendingIntent.getService(context, id, back, flags));

        try {
            context.startService(intent);
        } catch (Exception err) {
            SLOTS.remove(id);
            String msg = String.valueOf(err.getMessage()).replace("\"", "'");
            return "{\"ok\":false,\"error\":\"叫不动 Termux：" + msg + "\"}";
        }

        try {
            String payload = slot.poll(Math.max(5, timeoutSeconds), TimeUnit.SECONDS);
            if (payload == null) {
                return "{\"ok\":false,\"error\":\"Termux 没有在预期时间内回话\"}";
            }
            return payload;
        } catch (InterruptedException err) {
            Thread.currentThread().interrupt();
            return "{\"ok\":false,\"error\":\"等待被中断\"}";
        } finally {
            SLOTS.remove(id);
        }
    }

    /**
     * 发起一条后台命令，立刻返回一个任务编号，不等它跑完（2026-11-12）。
     *
     * 为什么需要：装包、下载、批处理动辄几分钟，同步等一定会超时；超时后命令还在手机里跑，
     * 电脑却以为失败了，会重跑，造成重复安装、重复删除。所以拆成"发起 / 查看 / 停止"。
     */
    static String startJob(Context context, String jobId, String command, String workdir) {
        String dir = workdir == null || workdir.trim().isEmpty() ? "" : "cd " + quote(workdir.trim()) + " ; ";
        // 逐条记录退出码，让"查看"能判断是跑完还是失败。
        String script = "mkdir -p " + JOB_DIR + " ; "
                + "{ " + dir + command + " ; echo \"__DSH_EXIT__$?\" ; } "
                + "> " + JOB_DIR + "/" + jobId + ".out 2>&1 & "
                + "echo $! > " + JOB_DIR + "/" + jobId + ".pid ; echo started";
        return exec(context, script, 20, null, null);
    }

    /** 看一个后台任务：还在跑吗、输出了什么。 */
    static String jobOutput(Context context, String jobId) {
        String out = JOB_DIR + "/" + jobId + ".out";
        String pid = JOB_DIR + "/" + jobId + ".pid";
        // 只回最后两万字节：一次塞太多会被系统截断，也容易压垮通道。
        String script = "if [ ! -f " + out + " ]; then echo \"__DSH_NOJOB__\" ; exit 0 ; fi ; "
                + "tail -c 20000 " + out + " ; "
                + "if [ -f " + pid + " ] && kill -0 \"$(cat " + pid + ")\" 2>/dev/null ; "
                + "then echo \"__DSH_RUNNING__\" ; fi";
        return exec(context, script, 30, null, null);
    }

    /** 停掉一个后台任务（连同它派生的子进程）。 */
    static String stopJob(Context context, String jobId) {
        String pid = JOB_DIR + "/" + jobId + ".pid";
        String script = "if [ ! -f " + pid + " ] ; then echo \"__DSH_NOJOB__\" ; exit 0 ; fi ; "
                + "p=\"$(cat " + pid + ")\" ; "
                + "pkill -P \"$p\" 2>/dev/null ; kill -9 \"$p\" 2>/dev/null ; "
                + "rm -f " + pid + " ; echo stopped";
        return exec(context, script, 20, null, null);
    }

    /** 给工作目录路径加引号，避免空格把它拆开。 */
    private static String quote(String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }

    /** 结果服务收到回传后把它交到这里。 */
    static void deliver(int executionId, String payload) {
        ArrayBlockingQueue<String> slot = SLOTS.get(executionId);
        if (slot != null) slot.offer(payload);
    }
}
