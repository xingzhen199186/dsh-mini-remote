package com.dsh.miniremote;

import android.accessibilityservice.AccessibilityService;
import android.view.accessibility.AccessibilityEvent;

/**
 * bridge 构建版本的无障碍服务空壳。
 * P3 通过闸门评审后，才在这里接入设备桥指令与手机操作实现；P1 不处理任何事件。
 */
public final class BridgeAccessibilityService extends AccessibilityService {
    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // P3：接 phone-hub 指令分发与操作结果回执，当前阶段保持空实现。
    }

    @Override
    public void onInterrupt() {
        // P3：清理被系统中断的操作状态，当前阶段没有状态需要清理。
    }
}
