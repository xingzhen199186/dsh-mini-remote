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
        capsule.setOnClickListener(v -> {
            wake();
            onStop.run();
        });

        WindowManager.LayoutParams next = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
                PixelFormat.TRANSLUCENT);
        next.gravity = Gravity.TOP | Gravity.END;
        next.x = dp(10);
        // 竖直放在屏幕中间偏下（2026-11-10 用户反馈）：原来 y=160dp 正好压住
        // 设置页里「手机关/屏幕操作」那几行的按钮，看着像页面上长了个红疙瘩。
        // 屏幕右侧偏下：竖直落在下方那段（约 2/3 处），从下往上看是"靠右下"的位置
        //（2026-11-10 用户第三次定位：右上/中间都压内容，右侧偏下最不容易挡）。
        next.y = Math.round(service.getResources().getDisplayMetrics().heightPixels * 2f / 3f);
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
                        wake();
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
            wake();
        } catch (Exception err) {
            // 浮层只是停止的另一种入口；画不出来也不能影响原来的桥。
            android.util.Log.w("MiniBridge", "停止胶囊显示失败：" + err.getMessage());
            view = null;
            params = null;
        }
    }

    private static final long IDLE_MS = 2500L;
    private final android.os.Handler idleHandler =
            new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable fadeOut = () -> {
        if (view != null) view.setAlpha(0.55f);
    };

    /** 碰一下就恢复不透明，之后重新计时。看得见，但不抢眼。 */
    private void wake() {
        idleHandler.removeCallbacks(fadeOut);
        if (view != null) view.setAlpha(1f);
        idleHandler.postDelayed(fadeOut, IDLE_MS);
    }

    /** 所有生命周期出口都走这里；重复移除也必须安全。 */
    void dismiss() {
        idleHandler.removeCallbacks(fadeOut);
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
