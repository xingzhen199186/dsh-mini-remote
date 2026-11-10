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

    static final String ACTION_CLIPBOARD = "com.dsh.miniremote.action.CLIPBOARD";

    /**
     * 剪贴板确认（2026-11-09，`phone_set_clipboard`）。
     *
     * **每次都要用户点一下**：模型可能读到不可信内容，把转账地址或命令换掉，而用户
     * 粘贴时未必细看。所以这里不做"连续几次就不问"的省事做法。
     *
     * 正文只放摘要，够判断就行；完整内容由复制动作真正写入。
     */
    static void showClipboardAsk(Context context, String callId, String text, String baseUrl, String credential, long expiresAt) {
        Context appContext = context.getApplicationContext();
        Intent confirm = new Intent(appContext, ClipboardReceiver.class)
                .setAction(ACTION_CLIPBOARD)
                .putExtra("callId", callId)
                .putExtra("text", text)
                .putExtra("baseUrl", baseUrl)
                .putExtra("credential", credential)
                .putExtra("expiresAt", expiresAt);
        // 同一个 requestCode 若意外碰撞，宁可让旧动作失效，也不能把旧按钮换成新内容。
        int flags = PendingIntent.FLAG_CANCEL_CURRENT
                | (android.os.Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pending = PendingIntent.getBroadcast(appContext, callId.hashCode(), confirm, flags);
        Notification.Builder builder = baseBuilder(appContext, "clip:" + callId)
                .setContentTitle("电脑想复制以下全文（请展开核对）")
                .setContentText(text)
                .setStyle(new Notification.BigTextStyle().bigText(text))
                .addAction(new Notification.Action.Builder(null, "核对全文后复制", pending).build());
        manager(appContext).notify(notificationId("clip:" + callId), builder.build());
    }

    /** 点过就撤掉这条确认，免得同一张通知再被点第二次。 */
    static void cancelClipboardAsk(Context context, String callId) {
        if (callId == null || callId.isEmpty()) return;
        manager(context.getApplicationContext()).cancel(notificationId("clip:" + callId));
    }

    static final String WAKE_CHANNEL = "wake";

    /**
     * 全屏通知：把熄着的屏幕点亮，并把 App 带到前台（2026-11-10）。
     *
     * 这是安卓唯一"正规"的亮屏通道——闹钟、来电用的就是它。**不能解锁**，
     * 手机有锁屏密码时仍然停在锁屏上，这是系统的安全底线，不是我们没申请到权限。
     *
     * 安卓 14 起，非闹钟/通话类应用要用户手动允许全屏通知，否则只会是一条普通通知。
     */
    static void showWake(Context context, String text) {
        Context appContext = context.getApplicationContext();
        Intent open = new Intent(appContext, MainActivity.class)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP)
                .putExtra("wakeup", true);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (android.os.Build.VERSION.SDK_INT >= 23 ? PendingIntent.FLAG_IMMUTABLE : 0);
        PendingIntent pending = PendingIntent.getActivity(appContext, 7101, open, flags);

        NotificationManager mgr = manager(appContext);
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            NotificationChannel channel = new NotificationChannel(WAKE_CHANNEL, "唤醒手机",
                    NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("任务需要手机亮屏时使用");
            channel.setSound(null, null);
            mgr.createNotificationChannel(channel);
        }
        Notification.Builder builder = new Notification.Builder(appContext, WAKE_CHANNEL)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle("手机需要亮一下")
                .setContentText(text == null || text.isEmpty() ? "点开继续" : text)
                .setStyle(new Notification.BigTextStyle().bigText(text == null ? "点开继续" : text))
                .setContentIntent(pending)
                .setFullScreenIntent(pending, true)
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_ALARM);
        mgr.notify(notificationId("wake"), builder.build());
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
