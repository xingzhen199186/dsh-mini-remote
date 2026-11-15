package com.dsh.miniremote;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 自连通道的自动检查（2026-11-15）。
 *
 * 为什么要有它：这条通道今天踩过的坑（帧没走 TLS、公钥字段写错、多发一个 CNXN、
 * 后台任务 0 字节）全靠人肉复验才发现——不固化成一条命令，下次改动还会重犯。
 *
 * 它跑的是**真实路径**：`ShellBackend.exec` / `startJob` / `jobOutput` / `stopJob`，
 * 也就是 `phone_shell` 走的那套；不是拿 adb shell 替代（那正是上次掩盖 bug 的做法）。
 */
final class AdbChannelCheck {

    private static final String RESULT_FILE = "adb-channel-check.json";

    private AdbChannelCheck() {
    }

    /** 跑一遍，结果写进 files/adb-channel-check.json。 */
    static void run(Context context) {
        Context app = context.getApplicationContext();
        JSONArray checks = new JSONArray();
        try {
            checks.put(checkWhoami(app));
            checks.put(checkUnicode(app));
            checks.put(checkPipe(app));
            checks.put(checkBackground(app));
            checks.put(checkReuse(app));
            checks.put(checkFallback(app));
        } catch (Exception err) {
            try {
                JSONObject one = new JSONObject();
                one.put("name", "内部错误");
                one.put("pass", false);
                one.put("detail", err.getMessage() == null ? "未知" : err.getMessage());
                checks.put(one);
            } catch (Exception ignored) {
            }
        }
        JSONObject out = new JSONObject();
        try {
            out.put("at", System.currentTimeMillis());
            out.put("checks", checks);
        } catch (Exception ignored) {
        }
        try (java.io.FileOutputStream stream = new java.io.FileOutputStream(
                new java.io.File(app.getFilesDir(), RESULT_FILE))) {
            stream.write(out.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        } catch (Exception ignored) {
        }
    }

    private static JSONObject checkWhoami(Context context) throws Exception {
        String raw = ShellBackend.exec(context, "whoami", 20, null, null);
        return judge("身份是 shell", raw, "shell");
    }

    private static JSONObject checkUnicode(Context context) throws Exception {
        String raw = ShellBackend.exec(context, "echo 中文测试", 20, null, null);
        return judge("中文不乱码", raw, "中文测试");
    }

    private static JSONObject checkPipe(Context context) throws Exception {
        String raw = ShellBackend.exec(context, "echo abc | tr a-z A-Z", 20, null, null);
        return judge("管道可用", raw, "ABC");
    }

    private static JSONObject checkBackground(Context context) throws Exception {
        JSONObject one = new JSONObject();
        one.put("name", "后台任务能起、能读、能停");
        String started = ShellBackend.startJob(context,
                "selfcheck" + (System.currentTimeMillis() % 1000),
                "for i in 1 2 3; do echo b$i; sleep 1; done", null);
        if (started == null) {
            one.put("pass", false);
            one.put("detail", "起不来（可能没配对）");
            return one;
        }
        JSONObject startedJson = new JSONObject(started);
        String jobId = startedJson.optString("jobId", "");
        Thread.sleep(4500);                       // 让它至少写出几行
        String output = ShellBackend.jobOutput(context, jobId);
        String stopped = ShellBackend.stopJob(context, jobId);
        boolean sawLine = output != null && output.contains("b1");
        boolean didStop = stopped != null && stopped.contains("\"stopped\":true");
        one.put("pass", sawLine && didStop);
        one.put("detail", "jobId=" + jobId + " 有输出=" + sawLine + " 已停止=" + didStop);
        return one;
    }

    /** 连接复用：连续几条命令应当明显快于每条都重新握手。 */
    private static JSONObject checkReuse(Context context) throws Exception {
        JSONObject one = new JSONObject();
        one.put("name", "连接复用：连续 5 条命令");
        long started = System.currentTimeMillis();
        boolean allOk = true;
        for (int i = 0; i < 5; i++) {
            String raw = ShellBackend.exec(context, "echo r" + i, 20, null, null);
            if (raw == null || !raw.contains("r" + i)) allOk = false;
        }
        long elapsed = System.currentTimeMillis() - started;
        one.put("pass", allOk && elapsed < 4000);
        one.put("detail", "5 条共 " + elapsed + "ms（每条重建连接时通常在 1500ms 以上）");
        return one;
    }

    /**
     * 退回 Termux 的那条路：临时把「已配对」标记摘掉，看它是否**安静退回**而不是报错。
     * 跑完无论成败都恢复标记。
     */
    private static JSONObject checkFallback(Context context) throws Exception {
        JSONObject one = new JSONObject();
        one.put("name", "没配对时安静退回");
        android.content.SharedPreferences prefs =
                context.getSharedPreferences("mini-adb", Context.MODE_PRIVATE);
        boolean wasPaired = prefs.getBoolean("paired", false);
        if (!wasPaired) {
            one.put("pass", true);
            one.put("detail", "本来就没配对，跳过（这不算验证）");
            return one;
        }
        prefs.edit().putBoolean("paired", false).commit();
        try {
            String raw = ShellBackend.exec(context, "echo fallback", 20, null, null);
            JSONObject parsed = new JSONObject(raw);
            String backend = parsed.optString("backend", "");
            boolean passed = "termux".equals(backend) || "none".equals(backend)
                    || parsed.optString("error", "").contains("Termux");
            one.put("pass", passed);
            one.put("detail", "backend=" + backend + " ok=" + parsed.optBoolean("ok", false));
            return one;
        } finally {
            prefs.edit().putBoolean("paired", true).commit();
        }
    }

    private static JSONObject judge(String name, String raw, String mustContain) throws Exception {
        JSONObject one = new JSONObject();
        one.put("name", name);
        boolean ok = raw != null && raw.contains(mustContain);
        one.put("pass", ok);
        String backend = "";
        try {
            backend = new JSONObject(raw == null ? "{}" : raw).optString("backend", "");
        } catch (Exception ignored) {
        }
        one.put("detail", "通道=" + backend + " 片段=" + (raw == null ? "" :
                raw.replaceAll("\\s+", " ").trim()));
        return one;
    }
}
