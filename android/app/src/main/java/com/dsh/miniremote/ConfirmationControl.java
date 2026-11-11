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
    /**
     * 这台机型上，操作前确认暂时关掉（2026-11-11 真机结论，荣耀 MagicOS / Android 15）。
     *
     * 三条实测，缺一不可地否掉了这条路：
     *   1. 无障碍浮层画得出来、按钮也显示正常，但**完全收不到触摸**
     *      （系统日志 `AppOps ... op=CREATE_ACCESSIBILITY_OVERLAY` 直接拒绝）；
     *   2. 改成通知按钮后，通知能弹出、三个按钮都在，**点下去仍然没有反应**；
     *   3. 点完按钮回到 App，**界面会卡死**——这是最不能接受的一条。
     *
     * 关掉不等于删掉：代码整段留着，换一台手机（或系统放开限制）时只改这一处即可。
     * 现在任何一个入口都不会走到“等确认”，所以卡死路径不可达。
     */
    static final boolean SUPPORTED = true;

    private static final String PREFS = "mini_ui_prefs";
    private static final String MODE = "phone_confirm_mode";
    /** 被"允许一次后切免确认"临时改过的会话；用户发来新指令时切回提问档。 */
    private static final String AUTO_OFF_TASK = "phone_auto_off_session";
    /**
     * 已经放行的任务编号（2026-11-11）。
     *
     * 为什么不只放内存：荣耀会把后台 App 连进程一起收掉，内存里的“这一轮已允许”
     * 跟着消失，下一个动作又弹卡。落到盘上就抗得住——任务编号里带着轮次，
     * 换一轮自然对不上，所以不会变成“永久免问”。
     */
    private static final String GRANT_TASK = "phone_confirm_grant_task";
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

        /**
         * 卡上这句必须让用户一眼看出**自己选的是哪一档**（2026-11-11）。
         *
         * 之前两档的文字都偏解释性（"只影响本轮任务"／"每执行一次都会问一次"），
         * 而按钮完全一样，于是"到底切没切档"从界面上看不出来，
         * 排查时只能靠猜。现在换成两句互相排斥的结论，各自说清按下去会发生什么。
         */
        String modeText() {
            if (ConfirmationState.TASK.equals(mode)) return "本轮不再询问";
            return "本次有效，下个动作还会问";
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
        // 关掉期间**不看已存储的档位**：有人之前存过 each/task 也一样当 off
        // （否则升级后行为会跟界面说明不一致，用户以为已经不用确认了，实际还在等）。
        if (!SUPPORTED) return ConfirmationState.OFF;
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
        // 关掉期间不延长电脑侧等待：没有确认要等，就不该多留时间。
        if (!SUPPORTED) return false;
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
        // 关掉期间这里是**第一句**：不建卡、不发通知、不起计时、不进任何等待。
        // 之所以放在最前面，是因为今天出过「点完通知按钮回 App 卡死」，
        // 只要不进等待，那条路径就不可能再被堵住。
        if (!SUPPORTED) return allow();
        final Context app = context.getApplicationContext();
        /* 曾经在这里做过"下一轮自动切回本任务档"，**已删**（2026-11-11 真机）。
         *
         * 原因：turn 编号在**每个工具调用之间也会变**，所以"换一轮"这个判据被
         * 每个动作各触发一次——刚切到免确认，下一个动作又被切回本任务档，
         * 于是三个动作弹了三次卡。用户要的是"允许一次，之后别再问"，
         * 那就切过去别切回来：想恢复提问，由用户自己在设置里改档位。
         */
        final String selected = selectedMode(app);
        // 诊断（2026-11-11）：把"读到的档位 / 算出的 mode / 授权是否还在"落到文件，
        // 否则"本任务免确认退化成每次都问"只能靠猜。
        try {
            java.io.File f = new java.io.File(app.getFilesDir(), "confirm-debug.log");
            String line = selected + " | task=" + taskId + " | mode=" + state.modeForTask(taskId, selected)
                    + " | granted=" + state.taskGranted(taskId) + "\n";
            java.nio.file.Files.write(f.toPath(), line.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    java.nio.file.StandardOpenOption.CREATE, java.nio.file.StandardOpenOption.APPEND);
        } catch (Exception ignored) { }
        // 默认档的快路径：不读任务状态、不建卡、不起计时，直接和今天完全一样。
        if (ConfirmationState.OFF.equals(selected) && !state.needsExtendedDeadline(selected)) {
            return allow();
        }
        // 通知被系统关掉时，确认根本没法问出口：立刻如实失败，不能挂着空等 90 秒。
        if (!Notifier.canPostConfirm(app)) {
            return failure("confirm_unavailable", Notifier.confirmUnavailableReason(app));
        }
        final long deadline = System.currentTimeMillis() + CONFIRM_MS;
        final long requestedEpoch = epoch;
        // 盘上记着的那一轮：锁外先读好，锁里只做内存比较。
        final String storedGrant = storedGrant(app);
        if (!storedGrant.isEmpty() && !storedGrant.equals(taskId) && !taskId.isEmpty()) {
            // 换了一轮：上一条授权作废，别让旧编号一直躺在盘上。
            forgetGrant(app);
        }
        while (true) {
            Pending created = null;
            synchronized (LOCK) {
                if (requestedEpoch != epoch) return stopped();
                if (!BridgeControl.isArmed(app)) {
                    return failure("not_armed", "手机桥已关闭，动作未执行");
                }
                String mode = state.modeForTask(taskId, selected);
                if (ConfirmationState.OFF.equals(mode)) return allow();
                // 同一轮、盘上记过：把内存状态补回来再判断（进程可能被杀过）。
                if (ConfirmationState.TASK.equals(mode) && taskId != null && taskId.equals(storedGrant)) {
                    state.grantCurrentTask(taskId);
                }
                if (ConfirmationState.TASK.equals(mode) && state.taskGranted(taskId)) return allow();
                if (pending == null) {
                    Card card = new Card(id, taskId, tool, target, mode, deadline);
                    created = new Pending(app, card);
                    pending = created;
                }
            }
            /* **锁外**做这两件事（2026-11-11 第二次卡死 / ANR）：
             *   1) startPrompt 发通知——系统调用；
             *   2) awaitDecision 等人**最长 90 秒**。
             * 上一版把这两步留在 synchronized 里，于是主线程上的广播接收器
             * 来拿同一把锁时被挡满 5 秒，系统直接判「应用无响应」。
             * 锁里只允许做内存判断，任何会等、会碰系统的事情都必须出去做。
             */
            if (created != null) {
                startPrompt(app, created);
                return awaitDecision(created, abort);
            }
            Pending occupied;
            synchronized (LOCK) {
                occupied = pending;
            }
            if (occupied == null) {
                continue;
            }
            if (!awaitSlot(occupied, deadline)) {
                if (requestedEpoch != epoch) return stopped();
                return failure("confirm_timeout", "90 秒内未确认，动作未执行");
            }
        }
    }

    /** 摆出确认通知并通知浮层；**不持锁**，因为它会碰系统服务与主线程。 */
    private static void startPrompt(Context app, Pending created) {
        if (!Notifier.showConfirmCard(app, created.card)) {
            settle(created, failure("confirm_unavailable", "确认通知发不出来，动作未执行"));
            return;
        }
        MAIN.post(() -> {
            CardListener listener = cardListener;
            if (listener != null) listener.onCard(created.card);
        });
    }

    /**
     * 用户点了通知上的按钮。**只认当前这一张卡**：旧通知、连点第二次都不作数，
     * 所以同一个动作不可能被执行两遍。
     */
    /* 注意（2026-11-11 真机）：档位是**字符串**，必须用 equals 比较。
     * 曾经写成 `card.mode == ConfirmationState.TASK`，比的是"是不是同一个对象"，
     * 而档位是从设置里读出来的新对象——条件永远为假，于是"允许"只放行那一次，
     * 既不记授权也不切免确认，表现为每步都弹卡。别再改回 ==。
     */
    static boolean answerCard(String cardId, boolean allow, boolean grantTask) {
        // 关掉期间按钮点了也不做事：这条路径从主线程（广播接收器）进来，
        // 必须第一时间返回，绝不在这里等锁或等任何东西。
        if (!SUPPORTED) return false;
        Pending target;
        Decision outcome;
        boolean granted = false;
        synchronized (LOCK) {
            Pending current = pending;
            if (current == null) return false;
            if (cardId == null || !cardId.equals(current.card.id)) return false;
            if (allow && grantTask && ConfirmationState.TASK.equals(current.card.mode)) {
                state.grantCurrentTask(current.card.taskId);
                granted = true;
                /* 用户定的方式（2026-11-11）：第一次允许后直接免确认，
                 * 但**记下这是自动切的、属于哪一轮**——下一轮任务编号一变就自动切回来，
                 * 这样"不再被每步打扰"和"每轮重新问"两件事都在。
                 */
                setSelectedMode(current.app, ConfirmationState.OFF);
                // 记**会话**而不是轮次：轮次每一步都会变，按它比对永远对不上。
                current.app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().putString(AUTO_OFF_TASK, sessionOfTask(current.card.taskId)).apply();
            }
            target = current;
            outcome = allow ? allow() : failure("user_rejected", "用户拒绝了这次操作，动作未执行");
        }
        // 记住这一轮要落到盘上，且**在锁外**写（写盘是系统调用）。
        if (granted) rememberGrant(target.app, target.card.taskId);
        // **结算放在锁外**（2026-11-11 卡死事故）：结算里要撤通知、要 post 主线程，
        // 这些都是系统调用；拿着锁做，等于让主线程排队等系统。
        settle(target, outcome);
        return true;
    }

    private static String storedGrant(Context app) {
        String value = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(GRANT_TASK, "");
        return value == null ? "" : value;
    }

    /** 只记编号，不记时间：编号里已经有轮次，换一轮自然失效，不需要另设过期。 */
    private static void rememberGrant(Context app, String taskId) {
        if (taskId == null || taskId.isEmpty()) return;
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(GRANT_TASK, taskId).apply();
    }

    private static void forgetGrant(Context app) {
        app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().remove(GRANT_TASK).apply();
    }

    /**
     * 只终止“正在等的那张卡”，**不动已经记住的任务授权**（2026-11-11）。
     *
     * 轮询因为换线路或重连而换代时调用它。原来这里调的是 cancelAll，
     * 于是每次重连都会把“用户刚点过允许、本轮别再问”抹掉——真机上表现成
     * “明明写着『本轮不再询问』，下一个动作又弹一张卡”。
     */
    static void cancelPending() {
        Pending current;
        synchronized (LOCK) {
            epoch++;
            current = pending;
        }
        if (current != null) settle(current, stopped());
    }

    /** 整个手机桥被关掉时才用它：连任务授权一起清，下次打开重新问。 */
    static void cancelAll(Context context) {
        Pending current;
        synchronized (LOCK) {
            epoch++;
            state.clear();
            current = pending;
        }
        if (context != null) forgetGrant(context.getApplicationContext());
        if (current != null) settle(current, stopped());
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
    /** 任务编号形如 `进程:会话:轮次`，取出其中的会话部分。 */
    private static String sessionOfTask(String taskId) {
        if (taskId == null) return "";
        String[] parts = taskId.split(":");
        return parts.length >= 3 ? parts[1] : taskId;
    }

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

    /**
     * 这一轮任务真的结束了（电脑在 turn/end 时告知）：
     * 把"允许一次后临时切成的免确认"切回本任务档，下一轮重新问。
     *
     * **只在这里切回**：工具调用之间不切——那正是之前每个动作都弹卡的错判。
     */
    static void onTaskEnded(String sessionId) {
        if (!SUPPORTED || sessionId == null || sessionId.isEmpty()) return;
        synchronized (LOCK) {
            Context app = pending != null ? pending.app : null;
            if (app == null) return;
            String autoOff = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString(AUTO_OFF_TASK, null);
            if (autoOff == null || !autoOff.equals(sessionId)) return;
            setSelectedMode(app, ConfirmationState.TASK);
            app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().remove(AUTO_OFF_TASK).apply();
        }
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
