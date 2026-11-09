package com.dsh.miniremote;

/**
 * 「复制到剪贴板」那一下（2026-11-09，P2 的最后一个工具）。
 *
 * 只有在用户**主动点通知上的按钮**之后才走到这里——这是整套手机桥里唯一一个
 * 需要用户逐次确认的动作，因为它动的是剪贴板：模型读到不可信内容后，可能把转账
 * 地址或命令替换成别人的，而用户粘贴时未必细看。
 */
public final class ClipboardReceiver extends android.content.BroadcastReceiver {
    @Override
    public void onReceive(android.content.Context context, android.content.Intent intent) {
        if (intent == null || !Notifier.ACTION_CLIPBOARD.equals(intent.getAction())) {
            return;
        }
        String callId = intent.getStringExtra("callId");
        String text = intent.getStringExtra("text");
        String baseUrl = intent.getStringExtra("baseUrl");
        String credential = intent.getStringExtra("credential");
        boolean ok = false;
        String message = "没拿到要复制的文字";
        try {
            android.content.ClipboardManager clipboard = (android.content.ClipboardManager)
                    context.getSystemService(android.content.Context.CLIPBOARD_SERVICE);
            if (clipboard != null && text != null) {
                clipboard.setPrimaryClip(android.content.ClipData.newPlainText("DSH", text));
                ok = true;
                message = "已复制到剪贴板";
            }
        } catch (Exception err) {
            message = "复制失败：" + err.getMessage();
        }
        BridgePoller.reportStatic(baseUrl, credential, callId, ok, message);
        Notifier.showFromComputer(context, ok ? "已复制" : "复制失败", message);
    }
}
