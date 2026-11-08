package com.dsh.miniremote;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.DialogInterface;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;

import java.io.IOException;
import java.security.GeneralSecurityException;
import java.util.ArrayList;
import java.util.List;

/**
 * 单条线路的配置页（2026-11-07）。
 *
 * 从 MainActivity 的「连接」区块点进来：能改地址、能扫码（二维码里可能是新地址，
 * 也可能是一整条配对链接——前者只改这一行，后者按重新配对处理，整份凭据都换）。
 * 已经配过的线路随时能改，不用先删。
 *
 * 两种进入方式：
 * - 带 EXTRA_URL：配置已有那条线路；
 * - 不带：添加一条新线路（手动地址）。
 */
public final class LineConfigActivity extends Activity {
    /** 上一个页面传过来的：要配置的是哪一条线路；不传表示添加新线路。 */
    static final String EXTRA_URL = "url";
    /** 这一条是不是主页面正在用的那条：为真时标题后面挂一句「正在用」。 */
    static final String EXTRA_CURRENT = "current";
    /** 槽位标识（lan / tailscale / b-relay …）：未配置的槽位进来时靠它知道自己在配哪条。 */
    static final String EXTRA_KIND = "kind";
    /** 回来时带上它：内置 Tailscale 已经连上，主界面可以设代理了。 */
    static final String EXTRA_TAILNET_URL = "tailnetUrl";
    /** 回来时带上它：刚退出登录，主界面该把代理撤掉。 */
    static final String EXTRA_TAILNET_SIGNED_OUT = "tailnetSignedOut";

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private PairingStore store;
    private PairingStore.Credentials credentials;
    /** 正在配置的那条线路的原始地址；添加模式为 null。 */
    private String originalUrl;
    private String lineType;
    private boolean adding;

    private TextView titleView;
    private TextView currentView;
    private EditText addressInput;
    private Button saveButton;
    private Button scanButton;
    /** 删掉这条线路：只在「不是当前正在用的那条」时露出来（2026-11-07）。 */
    private Button deleteButton;
    private TextView statusView;
    private EditText tailKeyInput;
    private LinearLayout accountCard;
    private TextView accountNameView;
    private TextView accountDetailView;
    private Button signOutButton;
    private boolean destroyed;
    private boolean busy;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        store = new PairingStore(this);
        try {
            credentials = store.load();
        } catch (GeneralSecurityException | IOException e) {
            credentials = null;
        }
        if (credentials == null) {
            Toast.makeText(this, "本机凭据读取失败，请返回重试。", Toast.LENGTH_SHORT).show();
            finish();
            return;
        }
        originalUrl = getIntent().getStringExtra(EXTRA_URL);
        adding = originalUrl == null || originalUrl.isEmpty();
        if (!adding) {
            boolean found = false;
            for (AddressPool.Entry entry : credentials.addresses) {
                if (entry.baseUrl.equals(originalUrl)) {
                    lineType = entry.type;
                    found = true;
                    break;
                }
            }
            if (!found) {
                Toast.makeText(this, "这条线路已被删除，请返回重试。", Toast.LENGTH_SHORT).show();
                finish();
                return;
            }
        } else {
            String kind = getIntent().getStringExtra(EXTRA_KIND);
            lineType = kind == null || kind.isEmpty() ? "manual" : kind;
        }

