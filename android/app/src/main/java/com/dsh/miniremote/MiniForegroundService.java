package com.dsh.miniremote;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.util.HashSet;
import java.util.Set;

/**
 * 锁屏也能收到待审批：任务进行期间保持一条服务器推送连接（2026-11-04）。
 *
 * 为什么必须是前台服务：应用退到后台后，普通轮询会被系统挂起，锁屏时什么都收不到。
 * 前台服务带一条常驻通知，系统允许它继续跑——这也是 Android 官方对「正在进行的任务」
 * 给出的唯一合法路径。
 *
 * **什么时候停**：应用回到前台（Activity 自己在轮询，不需要两条连接）、连接连续失败、
 * 或者用户点了停止。Android 15 起 dataSync 每 24 小时最多 6 小时，超时系统会回调
 * onTimeout，这里如实停掉，不做对抗。
 */
public final class MiniForegroundService extends Service {
    static final String EXTRA_BASE_URL = "baseUrl";
    static final String EXTRA_CREDENTIAL = "credential";
    /** 后台期间是否把手机桥的心跳接过来（2026-11-09 加固）。 */
    static final String EXTRA_BRIDGE = "bridge";

    private static final int NOTIFICATION_ID = 0x4d524001;
    private static final long RETRY_DELAY_MS = 5_000L;
    private static final int MAX_FAILURES = 6;

