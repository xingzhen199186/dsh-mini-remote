package com.dsh.miniremote;

/**
 * 三档确认的任务级状态；不碰 UI、网络或计时器。
 *
 * 当前任务选定后固定使用当时的档位。用户改设置只影响下一个 taskId，
 * 避免同一轮动作执行到一半突然换规则。
 */
final class ConfirmationState {
    static final String OFF = "off";
    static final String TASK = "task";
    static final String EACH = "each";

    private String activeTaskId;
    private String activeMode = OFF;
    private boolean taskGranted;

    synchronized String modeForTask(String taskId, String selectedMode) {
        String selected = normalize(selectedMode);
        if (taskId == null || taskId.isEmpty()) {
            // 没有轮次编号时不能把不同动作并入一个“永远不用再问”的任务。
            return selected;
        }
        if (!taskId.equals(activeTaskId)) {
            activeTaskId = taskId;
            activeMode = selected;
            taskGranted = false;
        }
        return activeMode;
    }

    synchronized void grantCurrentTask(String taskId) {
        if (taskId != null && !taskId.isEmpty() && taskId.equals(activeTaskId)) {
            taskGranted = true;
        }
    }

    synchronized boolean taskGranted(String taskId) {
        return taskId != null && !taskId.isEmpty() && taskId.equals(activeTaskId) && taskGranted;
    }

    /** 当前任务和下一轮都免确认时，电脑侧才保持原来的调用时限。 */
    synchronized boolean needsExtendedDeadline(String selectedMode) {
        return normalize(selectedMode) != OFF || activeMode != OFF;
    }

    synchronized void clear() {
        activeTaskId = null;
        activeMode = OFF;
        taskGranted = false;
    }

    static String normalize(String mode) {
        return TASK.equals(mode) || EACH.equals(mode) ? mode : OFF;
    }
}
