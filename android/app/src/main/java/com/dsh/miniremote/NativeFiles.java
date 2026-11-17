package com.dsh.miniremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * 手机上的文件能力，**全都跑在我们自己的 App 里**（2026-11-12）。
 *
 * 为什么不靠 Termux：用户不该为了用这个 App 再装一个 App。这里只用两种位置：
 *   · `app:` 开头的路径 —— App 自己的私有目录，不需要任何权限，用户看不见；
 *   · `work:` 开头的路径 —— 用户在系统选择器里**亲手选的一个文件夹**，之后归我们管。
 *
 * 关于商店：这两种方式都符合 Google Play 的要求。**绝不申请"所有文件访问"**
 * （MANAGE_EXTERNAL_STORAGE）——那要求应用的核心功能就是管文件，我们不是，硬报会被驳回。
 */
final class NativeFiles {
    static final String PREFS = "mini_ui_prefs";
    static final String WORK_TREE = "work_tree_uri";
    static final String WORK_NAME = "work_tree_name";

    /** 单次读写的上限，避免一次塞爆通道或内存。 */
    private static final int MAX_WRITE_CHARS = 60_000;
    private static final int MAX_READ_CHARS = 200_000;
    private static final int MAX_LIST = 500;

    private NativeFiles() {
    }

    static String workUri(Context context) {
        return prefs(context).getString(WORK_TREE, "");
    }

    static String workName(Context context) {
        return prefs(context).getString(WORK_NAME, "");
    }

    static void setWork(Context context, Uri uri, String name) {
        prefs(context).edit()
                .putString(WORK_TREE, uri == null ? "" : uri.toString())
                .putString(WORK_NAME, name == null ? "" : name)
                .apply();
    }

