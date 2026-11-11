package com.dsh.miniremote;

/**
 * 确认通知上的按钮（2026-11-11）。
 *
 * 为什么确认要挪到通知：荣耀系统层不允许无障碍浮层接收触摸
 * （日志里是 `AppOps ... op=CREATE_ACCESSIBILITY_OVERLAY`），浮层按钮画得出来却点不动。
 * 通知上的按钮由系统绘制、由系统派发点击，绕开这条限制。
 *
 * 这里**不重写一套判断**：收到点击就调 ConfirmationControl.answerCard，
 * 与浮层、停止、超时共用同一个状态机，谁点都一样，且只有第一次算数。
 */
public final class ConfirmActionReceiver extends android.content.BroadcastReceiver {
    @Override
    public void onReceive(android.content.Context context, android.content.Intent intent) {
        if (intent == null || !Notifier.ACTION_CONFIRM.equals(intent.getAction())) {
            return;
        }
        String cardId = intent.getStringExtra(Notifier.EXTRA_CONFIRM_CARD);
        String decision = intent.getStringExtra(Notifier.EXTRA_CONFIRM_DECISION);
        if (cardId == null || cardId.isEmpty() || decision == null) {
            return;
        }
        // 状态机只认当前这张卡：连点两次、点旧通知，第二次都会返回 false 而不会执行。
        boolean handled = ConfirmationControl.answerCard(
                cardId,
                !Notifier.DECISION_DENY.equals(decision),
                Notifier.DECISION_ALLOW_TASK.equals(decision));
        if (!handled) {
            android.util.Log.w("MiniBridge", "这条确认已经处理过或已过期，忽略");
        }
    }
}
