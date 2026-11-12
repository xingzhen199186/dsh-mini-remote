package com.dsh.miniremote;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

/**
 * 自研终端：直接用系统自带的 `sh` 执行命令（2026-11-12）。
 *
 * 为什么要它：用户不该为了敲一条命令再装一个 App。安卓系统本身就带
 * `/system/bin/sh` 和 toybox（0BSD），任何 App 都能调用——这是 AOSP 一直允许的，
 * 那条"禁止执行"的限制只作用于 App 自己可写目录里的文件。
 *
 * 边界必须说清：
 *  · 子进程仍然是**本 App 的身份**，不是 root，也不是 ADB shell；
 *  · 因此碰不到别的 App 的私有数据；
 *  · **看不到用户在系统选择器里选的那个工作文件夹**——那是授权凭证，不是路径。
 *    要用那个文件夹，走 phone_fs_* 那套原生文件工具。
 */
final class NativeShell {
    /** 一次最多回多少字符，避免把通道撑爆。 */
    private static final int MAX_OUTPUT = 200_000;

    private NativeShell() {
    }

    static String run(android.content.Context context, String command, int timeoutSeconds) {
        if (command == null || command.trim().isEmpty()) {
            return "{\"ok\":false,\"error\":\"命令是空的\"}";
        }
        Process process = null;
        try {
            ProcessBuilder builder = new ProcessBuilder("/system/bin/sh", "-c", command);
            builder.redirectErrorStream(true);
            // 给一个可写的家目录和临时目录，否则很多命令会报权限或找不到临时文件。
            builder.environment().put("HOME", context.getFilesDir().getAbsolutePath());
            builder.environment().put("TMPDIR", context.getCacheDir().getAbsolutePath());
            builder.environment().put("PATH",
                    "/system/bin:/system/xbin:" + context.getApplicationInfo().nativeLibraryDir);
            builder.directory(context.getFilesDir());
            process = builder.start();

            // 立刻关掉 stdin：交互式命令读不到输入会自然结束，不会一直挂着。
            try (OutputStream stdin = process.getOutputStream()) {
                stdin.write('\n');
            } catch (Exception ignored) {
                // 关不掉也没关系，下面还有超时兜底。
            }

            final InputStream out = process.getInputStream();
            final ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            final int[] overflow = {0};
            Thread reader = new Thread(() -> {
                byte[] chunk = new byte[8192];
                int n;
                try {
                    while ((n = out.read(chunk)) > 0) {
                        synchronized (buffer) {
                            int room = MAX_OUTPUT - buffer.size();
                            if (room <= 0) {
                                overflow[0]++;
                                continue;
                            }
                            buffer.write(chunk, 0, Math.min(room, n));
                        }
                    }
                } catch (Exception ignored) {
                    // 进程被杀时会抛，正常。
                }
            });
            reader.setDaemon(true);
            reader.start();

            boolean finished = process.waitFor(
                    Math.max(3, Math.min(300, timeoutSeconds)), TimeUnit.SECONDS);
            if (!finished) {
                process.destroy();
                reader.join(500);
                return new JSONObject()
                        .put("ok", false)
                        .put("error", "命令超过 " + timeoutSeconds + " 秒还没结束，已中止")
                        .put("stdout", textOf(buffer))
                        .toString();
            }
            reader.join(1000);
            String output = textOf(buffer);
            int exit = process.exitValue();
            JSONObject result = new JSONObject()
                    .put("ok", exit == 0)
                    .put("stdout", output)
                    .put("exitCode", exit);
            if (overflow[0] > 0) result.put("truncated", true);
            return result.toString();
        } catch (Exception err) {
            String message = err.getMessage() == null ? err.getClass().getSimpleName() : err.getMessage();
            try {
                return new JSONObject().put("ok", false).put("error", message.replace('"', '\'')).toString();
            } catch (Exception ignored) {
                return "{\"ok\":false}";
            }
        } finally {
            if (process != null) process.destroy();
        }
    }

    private static String textOf(ByteArrayOutputStream buffer) {
        synchronized (buffer) {
            return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
