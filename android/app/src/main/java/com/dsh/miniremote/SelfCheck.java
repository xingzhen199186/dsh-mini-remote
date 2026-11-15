package com.dsh.miniremote;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.accessibility.AccessibilityManager;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 「手机操控自检」：一页看全，每项能跳过去改（2026-11-14）。
 *
 * 为什么要有它：手机操控出问题的时候，用户看到的只是"点不动"，
 * 而原因可能是无障碍没开、通知没给、电池优化把 App 杀了、系统版本不支持截图——
 * 四件事长得一模一样。这一页就是把这四种"点不动"分开。
 *
 * 判断只读，不修：修要靠系统页面，用户自己点。
 */
final class SelfCheck {

    private SelfCheck() {
    }

    /** 无障碍服务是不是开着（认的是本 App 自己的服务）。 */
    static boolean accessibilityOn(Context context) {
        try {
            AccessibilityManager manager = (AccessibilityManager)
                    context.getSystemService(Context.ACCESSIBILITY_SERVICE);
            if (manager == null) return false;
            return !manager.getEnabledAccessibilityServiceList(
                    android.accessibilityservice.AccessibilityServiceInfo.FEEDBACK_ALL_MASK).isEmpty()
                    && enabledFor(context);
        } catch (Exception err) {
            return false;
        }
    }

    private static boolean enabledFor(Context context) {
        try {
            String setting = Settings.Secure.getString(
                    context.getContentResolver(), Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (setting == null) return false;
            return setting.contains(context.getPackageName());
        } catch (Exception err) {
            return false;
        }
    }

    static boolean notificationsOn(Context context) {
        try {
            androidx.core.app.NotificationManagerCompat manager =
                    androidx.core.app.NotificationManagerCompat.from(context);
            return manager.areNotificationsEnabled();
        } catch (Exception err) {
            return false;
        }
    }

    static boolean batteryOptimizedAway(Context context) {
        try {
            PowerManager power = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (power == null) return true;
            return !power.isIgnoringBatteryOptimizations(context.getPackageName());
        } catch (Exception err) {
            return true;
        }
    }

    static boolean canScreenshot() {
        return Build.VERSION.SDK_INT >= 30;
    }

    /** 自检结果：给设置页那一行显示摘要，也给对话框逐条排版。 */
    static JSONObject state(Context context) {
        JSONObject out = new JSONObject();
        try {
            out.put("accessibility", accessibilityOn(context));
            out.put("notifications", notificationsOn(context));
            out.put("batteryOk", !batteryOptimizedAway(context));
            out.put("screenshot", canScreenshot());
            out.put("sdk", Build.VERSION.SDK_INT);
        } catch (Exception ignored) {
            // 返回空对象即可，界面上会显示"读不到"。
        }
        return out;
    }

    private static List<String> lines(Context context) {
        List<String> rows = new ArrayList<>();
        rows.add((accessibilityOn(context) ? "✓ " : "✗ ") + "无障碍服务"
                + (accessibilityOn(context) ? "：已开启，能读屏和点按" : "：没开，读屏和点按都不能用"));
        rows.add((notificationsOn(context) ? "✓ " : "✗ ") + "通知"
                + (notificationsOn(context) ? "：可以提醒" : "：没给权限，任务跑完不会提醒你"));
        boolean batteryOk = !batteryOptimizedAway(context);
        rows.add((batteryOk ? "✓ " : "✗ ") + "后台存活"
                + (batteryOk ? "：已忽略电池优化" : "：还在被电池优化管，锁屏后可能被系统杀掉"));
        rows.add((canScreenshot() ? "✓ " : "✗ ") + "截图"
                + (canScreenshot() ? "：系统支持" : "：这台手机系统太旧（要 Android 11 以上）"));
        rows.add((accessibilityOn(context) ? "✓ " : "✗ ") + "手势"
                + (accessibilityOn(context) ? "：能点按和滑动" : "：无障碍没开，手势发不出去"));
        rows.add("· 通道状态看上面「手机桥」那一行：它才是手机和电脑连没连上的判据。");
        return rows;
    }

    /** 打开自检对话框。三个按钮分别跳到系统里能改它的地方。 */
    static void show(Activity activity) {
        if (activity == null || activity.isFinishing()) return;
        // 顺手开一次 mDNS 扫描：自连 ADB 的第一层就是"知道往哪儿连"（2026-11-15）。
        AdbDiscover.start(activity);
        StringBuilder text = new StringBuilder();
        for (String one : lines(activity)) text.append(one).append("\n\n");
        // 自连通道现在到底通不通：与设置页「手机终端」那一行同一份判断（2026-11-15）。
        try {
            org.json.JSONObject backend = new org.json.JSONObject(
                    ShellBackend.backendState(activity));
            String kind = backend.optString("backend", "none");
            boolean paired = backend.optBoolean("paired", false);
            boolean ready = backend.optBoolean("adbReady", false);
            long probed = backend.optLong("lastProbeAt", 0);
            String when = probed == 0 ? "还没探过"
                    : ("上次确认：" + Math.max(0, (System.currentTimeMillis() - probed) / 1000) + " 秒前");
            if ("adb".equals(kind)) {
                text.append("自连通道：已配对且可用（").append(when).append("）\n\n");
            } else if (paired) {
                text.append("自连通道：已配对，但此刻连不上（无线调试没开？），命令会退回 Termux。\n\n");
            } else {
                text.append("自连通道：还没配对（设置页可以配，配一次以后不用装 Termux）。\n\n");
            }
        } catch (Exception ignored) {
        }
        text.append(AdbDiscover.describe()).append("\n\n");
        new AlertDialog.Builder(activity)
                .setTitle("手机操控自检")
                .setMessage(text.toString().trim())
                .setPositiveButton("无障碍", (d, w) -> open(activity, "accessibility"))
                .setNeutralButton("通知", (d, w) -> open(activity, "notifications"))
                .setNegativeButton("关闭", null)
                .show();
    }

    /** 跳到某个系统设置页；跳不过去就退到本 App 的详情页。 */
    static void open(Context context, String which) {
        try {
            Intent intent;
            if ("accessibility".equals(which)) {
                intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            } else if ("notifications".equals(which)) {
                intent = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                        .putExtra(Settings.EXTRA_APP_PACKAGE, context.getPackageName());
            } else if ("battery".equals(which)) {
                intent = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            } else {
                intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.parse("package:" + context.getPackageName()));
            }
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception err) {
            try {
                context.startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS)
                        .setData(Uri.parse("package:" + context.getPackageName()))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            } catch (Exception ignored) {
                // 打不开就只能作罢，对话框里已经写清了该怎么改。
            }
        }
    }
}
