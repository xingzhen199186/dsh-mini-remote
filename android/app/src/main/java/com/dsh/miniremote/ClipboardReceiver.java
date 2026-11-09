package com.dsh.miniremote;

/**
 * 「复制到剪贴板」那一下（2026-11-09，P2 的最后一个工具）。
 *
 * 只有在用户**主动点通知上的按钮**之后才走到这里——这是整套手机桥里唯一一个
 * 需要用户逐次确认的动作，因为它动的是剪贴板：模型读到不可信内容后，可能把转账
 * 地址或命令替换成别人的，而用户粘贴时未必细看。
 *
 * 2026-11-09 安全复核补的三道：
 *   1. 点击时先确认**当前仍被授权**（本机开关 + 向电脑核验一次），撤权后旧通知不作数；
 *   2. 同一个确认在本进程里只能消费一次；重复点击直接拒绝；
 *   3. 字段不全、已过期一律不写，写失败也不自动重放。
 */
public final class ClipboardReceiver extends android.content.BroadcastReceiver {
    /** 同一个确认在本进程里只能消费一次；失败也不自动重放写操作。 */
    private static final java.util.Set<String> consumed = new java.util.HashSet<>();

    @Override
    public void onReceive(android.content.Context context, android.content.Intent intent) {
        if (intent == null || !Notifier.ACTION_CLIPBOARD.equals(intent.getAction())) {
            return;
        }
        final String callId = intent.getStringExtra("callId");
        final String text = intent.getStringExtra("text");
        final String baseUrl = intent.getStringExtra("baseUrl");
        final String credential = intent.getStringExtra("credential");
        final long expiresAt = intent.getLongExtra("expiresAt", 0);
        if (callId == null || callId.isEmpty()) return;
        synchronized (consumed) {
            if (!consumed.add(callId)) {
                android.util.Log.w("MiniBridge", "重复的剪贴板确认已拒绝");
                return;
            }
        }
        final android.content.Context app = context.getApplicationContext();
        final PendingResult pending = goAsync();
        new Thread(() -> {
            boolean ok = false;
            String message;
            try {
                if (text == null || baseUrl == null || baseUrl.isEmpty()
                        || credential == null || credential.isEmpty()) {
                    message = "确认信息不完整，已拒绝复制";
                } else if (expiresAt <= System.currentTimeMillis()) {
                    message = "这条复制确认已经过期，请让电脑重新发送";
                } else if (!armedLocally(app)) {
                    message = "手机桥已经关闭，这条复制确认作废";
                } else if (!armedOnComputer(baseUrl, credential)) {
                    message = "电脑端已经没有授权，这条复制确认作废";
                } else {
                    android.content.ClipboardManager clipboard = (android.content.ClipboardManager)
                            app.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
                    if (clipboard == null) {
                        message = "系统没有提供剪贴板服务";
                    } else {
                        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("DSH", text));
                        ok = true;
                        message = "已复制到剪贴板";
                    }
                }
            } catch (Exception err) {
                message = "复制失败：" + err.getMessage();
            } finally {
                pending.finish();
                // 点过就撤掉这张确认，减少被重复点击的机会；进程内去重是第二道。
                Notifier.cancelClipboardAsk(app, callId);
            }
            BridgePoller.reportStatic(baseUrl, credential, callId, ok, message);
            Notifier.showFromComputer(app, ok ? "已复制" : "复制失败", message);
        }, "mini-clipboard").start();
    }

    private static boolean armedLocally(android.content.Context context) {
        return context.getSharedPreferences("mini_ui_prefs", android.content.Context.MODE_PRIVATE)
                .getBoolean("mini_bridge_armed", false);
    }

    /** 向电脑核验当前授权；连不上就当作没有授权（fail-closed）。 */
    private static boolean armedOnComputer(String baseUrl, String credential) {
        try {
            Net.Response response = Net.get(baseUrl + "/mini/api/bridge/verify", credential);
            if (!response.isSuccess() || response.body == null) return false;
            org.json.JSONObject root = new org.json.JSONObject(response.body);
            return root.optBoolean("ok", false) && root.optBoolean("armed", false);
        } catch (Exception err) {
            android.util.Log.w("MiniBridge", "剪贴板写入前的授权核验失败", err);
            return false;
        }
    }
}
