package com.dsh.miniremote;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.termux.terminal.TerminalEmulator;
import com.termux.terminal.TerminalSession;
import com.termux.terminal.TerminalSessionClient;
import com.termux.view.TerminalView;
import com.termux.view.TerminalViewClient;

/**
 * 全屏终端（2026-11-12）。
 *
 * 用的是 **Termux 的 Apache-2.0 模块**（terminal-emulator + terminal-view），
 * 所以这里有真 PTY、真 ANSI 颜色、真光标：跟你电脑上那个终端是同一类东西，
 * 而不是"输入一条命令、等它出结果"的假终端。
 *
 * 跑的是手机自带的 `/system/bin/sh`——**不需要安装任何东西**。
 *
 * 边界：命令以本 App 的身份运行，碰不到别的 App 的私有数据；
 * 也看不到用户通过系统选择器选的工作文件夹（那是授权凭证，不是路径）。
 */
public class TerminalActivity extends Activity implements TerminalSessionClient, TerminalViewClient {
    private TerminalView terminalView;
    private TerminalSession session;
    private boolean ctrlDown;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0f1115"));

        root.addView(buildTopBar());

        terminalView = new TerminalView(this, null);
        terminalView.setTerminalViewClient(this);
        terminalView.setTextSize(12);
        terminalView.setBackgroundColor(Color.parseColor("#0f1115"));
        root.addView(terminalView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        root.addView(buildKeyBar());
        setContentView(root);

        startSession();
    }

    /** 起一个真正的 shell 会话：PTY + 持续输出。 */
    private void startSession() {
        String home = getFilesDir().getAbsolutePath();
        String shell = "/system/bin/sh";
        String[] env = new String[]{
                "HOME=" + home,
                "TMPDIR=" + getCacheDir().getAbsolutePath(),
                "PATH=/system/bin:/system/xbin",
                "TERM=xterm-256color",
                "LANG=en_US.UTF-8",
        };
        session = new TerminalSession(shell, home, new String[]{"-"}, env, 2000, this);
        terminalView.attachSession(session);
        terminalView.requestFocus();
        showKeyboard();
    }

    private void showKeyboard() {
        try {
            InputMethodManager imm =
                    (InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.showSoftInput(terminalView, InputMethodManager.SHOW_IMPLICIT);
        } catch (Exception ignored) {
            // 键盘弹不出来也能用外接键盘，不值得为此报错。
        }
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
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        params.setMarginStart(dp(8));
        bar.addView(title, params);

        Button paste = new Button(this);
        paste.setText("粘贴");
        paste.setOnClickListener(v -> pasteIntoTerminal());
        bar.addView(paste);
        return bar;
    }

    /** 手机键盘上没有 Esc/Ctrl/方向键，补一排，不然很多命令没法用。 */
    private HorizontalScrollView buildKeyBar() {
        HorizontalScrollView scroller = new HorizontalScrollView(this);
        scroller.setBackgroundColor(Color.parseColor("#161a22"));
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setPadding(dp(6), dp(4), dp(6), dp(4));

        final Button ctrl = new Button(this);
        ctrl.setText("Ctrl");
        ctrl.setOnClickListener(v -> {
            ctrlDown = !ctrlDown;
            ctrl.setText(ctrlDown ? "Ctrl ●" : "Ctrl");
        });
        bar.addView(ctrl);

        bar.addView(key("Esc", "\u001b"));
        bar.addView(key("Tab", "\t"));
        bar.addView(key("↑", "\u001b[A"));
        bar.addView(key("↓", "\u001b[B"));
        bar.addView(key("←", "\u001b[D"));
        bar.addView(key("→", "\u001b[C"));
        bar.addView(key("Ctrl-C", "\u0003"));
        bar.addView(key("清屏", "clear\r"));

        scroller.addView(bar);
        return scroller;
    }

    private Button key(String label, final String send) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextSize(12f);
        button.setOnClickListener(v -> {
            if (session != null) session.write(send);
            terminalView.requestFocus();
        });
        return button;
    }

    private void pasteIntoTerminal() {
        try {
            ClipboardManager manager = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = manager == null ? null : manager.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) {
                Toast.makeText(this, "剪贴板里没有文字", Toast.LENGTH_SHORT).show();
                return;
            }
            CharSequence text = clip.getItemAt(0).coerceToText(this);
            if (text != null && session != null) session.write(text.toString());
            showKeyboard();
        } catch (Exception err) {
            Toast.makeText(this, "粘贴失败：" + err.getMessage(), Toast.LENGTH_SHORT).show();
        }
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    @Override
    protected void onDestroy() {
        if (session != null) session.finishIfRunning();
        super.onDestroy();
    }

