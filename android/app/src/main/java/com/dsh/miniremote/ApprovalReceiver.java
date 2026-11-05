package com.dsh.miniremote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.io.IOException;
import java.security.GeneralSecurityException;

/** 在通知按钮的广播里直接提交审批，不需要先打开 Activity。 */
public final class ApprovalReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(final Context context, Intent intent) {
        final String action = intent.getAction();
        final String approvalId = intent.getStringExtra(Notifier.EXTRA_APPROVAL_ID);
        final String baseUrl = intent.getStringExtra(Notifier.EXTRA_BASE_URL);
        if (!Notifier.ACTION_APPROVE.equals(action) && !Notifier.ACTION_REJECT.equals(action)) {
            return;
        }
        if (approvalId == null || approvalId.isEmpty() || baseUrl == null || baseUrl.isEmpty()) {
            return;
        }

        final PendingResult pendingResult = goAsync();
        final Context appContext = context.getApplicationContext();
        Thread thread = new Thread(new Runnable() {
            @Override
            public void run() {
                String message;
                try {
                    PairingStore.Credentials credentials = new PairingStore(appContext).load();
                    if (credentials == null) {
                        message = "尚未配对，请打开应用完成配对。";
                    } else {
                        String decision = Notifier.ACTION_APPROVE.equals(action) ? "allow" : "deny";
                        String body = "{\"id\":" + PairingStore.jsonQuote(approvalId)
                                + ",\"decision\":" + PairingStore.jsonQuote(decision) + "}";
                        Net.Response response = Net.postJson(baseUrl + "/mini/api/approval",
                                body, credentials.deviceCredential());
                        if (response.status == 409) {
                            message = "已在别处处理";
                        } else if (response.isSuccess()) {
                            message = Notifier.ACTION_APPROVE.equals(action) ? "已批准" : "已拒绝";
                        } else {
                            message = response.chineseError();
                        }
                    }
                } catch (IOException e) {
                    message = e.getMessage() == null ? "网络请求失败，请稍后重试。" : e.getMessage();
                } catch (GeneralSecurityException e) {
                    message = "设备凭据无法解密，请打开应用重新配对。";
                } catch (RuntimeException e) {
                    message = "审批操作失败，请打开应用重试。";
                }
                try {
                    Notifier.showResult(appContext, approvalId, message);
                } finally {
                    pendingResult.finish();
                }
            }
        }, "mini-approval");
        thread.start();
    }
}
