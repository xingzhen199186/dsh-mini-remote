package com.dsh.miniremote;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 手机桥的"心跳"（P2 第一步，2026-11-09）。
 *
 * 它只做一件事：**武装期间不停地问电脑"我在线吗"**，让电脑那边知道这台手机的桥开着。
 * 还不会执行任何工具——第一步先把"在线"这件事做扎实。
 *
 * 用长轮询而不是定时轮询：服务端最多压 25 秒才回，所以一条连接就能同时承担
 * "报活"和"电脑有话要说"两件事，不用另开一条通道。
 */
final class BridgePoller {
    private volatile boolean running;
    /** 每次启停都换一代：旧线程的迟到响应不能在新一代里执行动作。 */
    private volatile long generation;
    /** 启停互斥：界面线程和后台上报线程都会碰它。 */
    private final Object lifecycle = new Object();
    private volatile boolean online;
    /** 连续失败次数：用来区分"还在连"和"根本连不上"，界面要说得不一样。 */
    private volatile int failures;
    /** 上一次收到 200 响应的时间；界面用它判断"真的连上了"而不是"以为连上了"。 */
    private volatile long lastOkMs;
    /** 这一代线程是否已经补发过武装，避免每轮都发。 */
    private volatile boolean rearmTried;
    /** 连续失败后的退避：别在断网时每 5 秒撞一次墙。 */
    private long backoffMs = 5_000;
    /** 有没有见过"已武装"：没见过的第一拍说没武装，多半是武装请求还在路上，不算关。 */
    private volatile boolean sawArmed;
    /** 第一拍用短请求，别让用户干等一个长轮询周期。 */
    private volatile boolean firstPoll = true;
    private Thread thread;
    private String baseUrl;
    private String credential;
    private Runnable onChange;
    /** 发通知要用它；由 MainActivity 设进来。 */
    private android.content.Context context;

    void attach(android.content.Context ctx) {
        this.context = ctx.getApplicationContext();
    }

    void setOnChange(Runnable callback) {
        this.onChange = callback;
    }

    void start(String baseUrl, String credential) {
        synchronized (lifecycle) {
            if (running && java.util.Objects.equals(this.baseUrl, baseUrl)
                    && java.util.Objects.equals(this.credential, credential)) {
                return;
            }
            if (running) stopLocked();
            this.baseUrl = baseUrl;
            this.credential = credential;
            running = true;
            final long token = ++generation;
            rearmTried = false;
            thread = new Thread(() -> run(token), "mini-bridge");
            thread.setDaemon(true);
            thread.start();
        }
    }

    void stop() {
        synchronized (lifecycle) {
            stopLocked();
        }
        notifyChange();
    }

    /** 必须在 lifecycle 锁里调用；只换代并停线程，不碰回调。 */
    private void stopLocked() {
        generation++;
        running = false;
        online = false;
        lastOkMs = 0;
        failures = 0;
        sawArmed = false;
        firstPoll = true;
        if (thread != null) {
            thread.interrupt();
            thread = null;
        }
    }

    /**
     * 真的连上了吗——判据是**最近 45 秒内收到过一次成功响应**，
     * 不是"服务端说我们已授权"。后者在电脑重启后会一直是 false 却又不报错，
     * 界面就会显示"已连接"而实际上什么也调不动（2026-11-10 李四审计指出）。
     */
    boolean isOnline() {
        return online && System.currentTimeMillis() - lastOkMs < 45_000;
    }

    /** 开关是开的、但最近没连上：界面要如实说这句话，而不是继续显示"已连接"。 */
    boolean isStale() {
        return online && System.currentTimeMillis() - lastOkMs >= 45_000;
    }

    int failures() {
        return failures;
    }

    private void notifyChange() {
        Runnable callback = onChange;
        if (callback != null) {
            callback.run();
        }
    }

