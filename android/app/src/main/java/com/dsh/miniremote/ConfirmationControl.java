package com.dsh.miniremote;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 确认动作的唯一状态机。通知是唯一确认入口，浮层只做展示。
 *
 * 档位持久化；待确认动作、任务放行和计时器只活在内存里。进程被杀后没有旧卡可恢复，
 * 也不会把当初尚未回答的动作补做一遍。
 */
final class ConfirmationControl {
    private static final String PREFS = "mini_ui_prefs";
    private static final String MODE = "phone_confirm_mode";
    /**
     * 30 秒对人太短（2026-11-11 用户反馈：人在外面，看到卡点开就过去了）。
     * 90 秒给足掏手机、看清文字、按下去的时间；电脑侧相应放宽到 130 秒。
     */
    private static final long CONFIRM_MS = 90_000L;
    private static final Object LOCK = new Object();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final ConfirmationState state = new ConfirmationState();

    private static volatile CardListener cardListener;
    private static Pending pending;
    private static volatile long epoch;

    interface CardListener {
        void onCard(Card card);
        void onCardClosed();
    }

    /** 等待期间的外部叫停条件（例如手机桥被关掉、这一代轮询已经作废）。 */
    interface Abort {
        boolean aborted();
    }

    static final class Card {
        final String id;
        final String taskId;
        final String tool;
        final String target;
        final String mode;
        final long deadline;

        Card(String id, String taskId, String tool, String target, String mode, long deadline) {
            this.id = id;
            this.taskId = taskId;
            this.tool = tool;
            this.target = target;
            this.mode = mode;
            this.deadline = deadline;
        }

        /** 卡上那句解释“这次问了之后还算不算数”，避免用户以为按了允许就永久放行。 */
        String modeText() {
            if (ConfirmationState.TASK.equals(mode)) return "只影响本轮任务，下一轮会重新询问。";
            return "每执行一次都会问一次。";
        }

        /** 动作说人话；通知正文和浮层共用同一句，两个入口不许各说各的。 */
        String actionText() {
            switch (tool) {
                case "phone_tap": return "点一下屏幕上这个控件";
                case "phone_open": return "打开一个 App";
                case "phone_notify": return "发一条通知";
                case "phone_swipe": return "滑动屏幕";
                case "phone_back": return "按返回键";
                case "phone_input": return "往输入框里填字";
                case "phone_screenshot": return "截一张屏";
                case "phone_observe": return "读一次屏幕文字";
                case "phone_wake": return "点亮屏幕";
                case "phone_send_file": return "把一个文件存到手机";
                default: return "执行 " + tool;
            }
        }

        /** 通知正文：动作 + 打码后的目标，不含输入正文和截图。 */
        String bodyText() {
            String head = actionText();
            if (target != null && !target.isEmpty()) head = head + "：" + target;
            return head + "\n" + modeText();
        }
    }

    static final class Decision {
        final boolean allowed;
        final boolean executed = false;
        final String reason;
        final String error;

        Decision(boolean allowed, String reason, String error) {
            this.allowed = allowed;
            this.reason = reason;
            this.error = error;
        }
    }

    private static final class Pending {
        final Card card;
        final Context app;
        final CountDownLatch done = new CountDownLatch(1);
        volatile Decision decision;

        Pending(Context app, Card card) {
            this.app = app;
            this.card = card;
        }
    }

    private ConfirmationControl() {
    }

    static String selectedMode(Context context) {
        return ConfirmationState.normalize(context.getApplicationContext()
                .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(MODE, ConfirmationState.OFF));
    }

    /** 只改下一轮使用的档位；当前任务仍由 ConfirmationState 里那份固定档位回答。 */
    static void setSelectedMode(Context context, String mode) {
        context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(MODE, ConfirmationState.normalize(mode)).apply();
    }

    static boolean needsExtendedDeadline(Context context) {
        return state.needsExtendedDeadline(selectedMode(context));
    }

    static void setCardListener(CardListener listener) {
        cardListener = listener;
    }

    static void clearCardListener(CardListener listener) {
        if (cardListener == listener) cardListener = null;
    }

    static Card currentCard() {
        synchronized (LOCK) {
            return pending == null ? null : pending.card;
        }
    }

    /** 同一时刻只让一张卡占住执行口；另一动作等自己的原期限，不叠卡也不加长时间。 */
    static Decision request(Context context, String id, String taskId, String tool, String target) {
        return request(context, id, taskId, tool, target, () -> false);
    }

