package com.dsh.miniremote;

import java.net.URI;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

/**
 * 配对地址池与探测状态机。
 * 本类不依赖 Android，网络访问由调用方通过 Prober 注入。
 */
public final class AddressPool {
    public enum State {
        IDLE,
        PROBING,
        CONNECTED,
        UNAVAILABLE
    }

    /** 一个不带末尾斜杠的服务器 base URL。 */
    public static final class Entry {
        public final String baseUrl;
        public final String type;

        public Entry(String baseUrl, String type) {
            if (baseUrl == null) {
                throw new IllegalArgumentException("地址不能为空。");
            }
            String normalized = baseUrl.trim();
            while (normalized.endsWith("/")) {
                normalized = normalized.substring(0, normalized.length() - 1);
            }
            URI uri;
            try {
                uri = URI.create(normalized);
            } catch (IllegalArgumentException e) {
                throw new IllegalArgumentException("服务器地址格式不正确。", e);
            }
            String scheme = uri.getScheme();
            if (scheme == null
                    || !("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                    || uri.getHost() == null) {
                throw new IllegalArgumentException("服务器地址必须是完整的 HTTP 或 HTTPS 地址。");
            }
            this.baseUrl = normalized;
            this.type = type == null ? "" : type;
        }

        int rank() {
            String value = type.toLowerCase(Locale.ROOT);
            if (value.contains("lan") || value.contains("internal") || value.contains("private")) {
                return 0;
            }
            if (value.contains("tailscale")) {
                return 1;
            }
            if (!value.isEmpty()) {
                return 2;
            }
            String host = URI.create(baseUrl).getHost();
            if (host == null) {
                return 2;
            }
            host = host.toLowerCase(Locale.ROOT);
            if (isTailscaleHost(host)) {
                return 1;
            }
            if (isLanHost(host)) {
                return 0;
            }
            return 2;
        }

        private static boolean isTailscaleHost(String host) {
            return host.endsWith(".ts.net") || host.startsWith("100.");
        }

        private static boolean isLanHost(String host) {
            if ("localhost".equals(host) || host.endsWith(".local") || host.startsWith("10.")
                    || host.startsWith("192.168.") || host.startsWith("169.254.")) {
                return true;
            }
            if (host.startsWith("172.")) {
                String[] parts = host.split("\\.");
                if (parts.length > 1) {
                    try {
                        int second = Integer.parseInt(parts[1]);
                        return second >= 16 && second <= 31;
                    } catch (NumberFormatException ignored) {
                        return false;
                    }
                }
            }
            return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
        }
    }

    /** 执行一次真实探测；返回 false 或抛出异常都表示当前地址不可用。 */
    public interface Prober {
        boolean probe(String baseUrl) throws Exception;
    }

    public static final class ProbeResult {
        public final State state;
        public final Entry current;
        public final boolean changed;
        public final boolean alreadyProbing;

        private ProbeResult(State state, Entry current, boolean changed, boolean alreadyProbing) {
            this.state = state;
            this.current = current;
            this.changed = changed;
            this.alreadyProbing = alreadyProbing;
        }
    }

    private final List<Entry> entries;
    private State state = State.IDLE;
    private Entry current;
    private boolean probing;

    public AddressPool(List<Entry> source) {
        if (source == null || source.isEmpty()) {
            throw new IllegalArgumentException("配对响应中没有可用地址。");
        }
        entries = new ArrayList<Entry>(source);
        Collections.sort(entries, new Comparator<Entry>() {
            @Override
            public int compare(Entry left, Entry right) {
                return Integer.compare(left.rank(), right.rank());
            }
        });
    }

    public synchronized State getState() {
        return state;
    }

    public synchronized Entry getCurrent() {
        return current;
    }

    public synchronized List<Entry> getEntries() {
        return new ArrayList<Entry>(entries);
    }

    /**
     * 按排序后的列表逐条探测。此方法会阻塞，必须由调用方放到后台线程执行。
     * 同时只允许一轮探测；重入时返回 alreadyProbing=true，不改变当前地址。
     */
    public ProbeResult probe(Prober prober) {
        if (prober == null) {
            throw new IllegalArgumentException("必须提供地址探测器。");
        }
        final List<Entry> snapshot;
        final Entry previous;
        synchronized (this) {
            if (probing) {
                return new ProbeResult(state, current, false, true);
            }
            probing = true;
            state = State.PROBING;
            snapshot = new ArrayList<Entry>(entries);
            previous = current;
        }

        Entry selected = null;
        for (Entry entry : snapshot) {
            try {
                if (prober.probe(entry.baseUrl)) {
                    selected = entry;
                    break;
                }
            } catch (Exception ignored) {
                // 当前地址失败是正常切换路径，继续尝试下一条。
            }
        }

        synchronized (this) {
            current = selected;
            state = selected == null ? State.UNAVAILABLE : State.CONNECTED;
            probing = false;
            boolean changed = previous == null
                    ? selected != null
                    : selected == null || !previous.baseUrl.equals(selected.baseUrl);
            return new ProbeResult(state, current, changed, false);
        }
    }
}
