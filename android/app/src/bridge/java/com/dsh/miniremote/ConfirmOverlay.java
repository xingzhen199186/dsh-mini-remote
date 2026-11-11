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

    /**
     * 确认卡（2026-11-11 重新恢复可点）。
     *
     * 之前"点不动"被我们误判成"系统禁止浮层触摸"。真正的差别在**接法**：
     * 停止胶囊用 TextView + onTouch 自己收 MotionEvent，能点；这里曾用 Button +
     * setOnClickListener 等系统派发，点不动。**改成和停止胶囊同一套**：按钮是
     * TextView，自己 onTouch，抬起时直接 answerCard，不走标准点击派发。
     */
    void show(final ConfirmationControl.Card card) {
        if (!ConfirmationControl.SUPPORTED) return;
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

        countdown = new TextView(service);
        countdown.setTextSize(13);
        countdown.setTextColor(0xff8a9099);
        countdown.setPadding(0, dp(6), 0, dp(6));
        box.addView(countdown);
        startCountdown(card.deadline);

        LinearLayout row = new LinearLayout(service);
        row.setOrientation(LinearLayout.HORIZONTAL);
        if (ConfirmationState.TASK.equals(card.mode)) {
            // 本任务档：拒绝 / 允许（允许即整轮免确认）
            row.addView(tapButton("拒绝", () ->
                    ConfirmationControl.answerCard(card.id, false, false)));
            row.addView(tapButton("允许", () ->
                    ConfirmationControl.answerCard(card.id, true, true)));
        } else {
            row.addView(tapButton("拒绝", () ->
                    ConfirmationControl.answerCard(card.id, false, false)));
            row.addView(tapButton("允许", () ->
                    ConfirmationControl.answerCard(card.id, true, false)));
        }
        box.addView(row);

        WindowManager.LayoutParams next = new WindowManager.LayoutParams(
                Math.min(dp(340), service.getResources().getDisplayMetrics().widthPixels - dp(32)),
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        next.gravity = Gravity.TOP | Gravity.CENTER_HORIZONTAL;
        next.y = dp(96);
        try {
            windowManager.addView(box, next);
            view = box;
            params = next;
        } catch (Exception err) {
            android.util.Log.w("MiniBridge", "确认浮层显示失败：" + err.getMessage());
            view = null;
            params = null;
        }
    }

    /** 和停止胶囊同一套：TextView + onTouch，抬起即答，不依赖 Button 的点击派发。 */
    private android.view.View tapButton(String label, final Runnable answer) {
        TextView b = new TextView(service);
        b.setText(label);
        b.setTextSize(14);
        b.setTextColor(0xff1f2328);
        b.setGravity(Gravity.CENTER);
        b.setMinHeight(dp(48));
        b.setMinWidth(dp(88));
        b.setPadding(dp(12), 0, dp(12), 0);
        b.setClickable(true);
        b.setFocusable(true);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xffe8ebef);
        bg.setCornerRadius(dp(10));
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        lp.setMargins(dp(4), dp(4), dp(4), dp(4));
        b.setLayoutParams(lp);
        b.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case android.view.MotionEvent.ACTION_DOWN:
                    v.setAlpha(0.7f);
                    return true;
                case android.view.MotionEvent.ACTION_UP:
                    v.setAlpha(1f);
                    // 直接在这里答，不调 performClick、不等系统派发。
                    answer.run();
                    return true;
                case android.view.MotionEvent.ACTION_CANCEL:
                    v.setAlpha(1f);
                    return true;
                default:
                    return true;
            }
        });
        return b;
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
