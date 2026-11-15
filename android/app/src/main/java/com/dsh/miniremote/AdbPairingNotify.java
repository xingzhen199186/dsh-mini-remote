package com.dsh.miniremote;

import android.app.PendingIntent;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * 「把 6 位配对码填在这里」——一条带输入框的通知（2026-11-15）。
 *
 * 为什么不做成 App 里的输入框：配对对话框**一离开就关**，端口随之消失。
 * 通知可以盖在系统设置之上，人**不用离开对话框**就能把码填给我们——
 * 这也是同类产品的做法。
 */
final class AdbPairingNotify {

    static final String CHANNEL = "adb-pairing";
    static final String EXTRA_TEXT = "code";
    static final int NOTICE_ID = 0x5ADB;
    static final String ACTION_CODE = "com.dsh.miniremote.PAIRING_CODE";

    private AdbPairingNotify() {
    }

    private static void ensureChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            android.util.Log.i("MiniBridge", "跳过建通道：系统太老");
            return;
        }
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            android.util.Log.w("MiniBridge", "拿不到通知管理器");
            return;
        }
        if (manager.getNotificationChannel(CHANNEL) != null) {
            android.util.Log.i("MiniBridge", "通道已存在");
            return;
        }
        try {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL, "配对码输入", NotificationManager.IMPORTANCE_HIGH);
            channel.setDescription("自连调试口时在这里填 6 位码，不用离开系统对话框");
            manager.createNotificationChannel(channel);
            android.util.Log.i("MiniBridge", "通道已建立");
        } catch (Exception err) {
            android.util.Log.w("MiniBridge", "建通道失败：" + err);
        }
    }

    static void show(Context context) {
        ensureChannel(context);
        Intent intent = new Intent(context, AdbPairingReceiver.class);
        intent.setAction(ACTION_CODE);
        PendingIntent pending = PendingIntent.getBroadcast(
                context, 1, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);

        android.app.RemoteInput remote = new android.app.RemoteInput.Builder(EXTRA_TEXT)
                .setLabel("6 位配对码")
                .build();
        android.graphics.drawable.Icon icon = android.graphics.drawable.Icon.createWithResource(
                context, android.R.drawable.stat_sys_data_bluetooth);
        Notification.Action action = new Notification.Action.Builder(
                icon, "填写配对码", pending).addRemoteInput(remote).build();

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL)
                : new Notification.Builder(context);
        builder.setContentTitle("填一下 6 位配对码")
                .setContentText("展开通知，点「填写配对码」；不用关掉系统里的配对对话框")
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_PROGRESS)
                .addAction(action);

        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null) manager.notify(NOTICE_ID, builder.build());
    }

    static void done(Context context, String text) {
        ensureChannel(context);
        NotificationManager manager =
                (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) return;
        if (text == null) {
            manager.cancel(NOTICE_ID);
            return;
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(context, CHANNEL)
                : new Notification.Builder(context);
        builder.setContentTitle("配对结果")
                .setContentText(text)
                .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
                .setAutoCancel(true);
        manager.notify(NOTICE_ID, builder.build());
    }
}
