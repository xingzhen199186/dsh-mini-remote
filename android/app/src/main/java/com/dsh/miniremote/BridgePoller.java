package com.dsh.miniremote;

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
final class BridgePoller implements Runnable {
    private volatile boolean running;
    private volatile boolean online;
    /** 连续失败次数：用来区分"还在连"和"根本连不上"，界面要说得不一样。 */
    private volatile int failures;
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
        if (running) {
            this.baseUrl = baseUrl;
            this.credential = credential;
            return;
        }
        this.baseUrl = baseUrl;
        this.credential = credential;
        running = true;
        thread = new Thread(this, "mini-bridge");
        thread.setDaemon(true);
        thread.start();
    }

    void stop() {
        running = false;
        online = false;
        failures = 0;
        sawArmed = false;
        firstPoll = true;
        if (thread != null) {
            thread.interrupt();
            thread = null;
        }
        notifyChange();
    }

    boolean isOnline() {
        return online;
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

    @Override
    public void run() {
        while (running) {
            try {
                // 第一拍**不要压 25 秒**：刚打开开关时用户盯着这一行，
                // 等 25 秒才变"已连接"会让人以为坏了。先问一次立刻回，之后再长轮询。
                String url = baseUrl + "/mini/api/bridge/poll?protocol=1"
                        + (firstPoll ? "&wait=0" : "&wait=1");
                // 读超时要比服务端压的 25 秒更长，否则正常的长轮询会被当成失败。
                Net.Response response = Net.getLong(url, credential, 35_000);
                boolean ok = response.isSuccess() && response.body != null && !response.body.isEmpty();
                if (ok) {
                    JSONObject root = new JSONObject(response.body);
                    firstPoll = false;
                    handleCalls(root.optJSONArray("calls"));
                    boolean armed = root.optBoolean("armed", false);
                    failures = 0;
                    backoffMs = 5_000;
                    online = armed;
                    notifyChange();
                    // 武装被关掉（比如在电脑侧关的）就停：没有授权就不该继续问。
                    if (!armed && sawArmed) {
                        running = false;
                    }
                    if (armed) {
                        sawArmed = true;
                    }
                } else {
                    failures++;
                    online = false;
                    notifyChange();
                    sleepQuietly(nextBackoff());
                }
            } catch (Exception err) {
                if (!running) {
                    return;
                }
                // 连不上就退一步再问：这里不打印、不弹提示——断了会由界面显示离线。
                failures++;
                online = false;
                notifyChange();
                sleepQuietly(nextBackoff());
            }
        }
        online = false;
        notifyChange();
    }

    /**
     * 执行电脑派下来的动作（P2 第二步）。
     *
     * 现在只有一个：`phone_notify`。**执行完必须回报**，否则电脑那边会一直等到超时，
     * 用户看到的是"发了但没回应"。所以成功失败都要回一条。
     */
    private void handleCalls(org.json.JSONArray calls) {
        if (calls == null || calls.length() == 0) {
            return;
        }
        for (int i = 0; i < calls.length(); i++) {
            org.json.JSONObject call = calls.optJSONObject(i);
            if (call == null) continue;
            final String id = call.optString("id", "");
            final String tool = call.optString("tool", "");
            org.json.JSONObject args = call.optJSONObject("args");
            if (id.isEmpty()) continue;
            if ("phone_notify".equals(tool)) {
                String title = args == null ? "" : args.optString("title", "");
                String body = args == null ? "" : args.optString("body", "");
                if (context != null) {
                    Notifier.showFromComputer(context, title, body);
                }
                report(id, true, "已显示通知");
            } else if ("phone_set_clipboard".equals(tool)) {
                // **不直接写**：只弹一条带按钮的通知，用户点了才算数。
                String text = args == null ? "" : args.optString("text", "");
                Notifier.showClipboardAsk(context, id, text, baseUrl, credential);
            } else if ("phone_send_file".equals(tool)) {
                try {
                    String name = args == null ? "文件.txt" : args.optString("name", "文件.txt");
                    String text = args == null ? "" : args.optString("text", "");
                    String saved = saveToDownloads(name, text);
                    Notifier.showFromComputer(context, "已保存到手机", "「" + name + "」已存到「下载/DSH」");
                    report(id, true, "已保存：" + saved);
                } catch (Exception err) {
                    report(id, false, "存文件失败：" + err.getMessage());
                }
            } else if ("phone_status".equals(tool)) {
                try {
                    report(id, true, statusJson());
                } catch (Exception err) {
                    report(id, false, "读不到手机状态：" + err.getMessage());
                }
            } else {
                report(id, false, "这个动作这台手机还不支持：" + tool);
            }
        }
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

    /** 给接收器用的静态回报（它拿不到 poller 实例）。 */
    static void reportStatic(String baseUrl, String credential, String id, boolean ok, String message) {
        if (baseUrl == null || credential == null || id == null) return;
        new Thread(() -> {
            try {
                String payload = "{\"id\":\"" + id + "\",\"ok\":" + ok
                        + ",\"result\":" + org.json.JSONObject.quote(message) + "}";
                Net.postJson(baseUrl + "/mini/api/bridge/result", payload, credential);
            } catch (Exception ignored) {
                // 回报失败不重试。
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
        if (base == null || cred == null) return;
        new Thread(() -> {
            try {
                String payload = "{\"id\":\"" + id + "\",\"ok\":" + ok
                        + ",\"result\":" + resultJson + "}";
                Net.postJson(base + "/mini/api/bridge/result", payload, cred);
            } catch (Exception ignored) {
                // 回报失败不重试：重试可能让同一件事执行两遍。
            }
        }, "mini-bridge-report").start();
    }

    /** 5s → 10 → 20 → 40 → 60 封顶。断网时不该每 5 秒撞一次。 */
    private long nextBackoff() {
        long wait = backoffMs;
        backoffMs = Math.min(60_000, backoffMs * 2);
        return wait;
    }

    private void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException err) {
            Thread.currentThread().interrupt();
            running = false;
        }
    }
}
