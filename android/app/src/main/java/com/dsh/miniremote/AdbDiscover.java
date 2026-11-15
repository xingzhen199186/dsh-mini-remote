package com.dsh.miniremote;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;

import java.util.ArrayList;
import java.util.List;

/**
 * 发现这台手机自己的「无线调试」入口（2026-11-15）。
 *
 * 为什么要它：自连 ADB 的第一步不是连接，而是**知道往哪儿连**。
 * 安卓的无线调试会通过 mDNS 广播两个服务：
 *   `_adb-tls-pairing._tcp`   一次性配对口（端口每次开着都可能变）
 *   `_adb-tls-connect._tcp`   配对之后的连接口
 * 系统不给我们直接读这些端口的 API，但 mDNS 是公开的，所以自己扫一遍。
 *
 * 这一步只**看**，不连、不改任何设置。配对与连接是后面两步的事。
 */
final class AdbDiscover {

    /** 系统给的这两个服务名，不是我们编的（`adb mdns services` 看到的就是它们）。 */
    static final String PAIRING = "_adb-tls-pairing._tcp";
    static final String CONNECT = "_adb-tls-connect._tcp";

    static final class Endpoint {
        final String type;
        final String host;
        final int port;

        Endpoint(String type, String host, int port) {
            this.type = type;
            this.host = host;
            this.port = port;
        }
    }

    private static final List<Endpoint> found = new ArrayList<>();
    private static String lastError = "";
    private static boolean started = false;
    private static long lastAt = 0;
    private static NsdManager manager;
    private static final List<NsdManager.DiscoveryListener> listeners = new ArrayList<>();

    private AdbDiscover() {
    }

    /** 开始扫（幂等；重复调用不会起两份）。 */
    static synchronized void start(Context context) {
        if (started) return;
        Context app = context.getApplicationContext();
        NsdManager nsd = (NsdManager) app.getSystemService(Context.NSD_SERVICE);
        if (nsd == null) {
            lastError = "这台手机不提供 mDNS 搜索";
            return;
        }
        manager = nsd;
        started = true;
        lastAt = System.currentTimeMillis();
        scan(PAIRING);
        scan(CONNECT);
    }

    private static void scan(String type) {
        NsdManager.DiscoveryListener listener = new NsdManager.DiscoveryListener() {
            @Override
            public void onStartDiscoveryFailed(String serviceType, int errorCode) {
                lastError = "搜索被系统拒绝（" + errorCode + "）";
            }

            @Override
            public void onStopDiscoveryFailed(String serviceType, int errorCode) {
            }

            @Override
            public void onDiscoveryStarted(String serviceType) {
            }

            @Override
            public void onDiscoveryStopped(String serviceType) {
            }

            @Override
            public void onServiceFound(NsdServiceInfo info) {
                resolve(info, type);
            }

            @Override
            public void onServiceLost(NsdServiceInfo info) {
                // 无线调试关掉时端口就没了：如实从清单里去掉，别留一个连不上的旧端口。
                synchronized (AdbDiscover.class) {
                    found.removeIf((one) -> type.equals(one.type) && one.port == info.getPort());
                }
            }
        };
        listeners.add(listener);
        try {
            manager.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener);
        } catch (Exception err) {
            lastError = "搜索 " + type + " 失败：" + (err.getMessage() == null ? "原因未知" : err.getMessage());
        }
    }

    private static void resolve(NsdServiceInfo info, String type) {
        try {
            manager.resolveService(info, new NsdManager.ResolveListener() {
                @Override
                public void onResolveFailed(NsdServiceInfo serviceInfo, int errorCode) {
                    lastError = "找到了端口但解析不出地址（" + errorCode + "）";
                }

                @Override
                public void onServiceResolved(NsdServiceInfo resolved) {
                    String host = resolved.getHost() == null ? "" : resolved.getHost().getHostAddress();
                    synchronized (AdbDiscover.class) {
                        found.removeIf((one) -> type.equals(one.type) && one.port == resolved.getPort());
                        found.add(new Endpoint(type, host, resolved.getPort()));
                        lastError = "";
                        lastAt = System.currentTimeMillis();
                    }
                }
            });
        } catch (Exception err) {
            lastError = "解析端口失败：" + (err.getMessage() == null ? "原因未知" : err.getMessage());
        }
    }

    /**
     * 重新扫一遍（2026-11-15）。
     *
     * 为什么需要：配对端口是**一次性的**——配对对话框关掉或超时，端口就没了，
     * 而 mDNS 缓存可能还留着旧记录。连之前重扫一次，避免拿一个死端口去连，
     * 让人以为"程序坏了"。
     */
    static synchronized void refresh(Context context) {
        Context app = context.getApplicationContext();
        if (manager != null) {
            for (NsdManager.DiscoveryListener one : listeners) {
                try {
                    manager.stopServiceDiscovery(one);
                } catch (Exception ignored) {
                }
            }
        }
        listeners.clear();
        found.clear();
        started = false;
        lastError = "";
        start(app);
    }

    /** 给界面看的一句话（自检页用）。 */
    static synchronized String describe() {
        if (lastError != null && !lastError.isEmpty()) return "无线调试口：" + lastError;
        Endpoint pairing = firstOf(PAIRING);
        Endpoint connect = firstOf(CONNECT);
        if (pairing == null && connect == null) {
            return "无线调试口：没找到（开发者选项里的「无线调试」关着时就是这样）";
        }
        StringBuilder text = new StringBuilder("无线调试口：");
        if (pairing != null) text.append("配对 ").append(pairing.port);
        if (connect != null) {
            if (pairing != null) text.append(" · ");
            text.append("连接 ").append(connect.port);
        }
        return text.toString();
    }

    private static Endpoint firstOf(String type) {
        for (Endpoint one : found) if (type.equals(one.type)) return one;
        return null;
    }

    /** 诊断用：当前找到的全部端口。 */
    static synchronized List<Endpoint> snapshot() {
        return new ArrayList<>(found);
    }

    /** 上次扫到东西的时间（0 表示还没扫到过）。 */
    static synchronized long lastSeenAt() {
        return lastAt;
    }
}
