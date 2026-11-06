package com.dsh.miniremote;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.Locale;

/** 手机页 WebView 壳：恢复配对凭据、探测地址、按地址写设备 Cookie。 */
public final class MainActivity extends Activity {
    /** 点「后台连接被挂起」那条通知进来时带上：强制再弹一次引导。 */
    static final String EXTRA_BACKGROUND_HINT = "backgroundHint";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private PairingStore.Credentials credentials;
    private AddressPool addressPool;
    private WebView webView;
    private String loadedBase;
    private boolean probing;
    private boolean destroyed;
    private int loadGeneration;
    /** 系统分享进来的内容，等地址就绪后发出去（2026-11-06）。 */
    private ShareSender.Payload pendingShare;
    /** 页面加载完了没有：分享要等页面能接收才注入。 */
    private boolean pageReady;
    private String pendingShareJson;
    /** 前台轮询待审批：把锁屏推送唤起后的通知画出来。 */
    private PendingPoller poller;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        PairingStore store = new PairingStore(this);
        try {
            credentials = store.load();
        } catch (GeneralSecurityException | IOException e) {
            showFatalMessage("本机配对凭据读取失败。请重新打开应用；若仍失败，请重新配对。");
            return;
        }
        if (credentials == null) {
            startActivity(new Intent(this, PairActivity.class));
            finish();
            return;
        }

