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
