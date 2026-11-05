package com.dsh.miniremote;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

/**
 * 前台轮询「还挂着什么待审批」。
 *
 * 为什么需要它：锁屏时只有系统推送喊得醒人（见服务端的待审批推送），而推送里只带
 * 一个编号。要把通知画出来（批准 / 拒绝两个按钮），客户端得能按编号确认它还在。
 *
 * 只在应用在前台时跑：退到后台就停，不为一个轮询常驻后台——那是 P2 手机桥才做的事。
 * 一次拉不到就等下一轮，不弹错、不打扰用户。
 */
final class PendingPoller {
    /** 20 秒一次：人看着屏幕时，这个节奏既不迟钝也不费电。 */
    private static final long INTERVAL_MS = 20_000L;
    /** 刚打开时先等一会儿：页面自己还在探测地址。 */
    private static final long FIRST_DELAY_MS = 3_000L;

    private final Activity activity;
    private final Handler handler = new Handler(Looper.getMainLooper());
    /** 已经画过通知的编号：同一件事只提醒一次。 */
    private final Set<String> shown = new HashSet<>();

    private String baseUrl;
    private String credential;
    private boolean running;

    PendingPoller(Activity activity) {
        this.activity = activity;
    }

    void start(String baseUrl, String credential) {
        this.baseUrl = baseUrl;
        this.credential = credential;
        if (running || baseUrl == null || credential == null) {
            return;
        }
        running = true;
        handler.postDelayed(tick, FIRST_DELAY_MS);
    }

    void stop() {
        running = false;
        handler.removeCallbacks(tick);
    }

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!running) {
                return;
            }
            final String base = baseUrl;
            final String cred = credential;
            if (base == null || cred == null) {
                handler.postDelayed(this, INTERVAL_MS);
                return;
            }
            Thread thread = new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        Net.Response response = Net.get(base + "/mini/api/pending", cred);
                        if (response.isSuccess()) {
                            handle(base, response.body);
                        }
                    } catch (Exception ignored) {
                        // 网络抖一下不算事：下一轮再试，别用弹窗打断人。
                    }
                    handler.postDelayed(tick, INTERVAL_MS);
                }
            });
            thread.start();
        }
    };

    private void handle(final String base, String body) {
        if (body == null || body.isEmpty()) {
            return;
        }
        try {
            JSONObject root = new JSONObject(body);
            JSONArray approvals = root.optJSONArray("approvals");
            if (approvals == null) {
                return;
            }
            for (int i = 0; i < approvals.length(); i += 1) {
                JSONObject item = approvals.optJSONObject(i);
                if (item == null) {
                    continue;
                }
                final String id = item.optString("id", "");
                if (id.isEmpty() || shown.contains(id)) {
                    continue;
                }
                shown.add(id);
                handler.post(new Runnable() {
                    @Override
                    public void run() {
                        Notifier.showApproval(activity, base, id);
                    }
                });
            }
        } catch (Exception ignored) {
            // 返回体不是预期的样子就当这一轮没拿到，不猜、不报警。
        }
    }
}
