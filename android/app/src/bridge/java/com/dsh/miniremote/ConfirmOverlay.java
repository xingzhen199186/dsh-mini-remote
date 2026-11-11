package com.dsh.miniremote;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.WindowManager;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 确认卡的**纯展示**浮层（2026-11-11 降级）。
 *
 * 原来这里有「允许／拒绝／允许本任务」三个按钮，真机（荣耀）上画得出来却完全收不到触摸：
 * 系统层不允许无障碍浮层接收点击（日志里有 `AppOps ... op=CREATE_ACCESSIBILITY_OVERLAY`）。
 * 改窗口焦点参数救不回来，所以确认入口整体挪到了通知，按钮由系统绘制、由系统派发点击。
 *
 * 这个浮层留下来只做一件事：让用户**看见**有东西在等确认。它不放按钮、
 * 不接收点击，因此系统允不允许它收触摸都无所谓；真正的决定在通知上按。
 */
final class ConfirmOverlay {
    private final AccessibilityService service;
    private final WindowManager windowManager;
    private LinearLayout view;
    private WindowManager.LayoutParams params;

    ConfirmOverlay(AccessibilityService service) {
        this.service = service;
        this.windowManager = (WindowManager) service.getSystemService(Context.WINDOW_SERVICE);
    }

    /** 只写动作和打码后的目标；不摆输入正文、不摆截图，也不放按钮。 */
    void show(ConfirmationControl.Card card) {
        dismiss();
        if (windowManager == null) return;
        LinearLayout box = new LinearLayout(service);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(18), dp(16), dp(18), dp(16));
        GradientDrawable background = new GradientDrawable();
        background.setColor(0xf2ffffff);
        background.setCornerRadius(dp(16));
        box.setBackground(background);

        TextView title = new TextView(service);
        title.setText("电脑想操作你的手机");
        title.setTextSize(16);
        title.setTextColor(0xff1f2328);
        box.addView(title);

        TextView detail = new TextView(service);
        detail.setText(card.actionText()
                + (card.target == null || card.target.isEmpty() ? "" : "：" + card.target));
        detail.setTextSize(14);
        detail.setTextColor(0xff4a5058);
        detail.setPadding(0, dp(8), 0, dp(8));
        box.addView(detail);

        TextView how = new TextView(service);
        how.setText("请在通知栏点「允许」或「拒绝」。");
        how.setTextSize(13);
        how.setTextColor(0xff1f6feb);
        box.addView(how);

        // 倒计时让人看得见还剩多久；到点自己消失，不会一直挂在屏幕上。
        countdown = new TextView(service);
        countdown.setTextSize(13);
        countdown.setTextColor(0xff8a9099);
        countdown.setPadding(0, dp(6), 0, 0);
        box.addView(countdown);
        startCountdown(card.deadline);

        WindowManager.LayoutParams next = new WindowManager.LayoutParams(
                Math.min(dp(340), service.getResources().getDisplayMetrics().widthPixels - dp(32)),
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                // 只展示：既不抢焦点，也不吞触摸，底下的界面照常能用。
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        next.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        next.y = dp(96);
        try {
            windowManager.addView(box, next);
            view = box;
            params = next;
        } catch (Exception err) {
            // 展示不出来不影响确认：真正要决策的那条通知还在。
            android.util.Log.w("MiniBridge", "确认浮层显示失败：" + err.getMessage());
            view = null;
            params = null;
        }
    }

    private TextView countdown;
    private long deadlineAt;
    private final android.os.Handler ticker = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (view == null || countdown == null) return;
            long left = deadlineAt - System.currentTimeMillis();
            if (left <= 0) {
                // 到点自己消失；真正的失败结果由 ConfirmationControl 结算后回给电脑。
                dismiss();
                return;
            }
            countdown.setText("还剩 " + ((left + 999) / 1000) + " 秒");
            ticker.postDelayed(this, 250);
        }
    };

    private void startCountdown(long deadline) {
        deadlineAt = deadline;
        ticker.removeCallbacks(tick);
        ticker.post(tick);
    }

    /** 卡是否正摆在屏幕上；补摆时用它避免反复重建造成闪动。 */
    boolean isShowing() {
        return view != null;
    }

    private int dp(int value) {
        return Math.round(value * service.getResources().getDisplayMetrics().density);
    }

    /** 所有出口都走这里；重复撤卡也必须安全。 */
    void dismiss() {
        ticker.removeCallbacks(tick);
        countdown = null;
        LinearLayout current = view;
        view = null;
        params = null;
        if (current == null || windowManager == null) return;
        try {
            windowManager.removeViewImmediate(current);
        } catch (Exception ignored) {
            // 系统先一步移走时，不需要把服务销毁变成一次崩溃。
        }
    }
}
