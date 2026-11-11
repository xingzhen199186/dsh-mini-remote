package com.dsh.miniremote;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 手机上能回看的操作记录（2026-11-11，D1）。
 *
 * 记的是「什么时间、做了什么、点的是哪个、成没成」——让人不用回电脑翻会话，
 * 就能知道刚才它看了屏幕、点了哪个按钮、哪一步失败。
 *
 * 三条硬规矩：
 *   · 最多留最近 50 条（一段连续操作够看，越多越没必要）；
 *   · **不记内容**：输入正文、屏幕正文、截图、Base64、凭据、完整网址一概不写；
 *   · 目标标签先过 SensitiveText 打码——按钮上也可能带号码。
 */
final class ActionLog {
    private static final int MAX = 50;
    private static final String FILE = "action-log.json";
    private static final Object LOCK = new Object();

    private ActionLog() {
    }

    static void record(Context context, String tool, String target, boolean ok) {
        if (context == null) return;
        try {
            JSONObject entry = new JSONObject();
            entry.put("at", System.currentTimeMillis());
            entry.put("tool", tool == null ? "" : tool);
            entry.put("target", SensitiveText.mask(target == null ? "" : target));
            entry.put("ok", ok);
            synchronized (LOCK) {
                JSONArray list = read(context);
                list.put(entry);
                while (list.length() > MAX) {
                    list.remove(0);
                }
                write(context, list);
            }
        } catch (Exception ignored) {
            // 记录只是给人看的旁证，写不进去也不能影响动作本身。
        }
    }

    /** 给设置页看的最近若干条（新的在前）。 */
    static String recent(Context context, int limit) {
        try {
            JSONArray out = new JSONArray();
            JSONArray list = read(context);
            SimpleDateFormat fmt = new SimpleDateFormat("MM-dd HH:mm:ss", Locale.US);
            int count = 0;
            for (int i = list.length() - 1; i >= 0 && count < limit; i--, count++) {
                JSONObject e = list.getJSONObject(i);
                JSONObject row = new JSONObject();
                row.put("time", fmt.format(new Date(e.optLong("at"))));
                row.put("tool", e.optString("tool"));
                row.put("target", e.optString("target"));
                row.put("ok", e.optBoolean("ok"));
                out.put(row);
            }
            return out.toString();
        } catch (Exception err) {
            return "[]";
        }
    }

    private static JSONArray read(Context context) {
        try {
            File file = new File(context.getFilesDir(), FILE);
            if (!file.exists()) return new JSONArray();
            try (FileInputStream in = new FileInputStream(file)) {
                byte[] buf = new byte[(int) file.length()];
                int off = 0;
                while (off < buf.length) {
                    int n = in.read(buf, off, buf.length - off);
                    if (n < 0) break;
                    off += n;
                }
                return new JSONArray(new String(buf, 0, off, StandardCharsets.UTF_8));
            }
        } catch (Exception err) {
            return new JSONArray();
        }
    }

    /** 先写临时文件再改名：写一半被杀也不会留下半个 JSON。 */
    private static void write(Context context, JSONArray list) throws Exception {
        File dir = context.getFilesDir();
        File tmp = new File(dir, FILE + ".tmp");
        try (FileOutputStream os = new FileOutputStream(tmp, false)) {
            os.write(list.toString().getBytes(StandardCharsets.UTF_8));
            os.getFD().sync();
        }
        File target = new File(dir, FILE);
        if (!tmp.renameTo(target)) {
            try (FileOutputStream os = new FileOutputStream(target, false)) {
                os.write(list.toString().getBytes(StandardCharsets.UTF_8));
            }
            tmp.delete();
        }
    }
}
