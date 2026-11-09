package com.dsh.miniremote;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** 待审批通知。后续推送接收器拿到 approvalId 与当前 base URL 后调用 showApproval。 */
public final class Notifier {
    static final String ACTION_APPROVE = "com.dsh.miniremote.action.APPROVE";
    static final String ACTION_REJECT = "com.dsh.miniremote.action.REJECT";
    static final String EXTRA_APPROVAL_ID = "approvalId";
    static final String EXTRA_BASE_URL = "baseUrl";

    private static final String CHANNEL_ID = "mini_approvals";
    /**
     * 前台服务那条常驻通知。安卓规定它必须存在，没法隐藏；那就把它压到最低存在感：
     * IMPORTANCE_MIN = 不占状态栏图标、不出横幅、不响，只折叠在通知栏的“其他通知”里
     * （2026-11-06 用户要求：有连接也别挂着显眼的通知）。
     */
    private static final String SERVICE_CHANNEL_ID = "mini_service_v2";
    /** 旧版渠道：用户可能已经手动调高过它的重要性，直接弃用。 */
    private static final String LEGACY_SERVICE_CHANNEL_ID = "mini_service";

    private Notifier() {
    }

    public static void showApproval(Context context, String baseUrl, String approvalId) {
        if (baseUrl == null || baseUrl.isEmpty() || approvalId == null || approvalId.isEmpty()) {
            throw new IllegalArgumentException("通知必须带审批 id 和服务器地址。");
        }
        Context appContext = context.getApplicationContext();
        Notification.Builder builder = baseBuilder(appContext, approvalId)
                .setContentTitle("DSH 有一项待审批")
                .setContentText("电脑端有一项操作等待你处理。")
                .addAction(0, "批准", actionIntent(appContext, baseUrl, approvalId, ACTION_APPROVE))
                .addAction(0, "拒绝", actionIntent(appContext, baseUrl, approvalId, ACTION_REJECT));
        manager(appContext).notify(notificationId(approvalId), builder.build());
    }

    /** 前台服务那条常驻通知（不可滑动清除，随服务结束消失）。 */
    static Notification serviceNotification(Context context, String title, String text) {
        createServiceChannel(context);
        Intent open = new Intent(context, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(context, 0x51, open, pendingIntentFlags());
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, SERVICE_CHANNEL_ID) : new Notification.Builder(context);
        return builder.setSmallIcon(R.drawable.ic_notify)
                .setLargeIcon(android.graphics.BitmapFactory.decodeResource(
                        context.getResources(), R.mipmap.ic_launcher))
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setPriority(Notification.PRIORITY_MIN)
                .build();
    }

    /** 一条普通提醒（没带操作按钮）：比如「有一道题等你回答」。 */
    static void showInfo(Context context, String title, String text, String tag) {
        Context appContext = context.getApplicationContext();
        Notification.Builder builder = baseBuilder(appContext, tag == null ? "info" : tag)
                .setContentTitle(title)
                .setContentText(text);
        manager(appContext).notify(notificationId(tag == null ? "info" : tag), builder.build());
    }

    static void showResult(Context context, String approvalId, String message) {
        Context appContext = context.getApplicationContext();
        Notification.Builder builder = baseBuilder(appContext, approvalId)
                .setContentTitle("DSH 审批结果")
                .setContentText(message)
                .setStyle(new Notification.BigTextStyle().bigText(message));
        manager(appContext).notify(notificationId(approvalId), builder.build());
    }

    /**
     * 后台连接反复失败：请用户回去检查电池设置（2026-11-06）。
     * 点通知会打开主界面并强制弹出那段引导，不再受“只提醒一次”的限制。
     */
    static void showBackgroundHint(Context context) {
        Context appContext = context.getApplicationContext();
        Intent open = new Intent(appContext, MainActivity.class);
        open.putExtra(MainActivity.EXTRA_BACKGROUND_HINT, true);
        PendingIntent contentIntent = PendingIntent.getActivity(appContext, 0x52, open, pendingIntentFlags());
        Notification.Builder builder = baseBuilder(appContext, "background-hint")
                .setContentTitle("DSH 后台连接被系统挂起")
                .setContentText("锁屏提醒可能收不到，点这里检查电池设置。")
                .setContentIntent(contentIntent);
        manager(appContext).notify(notificationId("background-hint"), builder.build());
    }