        addressPool = new AddressPool(credentials.addresses);
        webView = new WebView(this);
        setContentView(webView);
        // 调试版才开远程调试（chrome://inspect / adb forward），发布版不留这个口子。
        // 2026-11-06 加：页面连不上推送流时要能在电脑上看到 WebView 的控制台与网络。
        boolean debuggable = (getApplicationInfo().flags
                & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        webView.getSettings().setJavaScriptEnabled(true);
        webView.getSettings().setDomStorageEnabled(true);
        webView.setWebViewClient(new PairedHostClient());
        // Android 13 起通知要运行时授权；不申请的话，锁屏提醒和「批准/拒绝」按钮
        // 会被系统静默丢掉，前台服务等于白跑（2026-11-06 补）。
        if (android.os.Build.VERSION.SDK_INT >= 33
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 1);
        }
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);
        probeAddresses();
        if (getIntent().getBooleanExtra(EXTRA_BACKGROUND_HINT, false)) {
            getIntent().removeExtra(EXTRA_BACKGROUND_HINT);
            explainBackground(true);
        } else {
            explainBackground(false);
        }
        // 系统分享进来的内容：等地址探测完（selectAddress）再发，这里先收下。
        pendingShare = ShareSender.parse(getIntent());
        if (pendingShare != null) {
            deliverPendingShare();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && intent.getBooleanExtra(EXTRA_BACKGROUND_HINT, false)) {
            intent.removeExtra(EXTRA_BACKGROUND_HINT);
            explainBackground(true);
        }
        ShareSender.Payload shared = ShareSender.parse(intent);
        if (shared != null) {
            pendingShare = shared;
            deliverPendingShare();
        }
    }

    /** 分享内容要等拿到地址、写好 Cookie 之后再发；早到的就等 selectAddress 来叫。 */
    private void deliverPendingShare() {
        final ShareSender.Payload payload = pendingShare;
        if (payload == null || loadedBase == null || credentials == null) {
            return;
        }
        pendingShare = null;
        final String base = loadedBase;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    org.json.JSONObject result = ShareSender.upload(MainActivity.this, base,
                            credentials.deviceCredential(), payload);
                    injectShare(result.toString());
                } catch (Exception err) {
                    ShareSender.toast(MainActivity.this, "分享失败：" + err.getMessage());
                }
            }
        }, "mini-share").start();
    }

    /** 把文件挂进网页那边的输入框；页面还没加载好就先存着，onPageFinished 再来一次。 */
    private void injectShare(final String json) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (!pageReady || webView == null) {
                    pendingShareJson = json;
                    return;
                }
                webView.evaluateJavascript(
                        "(typeof window.miniComposeShare === 'function')"
                                + " ? window.miniComposeShare(" + json + ") : -1",
                        new ValueCallback<String>() {
                            @Override
                            public void onReceiveValue(String value) {
                                boolean ok = value != null && !"null".equals(value) && !"-1".equals(value);
                                ShareSender.toast(MainActivity.this,
                                        ok ? "已放入输入框" : "页面还没更新，请重启 DSH 后重试");
                            }
                        });
            }
        });
    }

    /**
     * 锁屏提醒的前提：系统不能把本应用冻结在后台（2026-11-06 真机结论）。
     * 荣耀实测：不放行时前台服务还在、通知也在，但连接被挂起，审批收不到。
     * 首次进主界面提醒一次；后台连接反复失败时点通知进来，force=true 再提醒一次。
     */
    private void explainBackground(boolean force) {
        if (Build.VERSION.SDK_INT < 23) {
            return;
        }
        SharedPreferences prefs = getSharedPreferences("mini.prefs", MODE_PRIVATE);
        if (!force && prefs.getBoolean("backgroundHintShown", false)) {
            return;
        }
        prefs.edit().putBoolean("backgroundHintShown", true).apply();
        new AlertDialog.Builder(this)
                .setTitle("锁屏提醒需要一项系统设置")
                .setMessage("国产手机默认会冻结后台应用，锁屏后就收不到审批提醒。\n\n"
                        + "请在系统的「电池 → 应用启动管理」里把「DSH 极简遥控器」改成"
                        + "允许后台活动；点「去设置」会打开本应用的详情页。")
                .setPositiveButton("去设置", (dialog, which) -> openBatterySettings())
                .setNegativeButton("知道了", null)
                .show();
    }

    private void openBatterySettings() {
        // 2026-11-06 真机：荣耀不认 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS（能解析但页面立刻关掉），
        // 应用详情页则一定存在。所以直接开详情页，用户从那里进「电池 / 耗电管理」。
        try {
            startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                    Uri.parse("package:" + getPackageName())));
        } catch (Exception ignored) {
            // 连详情页都打不开就什么也不做，别让用户卡在一个空对话框上。
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 回到前台时重新按地址池顺序探测；网络切换后的首次操作不会长期困在旧地址。
        if (addressPool != null) {
            probeAddresses();
        }
        if (poller != null && loadedBase != null) {
            startPolling(loadedBase);
        }
        // 回前台：前台轮询接手，长连接让位——两条同时跑只会重复提醒。
        MiniForegroundService.stop(this);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // 退到后台就停轮询；改由前台服务保持一条推送连接，否则锁屏后什么都收不到。
        if (poller != null) {
            poller.stop();
        }
        if (loadedBase != null && credentials != null) {
            MiniForegroundService.start(this, loadedBase, credentials.deviceCredential());
        }
    }

    private void probeAddresses() {
        if (probing || destroyed || addressPool == null) {
            return;
        }
        probing = true;
        final String deviceCredential = credentials.deviceCredential();
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                final AddressPool.ProbeResult result = addressPool.probe(new AddressPool.Prober() {
                    @Override
                    public boolean probe(String baseUrl) {
                        try {
                            Net.Response response = Net.get(
                                    baseUrl + "/mini/api/version", deviceCredential);
                            return response.isSuccess();
                        } catch (IOException e) {
                            return false;
                        }
                    }
                });
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (destroyed) {
                            return;
                        }
                        probing = false;
                        if (result.alreadyProbing) {
                            return;
                        }
                        if (result.current != null) {
                            selectAddress(result.current.baseUrl);
                        } else if (loadedBase == null) {
                            showPageMessage("暂时连不上电脑",
                                    "内网、Tailscale 和固定地址都探测失败。请检查电脑端服务与手机网络，再回到本应用重试。");
                        } else {
                            Toast.makeText(MainActivity.this,
                                    "所有配对地址暂时都不可用，请稍后重试。", Toast.LENGTH_LONG).show();
                        }
                    }
                });
            }
        }, "mini-address-probe");
        thread.start();
    }

    /** 轮询只在前台跑；地址换一条就按新地址重开一轮。 */
    private void startPolling(String baseUrl) {
        if (poller == null) {
            poller = new PendingPoller(this);
        }
        poller.stop();
        poller.start(baseUrl, credentials.deviceCredential());
    }

    /** Cookie 按 base URL 的主机隔离，所以每次换地址都必须重新写一次。 */
    private void selectAddress(final String baseUrl) {
        if (baseUrl.equals(loadedBase)) {
            return;
        }
        final int generation = ++loadGeneration;
        final CookieManager cookies = CookieManager.getInstance();
        StringBuilder cookie = new StringBuilder("dsh_mini_device=")
                .append(credentials.deviceCredential())
                .append("; Path=/mini; HttpOnly; SameSite=Lax");
        if (baseUrl.toLowerCase(Locale.ROOT).startsWith("https:")) {
            cookie.append("; Secure");
        }
        cookies.setCookie(baseUrl, cookie.toString(), new ValueCallback<Boolean>() {
            @Override
            public void onReceiveValue(Boolean accepted) {
                // setCookie 完成后先 flush，再加载页面，避免首请求抢在 Cookie 落盘前发出。
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (destroyed || generation != loadGeneration) {
                            return;
                        }
                        cookies.flush();
                        loadedBase = baseUrl;
                        pageReady = false;
                        webView.loadUrl(baseUrl + "/mini/");
                        startPolling(baseUrl);
                        deliverPendingShare();
                    }
                });
            }
        });
    }

    private void showPageMessage(String title, String detail) {
        if (webView == null) {
            showFatalMessage(title + "。\n" + detail);
            return;
        }
        String html = "<!doctype html><html><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1'></head>"
                + "<body style='font-family:sans-serif;padding:32px;line-height:1.7'>"
                + "<h2>" + title + "</h2><p>" + detail + "</p></body></html>";
        webView.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
    }

    private void showFatalMessage(String message) {
        TextView view = new TextView(this);
        view.setText(message);
        view.setTextSize(17);
        int padding = Math.round(24 * getResources().getDisplayMetrics().density);
        view.setPadding(padding, padding, padding, padding);
        setContentView(view);
    }

    /** 只允许导航到配对地址池中的源，避免页面把设备 Cookie 带到陌生主机。 */
    private boolean isPairedOrigin(Uri uri) {
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null
                || !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))) {
            return false;
        }
        for (AddressPool.Entry entry : addressPool.getEntries()) {
            Uri allowed = Uri.parse(entry.baseUrl);
            if (scheme.equalsIgnoreCase(allowed.getScheme())
                    && host.equalsIgnoreCase(allowed.getHost())
                    && effectivePort(uri) == effectivePort(allowed)) {
                return true;
            }
        }
        return false;
    }

    private static int effectivePort(Uri uri) {
        if (uri.getPort() >= 0) {
            return uri.getPort();
        }
        return "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
    }

    private final class PairedHostClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            if (isPairedOrigin(request.getUrl())) {
                return false;
            }
            Toast.makeText(MainActivity.this, "已阻止打开配对范围之外的地址。", Toast.LENGTH_SHORT).show();
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady = true;
            if (pendingShareJson != null) {
                String json = pendingShareJson;
                pendingShareJson = null;
                injectShare(json);
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        loadGeneration++;
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