    private void run(long token) {
        while (running && generation == token) {
            try {
                // 第一拍**不要压 25 秒**：刚打开开关时用户盯着这一行，
                // 等 25 秒才变"已连接"会让人以为坏了。先问一次立刻回，之后再长轮询。
                String url = baseUrl + "/mini/api/bridge/poll?protocol=1"
                        + (firstPoll ? "&wait=0" : "&wait=1");
                // 读超时要比服务端压的 25 秒更长，否则正常的长轮询会被当成失败。
                Net.Response response = Net.getLong(url, credential, 35_000);
                if (!running || generation != token) return;
                boolean ok = response.isSuccess() && response.body != null && !response.body.isEmpty();
                if (ok) {
                    JSONObject root = new JSONObject(response.body);
                    firstPoll = false;
                    boolean armed = root.optBoolean("armed", false);
                    // 先认授权再认动作：即使异常服务端在撤权响应里塞了 calls，也绝不执行。
                    if (armed) {
                        handleCalls(dropReplayed(root.optJSONArray("calls")), token);
                    } else if (root.optJSONArray("calls") != null
                            && root.optJSONArray("calls").length() > 0) {
                        android.util.Log.w("MiniBridge", "未武装响应带有调用，已整批拒绝");
                    }
                    failures = 0;
                    backoffMs = 5_000;
                    online = armed;
                    lastOkMs = System.currentTimeMillis();
                    notifyChange();
                    /* **电脑不记得，不等于用户撤权**（2026-11-10）。
                     *
                     * 原来这里一旦看到 armed=false 就自己停心跳，而且要人手动拨一次开关才能
                     * 回来——因为电脑端的武装状态只存在内存里，每次重启电脑就全没了
                     * （lib/bridge.js 里 entry.armed 是内存字段）。于是"重启电脑"被手机
                     * 误读成"用户关掉了开关"，整套手机能力静默失效，而界面仍显示"已连接"。
                     *
                     * 现在的分工：**停不停只由本地开关决定**；电脑说没武装，手机就补发一次
                     * 自己的决定（每代只补一次，失败按既有退避重试）。这不等于电脑替用户
                     * 开权限——补发的仍然是手机本地那个开关的意思。
                     */
                    if (!armed) {
                        rearmIfNeeded(token);
                    } else {
                        sawArmed = true;
                    }
                } else {
                    failures++;
                    online = false;
                    android.util.Log.w("MiniBridge", "轮询失败：HTTP " + response.status);
                    refreshBaseUrlFromPrefs();
                    notifyChange();
                    sleepQuietly(nextBackoff(), token);
                }
            } catch (Exception err) {
                if (!running || generation != token) {
                    return;
                }
                android.util.Log.w("MiniBridge", "轮询异常", err);
                failures++;
                online = false;
                refreshBaseUrlFromPrefs();
                notifyChange();
                sleepQuietly(nextBackoff(), token);
            }
        }
        if (generation == token) {
            online = false;
            notifyChange();
        }
    }

