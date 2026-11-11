package com.dsh.miniremote;

import android.app.IntentService;
import android.content.Intent;
import android.os.Bundle;

import org.json.JSONObject;

/**
 * 接 Termux 回传的命令结果（2026-11-12）。
 *
 * 这里**不硬编码字段名**：Termux 各版本的键可能不同，所以把 bundle 里所有键值
 * 按后缀归类（*_STDOUT / *_STDERR / *_EXIT_CODE），拿不准时把原始键值一并带回去。
 * 第一次真机跑通靠的就是这份原始数据——比猜键名可靠。
 */
public class TermuxResultService extends IntentService {
    static final String EXTRA_EXECUTION_ID = "execution_id";

    public TermuxResultService() {
        super("TermuxResultService");
    }

    @Override
    protected void onHandleIntent(Intent intent) {
        if (intent == null) return;
        int id = intent.getIntExtra(EXTRA_EXECUTION_ID, 0);
        try {
            StringBuilder raw = new StringBuilder();
            String stdout = "";
            String stderr = "";
            Integer exitCode = null;
            String lastErr = "";

            for (String key : intent.getExtras().keySet()) {
                Object value = intent.getExtras().get(key);
                if (value instanceof Bundle) {
                    Bundle inner = (Bundle) value;
                    for (String k : inner.keySet()) {
                        Object v = inner.get(k);
                        String text = v == null ? "null" : String.valueOf(v);
                        if (raw.length() < 4000) raw.append(k).append(" = ").append(text).append('\n');
                        // 真机确认过的名字就是 stdout / stderr / errmsg / *_original_length。
                        // 但版本之间可能带前缀，所以用"包含"来判断；带 length 的是长度，跳过。
                        String lower = k.toLowerCase();
                        if (lower.contains("stdout") && !lower.contains("length")) stdout = text;
                        else if (lower.contains("stderr") && !lower.contains("length")) stderr = text;
                        else if (lower.contains("exit") && v instanceof Integer) exitCode = (Integer) v;
                        else if (lower.contains("errmsg")) lastErr = text;
                    }
                }
            }

            JSONObject out = new JSONObject();
            out.put("ok", exitCode != null && exitCode == 0);
            out.put("stdout", stdout);
            out.put("stderr", stderr);
            if (exitCode != null) out.put("exitCode", exitCode);
            // Termux 正常时会把 errmsg 传成字符串 "null"，别当真错误显示出去。
            if (!lastErr.isEmpty() && !"null".equalsIgnoreCase(lastErr.trim())) {
                out.put("termuxError", lastErr);
            }
            // 第一次联调要看的原始键值；解析稳定之后这一行可以不留。
            out.put("raw", raw.toString());
            TermuxRun.deliver(id, out.toString());
        } catch (Exception err) {
            String msg = String.valueOf(err.getMessage()).replace("\"", "'");
            TermuxRun.deliver(id, "{\"ok\":false,\"error\":\"读取结果失败：" + msg + "\"}");
        }
    }
}
