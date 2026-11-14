package com.dsh.miniremote;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

import java.io.IOException;
import java.security.GeneralSecurityException;

/**
 * 在通知按钮里直接回答提问（2026-11-14）。
 *
 * 和审批那条路（ApprovalReceiver）同一个套路：**不打开界面**，后台把答案 POST 回去。
 * 这样用户锁屏时看到"问你选哪个"，点一下就完事，不必先解锁、进 App、再点一遍。
 */
public final class QuestionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(final Context context, Intent intent) {
        if (!Notifier.ACTION_ANSWER.equals(intent.getAction())) return;
        final String askId = intent.getStringExtra(Notifier.EXTRA_ASK_ID);
        final String questionId = intent.getStringExtra(Notifier.EXTRA_QUESTION_ID);
        final String label = intent.getStringExtra(Notifier.EXTRA_LABEL);
        final String baseUrl = intent.getStringExtra(Notifier.EXTRA_BASE_URL);
        if (askId == null || askId.isEmpty() || baseUrl == null || baseUrl.isEmpty() || label == null) return;

        final PendingResult pendingResult = goAsync();
        final Context appContext = context.getApplicationContext();
        new Thread(new Runnable() {
            @Override
            public void run() {
                String message;
                try {
                    PairingStore.Credentials credentials = new PairingStore(appContext).load();
                    if (credentials == null) {
                        message = "尚未配对，请打开应用完成配对。";
                    } else {
                        // 协议和页面上那条完全一样：{id, answers:[{id: 题号, selected: [选项文字]}]}
                        String body = "{\"id\":" + PairingStore.jsonQuote(askId)
                                + ",\"answers\":[{\"id\":" + PairingStore.jsonQuote(questionId == null ? "" : questionId)
                                + ",\"selected\":[" + PairingStore.jsonQuote(label) + "]}]}";
                        Net.Response response = Net.postJson(baseUrl + "/mini/api/answer",
                                body, credentials.deviceCredential());
                        if (response.status == 409) {
                            message = "这道题已经结束了";
                        } else if (response.isSuccess()) {
                            message = "已答：" + label;
                        } else {
                            message = response.chineseError();
                        }
                    }
                } catch (IOException e) {
                    message = e.getMessage() == null ? "网络请求失败，请稍后重试。" : e.getMessage();
                } catch (GeneralSecurityException e) {
                    message = "设备凭据无法解密，请打开应用重新配对。";
                } catch (RuntimeException e) {
                    message = "回答失败，请打开应用重试。";
                }
                try {
                    Notifier.showResult(appContext, askId, message);
                } finally {
                    pendingResult.finish();
                }
            }
        }).start();
    }
}
