package com.dsh.miniremote;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.GestureDescription;
import android.graphics.Bitmap;
import android.graphics.Path;
import android.os.Build;
import android.view.accessibility.AccessibilityEvent;

import java.io.File;
import java.io.FileOutputStream;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * P0 探针（2026-11-09）：只证明三件事能做成——**开启无障碍、截图、点一下**。
 *
 * 这一版**不含任何 AI 指令通道**，也不读界面内容、不点任何真实 App 的按钮。
 * 它存在的意义是回答一个产品问题：在这台手机上，"让机器点你的屏幕"到底要几步、
 * 用户愿不愿意走完。若这一步都写不成小白能照着做的引导，后面的工具集就不该做。
 *
 * 三条边界，现在就在代码里立着：
 *   · 只在 bridge 构建版本里存在（standard 版的清单根本不声明它）；
 *   · 截图与点击都**必须由用户在界面上主动点按钮**触发，没有任何远程入口；
 *   · 日志只记结果，不记画面内容。
 */
public final class BridgeAccessibilityService extends AccessibilityService {
    /** 运行中的实例；没开启无障碍时为 null。 */
    private static volatile BridgeAccessibilityService instance;

    static boolean isRunning() {
        return instance != null;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onDestroy() {
        if (instance == this) {
            instance = null;
        }
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // P0 不读界面内容：探针只需要能截图和点击。
    }

    @Override
    public void onInterrupt() {
        // 没有进行中的操作需要清理。
    }

    /**
     * 截一张图，存到缓存目录。返回存的路径；失败返回以 "错误：" 开头的说明。
     *
     * 用系统给的 takeScreenshot（Android 11+）：它由系统自己合成画面，不依赖我们
     * 去读别人的窗口，也就不会碰到"读取其他应用内容"那条红线。
     */
    static String takeShot(File dir) {
        BridgeAccessibilityService service = instance;
        if (service == null) {
            return "错误：无障碍还没开启";
        }
        if (Build.VERSION.SDK_INT < 30) {
            return "错误：系统版本太低（需要 Android 11 以上）";
        }
        final CountDownLatch latch = new CountDownLatch(1);
        final Bitmap[] result = new Bitmap[1];
        service.takeScreenshot(android.view.Display.DEFAULT_DISPLAY,
                service.getMainExecutor(),
                new TakeScreenshotCallback() {
                    @Override
                    public void onSuccess(ScreenshotResult screenshot) {
                        result[0] = Bitmap.wrapHardwareBuffer(screenshot.getHardwareBuffer(), screenshot.getColorSpace());
                        latch.countDown();
                    }

                    @Override
                    public void onFailure(int errorCode) {
                        latch.countDown();
                    }
                });
        try {
            if (!latch.await(3, TimeUnit.SECONDS)) {
                return "错误：截图超时";
            }
        } catch (InterruptedException err) {
            return "错误：截图被打断";
        }
        Bitmap bitmap = result[0];
        if (bitmap == null) {
            return "错误：这一屏不允许截图（安全窗口）";
        }
        try {
            if (!dir.exists() && !dir.mkdirs()) {
                return "错误：存图目录建不出来";
            }
            File out = new File(dir, "probe-shot.png");
            try (FileOutputStream os = new FileOutputStream(out)) {
                bitmap.compress(Bitmap.CompressFormat.PNG, 100, os);
            }
            return out.getAbsolutePath() + "|" + bitmap.getWidth() + "x" + bitmap.getHeight();
        } catch (Exception err) {
            return "错误：存图失败 " + err.getMessage();
        }
    }

    /**
     * 看一眼当前屏幕（P3 的第一个工具，2026-11-09）。
     *
     * 只读，不动任何东西。返回：前台包名、窗口标题、以及**可操作控件**的清单
     * （序号、文字、描述、位置）。给模型看的不是整棵控件树——那太长，而是"能点的那些"。
     *
     * **刻意不返回**：密码框的内容、输入框里已填的字（只报"这里能输入"）、
     * 以及任何看起来像敏感信息的东西。界面上有什么文字会如实返回，因为不返回就
     * 判断不了该点哪里；但输入框的**当前值**一律不读。
     */
    static String observe() {
        BridgeAccessibilityService service = instance;
        if (service == null) {
            return "{\"ok\":false,\"error\":\"无障碍还没开启\"}";
        }
        try {
            android.view.accessibility.AccessibilityNodeInfo root = service.getRootInActiveWindow();
            if (root == null) {
                return "{\"ok\":false,\"error\":\"这一屏读不到（可能锁屏或系统界面）\"}";
            }
            String pkg = root.getPackageName() == null ? "" : root.getPackageName().toString();
            org.json.JSONArray items = new org.json.JSONArray();
            java.util.ArrayList<android.view.accessibility.AccessibilityNodeInfo> queue = new java.util.ArrayList<>();
            queue.add(root);
            int index = 0;
            int visited = 0;
            while (!queue.isEmpty() && visited < 400 && index < 60) {
                android.view.accessibility.AccessibilityNodeInfo node = queue.remove(0);
                visited++;
                if (node == null) continue;
                boolean clickable = node.isClickable();
                boolean editable = node.isEditable();
                if (clickable || editable || node.isScrollable()) {
                    org.json.JSONObject item = new org.json.JSONObject();
                    item.put("i", index++);
                    item.put("t", node.getText() == null ? "" : node.getText().toString());
                    item.put("d", node.getContentDescription() == null ? "" : node.getContentDescription().toString());
                    android.graphics.Rect rect = new android.graphics.Rect();
                    node.getBoundsInScreen(rect);
                    item.put("b", rect.left + "," + rect.top + "," + rect.right + "," + rect.bottom);
                    if (editable) item.put("edit", true);
                    if (node.isScrollable()) item.put("scroll", true);
                    if (node.isCheckable()) item.put("checked", node.isChecked());
                    items.put(item);
                }
                for (int i = 0; i < node.getChildCount(); i++) {
                    queue.add(node.getChild(i));
                }
            }
            org.json.JSONObject out = new org.json.JSONObject();
            out.put("ok", true);
            out.put("pkg", pkg);
            out.put("locked", service.getSystemService(android.app.KeyguardManager.class) != null
                    && ((android.app.KeyguardManager) service.getSystemService(android.content.Context.KEYGUARD_SERVICE)).isKeyguardLocked());
            out.put("items", items);
            return out.toString();
        } catch (Exception err) {
            String message = String.valueOf(err.getMessage()).replace("\"", "'");
            return "{\"ok\":false,\"error\":\"" + message + "\"}";
        }
    }

    /** 在屏幕上点一下（坐标为屏幕像素）。用于证明"注入手势"这条路是通的。 */
    static String tap(float x, float y) {
        BridgeAccessibilityService service = instance;
        if (service == null) {
            return "错误：无障碍还没开启";
        }
        Path path = new Path();
        path.moveTo(x, y);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, 60))
                .build();
        final CountDownLatch latch = new CountDownLatch(1);
        final boolean[] done = new boolean[1];
        boolean dispatched = service.dispatchGesture(gesture, new GestureResultCallback() {
            @Override
            public void onCompleted(GestureDescription gestureDescription) {
                done[0] = true;
                latch.countDown();
            }

            @Override
            public void onCancelled(GestureDescription gestureDescription) {
                latch.countDown();
            }
        }, null);
        if (!dispatched) {
            return "错误：系统拒绝了这个手势";
        }
        try {
            if (!latch.await(3, TimeUnit.SECONDS)) {
                return "错误：手势没有回应";
            }
        } catch (InterruptedException err) {
            return "错误：等待被打断";
        }
        return done[0] ? "已点击 (" + Math.round(x) + ", " + Math.round(y) + ")" : "错误：手势被取消";
    }
}
