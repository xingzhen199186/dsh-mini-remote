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
    /** 前台服务那条常驻通知：要显眼到系统不会杀，又不能吵人，所以单开一个低优先级渠道。 */
    private static final String SERVICE_CHANNEL_ID = "mini_service";

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
        return builder.setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle(title)
                .setContentText(text)
                .setContentIntent(contentIntent)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setPriority(Notification.PRIORITY_LOW)
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

    private static Notification.Builder baseBuilder(Context context, String approvalId) {
        createChannel(context);
        Intent open = new Intent(context, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(context,
                approvalId.hashCode(), open, pendingIntentFlags());
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL_ID) : new Notification.Builder(context);
        return builder.setSmallIcon(android.R.drawable.ic_dialog_info)
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
        if (mgr.getNotificationChannel(SERVICE_CHANNEL_ID) != null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(SERVICE_CHANNEL_ID, "任务提醒", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("任务进行期间保持连接，锁屏也能收到提醒。");
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
