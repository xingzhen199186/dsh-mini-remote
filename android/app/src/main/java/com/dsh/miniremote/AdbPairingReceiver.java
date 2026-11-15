package com.dsh.miniremote;

import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/**
 * 接收通知里填的 6 位配对码（2026-11-15）。
 *
 * 只做一件事：把码交给等待中的流程。所有"连不连、什么时候连"的判断都在那边，
 * 这里不碰网络，免得在广播里做阻塞操作。
 */
public final class AdbPairingReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence text = results == null ? null : results.getCharSequence(AdbPairingNotify.EXTRA_TEXT);
        if (text == null) {
            AdbPairingNotify.done(context, "没读到配对码，再点一次「填写配对码」");
            return;
        }
        AdbPairingWatcher.submitCode(context, text.toString());
    }
}