    private Thread worker;
    private volatile boolean running;
    private String baseUrl;
    private String credential;
    /** 已经弹过通知的编号：同一条审批只提醒一次。 */
    private final Set<String> shown = new HashSet<>();
    /** 后台连接反复失败时只提醒一次，避免每次重试都弹。 */
    private boolean hinted;
    /** 锁屏期间保住 CPU 和 Wi-Fi：否则 socket 还在，数据要等解锁才读（2026-11-06 实测）。 */
    private android.os.PowerManager.WakeLock wakeLock;
    /** 唤醒锁一次租多久：短租+续租，系统不会判成"长时间阻止休眠"。 */
    private static final long WAKE_LOCK_MS = 10 * 60 * 1000L;
    /** 后台查询间隔：十五秒，够及时，也不费电。 */
    private static final long POLL_INTERVAL_MS = 15_000L;
    private android.net.wifi.WifiManager.WifiLock wifiLock;
    /** 上一次 state 帧里任务是不是在跑：用来抓「跑完了」这一刻。 */
    private boolean wasRunning;
    /** 上一次查询时任务在不在跑：用来抓「刚刚跑完」那一刻。 */
    private boolean previousRunning;
    /** 任务结束后收摊的定时器：常驻通知不该在没任务时一直挂着。 */
    private Runnable idleStop;
    /** 后台维持的手机桥心跳；不需要时保持 null。 */
    private BridgePoller bridgePoller;
    private boolean wantBridge;
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());

    static void start(Context context, String baseUrl, String credential) {
        start(context, baseUrl, credential, false);
    }

    /**
     * @param keepBridge 退到后台后是否**继续维持手机桥的心跳**。
     *   以前桥的心跳只活在界面里：App 一退到后台、界面被系统回收，桥就悄悄断了，
     *   电脑那边从此看不到这台手机（2026-11-09 加固的第一条）。
     */
    static void start(Context context, String baseUrl, String credential, boolean keepBridge) {
        if (baseUrl == null || credential == null) {
            return;
        }
        Intent intent = new Intent(context, MiniForegroundService.class);
        intent.putExtra(EXTRA_BASE_URL, baseUrl);
        intent.putExtra(EXTRA_CREDENTIAL, credential);
        intent.putExtra(EXTRA_BRIDGE, keepBridge);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    static void stop(Context context) {
        context.stopService(new Intent(context, MiniForegroundService.class));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        baseUrl = intent == null ? null : intent.getStringExtra(EXTRA_BASE_URL);
        credential = intent == null ? null : intent.getStringExtra(EXTRA_CREDENTIAL);
        if (baseUrl == null || credential == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            startForeground(NOTIFICATION_ID, Notifier.serviceNotification(this, "正在盯着任务", "锁屏后也能收到审批提醒"));
        } catch (RuntimeException e) {
            // 挂不上前台通知就别硬撑，否则系统五秒后会判我们超时并把进程杀掉。
            stopSelf();
            return START_NOT_STICKY;
        }
        acquireLocks();
        wantBridge = intent != null && intent.getBooleanExtra(EXTRA_BRIDGE, false);
        if (wantBridge) {
            if (bridgePoller == null) {
                bridgePoller = new BridgePoller();
                bridgePoller.attach(this);
            }
            // 服务启动可能晚于一次停止；读取授权与启动必须走同一个临界区。
            BridgeControl.syncPoller(this, bridgePoller, baseUrl, credential);
        } else if (bridgePoller != null) {
            bridgePoller.stop();
            bridgePoller = null;
        }
        if (!running) {
            running = true;
            worker = new Thread(new Runnable() {
                @Override
                public void run() {
                    listenLoop();
                }
            }, "mini-sse");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        if (idleStop != null) {
            main.removeCallbacks(idleStop);
            idleStop = null;
        }
        running = false;
        if (bridgePoller != null) {
            bridgePoller.stop();
            bridgePoller = null;
        }
        if (worker != null) {
            worker.interrupt();
            worker = null;
        }
        main.removeCallbacks(renew);
        releaseLocks();
        super.onDestroy();
    }

    /** 只在服务存活期间持有；应用回到前台就停服务，不会长期占着。 */
    private void acquireLocks() {
        if (wakeLock == null) {
            android.os.PowerManager pm =
                    (android.os.PowerManager) getSystemService(POWER_SERVICE);
            wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "dsh-mini:sse");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) {
            // 一次只租十分钟：系统看到"长时间持有唤醒锁"会给用户弹红字
            // 「阻止系统休眠，耗电过快」。任务还在跑就续租，任务结束就不再续
            // （2026-11-08 用户看到的那条告警就是这么来的）。
            wakeLock.acquire(WAKE_LOCK_MS);
        }
        scheduleRenew();
        if (wifiLock == null) {
            android.net.wifi.WifiManager wm =
                    (android.net.wifi.WifiManager) getApplicationContext()
                            .getSystemService(WIFI_SERVICE);
            wifiLock = wm.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF,
                    "dsh-mini:sse");
            wifiLock.setReferenceCounted(false);
        }
        if (!wifiLock.isHeld()) {
            wifiLock.acquire();
        }
    }

    private void releaseLocks() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        if (wifiLock != null && wifiLock.isHeld()) {
            wifiLock.release();
        }
    }

    /** 续租：锁到期前再租一次，直到服务被停。 */
    private void scheduleRenew() {
        main.removeCallbacks(renew);
        if (!running) {
            return;
        }
        main.postDelayed(renew, WAKE_LOCK_MS - 60_000L);
    }

    private final Runnable renew = new Runnable() {
        @Override
        public void run() {
            if (!running) {
                return;
            }
            if (wakeLock != null && !wakeLock.isHeld()) {
                wakeLock.acquire(WAKE_LOCK_MS);
            }
            scheduleRenew();
        }
    };

    /** 连接断了就等一会儿再连；连续失败太多次就收摊，不无限重试耗电。 */
    /** 临时诊断：后台连接为什么没建立起来，写文件里看。 */
    private void trace(String message) {
        try (java.io.FileWriter writer = new java.io.FileWriter(
                new java.io.File(getFilesDir(), "sse.log"), true)) {
            writer.write(new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.US)
                    .format(new java.util.Date()) + " " + message + "\n");
        } catch (Exception ignored) {
            // 诊断日志写不进去不影响功能。
        }
    }

    /**
     * 后台就干一件事：隔一会儿问电脑「任务还在跑吗、有没有新审批」（2026-11-08）。
     *
     * 原来这里挂的是一条长连接推送。实测下来，长连接经我们内置的 Tailscale 隧道
     * 会卡在等响应（普通请求却能通），于是锁屏后什么都收不到。查询是普通请求，
     * 走的是同一条已经验证可用的路径；十五秒问一次，对电量的影响可以忽略。
     */
    private void listenLoop() {
        int failures = 0;
        trace("poll loop start base=" + baseUrl + " proxy=" + Net.hasTailnetProxy());
        while (running) {
            try {
                pollOnce();
                failures = 0;
            } catch (Exception err) {
                failures += 1;
                trace("poll fail#" + failures + " " + err);
                if (failures == 3 && !hinted) {
                    hinted = true;
                    Notifier.showBackgroundHint(this);
                }
            }
            if (!running) {
                break;
            }
            try {
                Thread.sleep(POLL_INTERVAL_MS);
            } catch (InterruptedException stop) {
                break;
            }
        }
        stopSelf();
    }

    /** 问一次电脑：任务在不在跑、有没有新的审批和提问。 */
    private void pollOnce() throws Exception {
        Net.Response response = Net.get(baseUrl + "/mini/api/pending", credential);
        if (!response.isSuccess() || response.body == null || response.body.isEmpty()) {
            throw new IllegalStateException("查询没拿到结果（" + response.status + "）");
        }
        JSONObject root = new JSONObject(response.body);
        boolean nowRunning = root.has("running") ? root.optBoolean("running", false) : true;
        if (previousRunning && !nowRunning) {
            // 通知正文用最后一条回复的第一行，别只写一句「回去看」
            //（2026-11-08 用户要求）。
            String latest = root.optJSONObject("latest") == null
                    ? "" : root.optJSONObject("latest").optString("text", "");
            Notifier.showDone(this, latest);
        }
        previousRunning = nowRunning;
        // 任务不在了就等半分钟收摊：给「跑完了」那条通知留一点时间被人看见。
        if (nowRunning) {
            cancelIdleStop();
        } else if (idleStop == null && !wantBridge) {
            /* **桥开着就不能自己收摊**（2026-11-10 真机撞上）。
             *
             * 原来这里不看 wantBridge：锁屏把界面收走后，服务接了桥的心跳，但"没有任务在跑"
             * 三分钟后照旧 stopSelf——于是桥静默死掉，电脑那边从此看不到这台手机。
             * 表现就是"锁屏一会儿再发通知，发不出去"。
             */
            idleStop = new Runnable() {
                @Override
                public void run() {
                    idleStop = null;
                    stopSelf();
                }
            };
            // 3 分钟：给"刚发完一句话、任务还没起来"留足时间。
            // 太短会把刚发出去的那一轮漏掉，太长又白耗电和配额。
            main.postDelayed(idleStop, 180_000L);
        }
        JSONArray approvals = root.optJSONArray("approvals");
        if (approvals != null) {
            for (int i = 0; i < approvals.length(); i += 1) {
                JSONObject item = approvals.optJSONObject(i);
                String id = item == null ? null : item.optString("id", "");
                if (id != null && !id.isEmpty() && shown.add(id)) {
                    Notifier.showApproval(this, baseUrl, id);
                }
            }
        }
        JSONArray questions = root.optJSONArray("questions");
        if (questions != null) {
            for (int i = 0; i < questions.length(); i += 1) {
                JSONObject item = questions.optJSONObject(i);
                String id = item == null ? null : item.optString("id", "");
                if (id != null && !id.isEmpty() && shown.add(id)) {
                    // 带选项的单题：选项直接做成通知按钮（2026-11-14）。
                    JSONArray opts = item.optJSONArray("options");
                    String questionId = item.optString("questionId", "");
                    if (opts != null && opts.length() > 0 && !questionId.isEmpty()) {
                        java.util.List<String> labels = new java.util.ArrayList<>();
                        for (int k = 0; k < opts.length(); k++) {
                            String one = opts.optString(k, "");
                            if (!one.isEmpty()) labels.add(one);
                        }
                        Notifier.showQuestion(this, baseUrl, id, questionId, labels);
                    } else {
                        Notifier.showInfo(this, "DSH 有一道题等你回答", "打开应用作答。", id);
                    }
                }
            }
        }
    }

    private void cancelIdleStop() {
        if (idleStop != null) {
            main.removeCallbacks(idleStop);
            idleStop = null;
        }
    }

    private void readStream() throws Exception {
        String url = baseUrl + "/mini/api/stream";
        trace("stream: 开始请求 " + url);
        long t0 = System.currentTimeMillis();
        Net.Response response = Net.getStream(url, credential, 15000);
        trace("stream: 头部到手 " + (System.currentTimeMillis() - t0) + "ms status=" + response.status);
        if (!response.isSuccess() || response.stream == null) {
            throw new IllegalStateException("推送连接没建立起来");
        }
        BufferedReader reader = new BufferedReader(new InputStreamReader(response.stream, "UTF-8"));
        android.util.Log.i("MiniSSE", "stream open: " + url);
        String event = null;
        StringBuilder data = new StringBuilder();
        String line;
        while (running && (line = reader.readLine()) != null) {
            if (line.isEmpty()) {
                handle(event, data.toString());
                event = null;
                data.setLength(0);
                continue;
            }
            if (line.startsWith("event:")) {
                event = line.substring(6).trim();
            } else if (line.startsWith("data:")) {
                data.append(line.substring(5).trim());
            }
        }
    }

    private void handle(String event, String raw) {
        if (event == null || raw.isEmpty()) {
            return;
        }
        android.util.Log.i("MiniSSE", "event=" + event + " len=" + raw.length());
        if ("approval".equals(event)) {
            String id = idOf(raw);
            android.util.Log.i("MiniSSE", "approval id=" + id);
            if (id != null && shown.add(id)) {
                Notifier.showApproval(this, baseUrl, id);
            }
        } else if ("state".equals(event)) {
            JSONObject json = parse(raw);
            if (json == null) {
                return;
            }
            boolean running = json.optBoolean("running", false);
            if (wasRunning && !running) {
                JSONObject latest = json.optJSONObject("latest");
                String text = latest == null ? "" : latest.optString("text", "");
                Notifier.showDone(this, firstLine(text));
            }
            wasRunning = running;
            // 任务不在了就等半分钟收摊：给「跑完了」那条通知留一点时间被人看见，
            // 然后连常驻通知一起撤掉。任务又跑起来就把收摊撤销。
            if (running) {
                if (idleStop != null) {
                    main.removeCallbacks(idleStop);
                    idleStop = null;
                }
            } else if (idleStop == null) {
                idleStop = new Runnable() {
                    @Override
                    public void run() {
                        idleStop = null;
                        stopSelf();
                    }
                };
                main.postDelayed(idleStop, 30_000L);
            }
        } else if ("question".equals(event)) {
            String id = idOf(raw);
            if (id != null && shown.add(id)) {
                // 这条路上 raw 里带着完整题目，单题且有选项时同样把选项画成按钮（2026-11-14）。
                boolean drawn = false;
                try {
                    org.json.JSONObject payload = new org.json.JSONObject(raw == null ? "{}" : raw);
                    org.json.JSONArray qs = payload.optJSONArray("questions");
                    if (qs != null && qs.length() == 1) {
                        org.json.JSONObject one = qs.optJSONObject(0);
                        org.json.JSONArray opts = one == null ? null : one.optJSONArray("options");
                        String questionId = one == null ? "" : one.optString("id", "");
                        if (opts != null && opts.length() > 0 && !questionId.isEmpty()) {
                            java.util.List<String> labels = new java.util.ArrayList<>();
                            for (int k = 0; k < opts.length() && k < 3; k++) {
                                org.json.JSONObject opt = opts.optJSONObject(k);
                                String label = opt == null ? "" : opt.optString("label", "");
                                if (!label.isEmpty()) labels.add(label);
                            }
                            if (!labels.isEmpty()) {
                                Notifier.showQuestion(this, baseUrl, id, questionId, labels);
                                drawn = true;
                            }
                        }
                    }
                } catch (Exception ignored) {
                    // 读不出来就退回原来那句提示。
                }
                if (!drawn) {
                    Notifier.showInfo(this, "DSH 有一道题等你回答", "打开应用作答。", id);
                }
            }
        }
    }

    private static JSONObject parse(String raw) {
        try {
            return new JSONObject(raw);
        } catch (Exception ignored) {
            return null;
        }
    }

    /** 通知栏只放得下一行：取正文第一行，去掉引用符号，太长就截断。 */
    private static String firstLine(String text) {
        if (text == null) {
            return "";
        }
        String line = text.trim();
        int nl = line.indexOf('\n');
        if (nl >= 0) {
            line = line.substring(0, nl);
        }
        line = line.replaceFirst("^#+\\s*", "").replaceFirst("^[-*]\\s+", "").trim();
        return line.length() > 90 ? line.substring(0, 90) + "…" : line;
    }

    private static String idOf(String raw) {
        try {
            JSONObject json = new JSONObject(raw);
            String id = json.optString("id", "");
            return id.isEmpty() ? null : id;
        } catch (Exception ignored) {
            return null;
        }
    }
}
