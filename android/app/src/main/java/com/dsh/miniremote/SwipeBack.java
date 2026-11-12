package com.dsh.miniremote;

import android.app.Activity;
import android.content.Context;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.widget.FrameLayout;

/**
 * 边缘滑动返回（2026-11-12）。
 *
 * 只给 App 自己的子页面用（配对、连接配置、扫码）。**主页面不加**——
 * 主页面是网页，横向滑动是网页自己的手势，抢过来会打架。
 *
 * 规则：只有从**左边缘**（默认 24dp 内）起手、并且一开始是横着走的，才算返回手势；
 * 竖着划、从中间开始划，一律不管，交回给页面自己。
 */
final class SwipeBack extends FrameLayout {
    private static final int EDGE_DP = 24;

    private final int edgePx;
    private final int touchSlop;
    private final int minDistance;
    private float downX;
    private float downY;
    private boolean tracking;
    private boolean dragging;

    private SwipeBack(Context context) {
        super(context);
        edgePx = Math.round(EDGE_DP * getResources().getDisplayMetrics().density);
        touchSlop = ViewConfiguration.get(context).getScaledTouchSlop();
        minDistance = getResources().getDisplayMetrics().widthPixels / 4;
    }

    /** 把当前 Activity 的内容套进一层，之后就能边缘滑动返回。 */
    static void install(Activity activity) {
        try {
            View content = activity.findViewById(android.R.id.content);
            if (!(content instanceof ViewGroup)) return;
            ViewGroup host = (ViewGroup) content;
            if (host.getChildCount() != 1) return;
            View child = host.getChildAt(0);
            if (child instanceof SwipeBack) return;
            host.removeView(child);
            SwipeBack wrapper = new SwipeBack(activity);
            wrapper.addView(child, new LayoutParams(
                    LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
            host.addView(wrapper, new ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        } catch (Exception ignored) {
            // 加不上就算了，页面照常能用。
        }
    }

    @Override
    public boolean onInterceptTouchEvent(MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = event.getX();
                downY = event.getY();
                tracking = downX <= edgePx;
                dragging = false;
                return false;
            case MotionEvent.ACTION_MOVE:
                if (!tracking) return false;
                float dx = event.getX() - downX;
                float dy = event.getY() - downY;
                if (Math.abs(dy) > Math.abs(dx)) {
                    // 竖着划：不是返回手势，交回页面。
                    tracking = false;
                    return false;
                }
                if (dx > touchSlop) {
                    dragging = true;
                    return true;
                }
                return false;
            default:
                return false;
        }
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        if (!dragging) return super.onTouchEvent(event);
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_MOVE: {
                float dx = Math.max(0f, event.getX() - downX);
                if (getChildCount() > 0) getChildAt(0).setTranslationX(dx);
                return true;
            }
            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL: {
                float dx = Math.max(0f, event.getX() - downX);
                boolean finish = event.getActionMasked() == MotionEvent.ACTION_UP && dx > minDistance;
                View child = getChildCount() > 0 ? getChildAt(0) : null;
                if (child == null) return true;
                if (finish) {
                    int width = getWidth();
                    child.animate().translationX(width).setDuration(140)
                            .withEndAction(() -> {
                                Context context = getContext();
                                if (context instanceof Activity) ((Activity) context).finish();
                            })
                            .start();
                } else {
                    child.animate().translationX(0f).setDuration(140).start();
                }
                dragging = false;
                tracking = false;
                return true;
            }
            default:
                return true;
        }
    }
}