    static Decision request(Context context, String id, String taskId, String tool, String target,
                            Abort abort) {
        final Context app = context.getApplicationContext();
        final String selected = selectedMode(app);
        // 默认档的快路径：不读任务状态、不建卡、不起计时，直接和今天完全一样。
        if (ConfirmationState.OFF.equals(selected) && !state.needsExtendedDeadline(selected)) {
            return allow();
        }
        // 通知被系统关掉时，确认根本没法问出口：立刻如实失败，不能挂着空等 90 秒。
        if (!Notifier.canPostConfirm(app)) {
            return failure("confirm_unavailable", "手机没允许发通知，确认卡显示不出来，动作未执行");
        }
        final long deadline = System.currentTimeMillis() + CONFIRM_MS;
        final long requestedEpoch = epoch;
        while (true) {
            Pending occupied = null;
            synchronized (LOCK) {
                if (requestedEpoch != epoch) return stopped();
                if (!BridgeControl.isArmed(app)) {
                    return failure("not_armed", "手机桥已关闭，动作未执行");
                }
                String mode = state.modeForTask(taskId, selected);
                if (mode == ConfirmationState.OFF) return allow();
                if (mode == ConfirmationState.TASK && state.taskGranted(taskId)) return allow();
                if (pending == null) {
                    Card card = new Card(id, taskId, tool, target, mode, deadline);
                    Pending created = new Pending(app, card);
                    pending = created;
                    occupied = created;
                    // 通知是唯一确认入口；浮层只是“有东西在等你”的展示。
                    if (!Notifier.showConfirmCard(app, card)) {
                        settle(created, failure("confirm_unavailable",
                                "确认通知发不出来，动作未执行"));
                    } else {
                        MAIN.post(() -> {
                            CardListener listener = cardListener;
                            if (listener != null) listener.onCard(card);
                        });
                    }
                    return awaitDecision(created, abort);
                }
            }
            if (!awaitSlot(occupied, deadline)) {
                if (requestedEpoch != epoch) return stopped();
                return failure("confirm_timeout", "90 秒内未确认，动作未执行");
            }
        }
    }

    /**
     * 用户点了通知上的按钮。**只认当前这一张卡**：旧通知、连点第二次都不作数，
     * 所以同一个动作不可能被执行两遍。
     */
    static boolean answerCard(String cardId, boolean allow, boolean grantTask) {
        Pending current;
        synchronized (LOCK) {
            current = pending;
            if (current == null) return false;
            if (cardId == null || !cardId.equals(current.card.id)) return false;
            if (allow && grantTask && current.card.mode == ConfirmationState.TASK) {
                state.grantCurrentTask(current.card.taskId);
            }
            settle(current, allow ? allow() : failure("user_rejected", "用户拒绝了这次操作，动作未执行"));
            return true;
        }
    }

    /** B1 停止复用这里：当前卡与正在等卡的线程一起结束，之后的回执不能再执行。 */
    static void cancelAll() {
        Pending current;
        synchronized (LOCK) {
            epoch++;
            state.clear();
            current = pending;
            if (current != null) settle(current, stopped());
        }
    }

    /**
     * 分段等：每 200 毫秒醒一次，让“桥被关掉”能立刻收尾。
     * 一口气等 90 秒的话，停止之后这条线程还要吊到超时才退出。
     */
    private static Decision awaitDecision(Pending created, Abort abort) {
        try {
            while (System.currentTimeMillis() < created.card.deadline) {
                long left = created.card.deadline - System.currentTimeMillis();
                if (created.done.await(Math.min(200L, Math.max(1L, left)), TimeUnit.MILLISECONDS)) {
                    break;
                }
                if (abort != null && abort.aborted()) {
                    settle(created, stopped());
                    break;
                }
            }
            if (created.decision == null && System.currentTimeMillis() >= created.card.deadline) {
                settle(created, failure("confirm_timeout", "90 秒内未确认，动作未执行"));
            }
        } catch (InterruptedException err) {
            Thread.currentThread().interrupt();
            settle(created, stopped());
        }
        return created.decision == null
                ? failure("confirm_timeout", "90 秒内未确认，动作未执行") : created.decision;
    }

    private static boolean awaitSlot(Pending occupied, long deadline) {
        try {
            long remaining = Math.max(0, deadline - System.currentTimeMillis());
            return occupied.done.await(remaining, TimeUnit.MILLISECONDS);
        } catch (InterruptedException err) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    /** 第一个终局生效；撤通知、清卡与唤醒只发生一次。 */
    private static void settle(Pending current, Decision decision) {
        synchronized (LOCK) {
            if (pending != current) return;
            pending = null;
            current.decision = decision;
            current.done.countDown();
        }
        Notifier.cancelConfirmCard(current.app, current.card.id);
        MAIN.post(() -> {
            CardListener listener = cardListener;
            if (listener != null) listener.onCardClosed();
        });
    }

    private static Decision allow() {
        return new Decision(true, "", "");
    }

    private static Decision stopped() {
        return failure("stopped_by_user", "用户停止了手机桥，动作未执行");
    }

    private static Decision failure(String reason, String error) {
        return new Decision(false, reason, error);
    }
}
