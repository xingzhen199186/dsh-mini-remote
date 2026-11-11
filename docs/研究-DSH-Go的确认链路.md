# 研究：DSH Go 的「确认」是怎么做的

> 2026-11-11。对象：`I:\DSH\dsh go\dsh-Go-main`，重点看
> `phone/a11y/ControlOverlay.kt`（浮层门）与 `phone/NotificationGate.kt`（通知门）。
> 目的：对照我们两天里踩到的三个坑——浮层不可点、通知按钮无响应、点完回 App 卡死。

---

## 一、总结构：两扇门，一套等待

```
用户要确认
   ↓
promptGate（无障碍浮层）——能显示就用它
   ↓ 显示失败/不可用
notificationGate（通知按钮）——系统画的按钮，一定能点
   ↓ 也不可用
直接拒绝（UNAVAILABLE / DENY）
```

两扇门都实现同一个 `UserGate` 接口，调用方不关心是哪一个。

**关键点**：它不是"选一个入口"，而是**带降级的两个入口**，且**降级判断是明确回执**：

```kotlin
val shown = onMain(1_500) { showConfirm(request, pending) } == true
if (!shown) { ...退到通知门... }
```

浮层"弹出来"这件事，**要在 1.5 秒内拿到明确答复**；拿不到就当没弹出来。**我们这边是"发布就算成功"，差别就在这。**

---

## 二、主线程是禁区

```kotlin
if (Looper.myLooper() == Looper.getMainLooper()) {
    Log.w(TAG, "confirm() on the main thread: denied")
    return Decision.DENY
}
```

**发现自己在主线程上就拒绝，不等待。**

等待只发生在工作线程：

```kotlin
latch.await(timeoutMs, TimeUnit.MILLISECONDS)   // NotificationGate 第 242 行
pending.await(request.timeoutMs + 1_500)        // 浮层门，超时留 1.5 秒余量
```

原作者注释写得很直白：*"Native confirm/handoff wait on their bridge worker"*。

---

## 三、通知门：六个细节，每个都值得抄

### 1. 每次提问用一个随机私有 action

```kotlin
val action = "${app.packageName}.PHONE_GATE." + PhoneBridge.hex(16)
```

接收器也是**动态注册**的，只在这个问题活着的期间存在：

```kotlin
app.registerReceiver(receiver, IntentFilter(action), Context.RECEIVER_NOT_EXPORTED)
```

**旧通知上的按钮不会命中新的提问**——action 每次都不一样。

### 2. PendingIntent 的 requestCode 唯一

```kotlin
PendingIntent.getBroadcast(app, id * 8 + code, Intent(action).setPackage(app.packageName)...)
```

`id` 每题自增，`code` 是按钮序号。**同一题的两个按钮不会互相顶掉。**

### 3. 划掉通知 = 拒绝，用 deleteIntent 表达

```kotlin
.setDeleteIntent(pending(dismissed, 7))   // dismissed 传 "deny"
```

**系统会自动把"被划掉"当成一次回答**，不需要额外监听。

### 4. 到点由系统撤，不用自己起定时器

```kotlin
if (Build.VERSION.SDK_INT >= O) b.setTimeoutAfter(timeoutMs)
```

**计时交给通知系统**——进程被冻住也不影响它按时消失。

### 5. 答案只认第一次

```kotlin
if (answer.compareAndSet(null, intent.getStringExtra(EXTRA_CHOICE))) latch.countDown()
```

连点两下、两个按钮同时到达，都只算一次。

### 6. 收尾放在 finally，且在工作线程上

```kotlin
} finally {
    runCatching { app.unregisterReceiver(receiver) }
    nm.cancel(TAG, id)
}
```

**撤通知是系统调用，但它发生在 await 返回之后的同一线程**，不在主线程、也不在持锁状态下。

---

## 四、可用性先检查，不可用立刻失败

```kotlin
fun available(): Boolean = runCatching {
    ensureChannel()
    channelAvailable(CHANNEL_CONFIRM, IMPORTANCE_HIGH)
}.getOrDefault(false)

// channelAvailable 里逐项检查：
// 通知总开关、渠道是否存在、importance 是否 >= HIGH、渠道组是否被屏蔽
```

不可用就返回 `UNAVAILABLE`，**不挂满超时**。我们缺这一步，于是"发不出去"会表现成"等超时"。

---

## 五、通知被划掉会重发

`handoff` 场景里它会重发最多三次：

```kotlin
repeat(3) {
    val left = deadline - System.currentTimeMillis()
    if (left <= 0) return TIMEOUT
    when (ask(..., ongoing = true)) { ... }
}
```

**因为对某些场景来说，按钮是唯一回答途径**，划掉就等于没回答。`confirm` 场景则不重发（划掉即拒绝）。

---

## 六、我们三天的三个坑，对照结论

| 我们的现象 | 上面哪一条没做到 |
|---|---|
| 浮层能画、点不动 | 没有"显示成不成"的回执；也没有降级门 |
| 通知按钮点了没反应 | 答案只认一次、随机 action、动态注册都缺；`setPackage` 也没写 |
| 点完回 App 卡死 | **在锁里做系统调用**（撤通知），且在可能被主线程触及的路径上 |
| 一律等满超时 | 没有 `available()` 预检查；失败被表现成超时 |

---

## 七、照抄清单（按优先级）

1. **主线程绝不等**：进入确认前先判 `isMainThread`，是就转工作线程或直接拒绝；
2. **系统调用不许在锁里**：撤通知、注销接收器，都放到等待返回之后；
3. **答案只认第一次**：`AtomicReference.compareAndSet` + `CountDownLatch(1)`；
4. **每题一个随机 action + 动态注册的私有接收器**；
5. **deleteIntent = 拒绝；setTimeoutAfter = 超时**，交给系统；
6. **可用性预检**：通知开关/渠道/importance，不可用立刻失败；
7. **降级链**：浮层 → 通知 → 拒绝，每层都有明确判定。

**唯一不抄的**：它把等待阻塞在工作线程上。我们这边工作线程同时兼任心跳与轮询，**必须先做"收发与执行分离"**，否则抄了也白搭。
