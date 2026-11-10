package com.dsh.miniremote;

import android.accessibilityservice.AccessibilityService;
import android.content.Context;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.TextView;

/**
 * 无障碍通道里的停止胶囊。
 *
 * 这个类只拥有 View 的显示、拖动和移除；授权真假由 BridgeControl 决定。
 * 这样服务销毁时只需撤掉 View，不会顺便改坏桥的授权状态。
 */
final class StopOverlay {
    private final AccessibilityService service;
    private final Runnable onStop;
    private final WindowManager windowManager;
    private TextView view;
    private WindowManager.LayoutParams params;

    StopOverlay(AccessibilityService service, Runnable onStop) {
        this.service = service;
        this.onStop = onStop;
        this.windowManager = (WindowManager) service.getSystemService(Context.WINDOW_SERVICE);
    }

    void show() {
        if (view != null || windowManager == null) return;
        final int touchSlop = ViewConfiguration.get(service).getScaledTouchSlop();
        TextView capsule = new TextView(service);
        capsule.setText("停止");
        capsule.setContentDescription("停止手机桥");
        capsule.setTextColor(0xffffffff);
        capsule.setTextSize(14);
        capsule.setGravity(Gravity.CENTER);
        capsule.setMinWidth(dp(72));
        capsule.setMinHeight(dp(48));
        capsule.setPadding(dp(16), 0, dp(16), 0);
        capsule.setClickable(true);
        capsule.setFocusable(true);
        GradientDrawable background = new GradientDrawable();
        background.setColor(0xccb42318);
        background.setCornerRadius(dp(48));
        capsule.setBackground(background);
        capsule.setOnClickListener(v -> onStop.run());

        WindowManager.LayoutParams next = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        next.gravity = Gravity.TOP | Gravity.END;
        next.x = dp(16);
        next.y = dp(160);
        capsule.setOnTouchListener(new View.OnTouchListener() {
            float downX;
            float downY;
            int startX;
            int startY;
            boolean dragged;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                if (params == null) return false;
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = event.getRawX();
                        downY = event.getRawY();
                        startX = params.x;
                        startY = params.y;
                        dragged = false;
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        int dx = Math.round(event.getRawX() - downX);
                        int dy = Math.round(event.getRawY() - downY);
                        if (!dragged && Math.abs(dx) <= touchSlop && Math.abs(dy) <= touchSlop) {
                            return true;
                        }
                        dragged = true;
                        move(startX - dx, startY + dy);
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (dragged) snapToEdge(); else v.performClick();
                        return true;
                    case MotionEvent.ACTION_CANCEL:
                        dragged = false;
                        return true;
                    default:
                        return false;
                }
            }
        });
        try {
            windowManager.addView(capsule, next);
            view = capsule;
            params = next;
        } catch (Exception err) {
            // 浮层只是停止的另一种入口；画不出来也不能影响原来的桥。
            android.util.Log.w("MiniBridge", "停止胶囊显示失败：" + err.getMessage());
            view = null;
            params = null;
        }
    }

    /** 所有生命周期出口都走这里；重复移除也必须安全。 */
    void dismiss() {
        TextView current = view;
        view = null;
        params = null;
        if (current == null || windowManager == null) return;
        current.setOnTouchListener(null);
        current.setOnClickListener(null);
        try {
            windowManager.removeViewImmediate(current);
        } catch (Exception ignored) {
            // 系统已先一步移除时，不需要把服务销毁变成一次崩溃。
        }
    }

    /** END 重力下 x 是距右边的距离；先限制活动范围，松手再贴到较近的一边。 */
    private void move(int x, int y) {
        int maxX = Math.max(0, service.getResources().getDisplayMetrics().widthPixels - view.getWidth());
        int maxY = Math.max(0, service.getResources().getDisplayMetrics().heightPixels - view.getHeight());
        params.x = Math.max(0, Math.min(maxX, x));
        params.y = Math.max(0, Math.min(maxY, y));
        update();
    }

    private void snapToEdge() {
        int maxX = Math.max(0, service.getResources().getDisplayMetrics().widthPixels - view.getWidth());
        params.x = params.x * 2 > maxX ? maxX : 0;
        update();
    }

    private void update() {
        if (view == null || params == null) return;
        try {
            windowManager.updateViewLayout(view, params);
        } catch (Exception ignored) {
            // 撤权可能刚好移除了 View；后续同步会负责最终状态。
        }
    }

    private int dp(int value) {
        return Math.round(value * service.getResources().getDisplayMetrics().density);
    }
}
