package com.dsh.miniremote;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 确认动作的唯一状态机。卡片由无障碍服务托管，动作线程只等待决定。
 *
 * 档位持久化；待确认动作、任务放行和计时器只活在内存里。进程被杀后没有旧卡可恢复，
 * 也不会把当初尚未回答的动作补做一遍。
 */
final class ConfirmationControl {
    private static final String PREFS = "mini_ui_prefs";
    private static final String MODE = "phone_confirm_mode";
    private static final long CONFIRM_MS = 30_000L;
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
        final CountDownLatch done = new CountDownLatch(1);
        volatile Decision decision;

        Pending(Card card) {
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
        final String selected = selectedMode(context);
        // 默认档的快路径：不读任务状态、不建卡、不起计时，直接和今天完全一样。
        if (ConfirmationState.OFF.equals(selected) && !state.needsExtendedDeadline(selected)) {
            return allow();
        }
        final long deadline = System.currentTimeMillis() + CONFIRM_MS;
        final long requestedEpoch;
        synchronized (LOCK) {
            requestedEpoch = epoch;
        }
        while (true) {
            Pending occupied = null;
            synchronized (LOCK) {
                if (requestedEpoch != epoch) return stopped();
                if (!BridgeControl.isArmed(context)) {
                    return failure("not_armed", "手机桥已关闭，动作未执行");
                }
                String mode = state.modeForTask(taskId, selected);
                if (mode == ConfirmationState.OFF) return allow();
                if (mode == ConfirmationState.TASK && state.taskGranted(taskId)) return allow();
                if (pending == null) {
                    Card card = new Card(id, taskId, tool, target, mode, deadline);
                    Pending created = new Pending(card);
                    pending = created;
                    occupied = created;
                    // 跳出锁后再碰 UI；监听器不存在时明确失败，不做看不见的执行。
                    if (cardListener == null) {
                        settle(created, failure("confirm_unavailable", "手机当前无法显示确认卡，动作未执行"));
                    } else {
                        MAIN.post(() -> {
                            CardListener listener = cardListener;
                            if (listener != null) listener.onCard(card);
                        });
                    }
                    return awaitDecision(created);
                }
            }
            if (!awaitSlot(occupied, deadline)) {
                if (requestedEpoch != epoch) return stopped();
                return failure("confirm_timeout", "30 秒内未确认，动作未执行");
            }
        }
    }

    static boolean answer(boolean allow) {
        Pending current;
        synchronized (LOCK) {
            current = pending;
            if (current == null) return false;
            if (allow && current.card.mode == ConfirmationState.TASK) {
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

    private static Decision awaitDecision(Pending created) {
        try {
            long remaining = Math.max(0, created.card.deadline - System.currentTimeMillis());
            if (!created.done.await(remaining, TimeUnit.MILLISECONDS)) {
                settle(created, failure("confirm_timeout", "30 秒内未确认，动作未执行"));
            }
        } catch (InterruptedException err) {
            Thread.currentThread().interrupt();
            settle(created, failure("confirm_interrupted", "确认等待被中断，动作未执行"));
        }
        return created.decision == null
                ? failure("confirm_timeout", "30 秒内未确认，动作未执行") : created.decision;
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

    /** 第一个终局生效；清卡与唤醒只发生一次。 */
    private static void settle(Pending current, Decision decision) {
        synchronized (LOCK) {
            if (pending != current) return;
            pending = null;
            current.decision = decision;
            current.done.countDown();
        }
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
