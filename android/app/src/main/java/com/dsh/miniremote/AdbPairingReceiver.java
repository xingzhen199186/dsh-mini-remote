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

    /** 调试用的第二条入口：让 adb 身份直接触发一次 shell 试跑，结果写文件。 */
    static final String ACTION_RUN_SHELL = "com.dsh.miniremote.RUN_SHELL";
    /** 自连通道的自动检查：跑完把结果写 files/adb-channel-check.json，给电脑上的脚本读。 */
    static final String ACTION_SELF_TEST = "com.dsh.miniremote.SELF_TEST";

    /** 调试用的第三条入口：把「手机终端」当前通道状态写进文件，供电脑读。 */
    static final String ACTION_DUMP_STATE = "com.dsh.miniremote.DUMP_STATE";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        if (ACTION_DUMP_STATE.equals(intent.getAction())) {
            final Context app = context.getApplicationContext();
            new Thread(() -> {
                String text = ShellBackend.backendState(app);
                try (java.io.FileOutputStream out = new java.io.FileOutputStream(
                        new java.io.File(app.getFilesDir(), "state-dump.json"))) {
                    out.write(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                } catch (Exception ignored) {
                }
            }, "mini-adb-dump-state").start();
            return;
        }
        if (ACTION_SELF_TEST.equals(intent.getAction())) {
            final Context app = context.getApplicationContext();
            new Thread(() -> AdbChannelCheck.run(app), "mini-adb-selfcheck").start();
            return;
        }
        if (ACTION_RUN_SHELL.equals(intent.getAction())) {
            final String command = intent.getStringExtra("cmd") == null ? "id" : intent.getStringExtra("cmd");
            final Context app = context.getApplicationContext();
            new Thread(() -> {
                AdbDiscover.Endpoint endpoint = AdbShell.connectEndpoint(app);
                String text;
                if (endpoint == null) {
                    text = "{\"ok\":false,\"error\":\"没有连接口\"}";
                } else {
                    AdbShell.Result result = AdbShell.run(app, endpoint.host, endpoint.port, command);
                    if (result.ok) {
                        // 跑通一次就记住：以后 phone_shell 会优先走这条通道。
                        ShellBackend.markPaired(app, endpoint.host, endpoint.port);
                    }
                    text = "{\"ok\":" + result.ok + ",\"port\":" + endpoint.port
                            + ",\"output\":\"" + result.output.replace("\\", "\\\\").replace("\"", "\\\"")
                            .replace("\n", "\\n").replace("\r", "") + "\",\"error\":\"" + result.error + "\"}";
                }
                try (java.io.FileOutputStream out = new java.io.FileOutputStream(
                        new java.io.File(app.getFilesDir(), "adb-shell.log"))) {
                    out.write(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                } catch (Exception ignored) {
                }
            }, "mini-adb-shell-broadcast").start();
            return;
        }
        Bundle results = RemoteInput.getResultsFromIntent(intent);
        CharSequence text = results == null ? null : results.getCharSequence(AdbPairingNotify.EXTRA_TEXT);
        if (text == null) {
            // 调试用：adb 身份可以直接把码塞进广播（普通 App 没有 DUMP 权限，调不动这个接收器）。
            text = intent.getStringExtra(AdbPairingNotify.EXTRA_TEXT);
        }
        if (text == null) {
            AdbPairingNotify.done(context, "没读到配对码，再点一次「填写配对码」");
            return;
        }
        AdbPairingWatcher.submitCode(context, text.toString());
    }
}
