package com.dsh.miniremote;

import android.content.Context;
import android.content.SharedPreferences;

import java.util.Locale;

/**
 * 手机端「连接」这一块的本地账本（2026-11-07）。
 *
 * 只干两件事：把服务器给的线路类型翻译成人话，以及记住用户手动挑中的那条地址。
 * 线路本身仍然存在配对凭据里（造地址池、写 Cookie 都用它），这里不另存一份。
 */
final class Connections {
    /** 单独一个偏好文件：配对凭据是加密的整块，不为一个字符串去动它。 */
    private static final String PREFERENCES = "mini_remote_connections";
    private static final String PREFERRED = "preferred_url";

    private Connections() {
    }

    /** 用户上次挑中的地址；没有就是 null。 */
    static String preferred(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        String value = prefs.getString(PREFERRED, null);
        if (value == null || value.isEmpty()) {
            return null;
        }
        return value;
    }

    static void setPreferred(Context context, String url) {
        SharedPreferences prefs = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        if (url == null || url.isEmpty()) {
            prefs.edit().remove(PREFERRED).apply();
            return;
        }
        prefs.edit().putString(PREFERRED, url).apply();
    }

    /**
     * 把线路类型收成一个「槽位」标识（2026-11-07）。
     *
     * 清单是按槽位排的：内网、Tailscale、公网各一条，清空某条之后槽位还在，
     * 只是变成「未配置」。所以要先把五花八门的 type 归到同一个槽位上。
     */
    static String slotOf(String type) {
        String t = type == null ? "" : type.toLowerCase(Locale.ROOT);
        if (t.contains("lan") || t.contains("internal") || t.contains("private")) {
            return "lan";
        }
        if (t.contains("tailscale-https")) {
            return "tailscale-https";
        }
        if (t.contains("tailscale")) {
            return "tailscale";
        }
        if (t.contains("b-relay")) {
            return "b-relay";
        }
        if (t.contains("multi-relay")) {
            return "multi-relay";
        }
        if (t.contains("self-relay")) {
            return "self-relay";
        }
        if (t.contains("public-relay")) {
            return "public-relay";
        }
        if (t.contains("manual")) {
            return "manual";
        }
        if (t.contains("public") || t.contains("tunnel")) {
            return "public";
        }
        return "other";
    }

    /**
     * 手动添加一条地址时，按地址本身猜它属于哪条路（2026-11-07）。
     *
     * 以前一律标成 manual，结果手机上加一个内网地址也显示「手动地址」——
     * 名字不对，用户还得多想一层它到底是什么。猜不出来才退回 manual。
     */
    static String inferType(String baseUrl) {
        if (baseUrl == null) {
            return "manual";
        }
        String host;
        try {
            host = java.net.URI.create(baseUrl.trim()).getHost();
        } catch (IllegalArgumentException e) {
            return "manual";
        }
        if (host == null) {
            return "manual";
        }
        host = host.toLowerCase(Locale.ROOT);
        if (host.endsWith(".ts.net") || host.startsWith("100.")) {
            return "tailscale";
        }
        if ("localhost".equals(host) || host.endsWith(".local") || host.startsWith("10.")
                || host.startsWith("192.168.") || host.startsWith("169.254.")
                || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:")) {
            return "lan";
        }
        if (host.startsWith("172.")) {
            String[] parts = host.split("\\.");
            if (parts.length > 1) {
                try {
                    int second = Integer.parseInt(parts[1]);
                    if (second >= 16 && second <= 31) {
                        return "lan";
                    }
                } catch (NumberFormatException ignored) {
                    // 不是内网段，继续往下走。
                }
            }
        }
        if ("https".equalsIgnoreCase(java.net.URI.create(baseUrl.trim()).getScheme())) {
            return "public";
        }
        return "manual";
    }

    /**
     * 把 type 翻译成列表里显示的名字。
     *
     * 判断顺序有意从窄到宽：「tailscale-https」必须排在「tailscale」前面，
     * 「b-relay / multi-relay / self-relay」必须排在「public-relay」前面，
     * 否则后者会把前者一起吃成一个名字。
     */
    static String labelOf(String type) {
        String t = type == null ? "" : type.toLowerCase(Locale.ROOT);
        if (t.contains("lan") || t.contains("internal") || t.contains("private")) {
            return "内网直连";
        }
        if (t.contains("tailscale-https")) {
            return "Tailscale（加密）";
        }
        if (t.contains("tailscale")) {
            return "Tailscale";
        }
        if (t.contains("b-relay")) {
            return "公网（专属固定）";
        }
        if (t.contains("multi-relay")) {
            return "公网（自建多用户）";
        }
        if (t.contains("self-relay")) {
            return "自建中继";
        }
        if (t.contains("public-relay")) {
            return "公网（共享固定）";
        }
        if (t.contains("manual")) {
            return "手动地址";
        }
        if (t.contains("public") || t.contains("tunnel")) {
            return "公网";
        }
        return "其他地址";
    }
}
