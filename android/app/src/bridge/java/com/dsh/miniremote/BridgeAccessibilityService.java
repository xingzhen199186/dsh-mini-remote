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
    /** 浮层只在服务连接后创建，避免系统尚未 attach 时拿不到 WindowManager。 */
    private StopOverlay stopOverlay;
    private ConfirmOverlay confirmOverlay;
    /**
     * 锁屏时不亮屏、不解锁：卡片根本画不出来，只发一条不含内容的通知。
     * 30 秒仍照算——人没看到提示就当作没有回答。
     */
    private final ConfirmationControl.CardListener confirmListener = new ConfirmationControl.CardListener() {
        @Override
        public void onCard(ConfirmationControl.Card card) {
            boolean locked = false;
            try {
                android.app.KeyguardManager keyguard = (android.app.KeyguardManager)
                        getSystemService(android.content.Context.KEYGUARD_SERVICE);
                locked = keyguard != null && keyguard.isKeyguardLocked();
            } catch (Exception ignored) {
                // 读不到锁屏状态时按“没锁”处理，卡片照常显示。
            }
            if (locked) {
                Notifier.showConfirmHint(BridgeAccessibilityService.this);
                return;
            }
            // 解锁后窗口一变也补摆一次，不必非等到下一条系统广播。
            if (confirmOverlay != null) confirmOverlay.show(card, this);
        }

        @Override
        public void onCardClosed() {
            if (confirmOverlay != null) confirmOverlay.dismiss();
            Notifier.cancelConfirmHint(BridgeAccessibilityService.this);
        }
    };
    /** 当前前台是谁：用来判断"要不要在自己的界面上盖一个停止键"。 */
    private volatile String foregroundPackage;
    private final BridgeControl.ArmedListener stopOverlayListener = armed -> syncStopOverlay();
    private final android.os.Handler overlayHandler = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable syncOverlayTask = this::syncStopOverlay;
    private boolean screenReceiverRegistered;
    /** 不能只等窗口事件：部分 ROM 锁屏/解锁只发系统广播。 */
    private final android.content.BroadcastReceiver screenReceiver = new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(android.content.Context context, android.content.Intent intent) {
            syncStopOverlay();
            // 锁屏时只发了通知、没摆卡；解锁这一刻把仍在等的那张补出来，
            // 否则通知承诺的"解锁后能看到"就是一句空话，动作必然白等到超时。
            showPendingCardIfAny();
        }
    };

    /** 锁屏期间攒下的那张卡，在解锁后补摆出来；没有在等卡就什么都不做。 */
    private void showPendingCardIfAny() {
        ConfirmationControl.Card waiting = ConfirmationControl.currentCard();
        if (waiting == null || confirmOverlay == null || confirmOverlay.isShowing()) return;
        boolean locked;
        try {
            android.app.KeyguardManager keyguard = (android.app.KeyguardManager)
                    getSystemService(android.content.Context.KEYGUARD_SERVICE);
            locked = keyguard != null && keyguard.isKeyguardLocked();
        } catch (Exception err) {
            locked = false;
        }
        if (locked) return;
        confirmOverlay.show(waiting, confirmListener);
    }

    /** 解锁/锁屏与武装状态共用这一个判据；本方法不尝试亮屏或解锁。 */
    private void syncStopOverlay() {
        if (stopOverlay == null) return;
        android.app.KeyguardManager keyguard = (android.app.KeyguardManager)
                getSystemService(android.content.Context.KEYGUARD_SERVICE);
        android.os.PowerManager power = (android.os.PowerManager)
                getSystemService(android.content.Context.POWER_SERVICE);
        boolean locked = keyguard != null && keyguard.isKeyguardLocked();
        boolean screenOn = power == null || power.isInteractive();
        // 在我们自己的 App 里不显示（2026-11-10 用户反馈）：
        // 这里本来就有手机桥开关，浮层只会挡住「关闭」按钮。
        String front = foregroundPackage;
        try {
            android.view.accessibility.AccessibilityNodeInfo root = getRootInActiveWindow();
            if (root != null && root.getPackageName() != null) {
                front = root.getPackageName().toString();
                foregroundPackage = front;
            }
        } catch (Exception ignored) {
            // 读不到就用上一次记录的窗口，和原来一样。
        }
        // 在我们自己的 App 里不显示（2026-11-10 用户反馈）：
        // 这里本来就有手机桥开关，浮层只会挡住「关闭」按钮。
        boolean mine = getPackageName().equals(front);
        if (BridgeControl.isArmed(this) && !locked && screenOn && !mine) {
            stopOverlay.show();
        } else {
            stopOverlay.dismiss();
        }
    }

    /** 服务真正离开时同时丢掉 View 与监听器；重复调用也安全。 */
    private void discardStopOverlay() {
        overlayHandler.removeCallbacks(syncOverlayTask);
        if (screenReceiverRegistered) {
            try {
                unregisterReceiver(screenReceiver);
            } catch (Exception ignored) {
                // 系统已先拆掉接收器时，服务销毁不应因此崩溃。
            }
            screenReceiverRegistered = false;
        }
        BridgeControl.clearStopOverlayListener(stopOverlayListener);
        ConfirmationControl.clearCardListener(confirmListener);
        if (confirmOverlay != null) {
            confirmOverlay.dismiss();
            confirmOverlay = null;
        }
        if (stopOverlay != null) {
            stopOverlay.dismiss();
            stopOverlay = null;
        }
    }

    /** 上一次 observe 收集到的可点区域，顺序与返回给模型的序号一致。 */
    private static final java.util.List<android.graphics.Rect> lastTargets = new java.util.ArrayList<>();
    /** 与 lastTargets 同序的标签，用来在界面变了之后核对"还是不是同一个控件"。 */
    private static final java.util.List<String> lastLabels = new java.util.ArrayList<>();
    private static long lastObserveAt;
    private static int lastObserveGeneration;
    /** 界面代次：内容一变就 +1。序号与它绑定，界面变了旧序号立刻失效。 */
    private static volatile int uiGeneration;

    static boolean isRunning() {
        return instance != null;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
        stopOverlay = new StopOverlay(this,
                () -> BridgeControl.setArmed(this, false, null, null, null));
        BridgeControl.setStopOverlayListener(stopOverlayListener);
        confirmOverlay = new ConfirmOverlay(this);
        ConfirmationControl.setCardListener(confirmListener);
        android.content.IntentFilter filter = new android.content.IntentFilter();
        filter.addAction(android.content.Intent.ACTION_SCREEN_ON);
        filter.addAction(android.content.Intent.ACTION_SCREEN_OFF);
        filter.addAction(android.content.Intent.ACTION_USER_PRESENT);
        try {
            registerReceiver(screenReceiver, filter);
            screenReceiverRegistered = true;
        } catch (Exception err) {
            android.util.Log.w("MiniBridge", "亮屏/解锁监听注册失败：" + err.getMessage());
        }
        syncStopOverlay();
    }

    @Override
    public boolean onUnbind(android.content.Intent intent) {
        discardStopOverlay();
        if (instance == this) {
            instance = null;
        }
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        discardStopOverlay();
        if (instance == this) {
            instance = null;
        }
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // 只数代次，不读内容：界面一变（翻页、弹窗、列表滚动），
        // 之前观察到的"第 3 个"就不再是同一个东西（2026-11-10）。
        if (event == null) {
            return;
        }
        int type = event.getEventType();
        // 只认"窗口换了"。内容变化、滚动这类事件也可能来自我们自己在后台的界面，
        // 用它更新前台包，会让浮层以为"自家 App 在前台"而立刻把自己拆掉
        //（真机现象：胶囊只活 151 毫秒）。
        if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                && event.getPackageName() != null) {
            foregroundPackage = event.getPackageName().toString();
        }
        if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                || type == AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
                || type == AccessibilityEvent.TYPE_VIEW_SCROLLED) {
            uiGeneration++;
        }
        if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                || type == AccessibilityEvent.TYPE_WINDOWS_CHANGED) {
            syncStopOverlay();
            // 解锁或切回前台时也补摆一次，不依赖某一条广播一定到。
            showPendingCardIfAny();
        }
    }

    @Override
    public void onInterrupt() {
        // 中断不是撤权：先撤画面；若系统没有再发窗口事件，也在本机状态未变时恢复。
        if (stopOverlay != null) {
            stopOverlay.dismiss();
        }
        overlayHandler.removeCallbacks(syncOverlayTask);
        overlayHandler.postDelayed(syncOverlayTask, 500);
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
        String blocked = blockReason(service, service.getRootInActiveWindow());
        if (blocked != null) return "错误：" + blocked;
        // 检查与真正取图之间可能换屏：记下当时的前台包名，取完再核一次。
        final String checkedPkg = currentPackage(service);
        final CountDownLatch latch = new CountDownLatch(1);
        final Bitmap[] result = new Bitmap[1];
        final int[] failure = { -1 };
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
                        failure[0] = errorCode;
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
            if (Build.VERSION.SDK_INT >= 34
                    && failure[0] == AccessibilityService.ERROR_TAKE_SCREENSHOT_SECURE_WINDOW) {
                return "错误：这一屏不允许截图（安全窗口）";
            }
            return "错误：截图失败（系统错误码 " + failure[0] + "）";
        }
        if (!checkedPkg.equals(currentPackage(service))) {
            return "错误：检查之后屏幕换了，这张图作废";
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
     * 一个控件的"人话标签"：自己的文字，没有就往下找两层。
     *
     * 输入框**一律不读当前值**（那里面可能是密码、验证码、住址），只给占位提示。
     */
    private static String labelOf(android.view.accessibility.AccessibilityNodeInfo node) {
        try {
            // 先判身份，再接触任何文字：输入框与密码框连内容描述也不读。
            if (node.isEditable() || node.isPassword()) return "";
            CharSequence own = node.getText();
            if (own != null && own.length() > 0) {
                return node.isEditable() ? "" : own.toString();
            }
            StringBuilder sb = new StringBuilder();
            collectText(node, sb, 2);
            return sb.toString();
        } catch (Exception err) {
            return "";
        }
    }

    /**
     * 这个包名是不是"碰不得"的界面。
     *
     * 名单按关键字匹配，宁可多挡：误挡只是少看一屏，漏挡可能把余额、卡号、验证码读出去。
     */
    private static boolean looksSensitive(String pkg) {
        String p = pkg == null ? "" : pkg.toLowerCase(java.util.Locale.ROOT);
        if (p.isEmpty()) {
            return true;
        }
        String[] keys = {
                "bank", "pay", "wallet", "alipay", "tenpay", "unionpay",
                "icbc", "ccb", "abc", "boc", "cmb", "spdb", "cib", "pingan", "citic", "psbc",
                "hxb", "cgbchina", "secure", "password", "keyguard", "settings", "systemui",
                "bitwarden", "keepass", "lastpass", "dashlane", "authenticator",
                "mms", "messaging", "gallery", "photos",
        };
        for (String key : keys) {
            if (p.contains(key)) {
                return true;
            }
        }
        return false;
    }

    /** 多用途容器里的支付/密码页只能按界面词再挡一道；命中即整屏拒绝，不把原文外发。 */
    private static boolean looksSensitiveText(CharSequence value) {
        if (value == null) return false;
        String s = value.toString().toLowerCase(java.util.Locale.ROOT);
        String[] keys = {
                "支付", "付款", "收款", "转账", "银行卡", "信用卡", "卡号", "钱包", "余额",
                "密码", "验证码", "payment", "pay now", "password", "verification code", "one-time code",
        };
        for (String key : keys) {
            if (s.contains(key)) return true;
        }
        return false;
    }

    /** 当前前台界面的包名；读不到就是空串（调用方按“不安全”处理）。 */
    private static String currentPackage(BridgeAccessibilityService service) {
        android.view.accessibility.AccessibilityNodeInfo root = service.getRootInActiveWindow();
        return root == null || root.getPackageName() == null ? "" : root.getPackageName().toString();
    }

    /** 在本机预检整棵树；预检不完整也按不安全处理。输入框内容不参与扫描。 */
    private static String protectedNodeReason(android.view.accessibility.AccessibilityNodeInfo root) {
        java.util.ArrayList<android.view.accessibility.AccessibilityNodeInfo> queue = new java.util.ArrayList<>();
        queue.add(root);
        int visited = 0;
        while (!queue.isEmpty() && visited < 400) {
            android.view.accessibility.AccessibilityNodeInfo node = queue.remove(0);
            visited++;
            if (node == null) continue;
            if (node.isPassword()) return "这一屏包含密码输入，按规则不读";
            if (!node.isEditable() && (looksSensitiveText(node.getText())
                    || looksSensitiveText(node.getContentDescription()))) {
                return "这一屏包含支付、转账、密码或验证信息，按规则不读";
            }
            for (int i = 0; i < node.getChildCount(); i++) queue.add(node.getChild(i));
        }
        return queue.isEmpty() ? null : "这一屏内容过多，无法完整确认是否安全";
    }

    /**
     * 开发期总开关：true = 不再拦截任何界面（支付、验证码、锁屏一律放行）。
     *
     * 2026-11-09 用户要求「先完全放开」，本机临时置 true；恢复保护把它改回 false 即可。
     */
    private static final boolean ALLOW_ALL_SCREENS = true;

    /** 观察、截图、点击共用的本地拒绝逻辑；任何不确定都 fail-closed。 */
    private static String blockReason(BridgeAccessibilityService service,
                                      android.view.accessibility.AccessibilityNodeInfo root) {
        if (ALLOW_ALL_SCREENS) return null;
        android.app.KeyguardManager keyguard = (android.app.KeyguardManager)
                service.getSystemService(android.content.Context.KEYGUARD_SERVICE);
        if (keyguard != null && keyguard.isKeyguardLocked()) {
            return "锁屏期间按规则不读、不截图、不点击";
        }
        if (root == null) return "这一屏读不到，按规则不继续";
        String pkg = root.getPackageName() == null ? "" : root.getPackageName().toString();
        if (looksSensitive(pkg)) {
            return "这一屏属于银行/支付/密码/短信/相册等受保护界面，按规则不读";
        }
        return protectedNodeReason(root);
    }

    /**
     * 一个控件自己这一层的可见文字；输入框（含密码框）一律返回空。
     *
     * 只取这一层，不往下递归——否则一个列表会把整个页面的文字都拼进来。
     */
    private static String visibleTextOf(android.view.accessibility.AccessibilityNodeInfo node) {
        try {
            if (node.isEditable() || node.isPassword()) {
                return "";
            }
            CharSequence text = node.getText();
            if (text == null) {
                return "";
            }
            String value = text.toString().trim();
            return value.replace('\n', ' ');
        } catch (Exception err) {
            return "";
        }
    }

    /** 这个控件里面还有没有"可点的孩子"——有的话它就是容器，不该当成一个条目。 */
    private static boolean hasClickableChild(android.view.accessibility.AccessibilityNodeInfo node) {
        for (int i = 0; i < node.getChildCount(); i++) {
            android.view.accessibility.AccessibilityNodeInfo child = node.getChild(i);
            if (child == null) continue;
            if (child.isClickable() || child.isEditable()) return true;
        }
        return false;
    }

    private static void collectText(android.view.accessibility.AccessibilityNodeInfo node, StringBuilder out, int depth) {
        if (node == null || depth < 0 || out.length() > 120) {
            return;
        }
        // 输入框和密码框的文本、描述、后代描述一律不读。
        if (node.isEditable() || node.isPassword()) return;
        CharSequence text = node.getText();
        if (text != null && text.length() > 0) {
            if (out.length() > 0) out.append(' ');
            out.append(text);
        }
        CharSequence desc = node.getContentDescription();
        if (desc != null && desc.length() > 0) {
            if (out.length() > 0) out.append(' ');
            out.append(desc);
        }
        for (int i = 0; i < node.getChildCount(); i++) {
            collectText(node.getChild(i), out, depth - 1);
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
            String pkg = root == null || root.getPackageName() == null ? "" : root.getPackageName().toString();
            // FLAG_SECURE 只挡截图，不挡无障碍读树；锁屏、敏感 App、密码框和容器内支付页
            // 都必须在取出任何可返回内容之前先挡住。
            String blockedReason = blockReason(service, root);
            if (blockedReason != null) {
                org.json.JSONObject blocked = new org.json.JSONObject();
                blocked.put("ok", false);
                blocked.put("blocked", true);
                blocked.put("pkg", pkg);
                blocked.put("error", blockedReason);
                return blocked.toString();
            }
            org.json.JSONArray items = new org.json.JSONArray();
            // 屏幕上的**静态文字**（标题、计算器的显示区、列表说明）。
            // 只让模型"能按"却"看不见按出来的结果"，它就没法自我核对（2026-11-09 真机：
            // 按完 7+8 它答不出 15，因为显示屏不是可点控件）。输入框与其后代一律不收。
            org.json.JSONArray texts = new org.json.JSONArray();
            lastTargets.clear();
            lastLabels.clear();
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
                // 容器要跳过：它自己也可点，但真正的条目在它的孩子里。
                // 收进来会让模型看到"荣耀绿洲护眼 声音和振动 通知和状态栏 …"这样一整串，
                // 等于把菜单压成一行，反而没法选（2026-11-09 实测）。
                if (hasClickableChild(node)) {
                    clickable = false;
                }
                // 文字**在遍历里就收**，不限于可点控件：计算器的显示区点不了，
                // 但模型必须看见它才算真的"看见结果"（2026-11-09 真机）。
                if (texts.length() < 40) {
                    String visible = visibleTextOf(node);
                    if (!visible.isEmpty() && visible.length() <= 80) {
                        texts.put(visible);
                    }
                }
                if ((clickable || editable || node.isScrollable())) {
                    // **先把标签算出来再分配序号**：原来的顺序是先 i++ 再判长度，
                    // 被丢掉的长标签项白白用掉一个号，后面每一项的序号都比它在列表里的
                    // 位置大一位——真机上就出现"点 1 号却点到电话"（2026-11-10）。
                    String label = labelOf(node);
                    // 一整串拼起来的标签说明这还是个容器（真机实测：首页那条把整个菜单
                    // 压成了一行）。真正的条目名字都很短，超过 60 字就不当条目。
                    if (label.length() > 60) {
                        continue;
                    }
                    org.json.JSONObject item = new org.json.JSONObject();
                    item.put("i", index++);
                    item.put("t", label);
                    item.put("d", editable || node.isPassword() || node.getContentDescription() == null
                            ? "" : node.getContentDescription().toString());
                    android.graphics.Rect rect = new android.graphics.Rect();
                    node.getBoundsInScreen(rect);
                    lastTargets.add(new android.graphics.Rect(rect.left, rect.top, rect.right, rect.bottom));
                    lastLabels.add(label);
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
            out.put("texts", texts);
            lastObserveAt = System.currentTimeMillis();
            lastObserveGeneration = uiGeneration;
            return maskObserveForModel(out);
        } catch (Exception err) {
            String message = String.valueOf(err.getMessage()).replace("\"", "'");
            return "{\"ok\":false,\"error\":\"" + message + "\"}";
        }
    }

    /**
     * observe 的统一出口：只处理给模型看的 JSON 投影。
     *
     * lastTargets / lastLabels 在遍历控件时已经另行保存，这里不碰它们，所以序号、坐标
     * 与点击定位不因打码改变。以后新增工具只要复用 observe()，就不会绕过这道处理。
     */
    private static String maskObserveForModel(org.json.JSONObject out) throws org.json.JSONException {
        org.json.JSONArray items = out.optJSONArray("items");
        if (items != null) {
            for (int i = 0; i < items.length(); i++) {
                org.json.JSONObject item = items.optJSONObject(i);
                if (item == null) continue;
                item.put("t", SensitiveText.mask(item.optString("t", "")));
                item.put("d", SensitiveText.mask(item.optString("d", "")));
            }
        }
        org.json.JSONArray texts = out.optJSONArray("texts");
        if (texts != null) {
            for (int i = 0; i < texts.length(); i++) {
                String value = texts.optString(i, "");
                texts.put(i, SensitiveText.mask(value));
            }
        }
        return out.toString();
    }

    /** 确认卡需要的是打码后的标签；原始 lastLabels 仍只服务内部定位。 */
    static String targetLabel(int index) {
        if (index < 0 || index >= lastLabels.size()) return "";
        return SensitiveText.mask(lastLabels.get(index));
    }

    /**
     * 按**序号**点一下（P3 的第二个工具，2026-11-09）。
     *
     * 不按坐标：让模型算像素，错一次就可能点中"付款"。序号只在最近一次观察后
     * 一小段时间内有效，过期就要求重新观察——界面变了还照旧点，是最危险的一种错。
     */
    static String tapIndex(int index) {
        if (instance == null) {
            return "{\"ok\":false,\"error\":\"无障碍还没开启\"}";
        }
        if (lastTargets.isEmpty() || System.currentTimeMillis() - lastObserveAt > 30_000) {
            return "{\"ok\":false,\"error\":\"请先看一眼屏幕（观察一次），序号才有意义\"}";
        }
        /* 界面变了怎么办（2026-11-10 第二次修）。
         *
         * 一刀切拒绝是错的：计算器按下数字后，显示区会异步刷新，代次必然变，
         * 于是"点 7 成功、点加失败"。但完全不管也不行——真翻页时序号会指到别处。
         *
         * 折中：变了就**重新观察一次**，核对同一序号上的控件**标签是否还是那个**；
         * 一样就照点（说明只是显示刷新），不一样才拒绝。
         */
        if (lastObserveGeneration != uiGeneration) {
            String expected = index < lastLabels.size() ? lastLabels.get(index) : "";
            observe();
            String actual = index < lastLabels.size() ? lastLabels.get(index) : null;
            if (actual == null || !actual.equals(expected)) {
                return "{\"ok\":false,\"error\":\"界面已经变了，第 " + index + " 个控件已不是原来那个，请重新观察再点\"}";
            }
        }
        if (index < 0 || index >= lastTargets.size()) {
            return "{\"ok\":false,\"error\":\"没有第 " + index + " 个控件，先重新观察\"}";
        }
        android.graphics.Rect rect = lastTargets.get(index);
        String result = tap(rect.centerX(), rect.centerY());
        if (!result.startsWith("错误")) {
            // 自己点的这一下会改变界面；刷新快照，让后续序号基于新画面重新算，
            // 而不是让用户/模型为系统自己的动作付一次"重新观察"的代价。
            try {
                observe();
            } catch (Exception ignored) {
                // 刷新失败不影响这一下点击的结果。
            }
        }
        if (result.startsWith("错误")) {
            return "{\"ok\":false,\"error\":\"" + result.replace("\"", "'") + "\"}";
        }
        return "{\"ok\":true,\"result\":\"" + result + "\"}";
    }

    /**
     * 截一张图，压小之后以 base64 交回电脑（2026-11-10）。
     *
     * 为什么要截图：微博这类 App 大量用自绘控件，"跳过"两个字只是个画上去的字符串——
     * 既不在控件树里，也没法按序号点。只有看图才知道那东西长什么样、在哪。
     *
     * 压到宽 720 的 JPEG：一张原图动辄 3~5MB，走桥太笨；720 宽够看清界面布局，
     * 也让回传的 JSON 保持在几十到一两百 KB。
     */
    static String shotBase64() {
        BridgeAccessibilityService service = instance;
        if (service == null) {
            return "{\"ok\":false,\"error\":\"无障碍还没开启\"}";
        }
        if (Build.VERSION.SDK_INT < 30) {
            return "{\"ok\":false,\"error\":\"系统版本太低（需要 Android 11 以上）\"}";
        }
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        final Bitmap[] holder = new Bitmap[1];
        service.takeScreenshot(android.view.Display.DEFAULT_DISPLAY, service.getMainExecutor(),
                new TakeScreenshotCallback() {
                    @Override
                    public void onSuccess(ScreenshotResult screenshot) {
                        holder[0] = Bitmap.wrapHardwareBuffer(screenshot.getHardwareBuffer(), screenshot.getColorSpace());
                        latch.countDown();
                    }

                    @Override
                    public void onFailure(int errorCode) {
                        latch.countDown();
                    }
                });
        try {
            if (!latch.await(3, java.util.concurrent.TimeUnit.SECONDS)) {
                return "{\"ok\":false,\"error\":\"截图超时\"}";
            }
        } catch (InterruptedException err) {
            return "{\"ok\":false,\"error\":\"截图被打断\"}";
        }
        Bitmap full = holder[0];
        if (full == null) {
            return "{\"ok\":false,\"error\":\"这一屏不允许截图（安全窗口）\"}";
        }
        try {
            int width = 480;
            int height = Math.max(1, full.getHeight() * width / full.getWidth());
            Bitmap small = Bitmap.createScaledBitmap(full, width, height, true);
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            small.compress(Bitmap.CompressFormat.JPEG, 50, out);
            String base64 = android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP);
            org.json.JSONObject result = new org.json.JSONObject();
            result.put("ok", true);
            result.put("width", width);
            result.put("height", height);
            result.put("jpeg", base64);
            return result.toString();
        } catch (Exception err) {
            String message = String.valueOf(err.getMessage()).replace("\"", "'");
            return "{\"ok\":false,\"error\":\"压图失败：" + message + "\"}";
        }
    }

    /** 返回键。**不提供**主页与最近任务：那样会脱离授权范围（RFC 8.3）。 */
    static String back() {
        if (instance == null) {
            return "{\"ok\":false,\"error\":\"无障碍还没开启\"}";
        }
        boolean done = instance.performGlobalAction(GLOBAL_ACTION_BACK);
        return done ? "{\"ok\":true,\"result\":\"已返回\"}"
                : "{\"ok\":false,\"error\":\"系统拒绝了这个返回动作\"}";
    }

    /** 滑动。只认四个方向，不让模型算像素。 */
    static String swipe(String direction) {
        if (instance == null) {
            return "{\"ok\":false,\"error\":\"无障碍还没开启\"}";
        }
        android.util.DisplayMetrics metrics = instance.getResources().getDisplayMetrics();
        float cx = metrics.widthPixels / 2f;
        float cy = metrics.heightPixels / 2f;
        float dx = 0;
        float dy = 0;
        String dir = direction == null ? "" : direction.trim();
        if ("上".equals(dir) || "up".equalsIgnoreCase(dir)) {
            dy = -metrics.heightPixels * 0.35f;
        } else if ("下".equals(dir) || "down".equalsIgnoreCase(dir)) {
            dy = metrics.heightPixels * 0.35f;
        } else if ("左".equals(dir) || "left".equalsIgnoreCase(dir)) {
            dx = -metrics.widthPixels * 0.35f;
        } else if ("右".equals(dir) || "right".equalsIgnoreCase(dir)) {
            dx = metrics.widthPixels * 0.35f;
        } else {
            return "{\"ok\":false,\"error\":\"方向只能是 上/下/左/右\"}";
        }
        Path path = new Path();
        path.moveTo(cx, cy);
        path.lineTo(cx + dx, cy + dy);
        GestureDescription gesture = new GestureDescription.Builder()
                .addStroke(new GestureDescription.StrokeDescription(path, 0, 240))
                .build();
        boolean dispatched = instance.dispatchGesture(gesture, null, null);
        return dispatched ? "{\"ok\":true,\"result\":\"已向" + dir + "滑动\"}"
                : "{\"ok\":false,\"error\":\"系统拒绝了这个滑动手势\"}";
    }

    /**
     * 往第 index 个输入框里填字（P3，2026-11-09）。
     *
     * 先点一下让它获得焦点，再交给系统的"设置文本"动作——不逐字模拟按键：
     * 逐字敲要处理输入法、联想、光标位置，中文尤其不可靠。
     * **只填不发送**：提交要模型另外明确要求，避免误发消息。
     */
    static String input(int index, String text) {
        if (instance == null) {
            return "{\"ok\":false,\"error\":\"无障碍还没开启\"}";
        }
        if (text == null) {
            text = "";
        }
        String tapped = tapIndex(index);
        if (!tapped.contains("\"ok\":true")) {
            return tapped;
        }
        android.view.accessibility.AccessibilityNodeInfo root = instance.getRootInActiveWindow();
        if (root == null) {
            return "{\"ok\":false,\"error\":\"读不到当前界面\"}";
        }
        android.view.accessibility.AccessibilityNodeInfo focused = root.findFocus(
                android.view.accessibility.AccessibilityNodeInfo.FOCUS_INPUT);
        if (focused == null) {
            return "{\"ok\":false,\"error\":\"点了，但没有拿到输入焦点\"}";
        }
        android.os.Bundle args = new android.os.Bundle();
        args.putCharSequence(android.view.accessibility.AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text);
        boolean ok = focused.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_SET_TEXT, args);
        return ok ? "{\"ok\":true,\"result\":\"已填入\"}"
                : "{\"ok\":false,\"error\":\"这个输入框不接受直接填字\"}";
    }

    /** 在屏幕上点一下（坐标为屏幕像素）。用于证明"注入手势"这条路是通的。 */
    static String tap(float x, float y) {
        BridgeAccessibilityService service = instance;
        if (service == null) {
            return "错误：无障碍还没开启";
        }
        String blocked = blockReason(service, service.getRootInActiveWindow());
        if (blocked != null) return "错误：" + blocked;
        // 检查通过之后、真正派发手势之前再核一遍：这一小段里换了屏就不点。
        String again = blockReason(service, service.getRootInActiveWindow());
        if (again != null) return "错误：" + again;
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
