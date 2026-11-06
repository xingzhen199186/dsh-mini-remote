package com.dsh.miniremote;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;

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
    private android.net.wifi.WifiManager.WifiLock wifiLock;
    /** 上一次 state 帧里任务是不是在跑：用来抓「跑完了」这一刻。 */
    private boolean wasRunning;
    /** 任务结束后收摊的定时器：常驻通知不该在没任务时一直挂着。 */
    private Runnable idleStop;
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());

    static void start(Context context, String baseUrl, String credential) {
        if (baseUrl == null || credential == null) {
            return;
        }
        Intent intent = new Intent(context, MiniForegroundService.class);
        intent.putExtra(EXTRA_BASE_URL, baseUrl);
        intent.putExtra(EXTRA_CREDENTIAL, credential);
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
        startForeground(NOTIFICATION_ID, Notifier.serviceNotification(this, "正在盯着任务", "锁屏后也能收到审批提醒"));
        acquireLocks();
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
        if (worker != null) {
            worker.interrupt();
            worker = null;
        }
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
            wakeLock.acquire();
        }
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

    /** 连接断了就等一会儿再连；连续失败太多次就收摊，不无限重试耗电。 */
    private void listenLoop() {
        int failures = 0;
        while (running) {
            try {
                readStream();
                failures = 0;
            } catch (Exception err) {
                failures += 1;
                android.util.Log.w("MiniSSE", "stream failed (" + failures + "): " + err);
                // 连续三次连不上：多半是系统把后台冻结了（2026-11-06 荣耀实测）。
                // 只提醒一次，点通知回去检查电池设置。
                if (failures == 3 && !hinted) {
                    hinted = true;
                    Notifier.showBackgroundHint(this);
                }
            }
            if (!running || failures >= MAX_FAILURES) {
                break;
            }
            try {
                Thread.sleep(RETRY_DELAY_MS);
            } catch (InterruptedException stop) {
                break;
            }
        }
        stopSelf();
    }

    private void readStream() throws Exception {
        String url = baseUrl + "/mini/api/stream";
        Net.Response response = Net.getStream(url, credential);
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
                Notifier.showInfo(this, "DSH 有一道题等你回答", "打开应用作答。", id);
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
