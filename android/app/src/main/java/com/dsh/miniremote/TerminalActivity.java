package com.dsh.miniremote;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * 全屏终端页（2026-11-12）。
 *
 * 用系统自带的 `/system/bin/sh` 执行命令，**不需要安装任何东西**。
 * 放在独立页面而不是塞进设置里：终端要占满屏幕才好用。
 *
 * 边界（页面上也写着）：命令以本 App 的身份运行，碰不到别的 App 的私有数据；
 * 也看不到用户通过系统选择器选的工作文件夹——那是授权凭证，不是路径。
 */
public class TerminalActivity extends Activity {
    private TextView output;
    private ScrollView scroll;
    private EditText input;
    private Button run;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0f1115"));

        root.addView(buildTopBar());

        scroll = new ScrollView(this);
        output = new TextView(this);
        output.setTextSize(12f);
        output.setTypeface(Typeface.MONOSPACE);
        output.setTextColor(Color.parseColor("#d7e0ea"));
        output.setTextIsSelectable(true);
        output.setPadding(dp(12), dp(8), dp(12), dp(8));
        output.setText("终端 · 用手机自带的 sh，不需要安装任何东西\n"
                + "只能在 App 自己的目录里读写；要碰你选的工作文件夹，请用文件工具。\n\n");
        scroll.addView(output, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        root.addView(buildInputBar());

        setContentView(root);
    }

    private LinearLayout buildTopBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#161a22"));
        bar.setPadding(dp(8), dp(6), dp(8), dp(6));

        Button close = new Button(this);
        close.setText("关闭");
        close.setOnClickListener(v -> finish());
        bar.addView(close);

        TextView title = new TextView(this);
        title.setText("终端");
        title.setTextColor(Color.parseColor("#d7e0ea"));
        title.setTextSize(16f);
        LinearLayout.LayoutParams titleParams = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        titleParams.setMarginStart(dp(8));
        bar.addView(title, titleParams);

        Button clear = new Button(this);
        clear.setText("清空");
        clear.setOnClickListener(v -> output.setText(""));
        bar.addView(clear);
        return bar;
    }

    private LinearLayout buildInputBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#161a22"));
        bar.setPadding(dp(8), dp(6), dp(8), dp(6));

        input = new EditText(this);
        input.setHint("输入命令，例如 ls");
        input.setTextColor(Color.parseColor("#d7e0ea"));
        input.setHintTextColor(Color.parseColor("#6b7684"));
        input.setTypeface(Typeface.MONOSPACE);
        input.setSingleLine(true);
        input.setImeOptions(EditorInfo.IME_ACTION_SEND);
        input.setOnEditorActionListener((v, actionId, event) -> {
            submit();
            return true;
        });
        bar.addView(input, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        run = new Button(this);
        run.setText("运行");
        run.setOnClickListener(v -> submit());
        bar.addView(run);
        return bar;
    }

    private void submit() {
        final String command = input.getText().toString();
        if (command.trim().isEmpty()) return;
        input.setText("");
        append("$ " + command + "\n");
        run.setEnabled(false);
        run.setText("运行中");
        new Thread(() -> {
            String raw = NativeShell.run(this, command, 60);
            final String text = describe(raw);
            runOnUiThread(() -> {
                append(text);
                run.setEnabled(true);
                run.setText("运行");
            });
        }, "term-run").start();
    }

    /** 把执行结果翻成终端里该看到的样子。 */
    private static String describe(String raw) {
        try {
            JSONObject result = new JSONObject(raw);
            StringBuilder text = new StringBuilder();
            String stdout = result.optString("stdout", "");
            if (!stdout.isEmpty()) text.append(stdout);
            if (result.has("error")) text.append("【错误】").append(result.optString("error")).append('\n');
            else if (result.has("exitCode") && result.optInt("exitCode", 0) != 0) {
                text.append("【退出码 ").append(result.optInt("exitCode")).append("】\n");
            }
            if (result.optBoolean("truncated", false)) text.append("【输出太长，只显示了一部分】\n");
            if (text.length() == 0) text.append("（没有输出）\n");
            return text.toString();
        } catch (Exception ignored) {
            return raw + "\n";
        }
    }

    private void append(String text) {
        output.append(text);
        scroll.post(() -> scroll.fullScroll(ScrollView.FOCUS_DOWN));
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
