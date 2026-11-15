package com.dsh.miniremote;

/**
 * 把自连通道的失败翻成「下一步该做什么」（2026-11-15）。
 *
 * 为什么单开一个类：同一种失败会在三个地方冒出来——`phone_shell` 的返回、
 * 设置页那一行、自检脚本。三处各写一套说辞，迟早互相矛盾；
 * 这里一份对照表，谁要用谁来拿。
 *
 * 原则：**说清楚发生了什么 + 用户能做的一件事**；不抛原始英文错误。
 */
final class ShellErrors {

    private ShellErrors() {
    }

    /** 没有更具体的信息时的兜底。 */
    static final String GENERIC = "自连通道暂时不可用，已改用 Termux 执行。";

    /**
     * @param raw 底层错误原文（可能是英文）
     * @return 给用户看的一句话
     */
    static String hintFor(String raw) {
        if (raw == null) return GENERIC;
        String text = raw.toLowerCase();

        // 1) 手机不认这把钥匙：配对失效（清过数据、重装过、或手机上删了设备）。
        if (text.contains("certificate_unknown") || text.contains("certificate_verify")
                || text.contains("证书") || text.contains("钥匙")) {
            return "这台手机已经不认本 App 的钥匙了：打开 App 设置，点「重新配对」再试一次。";
        }

        // 2) 端口没了：无线调试关了，或端口变了。
        if (text.contains("econnrefused") || text.contains("连接被关闭")
                || text.contains("没收到 stls") || text.contains("connect")) {
            return "连不上手机的调试口：多半是无线调试关了，或端口变了。打开无线调试后再试。";
        }

        // 3) 握手失败：常见于手机那侧拒绝了连接（例如刚重启、或配对状态被清）。
        if (text.contains("tls") || text.contains("握手")) {
            return "和手机的加密握手没成功：先重开一次无线调试；还不行就点「重新配对」。";
        }

        // 4) 配对码相关（配对流程用的是同一套话术）。
        if (text.contains("配对码")) {
            return "配对码不对或不完整：重新点「开始配对」，在通知里把 6 位码填全。";
        }

        return GENERIC;
    }

    /** 这一条错误是不是"需要用户重新配对"。界面据此决定要不要把按钮亮出来。 */
    static boolean needsRepair(String raw) {
        if (raw == null) return false;
        String text = raw.toLowerCase();
        return text.contains("certificate_unknown") || text.contains("certificate_verify")
                || text.contains("钥匙");
    }

    /** 这一条错误是不是"无线调试没开/端口失效"，这类等用户开一下就好。 */
    static boolean looksLikePortGone(String raw) {
        if (raw == null) return false;
        String text = raw.toLowerCase();
        return text.contains("econnrefused") || text.contains("连接被关闭")
                || text.contains("没收到 stls");
    }
}