        int dp = Math.round(getResources().getDisplayMetrics().density);
        int pad = dp * 18;
        getWindow().setBackgroundDrawable(new android.graphics.drawable.ColorDrawable(0xFFEAF3FC));
        // 状态栏跟页面同色，别在顶上留一条系统默认的米色。
        getWindow().setStatusBarColor(0xFFEAF3FC);
        getWindow().getDecorView().setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);

        ScrollView scroll = new ScrollView(this);
        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setPadding(pad, pad, pad, pad);
        scroll.addView(page, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp * 16, dp * 16, dp * 16, dp * 18);
        GradientDrawable cardBg = new GradientDrawable();
        cardBg.setColor(0xFFFFFFFF);
        cardBg.setCornerRadius(dp * 16);
        card.setBackground(cardBg);
        page.addView(card);

        boolean current = getIntent().getBooleanExtra(EXTRA_CURRENT, false);
        titleView = new TextView(this);
        // 标题就是这条槽位的名字：未配置的槽位进来，也知道自己在配哪一条。
        titleView.setText(Connections.labelOf(lineType));
        titleView.setTextSize(22);
        titleView.setTextColor(0xFF1B2C49);
        titleView.setPadding(0, 0, 0, dp * 4);
        card.addView(titleView);

        currentView = new TextView(this);
        currentView.setTextSize(13);
        currentView.setTextColor(0xFF5A7290);
        if (adding) {
            currentView.setText("还没配置：填电脑给的地址，或者扫二维码。");
        } else if (current) {
            currentView.setText("当前地址：" + originalUrl + "（正在用）");
        } else {
            currentView.setText("当前地址：" + originalUrl);
        }
        currentView.setPadding(0, 0, 0, dp * 14);
        card.addView(currentView);

        TextView addressLabel = new TextView(this);
        addressLabel.setText(adding ? "地址" : "新地址");
        addressLabel.setTextSize(13);
        addressLabel.setTextColor(0xFF5A7290);
        addressLabel.setPadding(0, 0, 0, dp * 6);
        card.addView(addressLabel);

        addressInput = new EditText(this);
        addressInput.setHint("http://192.168.1.5:3090");
        addressInput.setHintTextColor(0xFF9AAEC6);
        addressInput.setTextColor(0xFF1B2C49);
        addressInput.setTextSize(15);
        addressInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        addressInput.setPadding(dp * 12, dp * 10, dp * 12, dp * 10);
        GradientDrawable inputBg = new GradientDrawable();
        inputBg.setColor(0xFFF2F8FF);
        inputBg.setCornerRadius(dp * 10);
        inputBg.setStroke(dp, 0xFFD3E2F3);
        addressInput.setBackground(inputBg);
        if (!adding) {
            addressInput.setText(originalUrl);
        }
        card.addView(addressInput);

        saveButton = new Button(this);
        saveButton.setText("保存");
        saveButton.setAllCaps(false);
        saveButton.setTextColor(Color.WHITE);
        saveButton.setTextSize(15);
        GradientDrawable primaryBg = new GradientDrawable();
        primaryBg.setColor(0xFF3B6FC4);
        primaryBg.setCornerRadius(dp * 10);
        saveButton.setBackground(primaryBg);
        LinearLayout.LayoutParams saveParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        saveParams.topMargin = dp * 14;
        card.addView(saveButton, saveParams);

        scanButton = new Button(this);
        scanButton.setText("拍摄扫码");
        scanButton.setAllCaps(false);
        scanButton.setTextColor(0xFF3B6FC4);
        scanButton.setTextSize(15);
        GradientDrawable ghostBg = new GradientDrawable();
        ghostBg.setColor(0xFFEEF4FB);
        ghostBg.setCornerRadius(dp * 10);
        scanButton.setBackground(ghostBg);
        LinearLayout.LayoutParams scanParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        scanParams.topMargin = dp * 10;
        card.addView(scanButton, scanParams);

        if ("tailscale".equals(Connections.slotOf(lineType))) {
            TextView tailLabel = new TextView(this);
            tailLabel.setText("内置 Tailscale（不装 App 也能连）");
            tailLabel.setTextSize(13);
            tailLabel.setTextColor(0xFF5A7290);
            tailLabel.setPadding(0, dp * 14, 0, dp * 6);
            card.addView(tailLabel);

            Button tailLogin = new Button(this);
            tailLogin.setText("登录 Tailscale 账号");
            tailLogin.setAllCaps(false);
            tailLogin.setTextColor(0xFFFFFFFF);
            tailLogin.setTextSize(15);
            GradientDrawable loginBg = new GradientDrawable();
            loginBg.setColor(0xFF3B6FC4);
            loginBg.setCornerRadius(dp * 10);
            tailLogin.setBackground(loginBg);
            LinearLayout.LayoutParams loginParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            card.addView(tailLogin, loginParams);
            tailLogin.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View view) {
                    loginTailnet();
                }
            });

            accountCard = new LinearLayout(this);
            accountCard.setOrientation(LinearLayout.VERTICAL);
            accountCard.setVisibility(View.GONE);
            LinearLayout.LayoutParams accountParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            accountParams.topMargin = dp * 12;
            card.addView(accountCard, accountParams);

            accountNameView = new TextView(this);
            accountNameView.setTextSize(15);
            accountNameView.setTextColor(0xFF1B2C49);
            accountCard.addView(accountNameView);

            accountDetailView = new TextView(this);
            accountDetailView.setTextSize(12);
            accountDetailView.setTextColor(0xFF5A7290);
            accountDetailView.setPadding(0, dp * 6, 0, 0);
            accountCard.addView(accountDetailView);

            signOutButton = new Button(this);
            signOutButton.setText("退出登录");
            signOutButton.setAllCaps(false);
            signOutButton.setTextColor(0xFFC0392B);
            signOutButton.setTextSize(14);
            GradientDrawable outBg = new GradientDrawable();
            outBg.setColor(0xFFFDF1EF);
            outBg.setCornerRadius(dp * 10);
            signOutButton.setBackground(outBg);
            LinearLayout.LayoutParams outParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            outParams.topMargin = dp * 10;
            accountCard.addView(signOutButton, outParams);
            signOutButton.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View view) {
                    confirmSignOut();
                }
            });

            TextView tailOr = new TextView(this);
            tailOr.setText("已经有一枚授权密钥的话，也可以直接粘在下面（老办法，不用登录）");
            tailOr.setTextSize(12);
            tailOr.setTextColor(0xFF8AA0BA);
            tailOr.setPadding(0, dp * 10, 0, dp * 4);
            card.addView(tailOr);

            tailKeyInput = new EditText(this);
            tailKeyInput.setHint("tskey-auth-…（可选）");
            tailKeyInput.setHintTextColor(0xFF9AAEC6);
            tailKeyInput.setTextColor(0xFF1B2C49);
            tailKeyInput.setTextSize(14);
            tailKeyInput.setInputType(InputType.TYPE_CLASS_TEXT);
            tailKeyInput.setPadding(dp * 12, dp * 10, dp * 12, dp * 10);
            GradientDrawable keyBg = new GradientDrawable();
            keyBg.setColor(0xFFF2F8FF);
            keyBg.setCornerRadius(dp * 10);
            keyBg.setStroke(dp, 0xFFD3E2F3);
            tailKeyInput.setBackground(keyBg);
            tailKeyInput.setText(TailNet.authKey(this));
            card.addView(tailKeyInput);

            Button tailConnect = new Button(this);
            tailConnect.setText("用内置连接这条线路");
            tailConnect.setAllCaps(false);
            tailConnect.setTextColor(0xFF3B6FC4);
            tailConnect.setTextSize(14);
            GradientDrawable tailBg = new GradientDrawable();
            tailBg.setColor(0xFFEEF4FB);
            tailBg.setCornerRadius(dp * 10);
            tailConnect.setBackground(tailBg);
            LinearLayout.LayoutParams tailParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            tailParams.topMargin = dp * 10;
            card.addView(tailConnect, tailParams);
            tailConnect.setOnClickListener(new View.OnClickListener() {
                @Override
                public void onClick(View view) {
                    connectBuiltIn();
                }
            });
        }

        TextView scanHint = new TextView(this);
        scanHint.setText("扫电脑上的二维码：是地址就填进上面，是配对码就直接重新配对。");
        // 两条 Cloudflare 固定地址最常见的坏法是「进程还在、连接死了」，
        // 在电脑端把它关一次再打开就能恢复（2026-11-07 用户要求提醒）。
        String slot = Connections.slotOf(lineType);
        if ("public-relay".equals(slot) || "b-relay".equals(slot)) {
            TextView relayHint = new TextView(this);
            relayHint.setText("一直连不上的话：到电脑端设置里把这条地址关一次、再打开，通常就好了。");
            relayHint.setTextSize(12);
            relayHint.setTextColor(0xFF5A7290);
            relayHint.setPadding(0, 0, 0, dp * 10);
            card.addView(relayHint);
        }
        scanHint.setTextSize(12);
        scanHint.setTextColor(0xFF5A7290);
        scanHint.setPadding(0, dp * 8, 0, dp * 12);
        card.addView(scanHint);

        deleteButton = new Button(this);
        deleteButton.setText("清空这条线路");
        deleteButton.setAllCaps(false);
        deleteButton.setTextColor(0xFFC0453F);
        deleteButton.setTextSize(14);
        GradientDrawable dangerBg = new GradientDrawable();
        dangerBg.setColor(0xFFFBEDEC);
        dangerBg.setCornerRadius(dp * 10);
        deleteButton.setBackground(dangerBg);
        LinearLayout.LayoutParams deleteParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        deleteParams.topMargin = dp * 10;
        card.addView(deleteButton, deleteParams);
        // 正在用的那条不给清空：清掉就没网了，先切换走。
        deleteButton.setVisibility(adding || current ? View.GONE : View.VISIBLE);
        deleteButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                confirmDelete();
            }
        });

        statusView = new TextView(this);
        statusView.setTextSize(14);
        statusView.setTextColor(0xFF5A7290);
        statusView.setPadding(0, dp * 12, 0, 0);
        card.addView(statusView);

        setContentView(scroll);

        saveButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                saveAddress();
            }
        });
        scanButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                startScan();
            }
        });
        loadAccountIfSignedIn();
    }

    /**
     * 已经登录过就把账号摆出来（2026-11-08，参照 TailSocks 的设置页）。
     *
     * 账号信息来自内核的状态接口，读一次就够；读不到就当没登录，别摆一个空卡片。
     */
    private void loadAccountIfSignedIn() {
        if (accountCard == null) {
            return;
        }
        if (!TailNet.isConnected()) {
            accountCard.setVisibility(View.GONE);
            return;
        }
        new Thread(new Runnable() {
            @Override
            public void run() {
                final String raw = TailNet.accountJson();
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (destroyed || raw == null) {
                            return;
                        }
                        try {
                            org.json.JSONObject info = new org.json.JSONObject(raw);
                            String name = info.optString("displayName");
                            if (name.isEmpty()) {
                                name = info.optString("loginName");
                            }
                            accountNameView.setText(name.isEmpty() ? "已登录" : name);
                            StringBuilder detail = new StringBuilder();
                            String login = info.optString("loginName");
                            if (!login.isEmpty()) {
                                detail.append(login);
                            }
                            String tailnet = info.optString("tailnet");
                            if (!tailnet.isEmpty()) {
                                detail.append(detail.length() > 0 ? "\n" : "").append("所属网络 ").append(tailnet);
                            }
                            String host = info.optString("hostName");
                            if (!host.isEmpty()) {
                                detail.append(detail.length() > 0 ? "\n" : "").append("当前设备 ").append(host);
                            }
                            accountDetailView.setText(detail.toString());
                            accountCard.setVisibility(View.VISIBLE);
                        } catch (org.json.JSONException ignored) {
                            // 解析不出来就当没读到。
                        }
                    }
                });
            }
        }, "mini-tailnet-account").start();
    }

    /** 退出登录：确认一次，然后让内核登出、清掉本机密钥。 */
    private void confirmSignOut() {
        new AlertDialog.Builder(this)
                .setTitle("退出登录？")
                .setMessage("退出后这台手机需要重新登录才能用内置 Tailscale。别的线路不受影响。")
                .setNegativeButton("取消", null)
                .setPositiveButton("退出", new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        doSignOut();
                    }
                })
                .show();
    }

    private void doSignOut() {
        if (busy) {
            return;
        }
        busy = true;
        signOutButton.setEnabled(false);
        statusView.setText("正在退出登录……");
        new Thread(new Runnable() {
            @Override
            public void run() {
                final String failure = TailNet.signOut(LineConfigActivity.this);
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        busy = false;
                        if (destroyed) {
                            return;
                        }
                        if (failure != null) {
                            signOutButton.setEnabled(true);
                            statusView.setText(failure);
                            return;
                        }
                        // 已经登出：把代理撤掉、回到普通线路，别让页面挂在一个死隧道上。
                        Intent result = new Intent();
                        result.putExtra(EXTRA_TAILNET_SIGNED_OUT, true);
                        setResult(RESULT_OK, result);
                        finish();
                    }
                });
            }
        }, "mini-tailnet-signout").start();
    }

    /** 手动改地址：校验通过后覆盖原来那一条（或新增一条），保存回加密凭据。 */
    private void saveAddress() {
        if (busy) {
            return;
        }
        final String next = addressInput.getText().toString().trim();
        if (next.isEmpty()) {
            statusView.setText("先把地址填上。");
            return;
        }
        if (!adding && next.equals(originalUrl)) {
            statusView.setText("地址没变，不用保存。");
            return;
        }
        final AddressPool.Entry entry;
        try {
            entry = new AddressPool.Entry(next, adding ? Connections.inferType(next) : lineType);
        } catch (IllegalArgumentException e) {
            String reason = e.getMessage();
            statusView.setText(reason == null ? "地址格式不对。" : reason);
            return;
        }
        for (AddressPool.Entry existing : credentials.addresses) {
            if (existing.baseUrl.equals(entry.baseUrl)
                    && (adding || !existing.baseUrl.equals(originalUrl))) {
                statusView.setText("这条线路已经在列表里了。");
                return;
            }
        }
        busy = true;
        saveButton.setEnabled(false);
        statusView.setText(adding ? "正在添加……" : "正在保存……");
        new Thread(new Runnable() {
            @Override
            public void run() {
                List<AddressPool.Entry> nextAddresses = new ArrayList<>();
                if (adding) {
                    nextAddresses.addAll(credentials.addresses);
                    nextAddresses.add(entry);
                } else {
                    for (AddressPool.Entry existing : credentials.addresses) {
                        if (existing.baseUrl.equals(originalUrl)) {
                            nextAddresses.add(entry);
                        } else {
                            nextAddresses.add(existing);
                        }
                    }
                }
                PairingStore.Credentials updated = new PairingStore.Credentials(
                        credentials.deviceId, credentials.deviceSecret, nextAddresses,
                        credentials.keyId, credentials.keyFp);
                String message;
                try {
                    store.save(updated);
                    credentials = updated;
                    message = adding ? "已添加。" : "已保存。";
                } catch (GeneralSecurityException | IOException e) {
                    message = "保存失败，请重试。";
                }
                final String resultMessage = message;
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (destroyed) {
                            return;
                        }
                        busy = false;
                        saveButton.setEnabled(true);
                        statusView.setText(resultMessage);
                        if (resultMessage.startsWith("已")) {
                            // 改完地址后回到主界面要重新探测；这里直接关掉，让 MainActivity onResume 走重连。
                            setResult(RESULT_OK);
                            finish();
                        }
                    }
                });
            }
        }, "mini-line-save").start();
    }

    /** 清空这条线路：地址去掉，槽位留着，随时可以重新配置。 */
    private void confirmDelete() {
        if (busy || adding || originalUrl == null) {
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("清空这条线路？")
                .setMessage(originalUrl + "\n\n清空后它回到「未配置」，你可以随时重新填地址或扫码；电脑那边不受影响。")
                .setNegativeButton("取消", null)
                .setPositiveButton("清空", (dialog, which) -> removeLine())
                .show();
    }

    private void removeLine() {
        busy = true;
        deleteButton.setEnabled(false);
        statusView.setText("正在清空……");
        new Thread(new Runnable() {
            @Override
            public void run() {
                List<AddressPool.Entry> nextAddresses = new ArrayList<>();
                for (AddressPool.Entry entry : credentials.addresses) {
                    if (!entry.baseUrl.equals(originalUrl)) {
                        nextAddresses.add(entry);
                    }
                }
                String message;
                boolean ok = false;
                if (nextAddresses.isEmpty()) {
                    message = "至少要留一条线路，先配好别的一条再清空这条。";
                } else {
                    try {
                        PairingStore.Credentials updated = new PairingStore.Credentials(
                                credentials.deviceId, credentials.deviceSecret, nextAddresses,
                                credentials.keyId, credentials.keyFp);
                        store.save(updated);
                        credentials = updated;
                        if (originalUrl.equals(Connections.preferred(LineConfigActivity.this))) {
                            Connections.setPreferred(LineConfigActivity.this, null);
                        }
                        message = "已清空。";
                        ok = true;
                    } catch (GeneralSecurityException | IOException e) {
                        message = "清空失败，请重试。";
                    }
                }
                final String resultMessage = message;
                final boolean removed = ok;
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (destroyed) {
                            return;
                        }
                        busy = false;
                        statusView.setText(resultMessage);
                        if (removed) {
                            setResult(RESULT_OK);
                            finish();
                        } else {
                            deleteButton.setEnabled(true);
                        }
                    }
                });
            }
        }, "mini-line-delete").start();
    }

    /**
     * 用内置内核连这条 tailnet 线路（2026-11-08）。
     *
     * 启动要几秒到几十秒，所以放后台线程；成功后把 URL 带回主界面，
     * 由它去设 WebView 代理并加载页面。
     */
    private void connectBuiltIn() {
        if (busy) {
            return;
        }
        String key = tailKeyInput == null ? "" : tailKeyInput.getText().toString().trim();
        if (key.isEmpty()) {
            statusView.setText("先把授权密钥填上。");
            return;
        }
        if (originalUrl == null || originalUrl.isEmpty()) {
            statusView.setText("这条线路还没有地址：先在上面填 tailnet 地址并保存。");
            return;
        }
        TailNet.setAuthKey(this, key);
        busy = true;
        saveButton.setEnabled(false);
        scanButton.setEnabled(false);
        statusView.setText("正在启动内置 Tailscale……第一次要十几秒。");
        final String targetUrl = originalUrl;
        new Thread(new Runnable() {
            @Override
            public void run() {
                final String failure = TailNet.startBlocking(LineConfigActivity.this);
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (destroyed) {
                            return;
                        }
                        busy = false;
                        saveButton.setEnabled(true);
                        scanButton.setEnabled(true);
                        if (failure != null) {
                            statusView.setText("没连上：" + failure);
                            return;
                        }
                        // 记住它，下次启动直接走内置连接。
                        Connections.setPreferred(LineConfigActivity.this, targetUrl);
                        Intent result = new Intent();
                        result.putExtra(EXTRA_TAILNET_URL, targetUrl);
                        setResult(RESULT_OK, result);
                        finish();
                    }
                });
            }
        }, "mini-tailnet-connect").start();
    }

    /** 调起相机扫码；扫到的东西先按配对链接试，不行再按普通地址试。 */
    private void startScan() {
        if (busy) {
            return;
        }
        IntentIntegrator integrator = new IntentIntegrator(this);
        integrator.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE);
        integrator.setPrompt("对准电脑上的二维码");
        integrator.setBeepEnabled(false);
        integrator.setOrientationLocked(false);
        integrator.initiateScan();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        IntentResult scan = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (scan == null || scan.getContents() == null) {
            return;
        }
        String text = scan.getContents().trim();
        // 电脑端生成的「内置 Tailscale 接入码」：一条 JSON，带着地址和一次性密钥。
        if (applyTailnetCode(text)) {
            return;
        }
        // 先按配对链接解析：里面有 grant 就是完整配对码，走重新配对。
        try {
            PairActivity.PairLink pairLink = PairActivity.PairLink.parse(text);
            rePair(pairLink);
            return;
        } catch (IllegalArgumentException ignored) {
            // 不是配对链接，继续按普通地址处理。
        }
        // 普通地址：校验通过后填进输入框，让用户确认后再保存。
        try {
            new AddressPool.Entry(text, lineType);
            addressInput.setText(text);
            statusView.setText("已扫到地址，确认后点「保存地址」。");
        } catch (IllegalArgumentException e) {
            statusView.setText("扫到的内容不是地址也不是配对码：" + text);
        }
    }

    /**
     * 「登录 Tailscale 账号」：拉起内核发起一次交互式登录，把授权网址交给系统浏览器，
     * 用户登录完内核自己就连上了（2026-11-08）。
     *
     * 之所以跳浏览器而不是内嵌网页：Tailscale 常用 Google/微软账号登录，这类登录
     * 明令禁止在 App 内嵌的网页里完成，内嵌会直接被拒。
     */
    private void loginTailnet() {
        if (busy) {
            return;
        }
        if (originalUrl == null || originalUrl.isEmpty()) {
            statusView.setText("这条线路还没有地址：先在上面填 tailnet 地址并保存。");
            return;
        }
        busy = true;
        saveButton.setEnabled(false);
        scanButton.setEnabled(false);
        statusView.setText("正在准备登录……");
        final String targetUrl = originalUrl;
        new Thread(new Runnable() {
            @Override
            public void run() {
                final String failure = TailNet.beginLogin(LineConfigActivity.this);
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (destroyed) {
                            return;
                        }
                        if (failure != null) {
                            busy = false;
                            saveButton.setEnabled(true);
                            scanButton.setEnabled(true);
                            statusView.setText("登录没起来：" + failure);
                            return;
                        }
                        String url = TailNet.pendingLoginUrl();
                        if (url.isEmpty()) {
                            // 内核说已经登录过了，不用再走网址。
                            finishConnected(targetUrl);
                            return;
                        }
                        openLoginPage(url);
                        statusView.setText("登录完成后会自动连上，回到这一页就行。");
                        waitLoginInBackground(targetUrl);
                    }
                });
            }
        }, "mini-tailnet-login").start();
    }

    /**
     * 把登录页交出去：优先 Chrome Custom Tabs（盖在 App 上的真浏览器标签页），
     * 手机上没有支持的浏览器时退回普通浏览器（2026-11-08）。
     */
    private void openLoginPage(String url) {
        android.net.Uri uri = android.net.Uri.parse(url);
        try {
            androidx.browser.customtabs.CustomTabsIntent.Builder builder =
                    new androidx.browser.customtabs.CustomTabsIntent.Builder();
            builder.setShowTitle(true);
            androidx.browser.customtabs.CustomTabsIntent intent = builder.build();
            intent.launchUrl(this, uri);
            return;
        } catch (Exception ignored) {
            // 没装支持 Custom Tabs 的浏览器，退回普通浏览器。
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (Exception e) {
            statusView.setText("打不开浏览器，把这条网址复制到浏览器里：\n" + url);
        }
    }

    /** 等用户在浏览器里登录完成；成功就带着地址回主界面。 */
    private void waitLoginInBackground(final String targetUrl) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                final String failure = TailNet.waitLoggedIn(180000L);
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (destroyed) {
                            return;
                        }
                        if (failure != null) {
                            busy = false;
                            saveButton.setEnabled(true);
                            scanButton.setEnabled(true);
                            statusView.setText("还没登录成功：" + failure + "。登录完再点一次也可以。");
                            return;
                        }
                        finishConnected(targetUrl);
                    }
                });
            }
        }, "mini-tailnet-wait").start();
    }

    /** 连上了：记住这条线路并带地址回主界面。 */
    private void finishConnected(String targetUrl) {
        busy = false;
        // 登录成功后那枚一次性密钥就没用了，留着只会让下一次误以为要粘贴它。
        TailNet.setAuthKey(this, "");
        Connections.setPreferred(LineConfigActivity.this, targetUrl);
        Intent result = new Intent();
        result.putExtra(EXTRA_TAILNET_URL, targetUrl);
        setResult(RESULT_OK, result);
        finish();
    }

    /**
     * 扫到电脑端生成的接入码：地址和密钥一起填好，直接连（2026-11-08）。
     *
     * 返回 true 表示这串内容确实是我们自己的接入码，已经处理完。
     */
    private boolean applyTailnetCode(String text) {
        if (text == null || !text.trim().startsWith("{")) {
            return false;
        }
        String addr;
        String key;
        try {
            org.json.JSONObject json = new org.json.JSONObject(text);
            if (!"tailnet".equals(json.optString("mini"))) {
                return false;
            }
            addr = json.optString("addr").trim();
            key = json.optString("key").trim();
        } catch (org.json.JSONException e) {
            return false;
        }
        if (addr.isEmpty() || key.isEmpty()) {
            statusView.setText("这个接入码不完整，回电脑上重新生成一个。");
            return true;
        }
        try {
            new AddressPool.Entry(addr, lineType);
        } catch (IllegalArgumentException e) {
            statusView.setText("接入码里的地址不对：" + addr);
            return true;
        }
        addressInput.setText(addr);
        if (tailKeyInput != null) {
            tailKeyInput.setText(key);
        }
        TailNet.setAuthKey(this, key);
        statusView.setText("扫到了接入码，正在连接……");
        connectBuiltIn();
        return true;
    }

    /** 扫到完整配对码：向电脑换一份新凭据，整份覆盖。 */
    private void rePair(final PairActivity.PairLink pairLink) {
        if (busy) {
            return;
        }
        busy = true;
        saveButton.setEnabled(false);
        scanButton.setEnabled(false);
        statusView.setText("正在向电脑交换设备凭据……");
        new Thread(new Runnable() {
            @Override
            public void run() {
                String message;
                PairingStore.Credentials paired = null;
                try {
                    String request = "{\"grant\":" + PairingStore.jsonQuote(pairLink.grant)
                            + ",\"kind\":\"android-app\"}";
                    Net.Response response = Net.postJson(
                            pairLink.baseUrl + "/mini/api/native-pair", request, null);
                    if (response.status == 404 || response.status == 405 || response.status == 501) {
                        message = "服务端还没升级，无法使用原生配对。请先升级电脑端 DSH。";
                    } else if (!response.isSuccess()) {
                        message = response.status == 410
                                ? "配对链接已过期，请回电脑重新生成。" : response.chineseError();
                    } else {
                        paired = PairingStore.Credentials.fromJson(response.body);
                        store.save(paired);
                        message = "重新配对成功。";
                    }
                } catch (IOException e) {
                    message = e.getMessage();
                } catch (GeneralSecurityException e) {
                    message = "无法把设备凭据安全保存到本机，请检查系统锁屏设置后重试。";
                } catch (RuntimeException e) {
                    message = "配对响应无法处理，请确认电脑端已经升级。";
                }
                final PairingStore.Credentials result = paired;
                final String resultMessage = message == null ? "重新配对失败，请重试。" : message;
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (destroyed) {
                            return;
                        }
                        busy = false;
                        saveButton.setEnabled(true);
                        scanButton.setEnabled(true);
                        statusView.setText(resultMessage);
                        if (result != null) {
                            setResult(RESULT_OK);
                            finish();
                        }
                    }
                });
            }
        }, "mini-line-repair").start();
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        super.onDestroy();
    }
}
