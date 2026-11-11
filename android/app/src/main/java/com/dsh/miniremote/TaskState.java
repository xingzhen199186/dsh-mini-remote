package com.dsh.miniremote;

/**
 * 电脑那边"有没有任务在跑"（2026-11-12 用户要求）。
 *
 * 停止浮层原先只要"离开我们的 App"就出现，于是平时浏览别的东西也一直挂着一个红按钮。
 * 现在由电脑在每次心跳里告知任务是否在跑，浮层**只在任务进行中出现**。
 *
 * 这个类放在主包里、只有两个静态字段：桥的轮询线程写，无障碍浮层读，
 * 两边不需要互相引用（浮层在另一个 flavor 里）。
 */
final class TaskState {
    private TaskState() {
    }

    /** 电脑上的任务是否正在执行。 */
    static volatile boolean busy;
}