    private static SharedPreferences prefs(Context context) {
        return context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** 给界面看的一句话状态。 */
    static String describe(Context context) {
        String name = workName(context);
        return name.isEmpty() ? "" : name;
    }

    // ── 路径解析 ────────────────────────────────────────────────

    /** `app:` 与 `work:` 两种前缀；其它一律拒绝，并给出可读的原因。 */
    static JSONObject resolve(Context context, String path) throws Exception {
        if (path == null || path.trim().isEmpty()) {
            throw new IllegalArgumentException("路径是空的");
        }
        String p = path.trim();
        if (p.startsWith("app:")) {
            return new JSONObject().put("kind", "app").put("rel", strip(p.substring(4)));
        }
        if (p.startsWith("work:")) {
            if (workUri(context).isEmpty()) {
                throw new IllegalStateException("还没有选工作文件夹。请到「设置 → 屏幕操作 → 工作文件夹」选一个。");
            }
            return new JSONObject().put("kind", "work").put("rel", strip(p.substring(5)));
        }
        throw new IllegalArgumentException("路径要以 app: 或 work: 开头（例如 work:下载/a.txt）");
    }

    private static String strip(String value) {
        String v = value == null ? "" : value.trim();
        while (v.startsWith("/")) v = v.substring(1);
        return v;
    }

    private static File appFile(Context context, String rel) {
        return rel.isEmpty() ? context.getFilesDir() : new File(context.getFilesDir(), rel);
    }

    /** 在 SAF 目录里按名字逐级找；找不到就返回 null。 */
    private static androidx.documentfile.provider.DocumentFile walk(
            Context context, String rel, boolean createMissing) {
        Uri tree = Uri.parse(workUri(context));
        androidx.documentfile.provider.DocumentFile dir =
                androidx.documentfile.provider.DocumentFile.fromTreeUri(context, tree);
        if (dir == null) return null;
        if (rel.isEmpty()) return dir;
        String[] parts = rel.split("/");
        androidx.documentfile.provider.DocumentFile current = dir;
        for (int i = 0; i < parts.length; i++) {
            String name = parts[i];
            if (name.isEmpty()) continue;
            boolean last = i == parts.length - 1;
            androidx.documentfile.provider.DocumentFile next = current.findFile(name);
            if (next == null) {
                if (!createMissing || last) return null;
                next = current.createDirectory(name);
                if (next == null) return null;
            }
            current = next;
        }
        return current;
    }

    // ── 四个动作 ────────────────────────────────────────────────

    static String list(Context context, String path) {
        try {
            JSONObject target = resolve(context, path);
            JSONArray items = new JSONArray();
            int scanned = 0;
            boolean truncated = false;
            if ("app".equals(target.getString("kind"))) {
                File dir = appFile(context, target.getString("rel"));
                if (!dir.exists()) return err("这个目录不存在：" + path);
                if (!dir.isDirectory()) return err("这不是目录：" + path);
                File[] children = dir.listFiles();
                if (children == null) return err("读不了这个目录");
                for (File child : children) {
                    if (scanned >= MAX_LIST) { truncated = true; break; }
                    scanned++;
                    items.put(new JSONObject()
                            .put("name", child.getName())
                            .put("dir", child.isDirectory())
                            .put("size", child.isDirectory() ? 0 : child.length()));
                }
            } else {
                androidx.documentfile.provider.DocumentFile dir =
                        walk(context, target.getString("rel"), false);
                if (dir == null || !dir.isDirectory()) return err("这个目录不存在或不是目录：" + path);
                for (androidx.documentfile.provider.DocumentFile child : dir.listFiles()) {
                    if (scanned >= MAX_LIST) { truncated = true; break; }
                    scanned++;
                    items.put(new JSONObject()
                            .put("name", child.getName() == null ? "" : child.getName())
                            .put("dir", child.isDirectory())
                            .put("size", child.length()));
                }
            }
            return new JSONObject().put("ok", true).put("path", path)
                    .put("scope", target.getString("kind"))
                    .put("scanned", scanned)
                    .put("truncated", truncated)
                    .put("complete", !truncated)
                    .put("items", items).toString();
        } catch (Exception e) {
            return err(reason(e));
        }
    }

    static String read(Context context, String path, int offset, int limit) {
        try {
            JSONObject target = resolve(context, path);
            // 二进制文件（docx/zip/pdf 等）不能按文本读：先探一下是不是文本。
            if (isBinaryPath(path)) {
                return err("这是二进制文件（" + binaryKind(path) + "），不能按文本读。请用 phone_open_file 打开，或先转成文本。");
            }
            List<String> lines = new ArrayList<>();
            if ("app".equals(target.getString("kind"))) {
                File file = appFile(context, target.getString("rel"));
                if (!file.exists() || file.isDirectory()) return err("没有这个文件：" + path);
                try (BufferedReader reader = new BufferedReader(
                        new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
                    String line;
                    while ((line = reader.readLine()) != null) lines.add(line);
                }
            } else {
                androidx.documentfile.provider.DocumentFile file =
                        walk(context, target.getString("rel"), false);
                if (file == null || !file.isFile()) return err("没有这个文件：" + path);
                try (InputStream in = context.getContentResolver().openInputStream(file.getUri())) {
                    if (in == null) return err("打不开这个文件");
                    BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
                    String line;
                    while ((line = reader.readLine()) != null) lines.add(line);
                }
            }
            int from = Math.max(0, offset - 1);
            int to = Math.min(lines.size(), from + Math.max(1, limit));
            StringBuilder text = new StringBuilder();
            for (int i = from; i < to; i++) {
                text.append(lines.get(i));
                if (i < to - 1) text.append('\n');
            }
            String body = text.length() > MAX_READ_CHARS
                    ? text.substring(0, MAX_READ_CHARS) : text.toString();
            boolean truncated = text.length() > MAX_READ_CHARS;
            return new JSONObject().put("ok", true).put("path", path)
                    .put("scope", target.getString("kind"))
                    .put("totalLines", lines.size())
                    .put("from", from + 1).put("to", to)
                    .put("truncated", truncated)
                    .put("complete", !truncated && to >= lines.size())
                    .put("text", body).toString();
        } catch (Exception e) {
            return err(reason(e));
        }
    }

    /** 按扩展名判断是不是二进制文件；是的话拒绝按文本读。 */
    private static boolean isBinaryPath(String path) {
        String lower = path.toLowerCase(java.util.Locale.ROOT);
        return lower.endsWith(".docx") || lower.endsWith(".doc")
                || lower.endsWith(".xlsx") || lower.endsWith(".xls")
                || lower.endsWith(".pptx") || lower.endsWith(".ppt")
                || lower.endsWith(".pdf") || lower.endsWith(".zip")
                || lower.endsWith(".rar") || lower.endsWith(".7z")
                || lower.endsWith(".apk") || lower.endsWith(".aab")
                || lower.endsWith(".jpg") || lower.endsWith(".jpeg")
                || lower.endsWith(".png") || lower.endsWith(".gif")
                || lower.endsWith(".mp3") || lower.endsWith(".mp4")
                || lower.endsWith(".wav") || lower.endsWith(".avi")
                || lower.endsWith(".mov") || lower.endsWith(".mkv");
    }

    private static String binaryKind(String path) {
        String lower = path.toLowerCase(java.util.Locale.ROOT);
        if (lower.endsWith(".docx") || lower.endsWith(".doc")) return "Word 文档";
        if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "Excel 表格";
        if (lower.endsWith(".pptx") || lower.endsWith(".ppt")) return "PPT 演示";
        if (lower.endsWith(".pdf")) return "PDF";
        if (lower.endsWith(".zip") || lower.endsWith(".rar") || lower.endsWith(".7z")) return "压缩包";
        if (lower.endsWith(".apk") || lower.endsWith(".aab")) return "安装包";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || lower.endsWith(".png")
                || lower.endsWith(".gif")) return "图片";
        if (lower.endsWith(".mp3") || lower.endsWith(".wav")) return "音频";
        if (lower.endsWith(".mp4") || lower.endsWith(".avi") || lower.endsWith(".mov")
                || lower.endsWith(".mkv")) return "视频";
        return "二进制";
    }

    static String write(Context context, String path, String content) {
        try {
            if (content != null && content.length() > MAX_WRITE_CHARS) {
                return err("内容太长（超过 6 万字符），分成几次写。");
            }
            JSONObject target = resolve(context, path);
            String body = content == null ? "" : content;
            if ("app".equals(target.getString("kind"))) {
                File file = appFile(context, target.getString("rel"));
                File parent = file.getParentFile();
                if (parent != null && !parent.exists() && !parent.mkdirs()) return err("建不了上级目录");
                try (FileOutputStream out = new FileOutputStream(file, false)) {
                    out.write(body.getBytes(StandardCharsets.UTF_8));
                }
                return new JSONObject().put("ok", true).put("path", path)
                        .put("bytes", file.length()).toString();
            }
            String rel = target.getString("rel");
            int slash = rel.lastIndexOf('/');
            String dirRel = slash < 0 ? "" : rel.substring(0, slash);
            String name = slash < 0 ? rel : rel.substring(slash + 1);
            if (name.isEmpty()) return err("路径要以文件名结尾");
            androidx.documentfile.provider.DocumentFile dir = walk(context, dirRel, true);
            if (dir == null || !dir.isDirectory()) return err("建不了上级目录");
            androidx.documentfile.provider.DocumentFile file = dir.findFile(name);
            if (file == null) file = dir.createFile("text/plain", name);
            if (file == null) return err("建不了这个文件");
            try (OutputStream out = context.getContentResolver().openOutputStream(file.getUri(), "wt")) {
                if (out == null) return err("打不开这个文件写");
                out.write(body.getBytes(StandardCharsets.UTF_8));
            }
            return new JSONObject().put("ok", true).put("path", path)
                    .put("bytes", body.getBytes(StandardCharsets.UTF_8).length).toString();
        } catch (Exception e) {
            return err(reason(e));
        }
    }

    static String edit(Context context, String path, String from, String to) {
        try {
            if (from == null || from.isEmpty()) return err("要指定 old（要被替换掉的原文）");
            String current = read(context, path, 1, Integer.MAX_VALUE / 4);
            JSONObject parsed = new JSONObject(current);
            if (!parsed.optBoolean("ok")) return current;
            String text = parsed.optString("text", "");
            int first = text.indexOf(from);
            if (first < 0) return err("文件里没有找到要替换的文字");
            if (text.indexOf(from, first + from.length()) >= 0) {
                return err("要替换的文字出现了不止一次，先写得更具体一些");
            }
            String next = text.substring(0, first) + (to == null ? "" : to) + text.substring(first + from.length());
            return write(context, path, next);
        } catch (Exception e) {
            return err(reason(e));
        }
    }


    // ── 找文件 / 搜内容 ────────────────────────────────────────

    /** 目录最多往下走几层，避免在超大目录里跑很久。 */
    private static final int MAX_DEPTH = 8;
    /** 一次最多返回多少条命中。 */
    private static final int MAX_HITS = 300;
    /** 搜内容时最多翻多少个文件、单文件多大。 */
    private static final int MAX_SCAN_FILES = 500;
    private static final long MAX_SCAN_BYTES = 256 * 1024;

    /** 把 *.txt 这种通配符翻成正则；只支持 * 和 ?。 */
    private static java.util.regex.Pattern globToRegex(String glob) {
        StringBuilder sb = new StringBuilder("^");
        for (char c : glob.toCharArray()) {
            if (c == '*') sb.append(".*");
            else if (c == '?') sb.append('.');
            else sb.append(java.util.regex.Pattern.quote(String.valueOf(c)));
        }
        return java.util.regex.Pattern.compile(sb.append('$').toString());
    }

    static String glob(Context context, String path, String pattern) {
        try {
            JSONObject target = resolve(context, path);
            java.util.regex.Pattern rx = globToRegex(pattern == null || pattern.isEmpty() ? "*" : pattern);
            JSONArray hits = new JSONArray();
            int[] scanned = {0};
            boolean truncated = false;
            if ("app".equals(target.getString("kind"))) {
                truncated = walkApp(new File(context.getFilesDir(), target.getString("rel")), "", 0, rx, hits, scanned);
            } else {
                androidx.documentfile.provider.DocumentFile dir =
                        walk(context, target.getString("rel"), false);
                if (dir == null || !dir.isDirectory()) return err("这个目录不存在或不是目录：" + path);
                truncated = walkTree(dir, "", 0, rx, hits, scanned);
            }
            return new JSONObject().put("ok", true)
                    .put("scope", target.getString("kind"))
                    .put("scanned", scanned[0])
                    .put("truncated", truncated)
                    .put("complete", !truncated)
                    .put("count", hits.length()).put("files", hits).toString();
        } catch (Exception e) {
            return err(reason(e));
        }
    }

    private static boolean walkApp(File dir, String prefix, int depth,
                                 java.util.regex.Pattern rx, JSONArray hits, int[] scanned) {
        if (dir == null || depth > MAX_DEPTH || hits.length() >= MAX_HITS) return hits.length() >= MAX_HITS;
        File[] children = dir.listFiles();
        if (children == null) return false;
        for (File child : children) {
            if (hits.length() >= MAX_HITS) return true;
            scanned[0]++;
            String rel = prefix.isEmpty() ? child.getName() : prefix + "/" + child.getName();
            if (child.isDirectory()) {
                if (walkApp(child, rel, depth + 1, rx, hits, scanned)) return true;
            } else if (rx.matcher(child.getName()).matches()) {
                hits.put(rel + "\t" + child.length());
            }
        }
        return false;
    }

    private static boolean walkTree(androidx.documentfile.provider.DocumentFile dir, String prefix,
                                  int depth, java.util.regex.Pattern rx, JSONArray hits, int[] scanned) {
        if (dir == null || depth > MAX_DEPTH || hits.length() >= MAX_HITS) return hits.length() >= MAX_HITS;
        for (androidx.documentfile.provider.DocumentFile child : dir.listFiles()) {
            if (hits.length() >= MAX_HITS) return true;
            scanned[0]++;
            String name = child.getName() == null ? "" : child.getName();
            String rel = prefix.isEmpty() ? name : prefix + "/" + name;
            if (child.isDirectory()) {
                if (walkTree(child, rel, depth + 1, rx, hits, scanned)) return true;
            } else if (rx.matcher(name).matches()) {
                hits.put(rel + "\t" + child.length());
            }
        }
        return false;
    }

    static String grep(Context context, String path, String pattern) {
        try {
            if (pattern == null || pattern.isEmpty()) return err("要指定 pattern");
            JSONObject target = resolve(context, path);
            JSONArray hits = new JSONArray();
            int[] budget = {MAX_SCAN_FILES};
            int[] scanned = {0};
            boolean truncated = false;
            if ("app".equals(target.getString("kind"))) {
                truncated = grepApp(new File(context.getFilesDir(), target.getString("rel")), "", 0, pattern, hits, budget, scanned);
            } else {
                androidx.documentfile.provider.DocumentFile dir =
                        walk(context, target.getString("rel"), false);
                if (dir == null) return err("这个位置不存在：" + path);
                truncated = grepTree(context, dir, "", 0, pattern, hits, budget, scanned);
            }
            return new JSONObject().put("ok", true)
                    .put("scope", target.getString("kind"))
                    .put("scanned", scanned[0])
                    .put("truncated", truncated)
                    .put("complete", !truncated)
                    .put("count", hits.length()).put("matches", hits).toString();
        } catch (Exception e) {
            return err(reason(e));
        }
    }

    private static boolean grepApp(File dir, String prefix, int depth, String pattern,
                                 JSONArray hits, int[] budget, int[] scanned) {
        if (dir == null || depth > MAX_DEPTH || hits.length() >= MAX_HITS || budget[0] <= 0)
            return hits.length() >= MAX_HITS || budget[0] <= 0;
        File[] children = dir.listFiles();
        if (children == null) return false;
        for (File child : children) {
            if (hits.length() >= MAX_HITS || budget[0] <= 0) return true;
            scanned[0]++;
            String rel = prefix.isEmpty() ? child.getName() : prefix + "/" + child.getName();
            if (child.isDirectory()) {
                if (grepApp(child, rel, depth + 1, pattern, hits, budget, scanned)) return true;
            } else if (child.length() <= MAX_SCAN_BYTES) {
                budget[0]--;
                scanFile(child.getName(), rel, readLinesApp(child), pattern, hits);
            }
        }
        return false;
    }

    private static boolean grepTree(Context context, androidx.documentfile.provider.DocumentFile dir,
                                  String prefix, int depth, String pattern, JSONArray hits, int[] budget, int[] scanned) {
        if (dir == null || depth > MAX_DEPTH || hits.length() >= MAX_HITS || budget[0] <= 0)
            return hits.length() >= MAX_HITS || budget[0] <= 0;
        for (androidx.documentfile.provider.DocumentFile child : dir.listFiles()) {
            if (hits.length() >= MAX_HITS || budget[0] <= 0) return true;
            scanned[0]++;
            String name = child.getName() == null ? "" : child.getName();
            String rel = prefix.isEmpty() ? name : prefix + "/" + name;
            if (child.isDirectory()) {
                if (grepTree(context, child, rel, depth + 1, pattern, hits, budget, scanned)) return true;
            } else if (child.length() <= MAX_SCAN_BYTES) {
                budget[0]--;
                scanFile(name, rel, readLinesUri(context, child.getUri()), pattern, hits);
            }
        }
        return false;
    }

    private static void scanFile(String name, String rel, List<String> lines, String pattern, JSONArray hits) {
        if (lines == null) return;
        java.util.regex.Pattern rx = null;
        try {
            rx = java.util.regex.Pattern.compile(pattern, java.util.regex.Pattern.CASE_INSENSITIVE);
        } catch (Exception ignored) {
            // 不是合法正则就按普通文字找。
        }
        for (int i = 0; i < lines.size() && hits.length() < MAX_HITS; i++) {
            String line = lines.get(i);
            boolean match = rx != null ? rx.matcher(line).find() : line.contains(pattern);
            if (!match) continue;
            try {
                hits.put(new JSONObject().put("file", rel).put("line", i + 1).put("text", line));
            } catch (Exception ignored) {
                // 单条拼不进 JSON 就跳过，不影响别的命中。
            }
        }
    }

    private static List<String> readLinesApp(File file) {
        List<String> lines = new ArrayList<>();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8))) {
            String line;
            while ((line = reader.readLine()) != null) lines.add(line);
        } catch (Exception e) {
            return null;
        }
        return lines;
    }

    private static List<String> readLinesUri(Context context, Uri uri) {
        List<String> lines = new ArrayList<>();
        try (InputStream in = context.getContentResolver().openInputStream(uri)) {
            if (in == null) return null;
            BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            String line;
            while ((line = reader.readLine()) != null) lines.add(line);
        } catch (Exception e) {
            return null;
        }
        return lines;
    }

    // ── 小工具 ─────────────────────────────────────────────────


    private static String err(String message) {
        try {
            return new JSONObject().put("ok", false).put("error", message).toString();
        } catch (Exception ignored) {
            return "{\"ok\":false}";
        }
    }

    /** 把系统异常翻成人话，别把整段堆栈丢给模型。 */
    private static String reason(Exception e) {
        if (e instanceof IllegalStateException || e instanceof IllegalArgumentException) {
            return e.getMessage() == null ? "参数不对" : e.getMessage();
        }
        String name = e.getClass().getSimpleName();
        String msg = e.getMessage() == null ? "" : e.getMessage();
        if (name.contains("Security")) return "没有权限访问这个位置（如果刚授权过，重新选一次文件夹）";
        if (name.contains("FileNotFound")) return "没有这个文件或目录";
        return (name + " " + msg).trim();
    }
}
