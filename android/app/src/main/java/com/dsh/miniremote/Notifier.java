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
                .setContentText(text.isEmpty() ? "可以回到会话里看结果了。" : text)
                .setStyle(new Notification.BigTextStyle()
                        .bigText(text.isEmpty() ? "可以回到会话里看结果了。" : text));
        manager(appContext).notify(notificationId("done"), builder.build());
    }

    /**
     * 锁屏时电脑要操作手机：只发一条**不含内容**的提醒（2026-11-10）。
     *
     * 不写是什么动作、不写目标——锁屏通知会在通知栏和息屏界面露出文字，谁站在旁边都能看见。
     * 这里也不尝试亮屏或解锁，让用户自己决定要不要看。
     */
    static void showConfirmHint(Context context) {
        Context appContext = context.getApplicationContext();
        Notification.Builder builder = baseBuilder(appContext, "confirm-hint")
                .setContentTitle("电脑想操作手机，需要你确认")
                .setContentText("解锁后打开这个提醒即可看到。");
        manager(appContext).notify(notificationId("confirm-hint"), builder.build());
    }

    /** 确认通知的渠道：要能横幅弹出，否则用户根本不知道有东西在等他。 */
    private static final String CONFIRM_CHANNEL_ID = "mini_confirm_v2";
    static final String ACTION_CONFIRM = "com.dsh.miniremote.CONFIRM";
    static final String EXTRA_CONFIRM_CARD = "confirmCardId";
    static final String EXTRA_CONFIRM_DECISION = "confirmDecision";
    static final String DECISION_ALLOW = "allow";
    static final String DECISION_DENY = "deny";
    static final String DECISION_ALLOW_TASK = "allowTask";

    /**
     * 能不能发通知。关掉了就必须立刻失败——不能让人干等 90 秒才等来一个超时。
     */
    static boolean canPostConfirm(Context context) {
        try {
            NotificationManager mgr = manager(context.getApplicationContext());
            if (mgr == null) return false;
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return true;
            if (!mgr.areNotificationsEnabled()) return false;
            // 渠道级别只影响"是否横幅"，不影响"能不能发"。这里不再拿它当失败条件
            //（2026-11-11 真机：用户明明开着通知，却因为旧渠道被系统降级而误判成"发不出去"）。
            return true;
        } catch (Exception err) {
            return false;
        }
    }

    /**
     * 电脑要操作手机：确认卡做成通知（2026-11-11）。
     *
     * 为什么不再是浮层：荣耀系统层不允许无障碍浮层接收触摸（日志里有
     * `AppOps: op=CREATE_ACCESSIBILITY_OVERLAY`），按钮画得出来但点不动。
     * 通知上的按钮由系统绘制、由系统派发点击，绕开了这条限制。
     *
     * 返回 false 表示通知没发出去（权限被关），调用方必须据此如实失败。
     */
    /**
     * 每张卡一个随机 action，配套一个**只在这道题活着期间存在**的私有接收器。
     *
     * 照 DSH Go 的做法：旧通知上的按钮命中不了新的提问；接收器用
     * RECEIVER_NOT_EXPORTED 注册，别的应用发不进来，系统派发的按钮点击照常能到
     *（PendingIntent 以我们的身份执行）。
     */
    private static final java.util.Map<String, android.content.BroadcastReceiver> GATES =
            new java.util.HashMap<>();
    private static final java.util.Map<String, String> GATE_ACTIONS = new java.util.HashMap<>();

    private static String openGate(Context app, final String cardId) {
        final String action = app.getPackageName() + ".MINI_CONFIRM."
                + java.util.UUID.randomUUID().toString().replace("-", "").substring(0, 16);
        android.content.BroadcastReceiver receiver = new android.content.BroadcastReceiver() {
            @Override
            public void onReceive(Context context, android.content.Intent intent) {
                if (intent == null) return;
                String decision = intent.getStringExtra(EXTRA_CONFIRM_DECISION);
                if (decision == null) return;
                // 只做一次比对和一次唤醒；answerCard 内部自己 post 主线程，接收器立刻返回。
                ConfirmationControl.answerCard(cardId,
                        !DECISION_DENY.equals(decision),
                        DECISION_ALLOW_TASK.equals(decision));
            }
        };
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            app.registerReceiver(receiver, new android.content.IntentFilter(action),
                    Context.RECEIVER_NOT_EXPORTED);
        } else {
            app.registerReceiver(receiver, new android.content.IntentFilter(action));
        }
        GATES.put(cardId, receiver);
        GATE_ACTIONS.put(cardId, action);
        return action;
    }

    private static void closeGate(Context app, String cardId) {
        android.content.BroadcastReceiver receiver = GATES.remove(cardId);
        GATE_ACTIONS.remove(cardId);
        if (receiver == null) return;
        try {
            app.unregisterReceiver(receiver);
        } catch (Exception ignored) {
            // 已经注销过：不值得为它报错。
        }
    }

    static boolean showConfirmCard(Context context, ConfirmationControl.Card card) {
        // 这台机型上确认功能已停用（浮层收不到触摸、通知按钮无响应），
        // 不再创建确认通知；状态机那边也不会调到这里。
        if (!ConfirmationControl.SUPPORTED) return false;
        Context appContext = context.getApplicationContext();
        try {
            NotificationManager mgr = manager(appContext);
            if (mgr == null) return false;
            // 先确认"这条通知真能弹出"：总开关、渠道是否有、重要级别够不够。
            // 不可用就立刻返回 false，让调用方如实失败——而不是挂满超时（DSH Go 的做法）。
            if (!canPostConfirm(appContext)) return false;
            createConfirmChannel(appContext);
            if (!canPostConfirm(appContext)) return false;
            String gateAction = openGate(appContext, card.id);
            Notification.Builder builder = new Notification.Builder(appContext, CONFIRM_CHANNEL_ID)
                    .setSmallIcon(R.drawable.ic_notify)
                    .setLargeIcon(android.graphics.BitmapFactory.decodeResource(
                            appContext.getResources(), R.mipmap.ic_launcher))
                    .setContentTitle("电脑想操作你的手机")
                    .setContentText(card.actionText())
                    .setStyle(new Notification.BigTextStyle().bigText(card.bodyText()))
                    .setCategory(Notification.CATEGORY_ALARM)
                    .setPriority(Notification.PRIORITY_HIGH)
                    .setVisibility(Notification.VISIBILITY_PRIVATE)
                    // 不自动消失：它代表一件还没决定的事，撤不撤由状态机说了算。
                    .setAutoCancel(false)
                    .setOngoing(false);
            if (ConfirmationState.TASK.equals(card.mode)) {
                builder.addAction(gateAction(appContext, gateAction, "允许本任务", DECISION_ALLOW_TASK, 1));
            }
            builder.addAction(gateAction(appContext, gateAction, "拒绝", DECISION_DENY, 2));
            builder.addAction(gateAction(appContext, gateAction, "允许", DECISION_ALLOW, 3));
            // 划掉通知 = 拒绝：系统会把"被划掉"当成一次回答，不用自己盯着。
            builder.setDeleteIntent(gateIntent(appContext, gateAction, DECISION_DENY, 7));
            long left = card.deadline - System.currentTimeMillis();
            if (android.os.Build.VERSION.SDK_INT >= 26 && left > 0) {
                // 到点由系统撤掉：进程被冻住也不影响它按时消失。
                builder.setTimeoutAfter(left);
            }
            mgr.notify(confirmNotificationId(card.id), builder.build());
            return true;
        } catch (Exception err) {
            android.util.Log.w("MiniBridge", "确认通知发不出来：" + err.getMessage());
            return false;
        }
    }

    /** 允许、拒绝、超时、停止——所有终局都要撤掉这条通知，别留一条已经作废的提醒。 */
    static void cancelConfirmCard(Context context, String cardId) {
        if (context == null || cardId == null) return;
        try {
            Context app = context.getApplicationContext();
            closeGate(app, cardId);
            NotificationManager mgr = manager(app);
            if (mgr == null) return;
            mgr.cancel(confirmNotificationId(cardId));
        } catch (Exception ignored) {
            // 撤不掉不影响动作结果；下一次确认会用新的编号。
        }
    }

    /** 按钮与"划掉"共用同一个私有 action，只是 decision 不同。 */
    private static PendingIntent gateIntent(Context context, String action, String decision, int code) {
        Intent intent = new Intent(action)
                .setPackage(context.getPackageName())
                .putExtra(EXTRA_CONFIRM_DECISION, decision);
        return PendingIntent.getBroadcast(context, action.hashCode() * 8 + code, intent,
                pendingIntentFlags());
    }

    private static Notification.Action gateAction(Context context, String action,
                                                  String label, String decision, int code) {
        return new Notification.Action.Builder(null, label,
                gateIntent(context, action, decision, code)).build();
    }

    private static int confirmNotificationId(String cardId) {
        return 0x4d530000 ^ (cardId == null ? 0 : cardId.hashCode());
    }

    /** 说清是哪一项挡住了确认通知——一句笼统的"没允许发通知"会让人查错方向。 */
    static String confirmUnavailableReason(Context context) {
        try {
            NotificationManager mgr = manager(context);
            if (mgr == null) return "系统通知服务不可用，确认卡显示不出来，动作未执行";
            if (!mgr.areNotificationsEnabled()) {
                return "这台手机把本应用的通知关掉了，确认卡显示不出来，动作未执行（设置 → 应用 → DSH Everywhere → 通知）";
            }
            return "确认通知发送失败（系统限制），动作未执行";
        } catch (Exception err) {
            return "确认通知发送失败：" + err.getMessage() + "，动作未执行";
        }
    }

    private static void createConfirmChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager mgr = manager(context);
        if (mgr == null || mgr.getNotificationChannel(CONFIRM_CHANNEL_ID) != null) return;
        NotificationChannel channel = new NotificationChannel(
                CONFIRM_CHANNEL_ID, "确认电脑操作", NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("电脑要操作这台手机时，在这里点允许或拒绝。");
        channel.setSound(null, null);
        channel.enableVibration(false);
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        mgr.createNotificationChannel(channel);
    }

    /** 卡已经结束（答了或超时）时把锁屏提示一起撤掉，别让通知栏留一条已经作废的提醒。 */
    static void cancelConfirmHint(Context context) {
        try {
            manager(context.getApplicationContext()).cancel(notificationId("confirm-hint"));
        } catch (Exception ignored) {
            // 通知服务不可用时撤不掉也不影响动作结果。
        }
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
    /**
     * 本机到底允不允许"全屏通知"（2026-11-10）。
     *
     * 安卓 14 起，权限写着 granted 也可能被判成"没资格"——真正的判据是这个查询。
     * 之前不看它就报"已发全屏通知"，属于老毛病：报告成功、实际没发生。
     */
    static boolean canWakeScreen(Context context) {
        if (android.os.Build.VERSION.SDK_INT < 34) {
            return true; // 低版本没有这道限制
        }
        try {
            NotificationManager mgr = manager(context);
            return mgr != null && mgr.canUseFullScreenIntent();
        } catch (Exception err) {
            return false;
        }
    }

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
