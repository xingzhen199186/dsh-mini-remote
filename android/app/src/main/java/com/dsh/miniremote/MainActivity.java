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
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import java.io.File;
import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

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
    /** 网页里 <input type="file"> 的回调与相机输出位置（2026-11-06）。 */
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraOutput;
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
        // 设置页「连接」那一块的数据源：线路清单、切换、增删（2026-11-07）。
        webView.addJavascriptInterface(new ConnectionBridge(), "MiniConn");
        webView.setWebViewClient(new PairedHostClient());
        webView.setWebChromeClient(new FileChooserClient());
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


    /**
     * 设置页里的「连接」区块，只有 App 里才有（2026-11-07）。
     *
     * 默认收起；展开后是一张线路清单：当前那条标「使用中」，其它可以一键切换，
     * 底下能手动加地址、也能删。数据全部来自外壳（window.MiniConn），
     * 页面自己的设置项一个都没碰。
     */
    private static final String CONN_SECTION_JS = """
            (function(){
              if (window.__miniConnUi) return;
              var bridge = window.MiniConn;
              if (!bridge) return;
              var host = document.querySelector('#settings .sheet-body');
              if (!host) return;
              window.__miniConnUi = 1;

              var block = document.createElement('div');
              block.id = 'miniConnBlock';
              block.innerHTML =
                '<div class="row"><div>'
                + '<div class="label">连接</div>'
                + '<div class="hint" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">'
                + '<span id="miniConnStatus">—</span><span>·</span><span id="miniConnSummary"></span>'
                + '</div></div>'
                + '<div id="miniConnActions" style="display:flex;gap:8px;flex:0 0 auto"></div>'
                + '</div>'
                + '<div id="miniConnBody" hidden></div>';
              host.insertBefore(block, host.firstChild);

              var body = block.querySelector('#miniConnBody');
              var summary = block.querySelector('#miniConnSummary');
              var statusSlot = block.querySelector('#miniConnStatus');
              var actions = block.querySelector('#miniConnActions');

              var toggle = document.createElement('button');
              toggle.className = 'btn';
              toggle.type = 'button';
              toggle.textContent = '展开';

              // 页面本来那条「连接」（状态 + 重连）搬进来，旧行藏掉：设置里只留一处。
              var reconnect = document.getElementById('btnReconnect');
              var connHint = document.getElementById('connHint');
              var oldRow = reconnect ? reconnect.closest('.row') : null;
              if (connHint) statusSlot.replaceWith(connHint);
              if (reconnect) actions.appendChild(reconnect);
              actions.appendChild(toggle);
              if (oldRow) oldRow.hidden = true;

              toggle.addEventListener('click', function(){
                var open = !body.hidden;
                body.hidden = open;
                toggle.textContent = open ? '展开' : '收起';
              });

              function esc(v){
                return String(v == null ? '' : v).replace(/[&<>"]/g, function(c){
                  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
                });
              }
              function row(label, hint, buttons){
                return '<div class="row"><div>'
                  + '<div class="label">' + esc(label) + '</div>'
                  + '<div class="hint">' + hint + '</div></div>'
                  + '<div style="display:flex;gap:8px;flex:0 0 auto">' + buttons + '</div></div>';
              }

              function render(){
                var data = {};
                try { data = JSON.parse(bridge.state() || '{}'); } catch (e) { data = {}; }
                var items = data.items || [];
                summary.textContent = items.length ? (items.length + ' 条线路') : '还没有可用的线路';
                var html = '';
                items.forEach(function(it){
                  var hint = esc(it.url) + (it.current ? ' · 使用中' : '');
                  var buttons = it.current
                    ? '<button class="btn" type="button" disabled>当前</button>'
                    : '<button class="btn" type="button" data-use="' + esc(it.url) + '">切换</button>';
                  if (it.type === 'manual') {
                    buttons += '<button class="btn" type="button" data-del="' + esc(it.url) + '">删除</button>';
                  }
                  html += row(it.label, hint, buttons);
                });
                html += '<div class="row"><input id="miniConnInput" type="url" placeholder="http://192.168.1.5:3090" '
                  + 'style="flex:1 1 auto;min-width:0;padding:10px 12px;border:1px solid var(--line);'
                  + 'border-radius:10px;background:var(--panel-2);color:var(--fg);font:inherit"></div>';
                html += row('添加地址', '粘贴电脑给的地址就能加一条线路',
                  '<button class="btn" id="miniConnAdd" type="button">添加</button>');
                body.innerHTML = html;

                Array.prototype.forEach.call(body.querySelectorAll('[data-use]'), function(btn){
                  btn.addEventListener('click', function(){
                    btn.textContent = '切换中…';
                    bridge.use(btn.getAttribute('data-use'));
                  });
                });
                Array.prototype.forEach.call(body.querySelectorAll('[data-del]'), function(btn){
                  btn.addEventListener('click', function(){
                    var url = btn.getAttribute('data-del');
                    if (!confirm('删掉这条线路？\\n' + url)) return;
                    var result = String(bridge.remove(url));
                    if (result.indexOf('err:') === 0) { alert(result.slice(4)); return; }
                    render();
                  });
                });
                var add = body.querySelector('#miniConnAdd');
                add.addEventListener('click', function(){
                  var input = body.querySelector('#miniConnInput');
                  var result = String(bridge.add(input.value || ''));
                  if (result.indexOf('err:') === 0) { alert(result.slice(4)); return; }
                  input.value = '';
                  render();
                });
              }
              render();
            })();
            """;

    /**
     * 状态栏/导航栏跟页面底色对齐（2026-11-06）。
     *
     * 壳默认给的是系统主题色，和页面的浅蓝底摆在一起能看出一条分界。这里问一下页面
     * 的 body 底色，把两条系统栏染成同一个颜色，界面就连成一整片了。
     */
    private void matchSystemBars() {
        if (webView == null) {
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return getComputedStyle(document.body).backgroundColor||''}catch(e){return ''}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        int color = parseCssColor(value);
                        if (color == 0) {
                            // 页面 body 常常是透明的（底色画在 html 或别处），这时候退回
                            // 一个浅色，别把状态栏染成黑的。
                            color = 0xFFF4F7FB;
                        }
                        getWindow().setStatusBarColor(color);
                        getWindow().setNavigationBarColor(color);
                        // 浅底配深色图标，否则时间/电量会看不见。
                        View decor = getWindow().getDecorView();
                        decor.setSystemUiVisibility(decor.getSystemUiVisibility()
                                | View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
                    }
                });
    }

    /** 把页面里的 rgb(...) / #rrggbb 解析成颜色；认不出来返回 0。 */
    private static int parseCssColor(String raw) {
        if (raw == null) {
            return 0;
        }
        String value = raw.replace("\"", "").trim();
        try {
            if (value.startsWith("#") && (value.length() == 7 || value.length() == 4)) {
                if (value.length() == 4) {
                    StringBuilder long_form = new StringBuilder("#");
                    for (int i = 1; i < 4; i += 1) {
                        long_form.append(value.charAt(i)).append(value.charAt(i));
                    }
                    value = long_form.toString();
                }
                return 0xFF000000 | Integer.parseInt(value.substring(1), 16);
            }
            if (value.startsWith("rgb")) {
                String inside = value.substring(value.indexOf('(') + 1, value.indexOf(')'));
                String[] parts = inside.split(",");
                int r = Integer.parseInt(parts[0].trim());
                int g = Integer.parseInt(parts[1].trim());
                int b = Integer.parseInt(parts[2].trim());
                if (parts.length >= 4) {
                    // 全透明的底色不能拿来染系统栏，否则就是一片黑。
                    double alpha = Double.parseDouble(parts[3].trim());
                    if (alpha <= 0.01) {
                        return 0;
                    }
                }
                return 0xFF000000 | (r << 16) | (g << 8) | b;
            }
        } catch (Exception ignored) {
            // 页面给了个怪颜色就当没拿到，保持系统默认。
        }
        return 0;
    }

    /**
     * 只给安卓壳用的样式补丁（2026-11-06）。
     *
     * 页面本来是按浏览器/桌面端设计的，套进手机壳后底部输入框贴着屏幕下沿、太挤。
     * 这里在页面加载完后注入一小段 CSS——只活在这个 WebView 里，网页端完全不受影响。
     */
    private void injectAppOnlyStyle() {
        if (webView == null) {
            return;
        }
        String css = "footer{"
                // 底栏本身只负责留白；真正的「框」是下面那个包裹层。
                + "padding:10px 14px calc(env(safe-area-inset-bottom,0px) + 26px) !important;"
                + "display:block !important;"
                + "}"
                // 输入框 + 工具栏同属一个圆角框：图标在里、框只有一层边。
                + "#miniConnBlock .btn{white-space:nowrap !important;}"
                + "#miniConnBlock .hint{overflow-wrap:anywhere !important;}"
                + "#miniComposer{"
                + "position:relative !important;"
                + "display:flex !important;flex-wrap:wrap !important;align-items:center !important;"
                + "width:100% !important;box-sizing:border-box !important;"
                + "border:1px solid var(--line) !important;border-radius:18px !important;"
                + "background:var(--panel-2) !important;"
                + "padding:6px 8px !important;min-height:46px !important;"
                + "}"
                + "#input{"
                + "order:1 !important;flex:1 1 100% !important;"
                + "border:none !important;background:transparent !important;box-shadow:none !important;"
                + "padding:6px 42px !important;min-height:34px !important;"
                + "}"
                // 打字后图标落到下面一行，文字就不再需要给它们让位：
                // 左边对齐鲸鱼、右边对齐发送键，两侧不留空档。
                + "body.mini-typing #input{padding:6px 8px 6px 2px !important;}"
                // 键盘起来时，底栏下面那点留白只剩原来的三分之一（26 → 9）。
                + "body.mini-typing footer{padding-bottom:calc(env(safe-area-inset-bottom,0px) + 9px) !important;}"
                + "#btnAttach{order:2 !important;}"
                + "#btnSend{order:3 !important;margin-left:auto !important;}"
                // 空白状态：两个图标浮在输入框两端、垂直居中。
                + "body:not(.mini-typing) #btnAttach,"
                + "body:not(.mini-typing) #btnSend{"
                + "position:absolute !important;top:50% !important;"
                + "transform:translateY(-50%) !important;margin:0 !important;z-index:2 !important;"
                + "}"
                + "body:not(.mini-typing) #btnAttach{left:18px !important;}"
                + "body:not(.mini-typing) #btnSend{right:18px !important;}"
                // 两个按钮统一尺寸，箭头居中。
                + "#btnAttach,#btnSend{"
                + "width:22px !important;height:22px !important;padding:0 !important;"
                + "display:flex !important;align-items:center !important;justify-content:center !important;"
                + "border-radius:10px !important;"
                + "}"
                + "#btnAttach{background:transparent !important;border:none !important;}"
                // 工具栏那一行：两个图标各往外让一点，框内两侧留出空白。
                + "body.mini-typing #btnAttach{margin:0 0 0 8px !important;}"
                + "body.mini-typing #btnSend{margin-right:8px !important;}"
                + "#btnAttach svg{width:22px !important;height:auto !important;}"
                + "#btnSend{"
                + "margin-left:auto !important;"
                + "border:none !important;border-radius:6px !important;"
                + "background:var(--act) !important;color:var(--on-act) !important;"
                + "font-size:0 !important;line-height:1 !important;"
                + "}"
                + "#btnSend::after{content:'\u2191';font-size:13px;line-height:1;display:block;}"
                + "main{padding-bottom:24px !important;}";
        String js = "(function(){"
                + "if(document.getElementById('mini-app-only-style'))return;"
                + "var s=document.createElement('style');"
                + "s.id='mini-app-only-style';"
                + "s.textContent=" + org.json.JSONObject.quote(css) + ";"
                + "(document.head||document.documentElement).appendChild(s);"
                + "})();";
        webView.evaluateJavascript(COMPOSER_WRAP_JS, null);
        webView.evaluateJavascript(js, null);
        webView.evaluateJavascript(COMPOSER_STATE_JS, null);
        webView.evaluateJavascript(CONN_SECTION_JS, null);
    }

    /**
     * 把输入框和两个按钮装进同一个容器（2026-11-06）。
     *
     * 页面原本把它们当成三个并排的独立元素；要做出「一整个圆角框、图标在里面」的效果，
     * 只能在外壳这边补一层容器。元素本身没换，页面绑的事件照旧。
     */
    private static final String COMPOSER_WRAP_JS = "(function(){"
            + "var footer=document.querySelector('footer');"
            + "if(!footer||document.getElementById('miniComposer'))return;"
            + "var input=document.getElementById('input');"
            + "var attach=document.getElementById('btnAttach');"
            + "var send=document.getElementById('btnSend');"
            + "if(!input||!attach||!send)return;"
            + "var box=document.createElement('div');"
            + "box.id='miniComposer';"
            + "footer.appendChild(box);"
            + "box.appendChild(attach);"
            + "box.appendChild(input);"
            + "box.appendChild(send);"
            + "})();";

    /**
     * 输入区的状态开关：空白时两个图标嵌在输入框里，一旦聚焦或有字就切换成下方工具栏。
     * 页面自己的发送逻辑不认这个类，它只影响外观（2026-11-06）。
     */
    private static final String COMPOSER_STATE_JS = "(function(){"
            + "if(window.__miniComposerBound)return;"
            + "window.__miniComposerBound=1;"
            + "var el=document.getElementById('input');"
            + "if(!el)return;"
            // 用「可视高度有没有被键盘吃掉」判断，而不是看焦点：
            // 安卓收起键盘后光标还在输入框里，按焦点判断会一直停在键盘态。
            + "var base=window.innerHeight;"
            + "function sync(){"
            + "var h=window.innerHeight;"
            + "if(h>base)base=h;"
            + "var open=h<base-120;"
            + "document.body.classList.toggle('mini-typing',open);"
            + "}"
            + "window.addEventListener('resize',sync);"
            + "if(window.visualViewport){"
            + "window.visualViewport.addEventListener('resize',sync);"
            + "window.visualViewport.addEventListener('scroll',sync);"
            + "}"
            + "el.addEventListener('focus',sync);"
            + "el.addEventListener('blur',sync);"
            + "el.addEventListener('input',sync);"
            + "setInterval(sync,300);"
            + "sync();"
            + "})();";


    /**
     * 设置页里的「连接」区块，只有 App 里才有（2026-11-07）。
     *
     * 默认收起；展开后是一张线路清单：当前那条标「使用中」，其它可以一键切换，
     * 底下能手动加地址、也能删。数据全部来自外壳（window.MiniConn），
     * 页面自己的设置项一个都没碰。
     */
    

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
                        + "请在系统的「电池 → 应用启动管理」里把「DSH Everywhere」改成"
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
        final boolean taskRunning = poller != null && poller.taskRunning();
        if (poller != null) {
            poller.stop();
        }
        // 只有确实有任务在跑才维持后台连接：空闲时挂一条「正在盯着任务」的常驻通知
        // 属于无中生有（2026-11-06 用户反馈）。
        if (taskRunning && loadedBase != null && credentials != null) {
            MiniForegroundService.start(this, loadedBase, credentials.deviceCredential());
        } else {
            MiniForegroundService.stop(this);
        }
    }

    private void probeAddresses() {
        if (probing || destroyed || addressPool == null) {
            return;
        }
        probing = true;
        final String deviceCredential = credentials.deviceCredential();
        final String preferred = Connections.preferred(this);
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                // 用户在「连接」里指定过线路：先试它。不通再退回自动探测，
                // 所以挑错了最多慢一次，不会连不上（2026-11-07）。
                if (preferred != null && preferredInPool(preferred) && probeOnce(preferred, deviceCredential)) {
                    mainHandler.post(new Runnable() {
                        @Override
                        public void run() {
                            if (destroyed) {
                                return;
                            }
                            probing = false;
                            selectAddress(preferred);
                        }
                    });
                    return;
                }
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


    /**
     * 设置页「连接」的数据源（2026-11-07）。
     *
     * 页面在手机壳里运行时才会挂上这个接口，所以网页端拿不到它，也就不用担心
     * 桌面浏览器里冒出一个只给 App 用的东西。方法都在 JS 线程被调用，
     * 凡是碰界面、改凭据的都丢回主线程。
     */
    private final class ConnectionBridge {
        @JavascriptInterface
        public String state() {
            JSONObject root = new JSONObject();
            try {
                root.put("current", loadedBase == null ? "" : loadedBase);
                JSONArray items = new JSONArray();
                for (AddressPool.Entry entry : credentials.addresses) {
                    JSONObject item = new JSONObject();
                    item.put("url", entry.baseUrl);
                    item.put("label", Connections.labelOf(entry.type));
                    item.put("type", entry.type);
                    item.put("current", entry.baseUrl.equals(loadedBase));
                    items.put(item);
                }
                root.put("items", items);
            } catch (JSONException e) {
                return "{}";
            }
            return root.toString();
        }

        @JavascriptInterface
        public String use(String url) {
            if (url == null || url.isEmpty()) {
                return "err:地址为空";
            }
            final String target = url;
            Connections.setPreferred(MainActivity.this, target);
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    if (!destroyed) {
                        selectAddress(target);
                    }
                }
            });
            return "ok";
        }

        @JavascriptInterface
        public String add(String url) {
            if (url == null || url.trim().isEmpty()) {
                return "err:先把地址填上";
            }
            try {
                AddressPool.Entry entry = new AddressPool.Entry(url.trim(), "manual");
                for (AddressPool.Entry existing : credentials.addresses) {
                    if (existing.baseUrl.equals(entry.baseUrl)) {
                        return "err:这条线路已经在列表里了";
                    }
                }
                List<AddressPool.Entry> next = new ArrayList<>(credentials.addresses);
                next.add(entry);
                return saveAddresses(next);
            } catch (IllegalArgumentException e) {
                String reason = e.getMessage();
                return "err:" + (reason == null ? "地址格式不对" : reason);
            }
        }

        @JavascriptInterface
        public String remove(String url) {
            if (url == null || url.isEmpty()) {
                return "err:地址为空";
            }
            List<AddressPool.Entry> next = new ArrayList<>();
            boolean removed = false;
            for (AddressPool.Entry entry : credentials.addresses) {
                if (entry.baseUrl.equals(url)) {
                    removed = true;
                    continue;
                }
                next.add(entry);
            }
            if (!removed) {
                return "err:没找到这条线路";
            }
            if (next.isEmpty()) {
                return "err:至少要留一条线路";
            }
            if (url.equals(Connections.preferred(MainActivity.this))) {
                Connections.setPreferred(MainActivity.this, null);
            }
            return saveAddresses(next);
        }

        /** 增删之后把凭据与地址池一起换掉，重启后仍然是这一份。 */
        private String saveAddresses(List<AddressPool.Entry> next) {
            try {
                PairingStore.Credentials updated = new PairingStore.Credentials(
                        credentials.deviceId, credentials.deviceSecret, next,
                        credentials.keyId, credentials.keyFp);
                new PairingStore(MainActivity.this).save(updated);
                credentials = updated;
                if (!preferredInPool(String.valueOf(Connections.preferred(MainActivity.this)))) {
                    Connections.setPreferred(MainActivity.this, null);
                }
                addressPool = new AddressPool(updated.addresses);
                return "ok";
            } catch (GeneralSecurityException | IOException e) {
                return "err:保存失败，请重试";
            }
        }
    }

    private boolean preferredInPool(String url) {
        for (AddressPool.Entry entry : credentials.addresses) {
            if (entry.baseUrl.equals(url)) {
                return true;
            }
        }
        return false;
    }

    private boolean probeOnce(String baseUrl, String deviceCredential) {
        try {
            Net.Response response = Net.get(baseUrl + "/mini/api/version", deviceCredential);
            return response.isSuccess();
        } catch (IOException e) {
            return false;
        }
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
            Uri target = request.getUrl();
            if (isPairedOrigin(target)) {
                return false;
            }
            // 外链交给系统浏览器：在壳里既打不开也没法后退，等于点了没反应。
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, target));
            } catch (Exception err) {
                Toast.makeText(MainActivity.this, "这台手机打不开这个链接。", Toast.LENGTH_SHORT).show();
            }
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            pageReady = true;
            injectAppOnlyStyle();
            matchSystemBars();
            if (pendingShareJson != null) {
                String json = pendingShareJson;
                pendingShareJson = null;
                injectShare(json);
            }
        }
    }

    private static final int REQUEST_FILE_CHOOSER = 0x4d55;

    /**
     * 页面里「选文件 / 拍照」点的是 <input type="file">；WebView 默认不处理，
     * 宿主不接就一点反应都没有（2026-11-06 真机反馈）。
     *
     * 两条路分开走：拍照进**应用内相机**（荣耀封了第三方调用系统相机，2026-11-06
     * 真机确认 Permission Denial），选文件仍走系统文件管理器。
     */
    private final class FileChooserClient extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                         FileChooserParams params) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(null);
            }
            fileCallback = callback;
            if (params.isCaptureEnabled()) {
                // 优先用系统相机：画质、变焦、HDR 都是手机原生的。
                // 前提是我们已经拿到运行时相机授权——声明了 CAMERA 却没授权时，
                // 安卓会直接拒绝这条 Intent（Permission Denial: revoked permission）。
                if (checkSelfPermission(android.Manifest.permission.CAMERA)
                        == android.content.pm.PackageManager.PERMISSION_GRANTED) {
                    Intent camera = systemCaptureIntent();
                    if (camera != null) {
                        try {
                            startActivityForResult(camera, REQUEST_FILE_CHOOSER);
                            return true;
                        } catch (Exception err) {
                            cameraOutput = null;
                        }
                    }
                }
                // 没有授权或系统相机起不来，就用应用内相机兜底。
                try {
                    startActivityForResult(new Intent(MainActivity.this, CaptureActivity.class),
                            REQUEST_FILE_CHOOSER);
                    return true;
                } catch (Exception err) {
                    android.util.Log.w("MiniCamera", "in-app capture failed", err);
                }
            }
            Intent content = new Intent(Intent.ACTION_GET_CONTENT);
            content.addCategory(Intent.CATEGORY_OPENABLE);
            String type = "*/*";
            String[] accepts = params.getAcceptTypes();
            if (accepts != null && accepts.length > 0 && accepts[0] != null && !accepts[0].isEmpty()) {
                type = accepts[0];
            }
            content.setType(type);
            if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                content.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            }
            try {
                startActivityForResult(Intent.createChooser(content, "选择文件"), REQUEST_FILE_CHOOSER);
            } catch (Exception err) {
                fileCallback = null;
                return false;
            }
            return true;
        }
    }

    /** 系统相机：照片写到 FileProvider 缓存，拍完拿回来。 */
    private Intent systemCaptureIntent() {
        try {
            File dir = new File(getCacheDir(), "camera");
            if (!dir.exists() && !dir.mkdirs()) {
                return null;
            }
            File file = File.createTempFile("shot-", ".jpg", dir);
            Uri target = FileProvider.getUriForFile(this, getPackageName() + ".fileprovider", file);
            Intent camera = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            camera.addCategory(Intent.CATEGORY_DEFAULT);
            camera.putExtra(MediaStore.EXTRA_OUTPUT, target);
            camera.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                    | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            cameraOutput = target;
            return camera;
        } catch (Exception err) {
            return null;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_FILE_CHOOSER || fileCallback == null) {
            return;
        }
        Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
        if (result == null || result.length == 0) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                result = new Uri[] { data.getData() };
            } else if (resultCode == RESULT_OK && cameraOutput != null && sizeOf(cameraOutput) > 0) {
                result = new Uri[] { cameraOutput };
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
        cameraOutput = null;
    }

    private long sizeOf(Uri uri) {
        try (android.content.res.AssetFileDescriptor fd =
                     getContentResolver().openAssetFileDescriptor(uri, "r")) {
            return fd == null ? -1 : fd.getLength();
        } catch (Exception err) {
            return -1;
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