    // ── TerminalSessionClient ─────────────────────────────────

    @Override
    public void onTextChanged(TerminalSession changedSession) {
        terminalView.onScreenUpdated();
    }

    @Override
    public void onTitleChanged(TerminalSession changedSession) {
        // 标题栏不跟着变，保持"终端"两个字。
    }

    @Override
    public void onSessionFinished(TerminalSession finishedSession) {
        runOnUiThread(() -> Toast.makeText(this, "会话已结束", Toast.LENGTH_SHORT).show());
    }

    @Override
    public void onCopyTextToClipboard(TerminalSession session, String text) {
        try {
            ClipboardManager manager = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            if (manager != null) manager.setPrimaryClip(ClipData.newPlainText("terminal", text));
        } catch (Exception ignored) {
            // 复制不了就算了，不影响终端本身。
        }
    }

    @Override
    public void onPasteTextFromClipboard(TerminalSession session) {
        pasteIntoTerminal();
    }

    @Override
    public void onBell(TerminalSession session) {
        // 不响铃。
    }

    @Override
    public void onColorsChanged(TerminalSession session) {
        terminalView.onScreenUpdated();
    }

    @Override
    public void onTerminalCursorStateChange(boolean state) {
        // 光标闪烁由控件自己处理。
    }

    @Override
    public void setTerminalShellPid(TerminalSession session, int pid) {
        // 不需要额外处理。
    }

    @Override
    public Integer getTerminalCursorStyle() {
        return com.termux.terminal.TerminalEmulator.DEFAULT_TERMINAL_CURSOR_STYLE;
    }

    @Override public void logError(String tag, String message) { }
    @Override public void logWarn(String tag, String message) { }
    @Override public void logInfo(String tag, String message) { }
    @Override public void logDebug(String tag, String message) { }
    @Override public void logVerbose(String tag, String message) { }
    @Override public void logStackTraceWithMessage(String tag, String message, Exception e) { }
    @Override public void logStackTrace(String tag, Exception e) { }

    // ── TerminalViewClient ────────────────────────────────────

    @Override
    public float onScale(float scale) {
        int size = Math.round(12 * scale);
        terminalView.setTextSize(Math.max(8, Math.min(32, size)));
        return 1f;
    }

    @Override
    public void onSingleTapUp(MotionEvent e) {
        showKeyboard();
    }

    @Override
    public boolean shouldBackButtonBeMappedToEscape() {
        return false;
    }

    @Override
    public boolean shouldEnforceCharBasedInput() {
        return true;
    }

    @Override
    public boolean shouldUseCtrlSpaceWorkaround() {
        return false;
    }

    @Override
    public boolean isTerminalViewSelected() {
        return true;
    }

    @Override
    public void copyModeChanged(boolean copyMode) {
        // 复制模式未启用。
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent e, TerminalSession session) {
        return false;
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent e) {
        if (keyCode == KeyEvent.KEYCODE_BACK && e.isTracking()) {
            // 返回键留给 Activity。
            return false;
        }
        return false;
    }

    @Override
    public boolean onLongPress(MotionEvent event) {
        return false;
    }

    @Override
    public boolean readControlKey() {
        return ctrlDown;
    }

    @Override
    public boolean readAltKey() {
        return false;
    }

    @Override
    public boolean readShiftKey() {
        return false;
    }

    @Override
    public boolean readFnKey() {
        return false;
    }

    @Override
    public boolean onCodePoint(int codePoint, boolean ctrlDown, TerminalSession session) {
        if (this.ctrlDown) {
            // 把下一个字符转成控制字符：Ctrl-C、Ctrl-D 这类就是这么来的。
            char c = Character.toLowerCase((char) codePoint);
            if (c >= 'a' && c <= 'z') {
                session.write(new String(new char[]{(char) (c - 'a' + 1)}));
                this.ctrlDown = false;
                return true;
            }
            this.ctrlDown = false;
        }
        return false;
    }

    @Override
    public void onEmulatorSet() {
        terminalView.onScreenUpdated();
    }
}
