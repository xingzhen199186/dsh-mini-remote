package com.dsh.miniremote;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 确认卡：无障碍通道里的一张浮层，不申请悬浮窗权限。
 *
 * 这个类只管“把问题摆出来、把按钮点到的结果交回去”，是否该问、问完算不算数
 * 全部由 ConfirmationControl 决定。同屏只留一张卡，换卡前先撤旧的。
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

    /** 卡上只写动作和打码后的目标；不摆输入正文、不摆截图。 */
    void show(ConfirmationControl.Card card, ConfirmationControl.CardListener listener) {
        dismiss();
        if (windowManager == null) {
            listener.onCardClosed();
            return;
        }
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
        detail.setText(actionText(card) + "\n" + (card.target.isEmpty() ? "" : card.target)
                + "\n\n" + card.modeText());
        detail.setTextSize(14);
        detail.setTextColor(0xff4a5058);
        detail.setPadding(0, dp(8), 0, dp(12));
        box.addView(detail);

        LinearLayout buttons = new LinearLayout(service);
        buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.setGravity(Gravity.END);
        if (ConfirmationState.TASK.equals(card.mode)) {
            buttons.addView(button("允许本任务", () -> {
                ConfirmationControl.answer(true);
                listener.onCardClosed();
                dismiss();
            }));
        }
        buttons.addView(button("拒绝", () -> {
            ConfirmationControl.answer(false);
            listener.onCardClosed();
            dismiss();
        }));
        buttons.addView(button("允许", () -> {
            ConfirmationControl.answer(true);
            listener.onCardClosed();
            dismiss();
        }));
        box.addView(buttons);

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
            // 画不出来就必须让调用方失败，不能看起来像“问了但没答”。
            android.util.Log.w("MiniBridge", "确认卡显示失败：" + err.getMessage());
            view = null;
            params = null;
            listener.onCardClosed();
        }
    }

    private Button button(String label, Runnable tap) {
        Button button = new Button(service);
        button.setText(label);
        // 48dp 是最小可点面积；按钮文字短，靠这里保证手指够得着。
        button.setMinHeight(dp(48));
        button.setMinWidth(dp(96));
        button.setOnClickListener(v -> tap.run());
        return button;
    }

    private String actionText(ConfirmationControl.Card card) {
        switch (card.tool) {
            case "phone_tap": return "点一下屏幕上这个控件";
            case "phone_open": return "打开一个 App";
            case "phone_notify": return "发一条通知";
            case "phone_swipe": return "滑动屏幕";
            case "phone_back": return "按返回键";
            case "phone_input": return "往输入框里填字";
            case "phone_screenshot": return "截一张屏";
            case "phone_observe": return "读一次屏幕文字";
            case "phone_wake": return "点亮屏幕";
            case "phone_send_file": return "把一个文件存到手机";
            default: return "执行 " + card.tool;
        }
    }

    private int dp(int value) {
        return Math.round(value * service.getResources().getDisplayMetrics().density);
    }

    /** 所有出口都走这里；重复撤卡也必须安全。 */
    void dismiss() {
        LinearLayout current = view;
        view = null;
        params = null;
        if (current == null || windowManager == null) return;
        for (int i = 0; i < current.getChildCount(); i++) {
            View child = current.getChildAt(i);
            if (child instanceof LinearLayout) {
                LinearLayout row = (LinearLayout) child;
                for (int j = 0; j < row.getChildCount(); j++) {
                    row.getChildAt(j).setOnClickListener(null);
                }
            }
        }
        try {
            windowManager.removeViewImmediate(current);
        } catch (Exception ignored) {
            // 系统先一步移走时，不需要把服务销毁变成一次崩溃。
        }
    }
}
