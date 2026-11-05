package com.dsh.miniremote;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.widget.Button;

import com.google.zxing.integration.android.IntentIntegrator;
import com.google.zxing.integration.android.IntentResult;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.IOException;
import java.security.GeneralSecurityException;

/** P1 先提供粘贴配对链接；扫码留待采用 CameraX 的后续版本实现。 */
public final class PairActivity extends Activity {
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private EditText linkInput;
    private Button submitButton;
    private TextView statusView;
    private boolean destroyed;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        int padding = Math.round(20 * getResources().getDisplayMetrics().density);
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        layout.setPadding(padding, padding, padding, padding);

        TextView title = new TextView(this);
        title.setText("配对这台手机");
        title.setTextSize(24);
        layout.addView(title);

        TextView explanation = new TextView(this);
        explanation.setText("打开电脑端 DSH 的手机配对面板，复制任意一枚配对链接后粘贴到这里。链接中的一次性 grant 不是设备凭据。");
        explanation.setPadding(0, padding / 2, 0, padding);
        layout.addView(explanation);

        linkInput = new EditText(this);
        linkInput.setHint("粘贴配对链接");
        linkInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        linkInput.setMinLines(3);
        layout.addView(linkInput);

        Button scanButton = new Button(this);
        scanButton.setText("扫二维码");
        layout.addView(scanButton);

        submitButton = new Button(this);
        submitButton.setText("开始配对");
        layout.addView(submitButton);

        statusView = new TextView(this);
        statusView.setPadding(0, padding / 2, 0, 0);
        layout.addView(statusView);

        setContentView(layout);
        submitButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                submitPairing();
            }
        });
        scanButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View view) {
                // 扫码走系统相机预览；解出来的就是一整条配对链接，直接填进输入框，
                // 不自动提交——让人先看一眼那条链接属于哪台电脑。
                IntentIntegrator integrator = new IntentIntegrator(PairActivity.this);
                integrator.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE);
                integrator.setPrompt("对准电脑上的配对二维码");
                integrator.setBeepEnabled(false);
                integrator.setOrientationLocked(false);
                integrator.initiateScan();
            }
        });
    }

    private void submitPairing() {
        final PairLink pairLink;
        try {
            pairLink = PairLink.parse(linkInput.getText().toString());
        } catch (IllegalArgumentException e) {
            statusView.setText(e.getMessage());
            return;
        }

        submitButton.setEnabled(false);
        statusView.setText("正在向电脑交换设备凭据……");
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                String message;
                PairingStore.Credentials paired = null;
                try {
                    // 此时尚无设备凭据，一次性 grant 是原生配对接口的唯一鉴权信息。
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
                        new PairingStore(PairActivity.this).save(paired);
                        message = "配对成功。";
                    }
                } catch (IOException e) {
                    message = e.getMessage();
                } catch (GeneralSecurityException e) {
                    message = "无法把设备凭据安全保存到本机，请检查系统锁屏设置后重试。";
                } catch (RuntimeException e) {
                    message = "配对响应无法处理，请确认电脑端已经升级。";
                }

                final PairingStore.Credentials result = paired;
                final String resultMessage = message == null ? "配对失败，请重试。" : message;
                mainHandler.post(new Runnable() {
                    @Override
                    public void run() {
                        if (destroyed) {
                            return;
                        }
                        if (result != null) {
                            Toast.makeText(PairActivity.this, "配对成功。", Toast.LENGTH_SHORT).show();
                            startActivity(new Intent(PairActivity.this, MainActivity.class));
                            finish();
                        } else {
                            submitButton.setEnabled(true);
                            statusView.setText(resultMessage);
                        }
                    }
                });
            }
        }, "mini-native-pair");
        thread.start();
    }

    private static final class PairLink {
        final String baseUrl;
        final String grant;

        PairLink(String baseUrl, String grant) {
            this.baseUrl = baseUrl;
            this.grant = grant;
        }

        static PairLink parse(String text) {
            if (text == null || text.trim().isEmpty()) {
                throw new IllegalArgumentException("请先粘贴配对链接。");
            }
            try {
                Uri uri = Uri.parse(text.trim());
                String scheme = uri.getScheme();
                String authority = uri.getEncodedAuthority();
                String grant = uri.getQueryParameter("grant");
                if (scheme == null
                        || !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                        || uri.getHost() == null || authority == null) {
                    throw new IllegalArgumentException("配对链接必须是完整的 HTTP 或 HTTPS 地址。");
                }
                if (grant == null || grant.isEmpty()) {
                    throw new IllegalArgumentException("链接里没有 grant，请复制完整的配对链接。");
                }
                String baseUrl = new Uri.Builder().scheme(scheme)
                        .encodedAuthority(authority).build().toString();
                // 同时校验 base URL，后续地址池也沿用同一格式。
                new AddressPool.Entry(baseUrl, "");
                return new PairLink(baseUrl, grant);
            } catch (IllegalArgumentException e) {
                if (e.getMessage() != null && e.getMessage().startsWith("配对")) {
                    throw e;
                }
                if (e.getMessage() != null && e.getMessage().startsWith("链接")) {
                    throw e;
                }
                throw new IllegalArgumentException("配对链接格式不正确，请重新复制。");
            }
        }
    }

    @Override
    protected void onDestroy() {
        destroyed = true;
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        IntentResult scan = IntentIntegrator.parseActivityResult(requestCode, resultCode, data);
        if (scan != null && scan.getContents() != null) {
            linkInput.setText(scan.getContents());
        }
    }
}
