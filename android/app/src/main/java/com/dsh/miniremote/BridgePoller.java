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
                    sleepQuietly(5_000);
                }
            } catch (Exception err) {
                if (!running) {
                    return;
                }
                // 连不上就退一步再问：这里不打印、不弹提示——断了会由界面显示离线。
                failures++;
                online = false;
                notifyChange();
                sleepQuietly(5_000);
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
            } else {
                report(id, false, "这个动作这台手机还不支持：" + tool);
            }
        }
    }

    /** 回报一次执行结果；回不上去就算了，电脑那边会按超时处理。 */
    private void report(String id, boolean ok, String message) {
        final String base = baseUrl;
        final String cred = credential;
        if (base == null || cred == null) return;
        new Thread(() -> {
            try {
                String payload = "{\"id\":\"" + id + "\",\"ok\":" + ok
                        + ",\"result\":\"" + message.replace("\"", "'") + "\"}";
                Net.postJson(base + "/mini/api/bridge/result", payload, cred);
            } catch (Exception ignored) {
                // 回报失败不重试：重试可能让同一件事执行两遍。
            }
        }, "mini-bridge-report").start();
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