    /** 一次任务跑完了（只在前台服务里发，也就是应用在后台或锁屏时）。 */
    static void showDone(Context context, String detail) {
        Context appContext = context.getApplicationContext();
        String text = detail == null ? "" : detail.trim();
        Notification.Builder builder = baseBuilder(appContext, "done")
                .setContentTitle("DSH 任务完成")
                .setContentText(text.isEmpty() ? "可以回到电脑上看结果了。" : text)
                .setStyle(new Notification.BigTextStyle()
                        .bigText(text.isEmpty() ? "可以回到电脑上看结果了。" : text));
        manager(appContext).notify(notificationId("done"), builder.build());
    }

    /**
     * 电脑主动发来的一条通知（2026-11-09，`phone_notify`）。
     *
     * 和「任务完成」那条分开：标题要用**电脑给的那个**，不能一律写死成"DSH 任务完成"——
     * 真机上第一次跑就露馅了：模型明明给了「该喝水了」，通知栏却写着"DSH 任务完成"。
     */
    static void showFromComputer(Context context, String title, String body) {
        Context appContext = context.getApplicationContext();
        String heading = title == null ? "" : title.trim();
        String text = body == null ? "" : body.trim();
        Notification.Builder builder = baseBuilder(appContext, "done")
                .setContentTitle(heading.isEmpty() ? "来自电脑的消息" : heading)
                .setContentText(text.isEmpty() ? heading : text)
                .setStyle(new Notification.BigTextStyle().bigText(text.isEmpty() ? heading : text));
        manager(appContext).notify(notificationId("done"), builder.build());
    }

    private static Notification.Builder baseBuilder(Context context, String approvalId) {
        createChannel(context);
        Intent open = new Intent(context, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(context,
                approvalId.hashCode(), open, pendingIntentFlags());
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL_ID) : new Notification.Builder(context);
        return builder.setSmallIcon(R.drawable.ic_notify)
                // 小图标只能是单色剪影（系统会染色），所以在右侧再放一张彩色的应用图标，
                // 用户一眼能认出是谁发的（2026-11-08 用户要求用 App 图标）。
                .setLargeIcon(android.graphics.BitmapFactory.decodeResource(
                        context.getResources(), R.mipmap.ic_launcher))
                .setContentIntent(contentIntent)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_REMINDER)
                .setVisibility(Notification.VISIBILITY_PRIVATE)
                .setPriority(Notification.PRIORITY_HIGH);
    }

    private static PendingIntent actionIntent(Context context, String baseUrl,
                                               String approvalId, String action) {
        Intent intent = new Intent(context, ApprovalReceiver.class);
        intent.setAction(action);
        intent.putExtra(EXTRA_APPROVAL_ID, approvalId);
        intent.putExtra(EXTRA_BASE_URL, baseUrl);
        return PendingIntent.getBroadcast(context, (approvalId + action).hashCode(),
                intent, pendingIntentFlags());
    }

    private static int pendingIntentFlags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
    }

    private static int notificationId(String approvalId) {
        return 0x4d520000 ^ approvalId.hashCode();
    }

    private static NotificationManager manager(Context context) {
        return (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
    }

    private static void createServiceChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager mgr = manager(context);
        // 旧的 LOW 渠道先清掉：渠道的重要性一旦被用户改过就锁住，只能换一个新的。
        try {
            if (mgr.getNotificationChannel(LEGACY_SERVICE_CHANNEL_ID) != null) {
                mgr.deleteNotificationChannel(LEGACY_SERVICE_CHANNEL_ID);
            }
        } catch (Exception ignored) {
            // 删不掉也不影响用新渠道。
        }
        if (mgr.getNotificationChannel(SERVICE_CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                SERVICE_CHANNEL_ID, "后台任务连接", NotificationManager.IMPORTANCE_MIN);
        channel.setDescription("有任务在跑时才保持连接，锁屏也能收到提醒；平时不通知。");
        channel.setShowBadge(false);
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_SECRET);
        mgr.createNotificationChannel(channel);
    }

    private static void createChannel(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "待审批提醒", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("电脑端需要你批准或拒绝操作时显示提醒。");
            manager(context).createNotificationChannel(channel);
        }
    }
}