    /**
     * 执行电脑派下来的动作（P2 第二步）。
     *
     * 现在只有一个：`phone_notify`。**执行完必须回报**，否则电脑那边会一直等到超时，
     * 用户看到的是"发了但没回应"。所以成功失败都要回一条。
     */
    private void handleCalls(org.json.JSONArray calls, long token) {
        if (calls == null || calls.length() == 0) {
            return;
        }
        for (int i = 0; i < calls.length(); i++) {
            // 一批动作执行到一半被停掉或换了线路：剩下的一个都不许再执行。
            if (!running || generation != token) {
                android.util.Log.w("MiniBridge", "手机桥已停止或换代，剩余调用不再执行");
                return;
            }
            org.json.JSONObject call = calls.optJSONObject(i);
            if (call == null) continue;
            final String id = call.optString("id", "");
            final String tool = call.optString("tool", "");
            final long expiresAt = call.optLong("expiresAt", 0);
            org.json.JSONObject args = call.optJSONObject("args");
            if (id.isEmpty()) continue;
            // 到期时间由服务端签发；缺失或已过期的动作一律不执行。
            if (expiresAt <= System.currentTimeMillis()) {
                report(id, false, "调用已经过期，手机拒绝执行");
                continue;
            }
            if ("phone_notify".equals(tool)) {
                String title = args == null ? "" : args.optString("title", "");
                String body = args == null ? "" : args.optString("body", "");
                String problem = notificationProblem();
                if (problem != null) {
                    report(id, false, problem);
                    continue;
                }
                try {
                    Notifier.showFromComputer(context, title, body);
                    report(id, true, "已显示通知");
                } catch (Exception err) {
                    report(id, false, "通知显示失败：" + err.getMessage());
                }
            } else if ("phone_screenshot".equals(tool)) {
                try {
                    Class<?> cls = Class.forName("com.dsh.miniremote.BridgeAccessibilityService");
                    String json = (String) cls.getDeclaredMethod("shotBase64").invoke(null);
                    reportRaw(id, json.contains("\"ok\":true"), json);
                } catch (ClassNotFoundException err) {
                    report(id, false, "这个版本没有截图能力（需要实验版）");
                } catch (Exception err) {
                    report(id, false, "截图失败：" + err.getMessage());
                }
            } else if ("phone_back".equals(tool) || "phone_swipe".equals(tool) || "phone_input".equals(tool)) {
                try {
                    Class<?> cls = Class.forName("com.dsh.miniremote.BridgeAccessibilityService");
                    String json;
                    if ("phone_back".equals(tool)) {
                        json = (String) cls.getDeclaredMethod("back").invoke(null);
                    } else if ("phone_swipe".equals(tool)) {
                        json = (String) cls.getDeclaredMethod("swipe", String.class)
                                .invoke(null, args == null ? "" : args.optString("direction", ""));
                    } else {
                        json = (String) cls.getDeclaredMethod("input", int.class, String.class)
                                .invoke(null, args == null ? -1 : args.optInt("index", -1),
                                        args == null ? "" : args.optString("text", ""));
                    }
                    // 动作做完顺手看一眼：把"做一步"和"看一眼"并成一次往返（2026-11-10）。
                    reportRaw(id, json.contains("\"ok\":true"), withScreen(cls, json));
                } catch (ClassNotFoundException err) {
                    report(id, false, "这个版本没有操作能力（需要实验版）");
                } catch (Exception err) {
                    report(id, false, "操作失败：" + err.getMessage());
                }
            } else if ("phone_open".equals(tool)) {
                try {
                    String pkg = args == null ? "" : args.optString("package", "").trim();
                    report(id, true, openApp(context, pkg));
                } catch (Exception err) {
                    report(id, false, "打开失败：" + err.getMessage());
                }
            } else if ("phone_tap".equals(tool)) {
                try {
                    int index = args == null ? -1 : args.optInt("index", -1);
                    Class<?> cls = Class.forName("com.dsh.miniremote.BridgeAccessibilityService");
                    String json = (String) cls.getDeclaredMethod("tapIndex", int.class).invoke(null, index);
                    // 点完顺手带回一眼，和返回/滑动/输入保持一致。
                    reportRaw(id, json.contains("\"ok\":true"), withScreen(cls, json));
                } catch (ClassNotFoundException err) {
                    report(id, false, "这个版本没有点击能力（需要实验版）");
                } catch (Exception err) {
                    report(id, false, "点击失败：" + err.getMessage());
                }
            } else if ("phone_observe".equals(tool)) {
                try {
                    // 无障碍服务只在 bridge 版本里，走反射拿，标准版调用会得到"不支持"。
                    Class<?> cls = Class.forName("com.dsh.miniremote.BridgeAccessibilityService");
                    String json = (String) cls.getDeclaredMethod("observe").invoke(null);
                    org.json.JSONObject observed = new org.json.JSONObject(json);
                    if (observed.optBoolean("ok", false)) {
                        reportRaw(id, true, json);
                    } else {
                        report(id, false, observed.optString("error", "观察失败"));
                    }
                } catch (ClassNotFoundException err) {
                    report(id, false, "这个版本没有屏幕观察能力（需要实验版）");
                } catch (Exception err) {
                    report(id, false, "观察失败：" + err.getMessage());
                }
            } else if ("phone_set_clipboard".equals(tool)) {
                // **不直接写**：只弹一条带按钮的通知，用户点了才算数。
                String problem = notificationProblem();
                if (problem != null) {
                    report(id, false, problem);
                    continue;
                }
                try {
                    String text = args == null ? "" : args.optString("text", "");
                    Notifier.showClipboardAsk(context, id, text, baseUrl, credential, expiresAt);
                } catch (Exception err) {
                    report(id, false, "剪贴板确认通知显示失败：" + err.getMessage());
                }
            } else if ("phone_send_file".equals(tool)) {
                try {
                    String name = args == null ? "文件.txt" : args.optString("name", "文件.txt");
                    String text = args == null ? "" : args.optString("text", "");
                    String saved = saveToDownloads(name, text);
                    try {
                        Notifier.showFromComputer(context, "已保存到手机", "「" + name + "」已存到「下载/DSH」");
                    } catch (Exception err) {
                        // 文件已经存好，不能把通知失败误报成文件失败，诱导电脑再写一次。
                        android.util.Log.w("MiniBridge", "文件已保存，但通知显示失败", err);
                    }
                    report(id, true, "已保存：" + saved);
                } catch (Exception err) {
                    report(id, false, "存文件失败：" + err.getMessage());
                }
            } else if ("phone_status".equals(tool)) {
                try {
                    String json = statusJson();
                    org.json.JSONObject status = new org.json.JSONObject(json);
                    if (status.has("error")) {
                        report(id, false, "读不到手机状态：" + status.optString("error", "未知错误"));
                    } else {
                        report(id, true, json);
                    }
                } catch (Exception err) {
                    report(id, false, "读不到手机状态：" + err.getMessage());
                }
            } else {
                report(id, false, "这个动作这台手机还不支持：" + tool);
            }
        }
    }

