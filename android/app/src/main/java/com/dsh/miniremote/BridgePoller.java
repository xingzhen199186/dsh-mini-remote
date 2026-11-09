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
    private Thread thread;
    private String baseUrl;
    private String credential;
    private Runnable onChange;

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
                String url = baseUrl + "/mini/api/bridge/poll?wait=1&protocol=1";
                // 读超时要比服务端压的 25 秒更长，否则正常的长轮询会被当成失败。
                Net.Response response = Net.getLong(url, credential, 35_000);
                boolean ok = response.isSuccess() && response.body != null && !response.body.isEmpty();
                if (ok) {
                    JSONObject root = new JSONObject(response.body);
                    boolean armed = root.optBoolean("armed", false);
                    failures = 0;
                    online = armed;
                    notifyChange();
                    // 武装被关掉（比如在电脑侧关的）就停：没有授权就不该继续问。
                    if (!armed) {
                        running = false;
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

    private void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException err) {
            Thread.currentThread().interrupt();
            running = false;
        }
    }
}
