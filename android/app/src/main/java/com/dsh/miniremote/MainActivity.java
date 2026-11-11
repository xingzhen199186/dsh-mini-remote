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
import android.util.Log;
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
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;

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
    /** 内置 Tailscale：WebView 的代理是否已经切到本地内核。 */
    private boolean tailProxyOn;
    /** 界面现在是不是在前台（用于判断用户是否在看这一页）。 */
    private boolean isResumed;
    /** 内置内核正在启动：这期间别让探测把线路换掉。 */
    private volatile boolean tailNetStarting;
    /** 这一轮里内置线路确实起不来，允许退回别的线路（下次启动再试）。 */
    private volatile boolean tailNetGivenUp;
    /** 离开内置线路后，多久没人用它就把内核停掉（省电）。 */
    private static final long TAILNET_IDLE_STOP_MS = 5 * 60 * 1000L;
    /** 等代理生效后再执行的动作（换地址/加载页面）。 */
    private Runnable pendingAfterProxy;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        applyWakeIntent(getIntent());
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
        webView.addJavascriptInterface(new UiPrefsBridge(), "DshMiniUi");
        webView.addJavascriptInterface(new AppUpdateBridge(), "MiniUpdate");
        webView.addJavascriptInterface(new NotifyBridge(), "MiniNotify");
        webView.addJavascriptInterface(new ProbeBridge(), "MiniProbe");
        webView.addJavascriptInterface(new BridgeBridge(), "MiniBridge");
        hookBridgeCallback();
        webView.setWebViewClient(new PairedHostClient());
        webView.setWebChromeClient(new FileChooserClient());
        // Android 13 起通知要运行时授权；不申请的话，锁屏提醒和「批准/拒绝」按钮
        // 会被系统静默丢掉，前台服务等于白跑（2026-11-06 补）。
        if (android.os.Build.VERSION.SDK_INT >= 33
                && checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 1);
        }
        android.content.IntentFilter screenFilter =
                new android.content.IntentFilter();
        screenFilter.addAction(Intent.ACTION_SCREEN_ON);
        screenFilter.addAction(Intent.ACTION_SCREEN_OFF);
        registerReceiver(screenReceiver, screenFilter);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);
        // 上次选中的是 tailnet 地址、并且存了授权密钥：先把内置内核拉起来，
        // 代理就绪后再去探测，否则探测会走公网直接失败（2026-11-08）。
        final String preferredUrl = Connections.preferred(this);
        if (preferredUrl != null && Net.isTailnetAddress(preferredUrl) && TailNet.hasSession(this)) {
            // 不走自动探测：用户选的就是这条，直接用它。
            ensureTailNetThen(new Runnable() {
                @Override
                public void run() {
                    selectAddress(preferredUrl);
                }
            });
        } else {
            probeAddresses();
        }
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
        applyWakeIntent(intent);
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


    /** 连接清单的固定槽位，顺序就是显示顺序。 */
    private static final String[] SLOT_KINDS = {
            "lan", "tailscale", "tailscale-https", "public-relay",
            "public", "b-relay", "self-relay", "multi-relay",
    };

    /** 从 LineConfigActivity 回来：刷新清单；如果改的是当前在用的地址，重新探测加载。 */
    private static final int REQUEST_LINE_CONFIG = 0x4d56;

    /**
     * 设置页里的「连接」区块，只有 App 里才有（2026-11-07）。
     *
     * 默认收起；展开后是一张线路清单：当前那条标「使用中」，其它可以一键切换，
     * 底下能手动加地址、也能删。数据全部来自外壳（window.MiniConn），
     * 页面自己的设置项一个都没碰。
     *
     * 整行可点进入配置页；行内按钮（切换/删除）不冒泡。
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
              var ICON_SWITCH = '<svg viewBox="0 0 24 24"><path d="M4 12h13"/><path d="M12 6l6 6-6 6"/></svg>';
              var ICON_DELETE = '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M7 7l1 12h8l1-12"/></svg>';
              var ICON_CHECK = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';

              function row(label, hint, buttons, url, current, kind){
                return '<div class="row" data-url="' + esc(url) + '" data-kind="' + esc(kind) + '" data-current="' + (current ? '1' : '') + '" style="cursor:pointer">'
                  + '<div style="display:flex;gap:10px;align-items:flex-start;min-width:0">'
                  + '<span class="mini-dot' + (current ? ' ok' : '') + '"></span>'
                  + '<div style="min-width:0">'
                  + '<div class="label">' + esc(label) + '</div>'
                  + '<div class="hint">' + hint + '</div></div></div>'
                  + '<div class="mini-acts">' + buttons + '</div></div>';
              }

              function render(){
                var data = {};
                try { data = JSON.parse(bridge.state() || '{}'); } catch (e) { data = {}; }
                var items = data.items || [];
                var tn = data.tailnet || {};
                tailnetSession = tn.session === true;
                tailnetConnected = tn.connected === true;
                var configured = items.filter(function(it){ return it.configured; }).length;
                summary.textContent = configured + ' / ' + items.length + ' 条已配置';
                var html = '';
                items.forEach(function(it){
                  var hint;
                  var buttons;
                  if (it.configured) {
                    hint = esc(it.url) + (it.current ? ' · 使用中' : '');
                    buttons = it.current
                      ? '<button class="mini-ico" type="button" disabled title="正在用">' + ICON_CHECK + '</button>'
                      : '<button class="mini-ico" type="button" data-use="' + esc(it.url) + '" title="切换到这条">' + ICON_SWITCH + '</button>';
                  } else {
                    hint = '未配置 · 点进来填地址或扫码';
                    buttons = '<button class="mini-ico" type="button" title="配置">'
                      + '<svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></svg></button>';
                  }
                  html += row(it.label, hint, buttons, it.url, it.current, it.kind);
                });
                body.innerHTML = html;

                Array.prototype.forEach.call(body.querySelectorAll('.row[data-kind]'), function(rowEl){
                  rowEl.addEventListener('click', function(ev){
                    if (ev.target.closest('button') && !ev.target.closest('button').disabled) return;
                    var url = rowEl.getAttribute('data-url');
                    bridge.config(url || '', rowEl.getAttribute('data-current') === '1',
                            rowEl.getAttribute('data-kind') || '');
                  });
                });
                Array.prototype.forEach.call(body.querySelectorAll('[data-use]'), function(btn){
                  btn.addEventListener('click', function(ev){
                    ev.stopPropagation();
                    btn.disabled = true;
                    bridge.use(btn.getAttribute('data-use'));
                  });
                });
                if (typeof bridge.probe === 'function') {
                  bridge.probe();
                }
              }

              // Cloudflare 那两条固定地址：连不上时最常见的原因是隧道进程还在、
              // 但连接已经死了，关一次再打开就能救回来（2026-11-07 用户要求提醒）。
              var FIXED_RELAYS = { 'public-relay': 1, 'b-relay': 1 };

              window.miniConnStatus = function(url, reachable){
                if (!url) return;
                var rows = body.querySelectorAll('.row[data-url]');
                for (var i = 0; i < rows.length; i++) {
                  if (rows[i].getAttribute('data-url') !== url) continue;
                  var row = rows[i];
                  var dot = row.querySelector('.mini-dot');
                  if (!dot) continue;
                  dot.classList.remove('ok', 'down');
                  dot.classList.add(reachable ? 'ok' : 'down');
                  updateRetryHint(row, reachable);
                  updateTailnetHint(row, reachable);
                }
              };

              function updateRetryHint(row, reachable){
                var existing = row.querySelector('.mini-retry-hint');
                var fixed = FIXED_RELAYS[row.getAttribute('data-kind')];
                if (reachable || !fixed) {
                  if (existing) existing.remove();
                  return;
                }
                if (existing) return;
                var hint = row.querySelector('.hint');
                if (!hint) return;
                var tip = document.createElement('span');
                tip.className = 'mini-retry-hint';
                tip.textContent = '连不上？到电脑端把这条关一次、再打开试试。';
                hint.appendChild(tip);
              }

              // 内置 Tailscale 的状态，render 时从桥里取一次。
              var tailnetSession = false;
              var tailnetConnected = false;

              /**
               * Tailscale 那两条线是红的、而账号其实早就配好了 —— 这种情况下能不能连上
               * 只取决于内置 Tailscale 有没有启动。用户看到的只是"它坏了"，所以在这里
               * 明说一句该做什么（2026-11-09 用户要求）。
               */
              function updateTailnetHint(row, reachable){
                var existing = row.querySelector('.mini-tailnet-hint');
                var kind = row.getAttribute('data-kind');
                var isTail = kind === 'tailscale' || kind === 'tailscale-https';
                // 条件就是用户说的那两句：**这条线是红的**，而且**地址已经填好**。
                // 之前我还额外要求"内置 Tailscale 没在跑"，结果真机上红着却不出提示——
                // 那个条件是我自己加的、也没有证据支撑，去掉。没填地址的行本来就会显示
                // 「未配置」，所以"账号地址都配好"这半句已经被它覆盖了。
                var configured = !!row.getAttribute('data-url');
                if (!(isTail && !reachable && configured)) {
                  if (existing) existing.remove();
                  return;
                }
                if (existing) return;
                var hint = row.querySelector('.hint');
                if (!hint) return;
                var tip = document.createElement('span');
                tip.className = 'mini-tailnet-hint';
                tip.textContent = '启动激活内置 Tailscale';
                hint.appendChild(tip);
              }

              window.miniConnRerender = render;
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
                // 状态圆点：灰=没探到/不知道，绿=通，红=不通。
                + "#miniConnBlock .mini-dot{"
                + "width:9px !important;height:9px !important;border-radius:50% !important;"
                + "background:#c6d4e6 !important;margin-top:8px !important;flex:0 0 auto !important;"
                + "}"
                + "#miniConnBlock .mini-dot.ok{background:#2fbf71 !important;"
                + "box-shadow:0 0 0 3px rgba(47,191,113,.16) !important;}"
                // 「启动激活内置 Tailscale」：不是故障说明，是下一步该做什么，所以用强调色。
                + "#miniConnBlock .mini-tailnet-hint{display:block !important;margin-top:4px !important;"
                + "color:#c2410c !important;font-weight:600 !important;}"
                + "#miniConnBlock .mini-dot.down{background:#e05b57 !important;}"
                // 右侧图标按钮
                + "#miniConnBlock .mini-acts{"
                + "display:flex !important;gap:4px !important;flex:0 0 auto !important;align-items:center !important;"
                + "}"
                + "#miniConnBlock .mini-ico{"
                + "width:34px !important;height:34px !important;padding:0 !important;border:none !important;"
                + "border-radius:10px !important;background:transparent !important;color:var(--muted) !important;"
                + "display:flex !important;align-items:center !important;justify-content:center !important;"
                + "}"
                + "#miniConnBlock .mini-ico.danger{color:#c0453f !important;}"
                + "#miniConnBlock .mini-ico:disabled{opacity:.45 !important;}"
                + "#miniConnBlock .mini-retry-hint{"
                + "display:block !important;margin-top:6px !important;"
                + "font-size:12px !important;line-height:1.5 !important;color:#c0453f !important;"
                + "}"
                + "#miniConnBlock .mini-ico svg{"
                + "width:18px !important;height:18px !important;stroke:currentColor !important;"
                + "fill:none !important;stroke-width:1.8 !important;"
                + "stroke-linecap:round !important;stroke-linejoin:round !important;"
                + "}"
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
                // 文字和下面那排图标之间留一点呼吸：padding-bottom 撑出来的是输入框
                // 自己的底边，背景透明，所以露出来的是外框那一层色，不会出现色差
                //（2026-11-08 用户要求）。
                // **空状态下的垂直对齐**（2026-11-09 用户指正）：两个图标是绝对定位、按
                // 顶栏中心对齐的；而输入框自己带着上下各 6 的 padding，文字重心就被推低
                // 了约 6 像素，看起来文字比两侧图标低一截。这里把空状态的内边距归零，
                // 文字就在 34 高的框里居中，正好与图标同一条中线。
                // 空状态下要让文字与两侧图标同一条中线，只需要做一件事：
                // **让输入框的高度恰好等于一行文字**，交给外层 flex 去居中。
                // 上一版只清了上下内边距、却留着 min-height:34 —— 盒子仍比一行高，
                // 文字贴着上沿，看着反而更高（2026-11-09 用户二次指正）。
                // 行高沿用页面自己的 1.5，这样"字体大小"切到小/大时依然成立。
                + "body:not(.mini-typing) #input{"
                + "padding-top:0 !important;padding-bottom:0 !important;"
                + "min-height:0 !important;height:auto !important;}"
                + "body.mini-typing #input{padding:6px 8px 18px 2px !important;}"
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
                + "body:not(.mini-typing) #btnAttach{left:14px !important;}"
                + "body:not(.mini-typing) #btnSend{right:14px !important;}"
                // 两个按钮统一尺寸，箭头居中。
                + "#btnAttach,#btnSend{"
                + "width:22px !important;height:22px !important;padding:0 !important;"
                + "display:flex !important;align-items:center !important;justify-content:center !important;"
                + "border-radius:10px !important;"
                + "}"
                + "#btnAttach{background:transparent !important;border:none !important;}"
                // 按钮本身撑到图标那么大：按钮被写死 22px 时，里面的鲸鱼再调大也会被
                // 挤回去（2026-11-08 实测：设 25 算出来还是 22）。
                + "#btnAttach{width:25px !important;height:25px !important;}"
                // 发送键也一起放到 25：两个按钮同样大小，蓝色方块跟着放宽，
                // 里面的箭头仍按它自己的尺寸居中（2026-11-08）。
                + "#btnSend{width:25px !important;height:25px !important;}"
                + "#btnAttach svg{flex:0 0 auto !important;}"
                // 工具栏那一行：两个图标各往外让一点，框内两侧留出空白。
                + "body.mini-typing #btnAttach{margin:0 0 0 2px !important;}"
                + "body.mini-typing #btnSend{margin-right:2px !important;}"
                + "#btnAttach svg{width:25px !important;height:auto !important;}"
                + "#btnSend{"
                + "margin-left:auto !important;"
                + "border:none !important;border-radius:6px !important;"
                + "background:var(--act) !important;color:var(--on-act) !important;"
                + "font-size:0 !important;line-height:1 !important;"
                + "}"
                // 箭头自绘：字符「↑」又细又长，压不粗也缩不短；用 SVG 直接画
                // 一根短杆加一个粗箭头，颜色跟着按钮文字色走（2026-11-08）。
                + "#btnSend::after{content:none !important;}"
                + "#btnSend svg{width:20px !important;height:20px !important;display:block !important;}"
                + "#btnSend svg path{stroke:currentColor !important;stroke-width:2.6 !important;"
                + "stroke-linecap:round !important;stroke-linejoin:round !important;fill:none !important;}"
                // 品牌块：上行 DSH Everywhere，下行当前会话名（只在 App 里）
                // 品牌块要**吃掉剩余宽度**：原来把状态文字藏起来之后，右边那两个按钮失去了
                // 撑开它们的那根弹簧，于是往左挤了一截（2026-11-09 用户看出位置变了）。
                + ".mini-brand-box{display:flex !important;flex-direction:column !important;"
                + "line-height:1.2 !important;min-width:0 !important;flex:1 1 auto !important;}"
                + "#status{display:none !important;}"
                + ".mini-brand-title{font-weight:600 !important;font-size:15px !important;"
                + "letter-spacing:.3px !important;white-space:nowrap !important;}"
                + ".mini-brand-session{font-size:11px !important;color:var(--muted,#8a8a8a) !important;"
                + "white-space:nowrap !important;overflow:hidden !important;text-overflow:ellipsis !important;"
                + "max-width:46vw !important;}"
                + "main{padding-bottom:24px !important;overflow-anchor:none !important;}"
                /* 设置页右上那个「关闭」按钮在 App 里去掉（2026-11-10 用户要求）：
                 * 手机上用手指从边缘往右一滑就能关，按钮是多余的。
                 * **只在这里隐藏**，网页版照旧留着——浏览器里没有这个手势。
                 */
                + "#btnSettingsClose{display:none !important;}"
                /* 设置页页眉改成"左边返回、中间标题"（2026-11-10 用户要求）：
                 * 手机上从边缘滑一下就能返回，那个位置的按钮改成返回箭头更符合习惯。
                 * 同样只在 App 里生效——网页版仍是原来的「设置 + 关闭」。
                 */
                + ".sheet-head{position:relative !important;}"
                + ".sheet-head h2{text-align:center !important;flex:1 !important;}"
                + "#miniBackBtn{position:absolute !important;left:6px !important;top:50% !important;"
                + "transform:translateY(-50%) !important;background:transparent !important;"
                + "border:0 !important;color:var(--fg,#1a1a1a) !important;font-size:24px !important;"
                + "line-height:1 !important;padding:8px 12px !important;cursor:pointer !important;}"
                + "@media (prefers-color-scheme: dark){#miniBackBtn{color:var(--fg,#eee) !important;}}"
                /* 「屏幕操作（无障碍）」做成手机桥的从属行：缩进 + 左侧一道细线，
                 * 读起来是"桥的能力之一"，而不是另一件不相干的事（2026-11-10 李四定的版式）。 */
                + "#miniA11yRow{margin:2px 0 0 12px !important;align-items:flex-start !important;gap:12px !important;}"
                + "#miniA11yHead{display:flex !important;align-items:center !important;gap:8px !important;"
                + "font-size:13px !important;font-weight:500 !important;cursor:pointer !important;"
                + "user-select:none !important;}"
                + "#miniA11yState{margin-left:auto !important;font-size:12px !important;"
                + "font-weight:400 !important;color:var(--muted,#8a8a8a) !important;white-space:nowrap !important;}"
                + "#miniA11yChev{color:var(--muted,#8b93a1) !important;font-size:14px !important;}"
                + "#miniA11yBody{margin-top:6px !important;}"
                + "#miniA11yPath{margin-top:4px !important;}"
                + "#miniA11yBody .btn{margin-top:8px !important;}"
                + "#miniA11yRow .label{font-size:13px !important;font-weight:500 !important;}"
                + "#miniA11yRow .hint{line-height:1.5 !important;}"
                + "#miniA11yRow [hidden]{display:none !important;}"
                + "#miniBridgeBlock{align-items:flex-start !important;gap:12px !important;}"
                + "#miniBridgeError{margin:4px 0 8px !important;padding:6px 8px !important;"
                + "border-radius:6px !important;color:#b42318 !important;background:#fff1f0 !important;"
                + "line-height:1.5 !important;white-space:normal !important;}"
                + "#miniBridgeError[hidden]{display:none !important;}";
        String js = "(function(){"
                + "if(document.getElementById('mini-app-only-style'))return;"
                + "var s=document.createElement('style');"
                + "s.id='mini-app-only-style';"
                + "s.textContent=" + org.json.JSONObject.quote(css) + ";"
                + "(document.head||document.documentElement).appendChild(s);"
                + "})();";
        webView.evaluateJavascript(BRAND_JS, null);
        webView.evaluateJavascript(STICKY_BOTTOM_JS, null);
        webView.evaluateJavascript(COMPOSER_WRAP_JS, null);
        webView.evaluateJavascript(js, null);
        webView.evaluateJavascript(COMPOSER_STATE_JS, null);
        webView.evaluateJavascript(CONN_SECTION_JS, null);
        webView.evaluateJavascript(UPDATE_UI_JS, null);
        webView.evaluateJavascript(BACK_UI_JS, null);
        webView.evaluateJavascript(SETTINGS_UI_JS, null);
        webView.evaluateJavascript(BRIDGE_UI_JS, null);
        applyBridgeArm();
    }

    /**
     * 把输入框和两个按钮装进同一个容器（2026-11-06）。
     *
     * 页面原本把它们当成三个并排的独立元素；要做出「一整个圆角框、图标在里面」的效果，
     * 只能在外壳这边补一层容器。元素本身没换，页面绑的事件照旧。
     */
    /**
     * 一直贴着底部走（2026-11-08 用户报「发送后跳到上面去」）。
     *
     * 网页版没问题、App 里有问题，差别在壳这边：输入框会在「图标嵌在框里」和
     * 「图标落到下面一行」两种形态之间切换，两种形态高度差三十多像素；键盘一收，
     * 聊天区跟着变高变矮。页面自己那套贴底逻辑只在它自己的动作里跑，管不到这种
     * 由外壳引起的尺寸变化。
     *
     * 这里补一个常驻观察：只要内容长高、视野变矮，就重新贴到底；用户一旦自己往上
     * 划过（不在底部了），就停手，不跟他抢。
     */
    /**
     * 只在「输入框那块改高度」时补一次贴底（2026-11-08）。
     *
     * 为什么范围这么窄：正文流式生成、结束落定，这些滚动都该由页面自己管
     * （它会把回答第一行对齐、满一屏停住）。之前这里盯着整个聊天区的尺寸和内容变化，
     * 结果正文一长就被拉回底部——满屏后继续往下滚就是这么来的。
     *
     * 外壳真正需要插手的只有一件事：输入框在两种形态间切换、键盘起落时，可视区高度变了，
     * 页面那套逻辑管不到。所以这里只盯着 footer 的高度变化。
     */
    private static final String STICKY_BOTTOM_JS = "(function(){"
            + "if(window.__miniSticky)return;"
            + "var m=document.getElementById('main');"
            + "var f=document.querySelector('footer');"
            + "if(!m||!f)return;"
            + "window.__miniSticky=1;"
            + "var pinned=true,lastTouch=0,programmatic=0;"
            + "function userActive(){return Date.now()-lastTouch<600;}"
            + "function atBottom(){return m.scrollHeight-m.scrollTop-(m.clientHeight||0)<60;}"
            + "['touchstart','touchmove','pointerdown','wheel'].forEach(function(n){"
            + "m.addEventListener(n,function(){lastTouch=Date.now();},{passive:true});"
            + "});"
            + "m.addEventListener('scroll',function(){"
            + "if(Date.now()<programmatic)return;"
            + "if(!userActive())return;"
            + "pinned=atBottom();"
            + "},{passive:true});"
            + "function pin(){"
            + "if(!pinned)return;"
            + "programmatic=Date.now()+150;"
            + "m.scrollTop=m.scrollHeight;"
            + "}"
            + "function pinSoon(){"
            + "if(window.requestAnimationFrame)requestAnimationFrame(pin);else setTimeout(pin,16);"
            // 再补一次：输入框变小的那一帧，新消息可能还没进 DOM，只贴一次会停在旧的底部。
            + "setTimeout(pin,260);"
            + "}"
            + "if(window.ResizeObserver){new ResizeObserver(pinSoon).observe(f);}"
            // 发出后输入框被清空：这是「刚发了一条」最可靠的信号。
            // 但新气泡是**服务器回话之后**才插进 DOM 的（页面自己先回显、也可能晚一步），
            // 只在那一刻贴一次常常贴早了——所以开一个三秒的小窗口，窗口里内容一变就再贴；
            // 一旦正文开始流式长出来就停手，把滚动交回页面（2026-11-08 用户报的）。
            + "function streaming(){return !!document.querySelector('#reply .live');}"
            + "var watchTimer=null,watchObs=null;"
            + "function stopWatch(){"
            + "if(watchObs){watchObs.disconnect();watchObs=null;}"
            + "if(watchTimer){clearTimeout(watchTimer);watchTimer=null;}"
            + "}"
            + "function armWatch(){"
            + "stopWatch();"
            + "if(!window.MutationObserver)return;"
            + "var armedAt=Date.now();"
            + "watchObs=new MutationObserver(function(){"
            // 头一秒先别让位：刚发出时正文可能还没开始，页面那套「对齐回答开头」会拿
            // **上一条回答**当目标，人就被带回去了。等过了这一秒，再交给页面。
            + "if(streaming()&&Date.now()-armedAt>1200){stopWatch();return;}"
            + "if(window.requestAnimationFrame)requestAnimationFrame(pin);else setTimeout(pin,16);"
            + "});"
            + "watchObs.observe(m,{childList:true,subtree:true});"
            + "watchTimer=setTimeout(stopWatch,3000);"
            + "}"
            + "var i=document.getElementById('input');"
            + "if(i){var had=false;"
            + "i.addEventListener('input',function(){"
            + "var now=!!i.value;"
            + "if(had&&!now){pinned=true;pinSoon();armWatch();}"
            + "had=now;"
            + "});}"
            + "})();";

    /**
     * 设置页里那一行「手机桥」（P2 第一步）。
     *
     * 只有一个开关和一句话状态。**这不是装饰**：桥关着的时候，电脑那边根本看不到
     * 这台手机，后面所有 `phone_*` 工具都不会出现——所以这个开关就是授权的意思。
     */
    private static final String BRIDGE_UI_JS = "(function(){"
            + "if(window.__miniBridgeUi)return;"
            + "var host=document.querySelector('#settings .sheet-body');"
            + "if(!host)return;"
            + "window.__miniBridgeUi=1;"
            + "var block=document.createElement('div');"
            + "block.id='miniBridgeBlock';"
            + "block.className='row';"
            + "block.innerHTML='<div style=\"flex:1;min-width:0\">"
            + "<div class=\"label\">手机桥</div>"
            + "<div class=\"hint\" id=\"miniBridgeHint\">正在读状态…</div>"
            + "</div><div style=\"flex:0 0 auto\"><button class=\"btn\" id=\"miniBridgeBtn\">打开</button></div>';"
            // 位置：紧跟在「连接」那一块下面（2026-11-10 用户要求）。
            // 「连接」是"手机怎么连上电脑"，「手机桥」是"连上之后电脑能做什么"，
            // 两件事前后脚，放一起才读得顺。连接块还没出来就等它一会儿。
            // 错误行：平时隐藏，有具体原因时才出现（不覆盖正常状态）
            + "var err=document.createElement('div');"
            + "err.id='miniBridgeError';err.className='hint';err.setAttribute('role','alert');"
            + "err.setAttribute('hidden','');"
            // 无障碍：桥的从属能力，做成常驻次级行——**任何状态下都在**，
            // 只是文字和按钮变。原来开着就整块消失，读者会以为这一项坏了（2026-11-10 李四建议）。
            + "var a11y=document.createElement('div');"
            + "a11y.id='miniA11yRow';a11y.className='row';"
            // 默认收起，只留一行"标题 + 当前状态"；点一下才展开细节和按钮
            //（2026-11-10 用户要求：这一项大多数时候不用管，摊开讲反而是噪音）。
            + "a11y.innerHTML='<div style=\"flex:1;min-width:0\">"
            + "<div id=\"miniA11yHead\" class=\"label\" role=\"button\" tabindex=\"0\""
            + " aria-expanded=\"false\" aria-controls=\"miniA11yBody\">"
            + "<span>屏幕操作</span>"
            + "<span id=\"miniA11yState\">未开启</span>"
            + "<span id=\"miniA11yChev\" aria-hidden=\"true\">\u203a</span></div>"
            + "<div id=\"miniA11yBody\" hidden>"
            + "<div class=\"hint\">允许电脑读取屏幕控件，并按编号点击。</div>"
            + "<div class=\"hint\" id=\"miniA11yMask\">文字会打码，截图仍是原始画面。</div>"
            // 确认档放在能力说明之后、按钮之前（2026-11-10 用户指定位置）：
            // 先知道“它能做什么、文字会打码”，再决定“每次要不要先问我”。
            + "<div class=\"hint\" id=\"miniConfirmLabel\">电脑操作手机前：</div>"
            + "<div class=\"hint\" id=\"miniConfirmRow\">"
            + "<button class=\"btn\" id=\"miniConfirmOff\">始终免确认</button>"
            + "<button class=\"btn\" id=\"miniConfirmTask\">本任务免确认</button>"
            + "<button class=\"btn\" id=\"miniConfirmEach\">每次都问</button>"
            + "</div>"
            + "<div class=\"hint\" id=\"miniConfirmHint\"></div>"
            + "<div class=\"hint\" id=\"miniA11yPath\">设置 → 辅助功能 → 无障碍 → DSH 手机桥（实验）</div>"
            + "<button class=\"btn\" id=\"miniA11yGo\">开无障碍</button>"
            + "</div></div>';"
            + "function place(){"
            + "var conn=document.getElementById('miniConnBlock');"
            + "if(!conn){setTimeout(place,500);return;}"
            + "if(err.previousElementSibling!==block){"
            + "conn.insertAdjacentElement('afterend',block);"
            + "block.insertAdjacentElement('afterend',err);"
            + "err.insertAdjacentElement('afterend',a11y);"
            + "}"
            + "}"
            + "place();"
            // 这一行整块去掉了（2026-11-10）：不同手机的入口不一样，常驻提示等于让人自己猜；
            // 改成"真的被系统拦住时"，由 phone_open 的返回直接告诉用户怎么做。
            + "var btn=document.getElementById('miniBridgeBtn');"
            + "var hint=document.getElementById('miniBridgeHint');"
            + "function paint(s){"
            + "var armed=s&&s.armed===true;"
            + "var online=s&&s.online===true;"
            + "btn.textContent=armed?'关闭':'打开';"
            + "var fails=(s&&s.failures)||0;"
            + "hint.textContent=armed"
            + "?(online?'已连接：电脑可以与这台手机收发指令':(fails>=2?'已开启，但还没连上电脑，正在自动重连':'正在连接电脑…'))"
            + ":'关着时，电脑看不到这台手机';"
            + "}"
            // 无障碍那一行：开着说清能力，关着给路径；任何情况都给一个去设置的入口
            + "function paintA11y(){"
            + "var box=document.getElementById('miniA11yHint');"
            + "var go=document.getElementById('miniA11yGo');"
            + "var state=document.getElementById('miniA11yState');"
            + "var path=document.getElementById('miniA11yPath');"
            + "if(!go||!state||!path)return;"
            // 只改三处：状态词、要不要显示路径、按钮文字（2026-11-10 李四重做的版式）。
            + "var on=false,unknown=false;"
            + "try{on=JSON.parse(window.MiniProbe.status()||'{}').running===true;}"
            + "catch(e){unknown=true;}"
            + "if(unknown){state.textContent='状态读不到';path.removeAttribute('hidden');"
            + "go.textContent='去设置';return;}"
            + "state.textContent=on?'已开启':'未开启';"
            + "go.textContent=on?'去设置':'开无障碍';"
            + "if(on)path.setAttribute('hidden','');else path.removeAttribute('hidden');"
            + "}"
            + "function setOpen(open){"
            + "var body=document.getElementById('miniA11yBody');"
            + "var head=document.getElementById('miniA11yHead');"
            + "var chev=document.getElementById('miniA11yChev');"
            + "if(!body||!head||!chev)return;"
            + "window.__miniA11yOpen=open;"
            + "if(open){body.removeAttribute('hidden');}"
            + "else{body.setAttribute('hidden','');}"
            + "head.setAttribute('aria-expanded',open?'true':'false');"
            + "chev.textContent=open?'\u2304':'\u203a';"
            + "}"
            + "var head=document.getElementById('miniA11yHead');"
            + "if(head&&!head.__wired){head.__wired=1;"
            + "head.addEventListener('click',function(){setOpen(!window.__miniA11yOpen);});"
            + "head.addEventListener('keydown',function(e){"
            + "if(e.key==='Enter'||e.key===' '){e.preventDefault();setOpen(!window.__miniA11yOpen);}});"
            + "}"
            + "setOpen(window.__miniA11yOpen===true);"
            + "var goBtn=document.getElementById('miniA11yGo');"
            + "if(goBtn){goBtn.setAttribute('onclick','MiniProbe.openSettings()');}"
            // 档位：三个按钮常驻，当前选中只在这里标出来；收起态不塞状态词（用户要求）。
            + "function paintConfirm(){"
            + "var mode='off';"
            + "try{mode=(JSON.parse(window.MiniProbe.confirmMode()||'{}').mode)||'off';}catch(e){}"
            + "var map={off:'miniConfirmOff',task:'miniConfirmTask',each:'miniConfirmEach'};"
            + "for(var k in map){var b=document.getElementById(map[k]);"
            + "if(b){b.style.fontWeight=(k===mode?'700':'400');"
            + "b.style.opacity=(k===mode?'1':'0.65');}}"
            + "var hint=document.getElementById('miniConfirmHint');"
            + "if(hint){hint.textContent=mode==='off'?'电脑操作手机时不打扰你。'"
            + ":(mode==='task'?'同一轮任务只问一次，下一轮重新问。':'每个动作都会先问一次。');}"
            + "}"
            + "window.__miniPickConfirm=function(mode){"
            + "try{window.MiniProbe.confirmMode(mode);}catch(e){}"
            + "paintConfirm();};"
            + "var offBtn=document.getElementById('miniConfirmOff');"
            + "var taskBtn=document.getElementById('miniConfirmTask');"
            + "var eachBtn=document.getElementById('miniConfirmEach');"
            + "if(offBtn)offBtn.setAttribute('onclick',\"window.__miniPickConfirm('off')\");"
            + "if(taskBtn)taskBtn.setAttribute('onclick',\"window.__miniPickConfirm('task')\");"
            + "if(eachBtn)eachBtn.setAttribute('onclick',\"window.__miniPickConfirm('each')\");"
            + "paintConfirm();"
            + "paintA11y();"
            + "setInterval(paintA11y,2000);"
            + "function read(){try{paint(JSON.parse(window.MiniBridge.state()||'{}'));}"
            + "catch(e){var h=document.getElementById('miniBridgeHint');"
            + "if(h)h.textContent='状态读不到（界面与手机可能已断开）';}}"
            + "window.miniBridgeStatus=function(){read();};"
            + "btn.addEventListener('click',function(){"
            + "var now=JSON.parse(window.MiniBridge.state()||'{}');"
            + "var next=!(now&&now.armed===true);"
            + "try{paint(JSON.parse(window.MiniBridge.arm(next)||'{}'));}catch(e){}"
            + "setTimeout(read,1200);"
            + "});"
            + "read();"
            // 光靠"状态变化时推一次"不够：心跳上线的那一刻页面可能还没准备好，
            // 那一次推送就落空了，而之后再没有变化、也就不会再推——界面永远停在
            // 「正在连接电脑…」（2026-11-09 真机实测：状态本身是对的，只有界面不动）。
            + "setInterval(read,3000);"
            + "})();";

    /**
     * 设置页里那一行「App 更新」（2026-11-09）。
     *
     * 放在 App 壳里，不改网页：网页版没有"安装包"这回事。
     * 顺序要有讲究——**先比指纹，再决定下不下**，不能一点就下几十兆。
     */
    /**
     * 让页面配合"返回手势"：把最上层的浮层关掉（2026-11-10）。
     *
     * 顺序是"最上面的先关"：先设置面板，再镜像，最后才是别的。
     * 没有任何浮层时返回 false，交给系统按原样处理（翻页或退出）。
     *
     * 关法不写死具体按钮：先找面板里的"关闭"按钮点它（保持页面自己的状态一致），
     * 找不到才退而求其次把面板隐藏起来。
     */
    /**
     * 设置页页眉左侧的返回按钮（2026-11-10）。
     *
     * 点它就等于点页面原本那个「关闭」——不另写一套关闭逻辑，免得两处行为不一致。
     * 只在 App 里插；网页版没有这段。
     */
    private static final String SETTINGS_UI_JS = "(function(){"
            + "function mount(){"
            + "var head=document.querySelector('#settings .sheet-head');"
            + "if(!head){setTimeout(mount,500);return;}"
            + "if(document.getElementById('miniBackBtn'))return;"
            + "var b=document.createElement('button');"
            + "b.id='miniBackBtn';b.type='button';b.textContent='\u2039';"
            + "b.setAttribute('aria-label','返回');"
            + "b.addEventListener('click',function(){"
            + "var c=document.getElementById('btnSettingsClose');"
            + "if(c){c.click();return;}"
            + "var sh=document.getElementById('settings');"
            + "if(sh)sh.classList.remove('open');"
            + "});"
            + "head.insertBefore(b,head.firstChild);"
            + "}"
            + "mount();"
            + "})();";

    private static final String BACK_UI_JS = "(function(){"
            + "if(window.miniCloseTop)return;"
            // 注意：固定定位（position:fixed）的元素 offsetParent 恒为 null，
            // 用它是查不出"看得见"的——第一版就这么写错了，结果返回手势照样退出 App。
            + "function visible(el){return !!el && !el.hasAttribute('hidden') && el.getClientRects().length>0;}"
            + "function closeByText(host){"
            + "if(!host)return false;"
            + "var btns=host.querySelectorAll('button,.btn,[role=button]');"
            + "for(var i=0;i<btns.length;i++){"
            + "if((btns[i].textContent||'').trim()==='关闭'){btns[i].click();return true;}"
            + "}"
            + "return false;"
            + "}"
            + "window.miniCloseTop=function(){"
            + "var settings=document.getElementById('settings');"
            + "if(visible(settings)){ if(closeByText(settings))return true; settings.setAttribute('hidden',''); return true; }"
            + "var mirror=document.getElementById('mirror');"
            + "if(visible(mirror)){ if(closeByText(mirror))return true; mirror.setAttribute('hidden',''); return true; }"
            + "return false;"
            + "};"
            + "})();";

    private static final String UPDATE_UI_JS = "(function(){"
            + "if(window.__miniUpdateUi)return;"
            + "var host=document.querySelector('#settings .sheet-body');"
            + "if(!host)return;"
            + "window.__miniUpdateUi=1;"
            + "var block=document.createElement('div');"
            + "block.id='miniUpdateBlock';"
            + "block.innerHTML='<div class=\"row\"><div>"
            + "<div class=\"label\">App 更新</div>"
            + "<div class=\"hint\" id=\"miniUpdateHint\">检查这台手机上的版本是不是最新的</div>"
            + "</div><div style=\"flex:0 0 auto\"><button class=\"btn\" id=\"miniUpdateBtn\">检查</button></div></div>';"
            // 位置：挪到「权限档位」之前（2026-11-10 李四审完的顺序）。
            // 更新是偶发维护，占着首屏会让人以为"现在就该更新"；
            // 日常要改的是连接、显示、提醒，那些应该在前面。
            + "function place(){"
            + "var perm=document.getElementById('permBlock');"
            + "if(!perm){setTimeout(place,500);return;}"
            // 先把「权限档位」挪到「进阶设置」之前：两件都改电脑能做什么，放在一起才顺；
            // 夹在日常交互设置里反而像普通偏好（2026-11-10 李四审完的顺序）。
            // **顺序有讲究**：得先挪它，再把更新插到它前面，否则更新会停在交互设置的上面。
            + "var adv=document.getElementById('rowMirror')||document.getElementById('rowMirrorOpen');"
            + "if(adv&&perm.nextElementSibling!==adv){adv.parentNode.insertBefore(perm,adv);}"
            + "if(block.nextElementSibling!==perm)perm.parentNode.insertBefore(block,perm);"
            + "}"
            + "place();"
            + "var btn=document.getElementById('miniUpdateBtn');"
            + "var hint=document.getElementById('miniUpdateHint');"
            + "function say(t){hint.textContent=t;}"
            // **把"我现在是哪个版本"写在脸上**（2026-11-09）。之前反复出现"到底装没装上"
            // 的扯皮：界面只回答"是不是最新"，不回答"我是谁"。这里显示本机安装包的指纹前 8 位，
            // 和电脑端报的那串一比，一眼就能看出是不是同一份。
            + "var selfTag='';"
            + "try{var hh=window.MiniUpdate&&window.MiniUpdate.selfHash?window.MiniUpdate.selfHash():'';"
            + "if(hh)selfTag=hh.slice(0,8);}catch(e){}"
            + "if(selfTag)say('当前版本 '+selfTag+' · 点检查看有没有新版');"
            + "btn.addEventListener('click',function(){"
            + "if(!window.MiniUpdate){say('这个版本还不支持自动更新。');return;}"
            + "btn.disabled=true;say('正在查询…');"
            + "fetch('/mini/api/app-update?flavor=" + com.dsh.miniremote.BuildConfig.FLAVOR + "',{credentials:'same-origin'})"
            + ".then(function(r){return r.json();})"
            + ".then(function(o){"
            + "if(!o||!o.ok){say((o&&o.error)||'电脑端暂时没有可发的安装包。');btn.disabled=false;return;}"
            + "var mine=window.MiniUpdate.selfHash?window.MiniUpdate.selfHash():'';"
            + "if(mine&&o.sha256&&mine===o.sha256){say('已经是最新版本（'+selfTag+'）。');btn.disabled=false;return;}"
            + "say('发现新版本：本机 '+selfTag+' → 电脑 '+String(o.sha256||'').slice(0,8)+'，开始下载（'+(Math.round((o.size||0)/1048576))+' MB）…');"
            + "window.__miniUpdateProgress=function(p){say('正在下载 '+p+'%…');};"
            + "window.__miniUpdateSwitch=function(){say('这条线路整块传不动，改成分段下载…');};"
            + "window.MiniUpdate.install(o.url, o.size||0);"
            // 原来这里会再写一句"下载完成后会弹出安装界面"（2026-11-10 用户要求去掉）：
            // 进度百分比本身已经说明在下载，安装器弹出来是自然的事，多一句只是噪音。
            + "setTimeout(function(){btn.disabled=false;},1200);"
            + "})"
            + ".catch(function(){say('查询失败，检查一下连接。');btn.disabled=false;});"
            + "});"
            + "})();";

    /**
     * 顶栏：品牌名 + 当前会话名（2026-11-09 用户要求，**只在 App 里**，网页版不动）。
     *
     * 为什么放在外壳而不改页面：这是「手机 App 的界面长相」，网页版有它自己的一套，
     * 改页面等于两边一起改。
     *
     * 会话名从哪来：页面把 `state` 关在闭包里，外面读不到；但 `/mini/api/state` 的快照
     * 里带着 `boundSessionId` 和会话列表（每项有 title）。只在**加载时**和**点了会话之后**
     * 各取一次——快照含整段历史，定时轮询会把流量白白烧掉。
     */
    private static final String BRAND_JS = "(function(){"
            + "if(window.__miniBrand)return;"
            + "var header=document.querySelector('header');"
            + "var brand=header?header.querySelector('.brand'):null;"
            + "if(!brand)return;"
            + "window.__miniBrand=1;"
            + "var box=document.createElement('span');"
            + "box.className='mini-brand-box';"
            + "var top=document.createElement('span');"
            + "top.className='mini-brand-title';"
            + "top.textContent='DSH Everywhere';"
            + "var sub=document.createElement('span');"
            + "sub.className='mini-brand-session';"
            + "sub.textContent='';"
            + "box.appendChild(top);box.appendChild(sub);"
            + "brand.parentNode.replaceChild(box,brand);"
            + "function paint(name){"
            + "var text=name||'';"
            + "if(sub.textContent===text)return;"
            + "sub.textContent=text;"
            + "sub.title=text;"            // 太长时手指按住能看到全名
            + "}"
            + "function pull(){"
            + "fetch('/mini/api/state',{credentials:'same-origin'})"
            + ".then(function(r){return r.json();})"
            + ".then(function(s){"
            + "var id=s&&s.boundSessionId;"
            + "var list=(s&&s.sessions)||[];"
            + "var row=null;"
            + "for(var i=0;i<list.length;i++){if(list[i].id===id){row=list[i];break;}}"
            + "var name=row&&row.title?String(row.title):'';"
            + "if(name){paint(name);return;}"
            // 快照里的标题可能是空的：再问一次「按编号查名字」那条接口
            // （电脑端那份落盘缓存，和飞书通知用的是同一份）。
            + "if(!id){paint('未命名会话');return;}"
            + "fetch('/mini/api/session-name?sessionId='+encodeURIComponent(id),{credentials:'same-origin'})"
            + ".then(function(r){return r.json();})"
            + ".then(function(o){paint((o&&o.title)||'未命名会话');})"
            + ".catch(function(){paint('未命名会话');});"
            + "}).catch(function(){});"
            + "}"
            // 快照里的标题**可能是空的**（真机实测：服务端那份元信息没带上标题，
            // 而导航里读日志折出来的名字是有的）。所以再补一条：导航里「当前会话」那一行
            // 一旦出现，就拿它的名字——那是用户亲眼看到的那个名字，口径一致。
            + "function fromNav(){"
            + "var el=document.querySelector('#nav .sess.cur .s-title');"
            + "if(!el)return;"
            + "var name=(el.textContent||'').trim();"
            + "if(name)paint(name);"
            + "}"
            + "try{"
            + "var nav=document.getElementById('nav');"
            + "if(nav&&window.MutationObserver){new MutationObserver(fromNav).observe(nav,{childList:true,subtree:true});}"
            + "}catch(e){}"
            + "fromNav();"
            + "pull();"
            // 点了会话（含新建）之后再取一次：那是「当前会话」变化的唯一入口。
            + "document.addEventListener('click',function(e){"
            + "var t=e.target;"
            + "while(t&&t!==document){"
            + "if(t.getAttribute&&(t.getAttribute('data-sess')||t.id==='btnNav')){setTimeout(function(){pull();fromNav();},900);return;}"
            + "t=t.parentNode;"
            + "}"
            + "},true);"
            + "})();";

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
            + "if(!send.querySelector('svg')){"
            + "var ns='http://www.w3.org/2000/svg';"
            + "var svg=document.createElementNS(ns,'svg');"
            + "svg.setAttribute('viewBox','0 0 24 24');"
            + "svg.setAttribute('aria-hidden','true');"
            + "var path=document.createElementNS(ns,'path');"
            // 短杆 + 粗箭头：杆从 y=17 到 y=9，头从 (7,13) 到 (12,8) 再到 (17,13)。
            + "path.setAttribute('d','M12 18.6V7.4M6.3 12.5 12 6.8l5.7 5.7');"
            + "svg.appendChild(path);"
            + "send.appendChild(svg);"
            + "}"
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
            // 输入框在「嵌着图标」和「下方工具栏」两种形态下高度不一样（差三十多像素）。
            // 发指令后键盘收起、形态切回，聊天区高度跟着变，人就会觉得页面往上跳了一下。
            // 所以：切换前人在底部，切换后补两次贴底（2026-11-08 用户报的）。
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

    /**
     * 被"亮屏"通知叫起来时（2026-11-10）：
     * 允许在有锁屏时把自己显示出来，并把熄着的屏幕点亮。
     *
     * **只是亮屏 + 显示，不是解锁**——有密码的话仍然停在锁屏上，用户得自己滑开。
     */
    private void applyWakeIntent(android.content.Intent intent) {
        if (intent == null || !intent.getBooleanExtra("wakeup", false)) {
            return;
        }
        if (android.os.Build.VERSION.SDK_INT >= 27) {
            setShowWhenLocked(true);
            setTurnScreenOn(true);
        } else {
            getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                    | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
        }
        intent.removeExtra("wakeup");
    }

    @Override
    protected void onResume() {
        super.onResume();
        isResumed = true;
        // 回到前台时重新按地址池顺序探测；网络切换后的首次操作不会长期困在旧地址。
        if (addressPool != null) {
            probeAddresses();
        }
        if (poller != null && loadedBase != null) {
            startPolling(loadedBase);
        }
        // 回到前台：如果刚才有"被系统拦住"的说明没来得及讲，现在弹出来。
        if (pendingGuide != null) {
            final String text = pendingGuide;
            pendingGuide = null;
            new android.app.AlertDialog.Builder(this)
                    .setTitle("打开 App 被系统拦住了")
                    .setMessage(text)
                    .setPositiveButton("知道了", null)
                    .show();
        }
        // 回前台：前台轮询接手，长连接让位——两条同时跑只会重复提醒。
        MiniForegroundService.stop(this);
        // 桥的心跳也从服务手里收回界面这边（2026-11-09 加固）。
        applyBridgeArm();
    }

    @Override
    protected void onPause() {
        super.onPause();
        isResumed = false;
        // 退到后台就停轮询；改由前台服务保持一条推送连接，否则锁屏后什么都收不到。
        final boolean taskRunning = poller != null && poller.taskRunning();
        if (poller != null) {
            poller.stop();
        }
        /* 退到后台时**一律接过后台盯着**（2026-11-09 用户要求）。
         *
         * 原来只在"页面已经知道有任务在跑"时才接过去。可真实的使用顺序偏偏相反：
         * 发完一句话就锁屏——那一刻页面还没收到"开始跑"的状态，于是服务根本没启动，
         * 任务跑完了也没有任何通知。这正是"通知从来不弹"的真正原因。
         *
         * 现在的分工：壳这边不判断，交给服务自己判断——它先盯着，**看到有任务在跑就继续盯，
         * 一直没任务就几分钟后自己收摊**（它那条常驻通知是 MIN 级，不占状态栏）。
         */
        if (loadedBase != null && credentials != null) {
            // 把桥的心跳一起交给服务：界面可能被系统回收，心跳不能跟着断。
            MiniForegroundService.start(this, loadedBase, credentials.deviceCredential(), bridgeArmed());
        } else {
            MiniForegroundService.stop(this);
        }
        // 界面这边先停掉自己那条，免得同一台手机开两条心跳。
        if (bridgeArmed()) {
            bridgePoller.stop();
        }
        if (taskRunning) {
            // 页面此刻确实在跑：什么都不用额外做，服务接上了就会等到它结束。
        }
    }

    /**
     * 用户此刻是否正看着这一页：应用在最前面、屏幕也亮着（2026-11-08）。
     *
     * 只按 onResume/onPause 判断不够——屏幕自动熄掉时 Activity 不会暂停，
     * 那时人已经走了，却仍被当成"在看着"，于是什么提醒都不发。
     */
    private boolean userIsLooking() {
        if (!isResumed) {
            return false;
        }
        android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
        return pm == null || pm.isInteractive();
    }

    /** 屏幕亮起/熄灭：熄屏后要把后台连接顶上，亮屏且在前台就撤掉。 */
    private final android.content.BroadcastReceiver screenReceiver =
            new android.content.BroadcastReceiver() {
                @Override
                public void onReceive(android.content.Context context, Intent intent) {
                    boolean on = Intent.ACTION_SCREEN_ON.equals(intent.getAction());
                    if (!on) {
                        startBackgroundServiceIfTaskRunning();
                    } else if (isResumed) {
                        MiniForegroundService.stop(MainActivity.this);
                    }
                }
            };

    private void startBackgroundServiceIfTaskRunning() {
        boolean taskRunning = poller != null && poller.taskRunning();
        if (taskRunning && loadedBase != null && credentials != null) {
            try {
                MiniForegroundService.start(this, loadedBase, credentials.deviceCredential());
            } catch (RuntimeException e) {
                // 安卓 14 起对「从后台拉起前台服务」管得严，被拒时不能让整个 App 崩掉：
                // 退回到前台轮询那条路，通知会晚一点，但不会没有（2026-11-08）。
            }
        }
    }

    private void probeAddresses() {
        if (probing || destroyed || addressPool == null) {
            return;
        }
        // 内核还在启动：这时的探测必然失败（代理还没挂上），
        // 让它跑只会把线路换成别的、并在 tailnet 地址上留一个错误页（2026-11-08）。
        if (tailNetStarting) {
            return;
        }
        // 内置 Tailscale 已连上、并且用户选的就是 tailnet 线路：这就是他要的路，
        // 不再去探测别的线路。否则内网地址会经隧道「同样可达」而被抢走首选，
        // 代理也会因为切到非 tailnet 地址被撤掉（2026-11-08 实测踩到）。
        final String chosen = Connections.preferred(this);
        if (chosen != null && Net.isTailnetAddress(chosen) && holdsTailnetLine()) {
            enableTailProxy(new Runnable() {
                @Override
                public void run() {
                    selectAddress(chosen);
                }
            });
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
                // 先按固定槽位排（2026-11-07 用户要求）：清空的那条仍然占一个位置，
                // 显示成「未配置」，随时能重新填。
                java.util.Set<String> usedSlots = new java.util.HashSet<>();
                for (String slot : SLOT_KINDS) {
                    AddressPool.Entry found = null;
                    for (AddressPool.Entry entry : credentials.addresses) {
                        if (slot.equals(Connections.slotOf(entry.type))) {
                            found = entry;
                            break;
                        }
                    }
                    usedSlots.add(slot);
                    JSONObject item = new JSONObject();
                    item.put("kind", slot);
                    item.put("label", Connections.labelOf(slot));
                    item.put("url", found == null ? "" : found.baseUrl);
                    item.put("type", found == null ? slot : found.type);
                    item.put("configured", found != null);
                    item.put("current", found != null && found.baseUrl.equals(loadedBase));
                    items.put(item);
                }
                // 槽位之外的（比如手动加的），原样附在后面。
                for (AddressPool.Entry entry : credentials.addresses) {
                    if (usedSlots.contains(Connections.slotOf(entry.type))) {
                        continue;
                    }
                    JSONObject item = new JSONObject();
                    item.put("kind", Connections.slotOf(entry.type));
                    item.put("label", Connections.labelOf(entry.type));
                    item.put("url", entry.baseUrl);
                    item.put("type", entry.type);
                    item.put("configured", true);
                    item.put("current", entry.baseUrl.equals(loadedBase));
                    items.put(item);
                }
                root.put("items", items);
                // 内置 Tailscale 的两件事，页面要用它们决定要不要提示「启动激活」：
                //   session   —— 账号/身份已经就位（登录过，不是没登录）
                //   connected —— 内核此刻在跑
                JSONObject tailnet = new JSONObject();
                tailnet.put("session", TailNet.hasSession(MainActivity.this));
                tailnet.put("connected", TailNet.isConnected());
                root.put("tailnet", tailnet);
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

        /**
         * 逐条探一下通不通，结果回吐给页面点灯（2026-11-07）。
         *
         * 每条各开一个线程：八条线路串着探，慢的时候要等一两分钟，
         * 圆点就一直是灰的；并行探最多等一个超时。
         */
        @JavascriptInterface
        public String probe() {
            final String deviceCredential = credentials.deviceCredential();
            for (final AddressPool.Entry entry : credentials.addresses) {
                Thread thread = new Thread(new Runnable() {
                    @Override
                    public void run() {
                        final boolean reachable = reachableQuick(entry.baseUrl, deviceCredential);
                        mainHandler.post(new Runnable() {
                            @Override
                            public void run() {
                                if (destroyed || webView == null) {
                                    return;
                                }
                                webView.evaluateJavascript(
                                        "window.miniConnStatus && window.miniConnStatus("
                                                + org.json.JSONObject.quote(entry.baseUrl) + ","
                                                + reachable + ")",
                                        null);
                            }
                        });
                    }
                }, "mini-line-probe");
                thread.start();
            }
            return "ok";
        }

        /** 打开某条线路的配置页；空字符串表示添加新地址。 */
        @JavascriptInterface
        public String config(String url, boolean current, String kind) {
            final String target = url == null ? "" : url;
            final boolean isCurrent = current;
            final String slot = kind == null ? "" : kind;
            mainHandler.post(new Runnable() {
                @Override
                public void run() {
                    if (destroyed) {
                        return;
                    }
                    Intent intent = new Intent(MainActivity.this, LineConfigActivity.class);
                    if (!target.isEmpty()) {
                        intent.putExtra(LineConfigActivity.EXTRA_URL, target);
                    }
                    intent.putExtra(LineConfigActivity.EXTRA_CURRENT, isCurrent);
                    intent.putExtra(LineConfigActivity.EXTRA_KIND, slot);
                    startActivityForResult(intent, REQUEST_LINE_CONFIG);
                }
            });
            return "ok";
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

    /**
     * 判断一条地址是不是真的「我们自己那台电脑」（2026-11-07）。
     *
     * 早先只连端口，结果闹了个笑话：没装 Tailscale 的手机上，
     * desktop-xxx.ts.net 被本机 VPN 客户端解析成了公网地址，端口有人应答，
     * 圆点就绿了——那不是我们的服务。所以这里真的去问一次版本接口，
     * 只有它按我们的约定回话，才算这条线通。
     *
     * 超时压得比正常请求短：圆点是「大致能用」的提示，不该让界面等十几秒。
     */
    private static boolean reachableQuick(String baseUrl, String deviceCredential) {
        java.net.HttpURLConnection connection = null;
        try {
            // 走 Net.open：tailnet 地址要过内置内核的代理，否则清单上的圆点
            // 永远红着，明明页面已经能打开（2026-11-08 用户反馈）。
            connection = Net.open(baseUrl + "/mini/api/version");
            connection.setRequestMethod("GET");
            boolean tailnet = Net.isTailnetAddress(baseUrl);
            connection.setConnectTimeout(tailnet ? 6000 : 2500);
            connection.setReadTimeout(tailnet ? 9000 : 3500);
            connection.setUseCaches(false);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("X-Mini-Device", deviceCredential);
            int status = connection.getResponseCode();
            return status >= 200 && status < 300;
        } catch (Exception e) {
            return false;
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private boolean probeOnce(String baseUrl, String deviceCredential) {
        try {
            Net.Response response = Net.get(baseUrl + "/mini/api/version", deviceCredential);
            return response.isSuccess();
        } catch (IOException e) {
            return false;
        }
    }

    /**
     * 把 WebView 的流量切到内置内核的本地代理（2026-11-08）。
     *
     * 只挂代理、不加直连兜底：这个模式下我们要的就是「全部走隧道」，
     * 直连兜底会让本该走隧道的请求悄悄走公网，反而更难查。
     */
    private void enableTailProxy(final Runnable after) {
        if (webView == null) {
            if (after != null) after.run();
            return;
        }
        if (tailProxyOn) {
            if (after != null) after.run();
            return;
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            Toast.makeText(this, "这个系统不支持给应用内网页设代理，内置 Tailscale 用不了。",
                    Toast.LENGTH_LONG).show();
            if (after != null) after.run();
            return;
        }
        ProxyConfig config = new ProxyConfig.Builder()
                .addProxyRule(TailNet.PROXY_HOST + ":" + TailNet.PROXY_PORT)
                .build();
        pendingAfterProxy = after;
        ProxyController.getInstance().setProxyOverride(config, mainHandler::post, new Runnable() {
            @Override
            public void run() {
                tailProxyOn = true;
                Net.setTailnetProxy(new java.net.Proxy(java.net.Proxy.Type.HTTP,
                        new java.net.InetSocketAddress(TailNet.PROXY_HOST, TailNet.PROXY_PORT)));
                Log.i("MiniTailProxy", "代理已设到 " + TailNet.PROXY_HOST + ":" + TailNet.PROXY_PORT);
                Runnable next = pendingAfterProxy;
                pendingAfterProxy = null;
                if (next != null) {
                    next.run();
                }
            }
        });
    }

    /**
     * 切到 tailnet 线路前，确认内置内核在跑（2026-11-08）。
     *
     * 内核是应用进程的子进程，进程被杀、或者用户之前切到别的线路，
     * 它都可能已经没了；这时只设代理会让页面直接报「无法访问」。
     */
    /**
     * 等隧道真的能走通再打开页面（2026-11-08）。
     *
     * 后端说「已连接」不等于第一包就通得过：刚连上时还要选路径（直连或中继），
     * 这期间发出去的第一个请求会失败。启动即加载页面就会撞上它，页面停在一个
     * 错误页上再也回不来。
     */
    private void whenTailnetReachable(final Runnable after) {
        final String target = Connections.preferred(this);
        if (target == null || target.isEmpty()) {
            after.run();
            return;
        }
        final String credential = credentials == null ? "" : credentials.deviceCredential();
        new Thread(new Runnable() {
            @Override
            public void run() {
                for (int i = 0; i < 20; i++) {
                    try {
                        Net.Response response = Net.get(target + "/mini/api/version", credential);
                        if (response.isSuccess() || response.status == 401 || response.status == 403) {
                            break; // 通了（401/403 也说明服务端在答话）
                        }
                    } catch (IOException ignored) {
                        // 再等一秒重试。
                    }
                    try {
                        Thread.sleep(1000);
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
                mainHandler.post(after);
            }
        }, "mini-tailnet-ready").start();
    }

    /** 现在是不是该由内置线路说了算：正在启动，或者已经连上，都算。 */
    private boolean holdsTailnetLine() {
        return !tailNetGivenUp && (tailNetStarting || TailNet.isConnected());
    }

    private void ensureTailNetThen(final Runnable after) {
        if (TailNet.isConnected()) {
            cancelTailNetIdleStop();
            enableTailProxy(after);
            return;
        }
        if (!TailNet.hasSession(this)) {
            Toast.makeText(this, "这条线路要用内置 Tailscale，先在它的配置页填授权密钥。",
                    Toast.LENGTH_LONG).show();
            if (after != null) after.run();
            return;
        }
        Toast.makeText(this, "正在启动内置 Tailscale……", Toast.LENGTH_SHORT).show();
        cancelTailNetIdleStop();
        tailNetStarting = true;
        new Thread(new Runnable() {
            @Override
            public void run() {
                final String failure = TailNet.startBlocking(MainActivity.this);
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        tailNetStarting = false;
                        if (destroyed) {
                            return;
                        }
                        if (failure != null) {
                            // 内核起不来就别硬往 tailnet 地址上撞：这一轮放弃内置线路，
                            // 退回自动探测，至少让用户还能用别的线路（2026-11-08）。
                            Toast.makeText(MainActivity.this,
                                    "内置 Tailscale 没起来：" + failure, Toast.LENGTH_LONG).show();
                            tailNetGivenUp = true;
                            probeAddresses();
                            return;
                        }
                        enableTailProxy(new Runnable() {
                            @Override
                            public void run() {
                                whenTailnetReachable(after);
                            }
                        });
                    }
                });
            }
        }, "mini-tailnet-ensure").start();
    }

    /**
     * 离开内置线路后计时停内核（2026-11-08）。
     *
     * 内核是个常驻进程，一直跑着白耗电；但也不能切走就立刻停——用户常常是
     * 来回切着比一比。所以留五分钟宽限，期间切回来就撤销。
     */
    private final Runnable tailNetIdleStop = new Runnable() {
        @Override
        public void run() {
            if (destroyed || tailNetStarting) {
                return;
            }
            String chosen = Connections.preferred(MainActivity.this);
            if (chosen != null && Net.isTailnetAddress(chosen)) {
                return; // 又切回 tailnet 了，别停。
            }
            new Thread(new Runnable() {
                @Override
                public void run() {
                    Log.i("MiniTailNet", "空闲超时，停掉内置内核");
                    TailNet.stop();
                }
            }, "mini-tailnet-idle-stop").start();
        }
    };

    private void scheduleTailNetIdleStop() {
        mainHandler.removeCallbacks(tailNetIdleStop);
        mainHandler.postDelayed(tailNetIdleStop, TAILNET_IDLE_STOP_MS);
    }

    private void cancelTailNetIdleStop() {
        mainHandler.removeCallbacks(tailNetIdleStop);
    }

    /** 离开 tailnet 地址时把代理撤掉，免得别的线路被它挡住。 */
    private void disableTailProxy(Runnable after) {
        if (webView == null || !tailProxyOn) {
            if (after != null) after.run();
            return;
        }
        ProxyController.getInstance().clearProxyOverride(mainHandler::post, new Runnable() {
            @Override
            public void run() {
                tailProxyOn = false;
                Net.setTailnetProxy(null);
                if (after != null) {
                    after.run();
                }
            }
        });
    }

    /** 轮询只在前台跑；地址换一条就按新地址重开一轮。 */
    private void startPolling(String baseUrl) {
        if (poller == null) {
            poller = new PendingPoller(this, this::userIsLooking);
        }
        poller.stop();
        poller.start(baseUrl, credentials.deviceCredential());
    }

    /** Cookie 按 base URL 的主机隔离，所以每次换地址都必须重新写一次。 */
    private void selectAddress(final String baseUrl) {
        // 同样的理由：内置线路在用的时候，别让探测结果把它顶掉。
        final String chosen = Connections.preferred(this);
        if (chosen != null && Net.isTailnetAddress(chosen) && holdsTailnetLine()
                && !chosen.equals(baseUrl)) {
            return;
        }
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
                        final Runnable load = new Runnable() {
                            @Override
                            public void run() {
                                if (destroyed || generation != loadGeneration) {
                                    return;
                                }
                                loadedBase = baseUrl;
                                pageReady = false;
                                webView.loadUrl(baseUrl + "/mini/");
                                startPolling(baseUrl);
                                deliverPendingShare();
                            }
                        };
                        // tailnet 地址必须走内置内核的代理；其它地址要把代理撤掉，
                        // 否则一条不可达的隧道会把所有线路都拖死（2026-11-08）。
                        if (Net.isTailnetAddress(baseUrl)) {
                            ensureTailNetThen(load);
                        } else {
                            cancelTailNetIdleStop();
                            disableTailProxy(new Runnable() {
                                @Override
                                public void run() {
                                    scheduleTailNetIdleStop();
                                    load.run();
                                }
                            });
                        }
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

    /**
     * 手机上的显示设置（显示模式、外观、字号、流式等）跟着这台手机走，不跟着线路走。
     *
     * 这些值页面本来存在 localStorage 里，而 localStorage 是按地址（源）隔离的：
     * 换一条线路就等于换了个地址，设置全丢。所以在壳里存一份，页面一加载就写回去，
     * 页面里改的也回写到这里。**只存在手机上**，不往电脑端写，所以桌面端不受影响。
     */
    private static final String[] UI_PREF_KEYS = {
            "dshMiniMode", "dshMiniSound", "dshMiniStreaming",
            "dshMiniTheme", "dshMiniFont", "dshMiniNotify",
    };

    private static boolean isUiPrefKey(String key) {
        if (key == null) {
            return false;
        }
        for (String allowed : UI_PREF_KEYS) {
            if (allowed.equals(key)) {
                return true;
            }
        }
        return false;
    }

    private android.content.SharedPreferences uiPrefs() {
        return getSharedPreferences("mini_ui_prefs", MODE_PRIVATE);
    }

    /** 页面能调的那一端：读一份全量、写单个键、删单个键。 */
    private final class UiPrefsBridge {
        @android.webkit.JavascriptInterface
        public String all() {
            org.json.JSONObject out = new org.json.JSONObject();
            android.content.SharedPreferences prefs = uiPrefs();
            for (String key : UI_PREF_KEYS) {
                String value = prefs.getString(key, null);
                if (value != null) {
                    try {
                        out.put(key, value);
                    } catch (org.json.JSONException ignored) {
                        // 键是固定常量，不会失败。
                    }
                }
            }
            return out.toString();
        }

        @android.webkit.JavascriptInterface
        public void save(String key, String value) {
            if (!isUiPrefKey(key) || value == null) {
                return;
            }
            uiPrefs().edit().putString(key, value).apply();
        }

        @android.webkit.JavascriptInterface
        public void remove(String key) {
            if (isUiPrefKey(key)) {
                uiPrefs().edit().remove(key).apply();
            }
        }
    }

    /** 手机桥（P2 第一步）：武装开关 + 心跳。整个 Activity 一份。 */
    private final BridgePoller bridgePoller = new BridgePoller();

    /** 武装状态由统一控制器读写，设置页与停止胶囊才能看到同一个结果。 */
    private boolean bridgeArmed() {
        return BridgeControl.isArmed(this);
    }

    /**
     * 手机桥（P2 第一步，2026-11-09）。
     *
     * **武装**是用户自己的动作：只有在这里打开，桥才开始心跳；关掉立刻停。
     * 第一步只有"在线/离线"，没有任何工具——所以这一页只回答一件事：
     * "电脑知道这台手机在不在"。
     */
    /** JavaScript 调用不等于本人授权；敏感入口必须在原生界面里再确认一次。 */
    private boolean confirmOnPhone(String title, String message) {
        if (destroyed || !isResumed) return false;
        final java.util.concurrent.CountDownLatch latch = new java.util.concurrent.CountDownLatch(1);
        final boolean[] approved = { false };
        final AlertDialog[] dialog = new AlertDialog[1];
        runOnUiThread(() -> {
            if (destroyed) {
                latch.countDown();
                return;
            }
            try {
                dialog[0] = new AlertDialog.Builder(this)
                        .setTitle(title)
                        .setMessage(message)
                        .setPositiveButton("允许", (d, w) -> {
                            approved[0] = true;
                            latch.countDown();
                        })
                        .setNegativeButton("拒绝", (d, w) -> latch.countDown())
                        .setOnCancelListener(d -> latch.countDown())
                        .create();
                dialog[0].show();
            } catch (Exception err) {
                Log.w("MiniBridge", "原生确认框显示失败", err);
                latch.countDown();
            }
        });
        try {
            if (!latch.await(30, java.util.concurrent.TimeUnit.SECONDS)) {
                runOnUiThread(() -> {
                    if (dialog[0] != null) dialog[0].dismiss();
                });
                return false;
            }
        } catch (InterruptedException err) {
            Thread.currentThread().interrupt();
            return false;
        }
        return approved[0];
    }

    private final class BridgeBridge {
        @android.webkit.JavascriptInterface
        public String state() {
            JSONObject root = new JSONObject();
            try {
                root.put("armed", bridgeArmed());
                root.put("online", bridgePoller.isOnline());
                root.put("failures", bridgePoller.failures());
            } catch (JSONException ignored) {
                return "{}";
            }
            return root.toString();
        }

        @android.webkit.JavascriptInterface
        public String arm(boolean armed) {
            if (armed && !confirmOnPhone("开启手机桥？",
                    "开启后，电脑可以按你的授权读取手机状态、发送通知和文件，并在你确认后写剪贴板。实验版还可能读取非敏感界面的控件。是否允许？")) {
                toastOnUi("未开启手机桥：没有获得本机确认");
                return "{\"armed\":false,\"error\":\"没有获得本机确认\"}";
            }
            // **必须真的去告诉电脑**（2026-11-09 修）：电脑那边的武装状态只由这条 POST 写。
            // 原来只在本机存了个开关就去轮询，于是每次问回来的都是"没武装"，
            // 心跳按"已被关掉"处理、立刻停——界面就永远停在"正在连接电脑"。
            final String base = loadedBase;
            final String cred = credentials == null ? null : credentials.deviceCredential();
            // 设置页和停止胶囊共用同一个控制器；离线停止也不会被远端回执翻盘。
            BridgeControl.setArmed(MainActivity.this, armed, base, cred, message -> {
                applyBridgeArm();
                Log.w("MiniBridge", "武装状态提交失败：" + message);
                toastOnUi("手机桥状态提交失败，已在本机停止：" + message);
            });
            applyBridgeArm();
            // 注入有时赶在页面真正稳定之前，会被下一次导航清掉（2026-11-09 实测：
            // 探针脚本一次都没执行）。延迟再补一次，脚本自己是幂等的。
            webView.postDelayed(() -> {
                if (webView != null) {
                    // 返回手势那个钩子同样要补一次：第一次注入常常赶在页面稳定前被导航冲掉。
                    webView.evaluateJavascript(BACK_UI_JS, null);
                    webView.evaluateJavascript(SETTINGS_UI_JS, null);
                }
            }, 2_000L);
            JSONObject root = new JSONObject();
            try {
                root.put("armed", armed);
                root.put("online", bridgePoller.isOnline());
            } catch (JSONException ignored) {
                return "{}";
            }
            return root.toString();
        }
    }

    /** 按当前武装状态开/停心跳；页面加载完、切线路、开关变化都走这里。 */
    /**
     * 等着给用户看的说明（2026-11-10）。
     *
     * 被系统拦住的那一刻，前台是别的 App，我们弹窗也看不见——所以先记下来，
     * 等用户回到我们界面时再弹。**弹出去的东西必须是用户主动回到这里才出现的**，
     * 不是凭空盖在别人头上。
     */
    static volatile String pendingGuide;

    /** 心跳上线/掉线时，页面上的状态跟着变。 */
    private void hookBridgeCallback() {
        bridgePoller.attach(this);
        bridgePoller.setOnChange(this::pushBridgeStatus);
    }

    private void applyBridgeArm() {
        BridgeControl.syncPoller(this, bridgePoller, loadedBase,
                credentials == null ? null : credentials.deviceCredential());
        pushBridgeStatus();
    }

    /** 把"在线/离线"推给页面，免得界面自己去猜。 */
    private void pushBridgeStatus() {
        if (webView == null) {
            return;
        }
        final String online = bridgePoller.isOnline() ? "true" : "false";
        runOnUiThread(() -> webView.evaluateJavascript(
                "window.miniBridgeStatus&&window.miniBridgeStatus(" + online + ")", null));
    }

    /**
     * P0 探针（2026-11-09）：只验证「开无障碍 → 截图 → 点一下」这条路通不通。
     *
     * 实现放在 bridge 构建版本里（standard 版根本没有那个类），所以这里用反射找它——
     * 标准版调用这些方法只会得到"这个版本没有探针"，不会崩。
     *
     * **没有任何远程入口**：每一次截图/点击都必须是用户在设置页上亲手点的。
     */
    private final class ProbeBridge {
        private Class<?> serviceClass() {
            try {
                return Class.forName("com.dsh.miniremote.BridgeAccessibilityService");
            } catch (ClassNotFoundException err) {
                return null;
            }
        }

        @android.webkit.JavascriptInterface
        public String status() {
            JSONObject out = new JSONObject();
            try {
                Class<?> cls = serviceClass();
                out.put("available", cls != null);
                out.put("running", cls != null && (boolean) cls.getDeclaredMethod("isRunning")
                        .invoke(null));
            } catch (Exception err) {
                try {
                    out.put("available", false);
                    out.put("error", String.valueOf(err.getMessage()));
                } catch (JSONException ignored) {
                    return "{}";
                }
            }
            return out.toString();
        }

        @android.webkit.JavascriptInterface
        public String confirmMode() {
            try {
                JSONObject out = new JSONObject();
                out.put("mode", ConfirmationControl.selectedMode(MainActivity.this));
                return out.toString();
            } catch (JSONException err) {
                return "{\"mode\":\"off\"}";
            }
        }

        /**
         * 切档只写设置，**不打断正在跑的那一轮**（2026-11-10 用户要求）：
         * 新档位从下一个任务编号开始生效，手机侧 ConfirmationState 会一直用旧档跑完当前轮。
         */
        @android.webkit.JavascriptInterface
        public void confirmMode(String mode) {
            ConfirmationControl.setSelectedMode(MainActivity.this, mode);
        }

        @android.webkit.JavascriptInterface
        public void openSettings() {
            runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(intent);
                } catch (Exception ignored) {
                    // 打不开就算了：界面上的状态会显示"未开启"。
                }
            });
        }

        @android.webkit.JavascriptInterface
        public String shot() {
            Class<?> cls = serviceClass();
            if (cls == null) {
                return "这个版本没有探针";
            }
            try {
                return (String) cls.getDeclaredMethod("takeShot", java.io.File.class)
                        .invoke(null, new java.io.File(getCacheDir(), "probe"));
            } catch (Exception err) {
                return "错误：" + err.getMessage();
            }
        }

        /**
         * 跳到系统的「应用跳转提醒」开关那儿（2026-11-10）。
         *
         * 安卓没给第三方 App 改这个开关的权限，只能带用户过去；而且荣耀用的是自家设置，
         * 页面入口未必是标准那个——所以**依次试几个，都不行就退到设置首页**，
         * 界面上写清页面名字让人自己找。假装能一键关掉才是骗人。
         */
        /** 跳到系统的「全屏通知」授权页（安卓 14 起才有这一页）。 */
        @android.webkit.JavascriptInterface
        public void openFullScreenSettings() {
            runOnUiThread(() -> {
                if (android.os.Build.VERSION.SDK_INT >= 34) {
                    try {
                        Intent intent = new Intent(android.provider.Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT);
                        intent.setData(android.net.Uri.parse("package:" + getPackageName()));
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(intent);
                        return;
                    } catch (Exception ignored) {
                        // 跳不过去就退到应用详情页，让用户自己找。
                    }
                }
                try {
                    Intent fallback = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                    fallback.setData(android.net.Uri.parse("package:" + getPackageName()));
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(fallback);
                } catch (Exception ignored) {
                    toastOnUi("打不开系统设置");
                }
            });
        }

        @android.webkit.JavascriptInterface
        public boolean canWakeScreen() {
            return Notifier.canWakeScreen(this_());
        }

        private android.content.Context this_() {
            return MainActivity.this;
        }

        @android.webkit.JavascriptInterface
        public void openPrivacySettings() {
            runOnUiThread(() -> {
                String[] candidates = {
                        "android.settings.PRIVACY_SETTINGS",
                        "android.settings.SECURITY_SETTINGS",
                        "android.settings.APPLICATION_SETTINGS",
                };
                for (String action : candidates) {
                    try {
                        Intent intent = new Intent(action);
                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                        startActivity(intent);
                        return;
                    } catch (Exception ignored) {
                        // 这个入口不存在，试下一个。
                    }
                }
                try {
                    Intent fallback = new Intent(android.provider.Settings.ACTION_SETTINGS);
                    fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(fallback);
                } catch (Exception ignored) {
                    toastOnUi("打不开系统设置");
                }
            });
        }

        @android.webkit.JavascriptInterface
        public String observe() {
            Class<?> cls = serviceClass();
            if (cls == null) {
                return "{\"ok\":false,\"error\":\"这个版本没有探针\"}";
            }
            try {
                return (String) cls.getDeclaredMethod("observe").invoke(null);
            } catch (Exception err) {
                return "{\"ok\":false,\"error\":\"" + String.valueOf(err.getMessage()).replace("\"", "'") + "\"}";
            }
        }

        @android.webkit.JavascriptInterface
        public String tap(float x, float y) {
            Class<?> cls = serviceClass();
            if (cls == null) {
                return "这个版本没有探针";
            }
            try {
                return (String) cls.getDeclaredMethod("tap", float.class, float.class)
                        .invoke(null, x, y);
            } catch (Exception err) {
                return "错误：" + err.getMessage();
            }
        }
    }


    /**
     * 发一条通知（2026-11-09）。
     *
     * 现在**没有界面入口**：设置页那行「通知 · 发一条」是排障时临时加的，通知通了
     * 就撤掉了。这个接口保留是因为 P2 的 `phone_notify` 要走的正是这条路径——
     * 到时候它会被重新接上，不该为了一行界面而删掉。
     *
     * 起因：真机上"任务跑完"那条通知一次都没弹过，而**弹不出来有五六种可能**——
     * 系统通知权限被关、渠道被关、服务没在跑、轮询没连上、通知被建但立刻取消。
     * 让用户分辨这些不现实。这个桥只做两件事：**立刻发一条**，并把"系统到底允不允许"
     * 一起报出来。能不能弹出，就不再靠猜。
     */
    private final class NotifyBridge {
        @android.webkit.JavascriptInterface
        public String test() {
            try {
                android.app.NotificationManager manager = getSystemService(android.app.NotificationManager.class);
                boolean allowed = manager != null && manager.areNotificationsEnabled();
                if (!allowed) {
                    return "系统把这台设备的通知关掉了：到「设置 → 应用 → DSH Everywhere → 通知」里打开";
                }
                Notifier.showDone(MainActivity.this, "这是一条测试通知 · 如果你看到它，说明通知这条路是通的");
                return "已发送。没看到的话，检查一下是否被下拉栏折叠进了「其他通知」";
            } catch (Exception err) {
                return "发送失败：" + err.getMessage();
            }
        }
    }

    /**
     * App 内检查更新（2026-11-09 用户要求）。
     *
     * 流程：页面问电脑端要安装包的指纹 → 和**本机这一份**的指纹比 → 不一样就下载并
     * 唤起系统安装器。全线走现有那条带凭据的连接，不需要数据线。
     *
     * 为什么比指纹而不是版本号：读 APK 里的版本号要解析二进制清单，代价大、还容易
     * 随打包方式变化；内容不一样就说明包换了，对"要不要更新"已经足够。
     */
    private final class AppUpdateBridge {
        /** 本机安装包的指纹（算一次就记住：几十兆，没必要每次摸）。 */
        private String selfHash;
        /** 页面告诉我们的总字节数（用来算百分比）；0 表示不知道。 */
        private volatile long expectedBytes;
        /** 上一次报过的百分比，避免同一个数字刷屏。 */
        private volatile int lastPct = -1;

        @android.webkit.JavascriptInterface
        public String selfHash() {
            if (selfHash != null) {
                return selfHash;
            }
            try {
                String path = getPackageManager()
                        .getPackageInfo(getPackageName(), 0).applicationInfo.sourceDir;
                java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
                try (java.io.InputStream in = new java.io.FileInputStream(path)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        md.update(buf, 0, n);
                    }
                }
                StringBuilder sb = new StringBuilder();
                for (byte b : md.digest()) {
                    sb.append(String.format("%02x", b));
                }
                selfHash = sb.toString();
                return selfHash;
            } catch (Exception err) {
                return "";
            }
        }

        /** 下载并唤起安装器。参数是站内路径（如 `/mini/api/app.apk`）。 */
        @android.webkit.JavascriptInterface
        public void install(String path, double totalBytes) {
            expectedBytes = (long) totalBytes;
            lastPct = -1;
            final String base = loadedBase;
            final String cred = credentials == null ? null : credentials.deviceCredential();
            if (base == null || path == null || path.isEmpty()) {
                return;
            }
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        java.io.File dir = new java.io.File(getCacheDir(), "update");
                        java.io.File out = new java.io.File(dir, "app.apk");
                        final long total = expectedBytes;
                        // 服务器可能不认分段：那种情况下 total 未知，也照样能下完。
                        Net.DownloadOutcome outcome = Net.downloadPreferWhole(base + path, cred, out, total, written -> {
                            if (total <= 0) {
                                return;
                            }
                            final int pct = (int) Math.min(100, written * 100 / total);
                            if (pct == lastPct) {
                                return;
                            }
                            lastPct = pct;
                            runOnUiThread(() -> webView.evaluateJavascript(
                                    "window.__miniUpdateProgress&&window.__miniUpdateProgress(" + pct + ")", null));
                        }, () -> runOnUiThread(() -> webView.evaluateJavascript(
                                "window.__miniUpdateSwitch&&window.__miniUpdateSwitch()", null)));
                        if (!outcome.ok) {
                            // 用户在外面用流量，必须知道是"该换网络"还是"再点一次就行"。
                            if (!outcome.connected) {
                                toastOnUi("连不上电脑。手机能上网吗？电脑那边还开着吗？");
                            } else {
                                int done = total > 0 ? (int) Math.min(100, outcome.written * 100 / total) : 0;
                                toastOnUi("下载到 " + done + "% 断了，网络不稳。信号好些后再点一次更新。");
                            }
                            return;
                        }
                        launchInstaller(out);
                    } catch (Exception err) {
                        toastOnUi("安装包下载失败：" + err.getMessage());
                    }
                }
            }, "mini-update").start();
        }
    }

    /** 把下载好的包装上：交给系统安装器，我们只管把文件地址递过去。 */
    private void launchInstaller(java.io.File apk) {
        runOnUiThread(() -> {
            try {
                android.net.Uri uri = androidx.core.content.FileProvider.getUriForFile(
                        this, getPackageName() + ".fileprovider", apk);
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(uri, "application/vnd.android.package-archive");
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
            } catch (Exception err) {
                Toast.makeText(this, "打不开安装器：" + err.getMessage(), Toast.LENGTH_LONG).show();
            }
        });
    }

    private void toastOnUi(String text) {
        runOnUiThread(() -> Toast.makeText(this, text, Toast.LENGTH_SHORT).show());
    }

    /**
     * 把外壳存的那份设置灌进当前线路的 localStorage，并把页面的改动回写。
     *
     * 页面在启动时就把这些值读进内存了，所以写完要刷一次；用 sessionStorage 记一下
     * 已经刷过，避免来回跳。
     */
    private void applyUiPrefs() {
        if (webView == null) {
            return;
        }
        String keys = "'dshMiniMode','dshMiniSound','dshMiniStreaming',"
                + "'dshMiniTheme','dshMiniFont','dshMiniNotify'";
        String js = "(function(){"
                + "var b=window.DshMiniUi;if(!b)return;"
                + "var K=[" + keys + "];"
                + "var stored={};try{stored=JSON.parse(b.all()||'{}')||{};}catch(e){}"
                + "var changed=false;"
                + "for(var i=0;i<K.length;i++){var k=K[i],v=stored[k];"
                + "if(v===undefined||v===null){"
                // 外壳没有这个值：把页面当前的记下来，换线路时才有的继承。
                + "var cur=localStorage.getItem(k);"
                + "if(cur!==null){try{b.save(k,cur);}catch(e){}}"
                + "continue;}"
                + "if(localStorage.getItem(k)!==v){localStorage.setItem(k,v);changed=true;}}"
                + "if(!window.__miniUiPatched){window.__miniUiPatched=1;"
                + "var set=localStorage.setItem.bind(localStorage);"
                + "localStorage.setItem=function(k,v){set(k,v);"
                + "if(K.indexOf(k)>=0){try{b.save(k,String(v));}catch(e){}}};"
                + "var rem=localStorage.removeItem.bind(localStorage);"
                + "localStorage.removeItem=function(k){rem(k);"
                + "if(K.indexOf(k)>=0){try{b.remove(k);}catch(e){}}};}"
                + "if(changed&&sessionStorage.getItem('__miniUiApplied')!=='1'){"
                + "sessionStorage.setItem('__miniUiApplied','1');location.reload();return;}"
                + "sessionStorage.setItem('__miniUiApplied','1');"
                + "})();";
        webView.evaluateJavascript(js, null);
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
            /* 页面连上之后很可能再整页重载一次（鉴权/跳转），
             * 那样 onPageFinished 里注入的东西会被新文档冲掉——表现就是
             * 「品牌名没变、设置页样式没生效」。所以隔几秒补几次，页面稳了就自然停。
             * 2026-11-10 真机撞上：注入全丢，只有接口还在（接口是按 WebView 注册的）。
             */
            for (int delay = 2000; delay <= 14000; delay += 3000) {
                webView.postDelayed(() -> {
                    if (destroyed || webView == null) {
                        return;
                    }
                    injectAppOnlyStyle();
                    webView.evaluateJavascript(BACK_UI_JS, null);
                    webView.evaluateJavascript(SETTINGS_UI_JS, null);
                }, delay);
            }
            applyUiPrefs();
            // **页面真正就绪后**再武装一次：注入那一刻往往还没有 base 地址，
            // 那一次会直接跳过；而之后再没有别的时机去启动心跳，于是"开关是开的、
            // 心跳却没跑"，界面永远停在"正在连接电脑"（2026-11-09 真机实测）。
            applyBridgeArm();
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
        if (requestCode == REQUEST_LINE_CONFIG) {
            if (resultCode == RESULT_OK && data != null
                    && data.getBooleanExtra(LineConfigActivity.EXTRA_TAILNET_SIGNED_OUT, false)) {
                // 刚退出登录：撤掉代理、别的线路照旧探测，别把页面留在死隧道上。
                cancelTailNetIdleStop();
                disableTailProxy(new Runnable() {
                    @Override
                    public void run() {
                        probeAddresses();
                    }
                });
                return;
            }
            if (resultCode == RESULT_OK && data != null
                    && data.getStringExtra(LineConfigActivity.EXTRA_TAILNET_URL) != null) {
                // 配置页已经把内置内核拉起来了：先设代理，再按这条地址加载。
                final String tailUrl = data.getStringExtra(LineConfigActivity.EXTRA_TAILNET_URL);
                enableTailProxy(new Runnable() {
                    @Override
                    public void run() {
                        selectAddress(tailUrl);
                    }
                });
                return;
            }
            if (resultCode == RESULT_OK) {
                // 配置页改完了：刷新清单；如果改的是当前在用的地址，重新探测加载。
                try {
                    credentials = new PairingStore(this).load();
                } catch (GeneralSecurityException | IOException e) {
                    // 凭据读不出来就按原样继续，下次启动再处理。
                }
                if (credentials != null) {
                    addressPool = new AddressPool(credentials.addresses);
                }
                if (webView != null) {
                    webView.evaluateJavascript(
                            "window.miniConnRerender && window.miniConnRerender()",
                            null);
                }
                probeAddresses();
            }
            return;
        }
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

    /**
     * 系统返回手势/返回键（2026-11-10）。
     *
     * 手机上从边缘往右滑会触发"返回"，但设置面板是我们网页里的一层浮层，
     * 原来这个手势会直接把页面往回翻甚至退出 App——**看起来像是滑动返回失灵**。
     * 现在先问页面一句"有没有打开的浮层"，有就关掉，没有才走原来的逻辑。
     */
    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return !!(window.miniCloseTop&&window.miniCloseTop());}catch(e){return false;}})()",
                value -> {
                    if ("true".equals(value)) {
                        return; // 页面自己收掉了浮层，这一下返回就到此为止
                    }
                    if (webView != null && webView.canGoBack()) {
                        webView.goBack();
                    } else {
                        MainActivity.super.onBackPressed();
                    }
                });
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        try {
            unregisterReceiver(screenReceiver);
        } catch (IllegalArgumentException ignored) {
            // 没注册成功就注销不掉，忽略。
        }
        loadGeneration++;
        if (webView != null) {
            webView.stopLoading();
            webView.destroy();
        }
        super.onDestroy();
    }
}