    /** 通知没权限时必须明确失败，不能向电脑谎报“已显示”。 */
    private String notificationProblem() {
        if (context == null) return "手机页面还没准备好，通知没有显示";
        if (android.os.Build.VERSION.SDK_INT >= 33
                && context.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            return "手机没有通知权限，请在系统设置里允许后再试";
        }
        return null;
    }

    /**
     * 把电脑发来的一段文本存进手机的「下载/DSH」（P2 第四步，2026-11-09）。
     *
     * 走 MediaStore 的 Downloads 集合：Android 10 起不需要存储权限，用户能在系统
     * 「文件」里直接看到。**不覆盖同名文件**——同名时自动加序号，避免把用户原有的
     * 文件冲掉（这是"送东西"该有的保守）。
     */
    private String saveToDownloads(String name, String text) throws Exception {
        String safe = name == null ? "文件.txt" : name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        if (safe.isEmpty()) safe = "文件.txt";
        byte[] bytes = text == null ? new byte[0] : text.getBytes("UTF-8");
        // MediaStore.Downloads / RELATIVE_PATH 是 Android 10（API 29）才有的；minSdk 是 28，
        // 直接引用会在 Android 9 上崩，而不是“存不进去”。
        if (android.os.Build.VERSION.SDK_INT < 29) {
            java.io.File dir = new java.io.File(context.getExternalFilesDir(
                    android.os.Environment.DIRECTORY_DOWNLOADS), "DSH");
            if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("建不出存放目录");
            java.io.File out = new java.io.File(dir, safe);
            try (java.io.FileOutputStream os = new java.io.FileOutputStream(out)) {
                os.write(bytes);
            }
            return out.getAbsolutePath();
        }
        android.content.ContentValues values = new android.content.ContentValues();
        values.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, safe);
        values.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "text/plain");
        values.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH,
                android.os.Environment.DIRECTORY_DOWNLOADS + "/DSH");
        android.net.Uri uri = context.getContentResolver().insert(
                android.provider.MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) {
            throw new IllegalStateException("系统没有给出存放位置");
        }
        try (java.io.OutputStream os = context.getContentResolver().openOutputStream(uri)) {
            if (os == null) throw new IllegalStateException("写不进去");
            os.write(bytes);
        }
        return safe;
    }

    /**
     * 手机状态（P2 第三步，2026-11-09）：电量、充电、网络、锁屏、是否前台。
     *
     * 只读，不在手机上留下任何痕迹——这是四个工具里最安全的一个。
     * **不读**短信、通知、相册、剪贴板：要那些内容只能由用户自己分享过来。
     */
    private String statusJson() {
        org.json.JSONObject out = new org.json.JSONObject();
        try {
            android.content.Context ctx = context;
            android.os.BatteryManager battery = (android.os.BatteryManager)
                    ctx.getSystemService(android.content.Context.BATTERY_SERVICE);
            int level = battery == null ? -1
                    : battery.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY);
            android.content.Intent intent = ctx.registerReceiver(null,
                    new android.content.IntentFilter(android.content.Intent.ACTION_BATTERY_CHANGED));
            int plugged = intent == null ? -1 : intent.getIntExtra(android.os.BatteryManager.EXTRA_PLUGGED, -1);
            android.os.PowerManager power = (android.os.PowerManager)
                    ctx.getSystemService(android.content.Context.POWER_SERVICE);
            android.app.KeyguardManager keyguard = (android.app.KeyguardManager)
                    ctx.getSystemService(android.content.Context.KEYGUARD_SERVICE);
            android.net.ConnectivityManager conn = (android.net.ConnectivityManager)
                    ctx.getSystemService(android.content.Context.CONNECTIVITY_SERVICE);
            // 网络这一项**单独兜住**：权限没给会抛 SecurityException，
            // 而它排在赋值之前会把电量一起带走（2026-11-09 真机就是只回了一句报错）。
            boolean wifi = false;
            boolean mobile = false;
            try {
                if (conn != null) {
                    android.net.Network active = conn.getActiveNetwork();
                    android.net.NetworkCapabilities caps = active == null ? null : conn.getNetworkCapabilities(active);
                    if (caps != null) {
                        wifi = caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI);
                        mobile = caps.hasTransport(android.net.NetworkCapabilities.TRANSPORT_CELLULAR);
                    }
                }
            } catch (Exception err) {
                // 读不出网络就报 none，不要连累电量。
            }
            out.put("battery", level);
            out.put("charging", plugged > 0);
            out.put("screenOn", power != null && power.isInteractive());
            out.put("locked", keyguard != null && keyguard.isKeyguardLocked());
            out.put("network", wifi ? "wifi" : mobile ? "mobile" : "none");
        } catch (Exception err) {
            try {
                out.put("error", String.valueOf(err.getMessage()));
            } catch (Exception ignored) {
                // 连错误都写不进去就算了：上层会按"没有字段"处理。
            }
        }
        return out.toString();
    }

    /**
     * 把某个 App 调到前台（P3，2026-11-09）。
     *
     * 只用系统的"启动入口"去开，**不按包名拼 Intent**——拼出来的那条路能启动
     * 不该启动的组件。找不到入口就老实说没有，不猜。
     */
    private static String openApp(android.content.Context context, String pkg) {
        if (pkg == null || pkg.isEmpty()) {
            throw new IllegalArgumentException("没有说要打开哪个 App");
        }
        if (pkg.equals(context.getPackageName())) {
            throw new IllegalArgumentException("不用打开我自己");
        }
        android.content.pm.PackageManager pm = context.getPackageManager();
        android.content.Intent launch = pm.getLaunchIntentForPackage(pkg);
        if (launch == null) {
            throw new IllegalArgumentException("这台手机上没有可打开的「" + pkg + "」");
        }
        launch.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(launch);
        return "已打开 " + pkg;
    }

    /** 给接收器用的静态回报（它拿不到 poller 实例）。 */
    static void reportStatic(String baseUrl, String credential, String id, boolean ok, String message) {
        if (baseUrl == null || credential == null || id == null) {
            android.util.Log.w("MiniBridge", "结果回报缺少地址、凭据或调用 id");
            return;
        }
        new Thread(() -> {
            try {
                String payload = "{\"id\":" + org.json.JSONObject.quote(id) + ",\"ok\":" + ok
                        + ",\"result\":" + org.json.JSONObject.quote(message) + "}";
                Net.Response response = Net.postJson(baseUrl + "/mini/api/bridge/result", payload, credential);
                if (!response.isSuccess()) {
                    android.util.Log.w("MiniBridge", "结果未被电脑接受：HTTP " + response.status);
                }
            } catch (Exception err) {
                // 回报失败不重试；至少留下不含内容、不含凭据的诊断。
                android.util.Log.w("MiniBridge", "结果回报失败", err);
            }
        }, "mini-bridge-report").start();
    }

    /** 回报一次执行结果；回不上去就算了，电脑那边会按超时处理。 */
    private void report(String id, boolean ok, String message) {
        reportRaw(id, ok, org.json.JSONObject.quote(message));
    }

    /** result 已经是 JSON 片段（对象或带引号的字符串）。 */
    private void reportRaw(String id, boolean ok, String resultJson) {
        final String base = baseUrl;
        final String cred = credential;
        if (base == null || cred == null) {
            android.util.Log.w("MiniBridge", "结果回报缺少地址或设备凭据");
            return;
        }
        new Thread(() -> {
            try {
                String payload = "{\"id\":" + org.json.JSONObject.quote(id) + ",\"ok\":" + ok
                        + ",\"result\":" + resultJson + "}";
                Net.Response response = Net.postJson(base + "/mini/api/bridge/result", payload, cred);
                if (!response.isSuccess()) {
                    android.util.Log.w("MiniBridge", "结果未被电脑接受：HTTP " + response.status);
                }
            } catch (Exception err) {
                // 回报失败不重试：重试可能让同一件事执行两遍。
                android.util.Log.w("MiniBridge", "结果回报失败", err);
            }
        }, "mini-bridge-report").start();
    }

    /**
     * 连不上几次之后，重读一次"用户上次挑中的地址"（2026-11-10）。
     *
     * 后台服务那条心跳是在启动那一刻拿到地址的，之后就不再变；而电脑换端口
     * （PORT_TRIES 会向后顺延）时，它会一直朝旧地址撞，永远不会自己发现。
     * 这里只在**真的连不上**时才重读，正常连接不会被打断。
     */
    private void refreshBaseUrlFromPrefs() {
        if (context == null || failures < 3) {
            return;
        }
        try {
            String latest = Connections.preferred(context);
            if (latest != null && !latest.isEmpty() && !latest.equals(baseUrl)) {
                android.util.Log.i("MiniBridge", "换用新地址重连：" + latest);
                baseUrl = latest;
                failures = 0;
                backoffMs = 5_000;
            }
        } catch (Exception err) {
            android.util.Log.w("MiniBridge", "重读地址失败：" + err.getMessage());
        }
    }

    /**
     * 丢掉重放或过期的调用（2026-11-10）。
     *
     * 电脑给每条调用配了一个单调递增的序号；手机记住已处理的最高那个，
     * **比它小的整条不执行**。这样同一条指令被重复送达（或被人抓了报文再放一遍）
     * 都不会执行第二次——重复点一下的代价可能是"又转了一次账"。
     *
     * 序号只在电脑本次进程内有效，重启后会重新计数，所以这里对"序号变小"只记日志、
     * 不硬拒：宁可少挡一次，也不要让整台手机卡死在旧序号上。
     */
    private org.json.JSONArray dropReplayed(org.json.JSONArray calls) {
        if (calls == null) {
            return null;
        }
        try {
            android.content.SharedPreferences prefs =
                    context.getSharedPreferences("mini_bridge_seq", android.content.Context.MODE_PRIVATE);
            long last = prefs.getLong("lastSeq", 0);
            org.json.JSONArray kept = new org.json.JSONArray();
            long highest = last;
            boolean sawSmaller = false;
            for (int i = 0; i < calls.length(); i += 1) {
                JSONObject call = calls.optJSONObject(i);
                if (call == null) continue;
                long seq = call.optLong("seq", 0);
                // **电脑重启后序号会从 1 重新数**，这时不能当重放丢掉——不然整台手机
                // 从此收不到任何指令，而电脑那边看起来一切正常（2026-11-10 就是这么失灵的）。
                // 所以按"本次进程"的标识换新纪元：标识变了就把已处理的最高序号清零。
                String epoch = call.optString("sessionId", "");
                if (!epoch.isEmpty()) {
                    String known = prefs.getString("sessionId", "");
                    if (!epoch.equals(known)) {
                        prefs.edit().putString("sessionId", epoch).putLong("lastSeq", 0).apply();
                        last = 0;
                        highest = 0;
                    }
                }
                if (seq > 0 && seq <= last) {
                    sawSmaller = true;
                    continue;
                }
                kept.put(call);
                if (seq > highest) highest = seq;
            }
            if (highest > last) {
                prefs.edit().putLong("lastSeq", highest).apply();
            }
            if (sawSmaller) {
                android.util.Log.w("MiniBridge", "有重放的调用被挡下（序号不大于已处理的最高值）");
            }
            return kept;
        } catch (Exception err) {
            android.util.Log.w("MiniBridge", "序号检查出错，按原样执行：" + err.getMessage());
            return calls;
        }
    }

    /**
     * 在动作结果里附上"现在的屏幕"。
     *
     * 不附这一步的话，模型每次都要多调一次观察才能知道按完变成了什么样；
     * 附上去之后一轮就能继续判断。观察失败不影响动作本身的成败。
     */
    private static String withScreen(Class<?> cls, String actionJson) {
        try {
            Object screen = cls.getDeclaredMethod("observe").invoke(null);
            org.json.JSONObject merged = new org.json.JSONObject(actionJson);
            merged.put("screen", new org.json.JSONObject(String.valueOf(screen)));
            return merged.toString();
        } catch (Exception err) {
            return actionJson;
        }
    }

    /** 电脑重启后忘了我们（armed=false）时，补发一次本地开关的决定。 */
    private void rearmIfNeeded(long token) {
        if (rearmTried || baseUrl == null || credential == null) {
            return;
        }
        rearmTried = true;
        try {
            String payload = "{\"armed\":true}";
            Net.postJson(baseUrl + "/mini/api/bridge/arm", payload, credential);
            android.util.Log.i("MiniBridge", "电脑端不记得这台手机了，已补发一次武装");
        } catch (Exception err) {
            android.util.Log.w("MiniBridge", "补发武装失败：" + err.getMessage());
        }
    }

    /** 5s → 10 → 20 → 40 → 60 封顶。断网时不该每 5 秒撞一次。 */
    private long nextBackoff() {
        long wait = backoffMs;
        backoffMs = Math.min(60_000, backoffMs * 2);
        return wait;
    }

    private void sleepQuietly(long millis, long token) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException err) {
            Thread.currentThread().interrupt();
            if (generation == token) running = false;
        }
    }
}
