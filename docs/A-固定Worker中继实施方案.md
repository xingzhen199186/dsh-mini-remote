# A：固定 Worker 中继实施方案

> 状态：设计评审稿，2026-10-27。只做方案，不代表 Worker 已上线。
>
> 目标：用户不准备 Cloudflare 账号、域名或服务器，也能用固定地址访问本插件；插件仍运行 quick tunnel，我方 Worker 把固定子域名映射到当前临时地址。
>
> 证据口径：**[仓库证据]** 指可直接定位到源码/文档；**[工程推断]** 指本方案的设计或估算，需开发、压测和真机验证。参考项目的本地 clone 未包含 Worker；其远端 GitHub `main` 已提供 `market/worker`，本稿已于 2026-10-27 追加核对。真实套餐/账单信息仍未提供。

## 0. 结论先行

A 可行，但它不是“免费换一个固定域名”这么简单，而是新增一个由我方运营的公共代理服务：

- 用户得到固定 Origin，重启 quick tunnel 后不必因临时域名变化而重新配对。
- 我方承担注册表、代理、滥用治理、请求配额、隐私告知、监控和故障响应。
- Worker 能看到明文流量，A 不是端到端加密；应用层口令、设备撤销仍在插件，不能交给 Worker 代替。
- 建议采用 **D1 管身份与撤销、KV 管短期目标、Cache API 只做节点内短缓存**。数据面不能每请求写 KV 或 D1。
- Free 阶段必须邀请制并保留裸 quick tunnel 回退；未完成限流、日志脱敏和撤销验证前，不公开开放注册。
- C 继续保留给愿意管理自己 Cloudflare 账号和域名的用户；A 不替代 C，也不与 B 混为一体。

---

## 1. 参考项目实际做法

### 1.1 有源码证据的行为

| 主题 | 参考项目做法 | 证据 |
|---|---|---|
| id / secret | 每个 profile 首次生成 8 字节随机 id，编码为 16 位 hex；32 字节 secret 编码为 base64url。id 是 64 位随机量，secret 是 256 位随机量。 | `src/relay-registry.ts:59-65`；格式断言见 `tests/relay-registry.spec.ts:92-98` |
| 本地持久化 | 每个 profile 一个 JSON，位于 `$DSH_HOME/remote-web-ui-registry/`；文件名校验为单一安全路径段，写入模式 `0600`。损坏文件会重新生成身份，旧固定 Origin 因而改变。 | `src/relay-registry.ts:51-57,68-91`；`tests/relay-registry.spec.ts:101-129` |
| 固定子域名 | 固定入口是 `https://<id>.dsh-market.com`；注释明确只用一层子域，避免超出 Universal SSL 单层覆盖。 | `src/relay-registry.ts:18-29,117-123` |
| 首次登记与续登记 | 首次请求带 `new_secret`；已成功登记后只带 `secret`。续登记不能凭一个新 secret 抢占已存在的 id。 | `src/relay-registry.ts:31-42,94-102,159-186`；`tests/relay-registry.spec.ts:138-160` |
| 注册接口 | 客户端向固定 Worker 端点 `PUT /api/relay/register` 发送 id、secret、target；成功后二维码使用固定入口。 | `src/relay-registry.ts:18-20,159-186` |
| 注销接口 | 关闭 relay 时向 `POST /api/relay/unregister` 发送 id 和 secret；调用侧吞掉失败，不阻塞本地停用。 | `src/relay-registry.ts:104-115,201-204`；`src/index.ts:468-479` |
| 注销边界 | 只有明确关闭 relay 才删除映射；普通 teardown 或切换模式保留映射，让手机看到离线状态并复用原身份。 | `src/index.ts:468-479` |
| 重试 | 注册失败后按 5 秒起步、最高 60 秒的指数退避重试；`dispose()` 取消定时器。登记成功后清零失败计数。 | `src/relay-registry.ts:181-197,206-230`；`tests/relay-registry.spec.ts:162-177,199-217` |
| 注册表丢行恢复 | 非 fresh 身份收到 `invalid-params` 后，下次重试重新带 `new_secret`；403 不这样处理。 | `src/relay-registry.ts:187-197`；`tests/relay-registry.spec.ts:179-197` |
| 与 quick 生命周期接线 | quick tunnel 进入 running 且有 URL 时注册；同一 target 去重。命名隧道不经过 relay。 | `src/index.ts:505-520,887-915` |
| 失败回退 | 首次注册不可达时，不阻塞 quick tunnel，二维码回退为裸临时 URL；已成功的固定 Origin 在一次刷新失败时保留，而不是立刻换源。 | `src/relay-registry.ts:6-10`；`src/index.ts:481-503`；`README.zh.md:90-96` |
| Host 处理 | 参考项目认为 Worker `fetch` 会把上游 Host 固定为 URL authority，因此在 cloudflared 上设置 `--http-host-header=<固定中继 Host>`，让本机看到稳定 Host。切换 relay 会改变 tunnel target 并重启连接器。 | `src/index.ts:916-930`；`src/tunnel.ts:270-282,323-336`；`tests/tunnel.spec.ts:431-444,509-517` |
| 隧道健康 | 每 60 秒探测公网 URL，连续两次失败后走重启路径；新 quick URL 再触发注册。401/403 被视为已经到达源站，5xx 被视为不健康。 | `src/tunnel.ts:118-149,252-257,504-555`；`tests/tunnel.spec.ts:265-407` |
| 配对关系 | 二维码的 base 在裸 quick、固定 relay、命名隧道之间选择；固定 Origin 让书签和 Cookie 跨重启保留。配对令牌有 TTL，设备会话另有持久化与空闲过期。 | `src/index.ts:447-519`；`src/index.ts:95-107,248-260`；`README.zh.md:88-108,183-192` |

补充边界：

- 参考客户端只在 tunnel start、target 变化和失败重试时 `announce`，没有周期性心跳；其 Worker 用 90 天 `last_seen_at` 做 GC，不是 45 分钟短 TTL。[客户端证据：`src/relay-registry.ts:125-230`；Worker 证据：`market/worker/src/relay.js:pruneRelay`]
- 注册请求未见显式超时或 `AbortSignal`；其注销封装也未检查 `response.ok`。这是客户端现状，不应原样复制。[仓库证据：`src/relay-registry.ts:104-115,159-198`]
- `tests/tunnel-plan.spec.ts:22-55` 证明 quick 优先于 named，named 必须有 token 和有效固定 URL；它验证的是模式选择，不验证 Worker。
- `tests/tunnel.spec.ts` 使用注入的进程、计时器和网络替身，证明生命周期策略，不证明真实 Cloudflare 中继行为。[仓库证据：该文件 `1-9,63-98`]

### 1.2 远端 Worker 实现（2026-10-27 GitHub 核对）

本地 clone 没有 `market/worker`，但远端 GitHub `main` 有完整 Worker 源码：

- `market/worker/src/relay.js`：A 的 quick 中继；
- `market/worker/src/relay-control.js`：命名隧道 lease（B 形态）；
- `market/worker/src/relay-bridge.js`：Durable Object 桥接；
- `market/worker/wrangler.jsonc`：D1、DO、cron、通配路由；
- `market/worker/migrations/0007_relay_registry.sql`、`0009_relay_leases.sql`、`0010_relay_lease_mode.sql`。

#### A 的 quick 中继实际做法

| 主题 | 实际实现 | 证据 |
|---|---|---|
| 数据面存储 | 每个请求直接查 D1 `relay_registrations`；没有 KV/Cache 作为注册表缓存。 | `relay.js:handleRelayProxy` |
| 表结构 | `relay_registrations(id, secret_hash, target, registered_at, last_seen_at)` + `relay_rate_limit(bucket, window_start, count)`。 | `0007_relay_registry.sql` |
| target 校验 | 只接受 `https://*.trycloudflare.com`，且 pathname 必须 `/`、无 query、无 userinfo、无端口。 | `relay.js:isAllowedTarget` |
| 注册限流 | 30 次/IP/分钟、6 次/id/分钟；窗口计数与注册写在同一 D1 batch。 | `relay.js:REGISTER_MAX_*` |
| 清理 | cron 每 30 分钟；90 天未见的注册删除，旧限流窗口删除。 | `wrangler.jsonc:triggers.crons`；`relay.js:pruneRelay` |
| 固定子域 | `<id>.dsh-market.com`，只允许一层子域，避免 Universal SSL 不覆盖两级。 | `relay.js:relayIdOf` |
| 代理 | 按 Host 解析 id，重写 Host 到临时隧道；逐跳头清理；`redirect: manual`；body 流式。 | `relay.js:handleRelayProxy` |
| WebSocket | 识别 `Upgrade: websocket`，保留 Upgrade 头，不设 `duplex`。 | `relay.js:handleRelayProxy` |
| 静态资源 | 只对带内容哈希的 `/assets/**` 加一年 immutable 缓存，其他响应原样。 | `relay.js:isImmutableAssetPath` |
| 离线页 | 无注册行返回 503 双语离线页，提示“刷新即可，无需重新配对”。 | `relay.js:OFFLINE_HTML` |
| 管理后台 | **没有**。注册/注销是插件自服务；运营者直接看 D1/Cloudflare 控制台。 | `relay.js`；`index.js` 路由 |

#### 额外的 named lease 和 bridge

`relay-control.js` 是**服务方代建命名隧道**（B 形态），不是 A 的 quick 路径：

- `PUT /api/relay/claim`：用 id/secret 认领；
- 通过 Cloudflare API 创建 `dsh-relay-<id>` 隧道、写 ingress、创建 `<id>.dsh-market.com` CNAME；
- 把 tunnel token 返回给插件；
- `release` 只标记 released，保留隧道和 CNAME；
- `retire` 才删除 Cloudflare 资源；
- `RELAY_MODE` / `relay_leases.mode` 控制 `quick` / `named` / `bridge`，默认 quick。

`relay-bridge.js` 是 Durable Object 桥接：每个 id 一个 DO，持有插件侧 connector socket，HTTP/WS 字节通过 DO 转发。它是 quick/named 之外的第三条传输，默认不启用。

#### 这份外部源码没有回答的事

- 真实套餐/账单：仓库没有；`wrangler.jsonc` 只声明 D1、DO、cron、observability，不能证明作者付了多少钱。
- 运营后台：没有；参考项目没有面向作者的 relay 管理页。
- D1 每请求读的容量上限：代码能看到，但没有压测数据。
- SSE/WS 的真实稳定性：有代理代码，没有公开压测报告。

因此，之前“Worker 源码/ wrangler 不在仓库”的结论只对**本地 clone** 成立；远端 GitHub 已经能核对实现。账单和后台仍然没有。

---

## 2. A、C、B 与参考项目的边界

### 2.1 A 的数据路径与责任

```text
手机 HTTPS
  → <id>.relay.example.com（我方 Worker，终止第一段 TLS）
  → https://<随机>.trycloudflare.com（Cloudflare quick tunnel，第二段 TLS）
  → 用户电脑 cloudflared
  → 127.0.0.1:<插件端口>
```

- **用户成本**：不需要 Cloudflare 账号、域名、控制台操作或自己的服务器；仍受 Cloudflare quick tunnel 可用性影响。
- **我方责任**：域名、Worker、注册表、身份撤销、限流配额、安全审计、隐私说明、监控和客服。
- **插件责任**：cloudflared 生命周期、id/secret 本地保管、注册/心跳/注销、配对、口令和设备撤销、失败回退。
- **Worker 不管应用配对**：它不能因为是固定入口就跳过 `/mini` 与 `/mini/api/*` 原有鉴权。

### 2.2 四种方案不要混淆

| 方案 | 固定地址从哪里来 | 数据面是否经过我方 Worker | 谁管 Cloudflare 配置 | 主要运营责任 |
|---|---|---|---|---|
| A | 我方分配 `<id>.relay.example.com`，target 是用户的 quick URL | 是 | 用户不用管；我方管 Worker，不管用户 Tunnel | 代理请求、注册表、滥用、配额、隐私 |
| C | 用户自己的命名隧道 Public Hostname | 否 | 用户自己的账号、域名和 token | 我方主要维护插件；用户管其 Cloudflare 配置 |
| B | 服务方代建命名隧道和 Public Hostname | 通常不需 Worker 逐请求代理 | 服务方账号/权限体系代建并分发配置 | Cloudflare 资源配置、账号 ACL、token 发放与回收；**不是本方案** |
| 参考项目 | quick 前置 dsh-market relay，另支持用户 named tunnel | relay 模式是 | 参考插件管本地生命周期；Worker 运营方管中继 | 其实际 Worker 运维细节仓库中未提供 |

B 的“服务方代建命名隧道”不应出现在 A 的 API、数据结构或成本模型里。A 不创建 Tunnel、不持有用户的 named token、不修改 Cloudflare Public Hostname。

### 2.3 固定地址能解决什么、不能解决什么

- target 更新成功后，固定 Origin 不变，原有 host-only Cookie 和书签继续有效。
- 裸 quick URL 与固定 relay URL 是不同 Origin，Cookie 不通用。首次从 A 回退到裸 quick 时，需要给用户新的二维码/链接。
- Worker 整体故障时，已经只有固定书签的手机无法由 Worker 自动跳转回 quick；插件只能在电脑端给出裸 quick 回退入口。不能承诺“旧书签自动故障转移”。
- 重置 id 会更换 Origin，必须重新配对；普通 quick URL 变化不应重置 id。

---

## 3. Worker 设计

以下均为 **[工程推断]**，是本项目的原创实施设计，不是对参考 Worker 的还原。

### 3.1 路由与控制面/数据面分离

控制面固定在 `relay.example.com`，数据面只使用一层通配子域 `*.relay.example.com`；不要做成 `a.b.relay.example.com`。

| 路由 | 方法与鉴权 | 行为 | 响应要点 |
|---|---|---|---|
| `/api/relay/v1/register` | `PUT`；id + secret | 创建身份或验证已有身份，写入/刷新 target；用于启动、URL 变化和心跳 | 200 才视为登记成功；409/403 不重试；429 带 `Retry-After` |
| `/api/relay/v1/unregister` | `POST`；id + secret | 停用当前 target，保留身份所有权，防止别人重新认领该 id | 成功 204；失败由插件记录但不阻塞本地停止 |
| `https://<id>.relay.example.com/*` | 支持页面/API 所需全部 HTTP 方法及 WebSocket Upgrade；不靠 id 鉴权 | **resolve + proxy**：从 Host 解析 id，读有效 target，转发原路径与查询串 | 无映射/过期返回不含 target 的 503 离线页；撤销返回 410 |
| `/api/relay/v1/health` | `GET`，公开、无参数 | 只报告 Worker 版本和基本存活 | 不返回注册数量、id、target 或存储内容；深度检查走独立管理鉴权 |
| `/admin/relay/v1/revoke` | 管理鉴权，不放进插件 | 泄露/滥用时撤销 id，并写入 KV 停用标记 | 记录管理审计；不能仅凭公网 id 调用 |

控制面 wire 契约保持最小：register 请求为 `{id, secret, target}`，200 响应为 `{publicUrl, expiresAt}`；unregister 请求为 `{id, secret}`，成功无正文。错误统一为 `{error:{code,retryable}}`，不把 D1/KV 原文、secret 或 target 带回。除首次创建外，已有 id 必须验证同一 secret；响应绝不返回 secret。

**不开放公共 `resolve? id=...` API**。解析是数据面内部步骤；公开 target 查询会泄露临时地址并增加枚举风险。健康路由也不承担逐 id 探测。

### 3.2 存储：D1 + KV + Cache API 各司其职

#### 推荐布局

**D1：身份控制面，低频读写**

```text
relay_identity(
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  state TEXT NOT NULL,          -- active | revoked
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
)
```

- 首次创建利用主键约束避免并发“抢同一个 id”；这是只用 KV 无法可靠提供的原子语义。
- 注册/心跳时读取并验证身份；撤销时更新状态。不要每部手机的业务请求都查 D1。
- D1 不保存明文 secret、手机 token、Cookie、请求正文或查询串。

**KV：短期 target 数据面，高频读、低频写**

```text
relay-target/v1/<id> → {
  version: 1,
  state: "active" | "disabled" | "revoked",
  targetOrigin: "https://....trycloudflare.com" | null,
  expiresAt: 1730000000000,
  updatedAt: 1730000000000
}
```

- 初始值：target TTL 45 分钟，插件每 15 分钟心跳刷新，并加 ±20% 抖动。
- 过期只使 target 失效，不删除 D1 身份；同一 secret 可以恢复，其他 secret 不能认领旧固定地址。
- unregister 写 `disabled` 而不是删除身份；revoke 同时更新 D1 和 KV。
- KV 写入失败时不能返回注册/撤销成功；进入告警和重试。最坏情况下由 `expiresAt` 兜底。

**Cache API：每个边缘节点的临时加速器，不是真相**

- 只缓存 KV 的 target 记录，不缓存 secretHash，不缓存任何手机响应。
- 正向缓存最多 5 秒，负向缓存最多 1 秒；每次使用前仍检查记录内 `expiresAt`。
- Cache API 不能提供全局一致撤销，也不能当作持久存储；KV 本身也存在传播延迟。
- 正常撤销目标：同节点 10 秒内生效，跨节点最迟 90 秒内生效并告警；存储故障时以 45 分钟 TTL 为最后边界。若业务要求“立即全局撤销”，需另加强一致在线检查，不能宣称本架构已经做到。

#### 取舍结论

| 方案 | 优点 | 不能承担的角色 |
|---|---|---|
| KV | 适合高频按 key 读、低频更新；部署简单 | 不适合原子计数、强一致撤销、每请求写入 |
| Cache API | 降低热点 KV 读取和延迟 | 不是数据库；不能全局 purge、不能保证撤销时效 |
| D1 | 主键、状态和管理审计清晰，适合身份控制面 | 不应成为每个手机请求的热点依赖；也不用来每请求累计用量 |

> 参考项目的 quick 路径实际是**每请求读一次 D1**，没有 KV/Cache 注册表缓存。它简单、一致，但把数据面绑在 D1 读配额和延迟上。我们建议的 KV + Cache 是为了在 Paid 规模下把 D1 从热路径拿开；Free 阶段也可以先用 D1 简化实现，但必须知道这是不同的容量模型。

**为什么绝不能每请求写 KV：**

1. 请求数会被同步放大成写入量，快速耗尽独立写入配额并增加成本；Free 的 10 万请求/天不等于还有 10 万次 KV 写。
2. KV 不提供适合全局配额的原子“读—加一—写”，并发更新会丢计数，给一种虚假的安全感。
3. 高频写同一 key 会形成热点，增加延迟与失败面；TTL 清理也会进一步放大写入。

用量统计走平台指标/分析事件，严格限流走平台限流或专门的一致计数组件，不能靠 KV 计数。

### 3.3 id、secret、撤销与过期

- id：插件用 CSPRNG 生成 **16 字节随机数**，以小写 Base32 无填充编码，形成 26 字符单标签；预期格式 `^[a-z2-7]{26}$`。id 公开出现在 Host 中，不是凭据，也不复用现有 `machine-id`。
- secret：生成 **32 字节随机数**，base64url 编码；只存本机身份文件和注册 TLS 请求，不进入二维码、浏览器状态接口或日志。
- 服务端哈希：`HMAC-SHA-256(serverPepper, id + ":" + secret)`，pepper 放 Workers Secret。随机 secret 已有 256 位熵，无需用慢密码哈希模拟口令强度；比较多使用等长字节比较并配合失败限流。
- 本地文件：`$DSH_HOME/dsh-mini-remote/relay-identity.json`，原子写入，Unix 权限 `0600`；Windows 依赖用户配置目录 ACL。文件含版本、id、secret、createdAt，不写进 `settings.json`。
- 身份文件损坏：先报错并允许“重置固定地址”，不要后台悄悄换 id；确认后撤销旧 id、生成新对并提示重新配对。
- secret 泄露：管理端撤销旧 id，插件重置身份。MVP 不做静默 rotate，避免把旧手机无感迁到攻击者 target；后续如做 rotate，必须验证旧 secret 后原子换哈希并轮换 pepper 版本。
- 心跳失败不立即删除身份；target 到期后固定地址返回离线页。注册表清理任务只删过期 KV target，不自动删 D1 身份。

### 3.4 target 校验与 SSRF/开放代理防护

注册时和每次代理前都执行同一纯函数校验，防止存储被污染后绕过：

1. 用 `new URL()` 解析；只允许 `https:`，不允许用户名、密码、hash、query、非根路径、显式端口。
2. hostname 必须匹配一个 quick 标签：`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$`；明确拒绝裸 `trycloudflare.com`、`api.trycloudflare.com`、后缀伪装和尾随点变体。
3. 数据面只从已登记记录取 target，**绝不接受请求里的 `url`、`target`、`Host` 或 `X-Forwarded-Host` 指定任意上游**；不支持 CONNECT。
4. `fetch(..., { redirect: "manual" })`，绝不跟随上游 3xx 到第二个地址。目标重定向按第 3.6 节处理，而不是继续 fetch。
5. 控制面 JSON 限制 4 KiB；方法和内容类型白名单；管理接口与插件接口分离。拒绝泛化 CORS，不返回 `Access-Control-Allow-Origin: *`。
6. 对注册、鉴权失败、无效 target 和代理请求分别限流；交互式人机验证不能挂在 SSE/WebSocket/API 数据面上。

这组规则把能力限制为“已注册 quick Origin 的反向代理”，而不是公共 HTTP 代理。它不替代插件自身鉴权。

### 3.5 Host、路径、查询串与请求头

| 项 | 规则 |
|---|---|
| 路径 | 把入站 `pathname` 原样拼到已验证 `targetOrigin` 后，不做 `/mini` 前缀剥离，不把未知路径改写到 `/`；保留 `%2F` 等编码，避免解码后再编码。 |
| 查询串 | 原样保留顺序、重复参数、`+` 和百分号编码；日志只记路径模板，绝不记 `?token=` 等内容。 |
| Host | Worker 到 quick URL 的 Host 由目标 URL authority 决定，不伪装自定义 Host；cloudflared 增加可选 `--http-host-header=<id>.relay.example.com`，使本机看到固定公网 Host。 |
| Origin / Referer | 浏览器提供的值原样保留，通常是固定 relay Origin；不改成临时 quick Origin，也不凭空为无 Origin 的请求造一个。插件镜像层继续按现有规则改写到 DSH 上游。 |
| 转发头 | 删除客户端伪造的 `Forwarded` / `X-Forwarded-*`，由 Worker 重建 `X-Forwarded-Host=<固定 Host>`、`X-Forwarded-Proto=https`；不把客户端 IP 写入业务日志。 |
| 普通逐跳头 | 删除 `Connection`、`Proxy-Connection`、`Keep-Alive`、`TE`、`Trailer`、`Transfer-Encoding`、`Upgrade` 等；Host 和 Content-Length 交给新 Request 重新计算。 |
| 应用头与凭据 | Cookie、Authorization、`X-Mini-*`、Content-Type、Accept、Last-Event-ID 等按白名单/既定协议转发；不新增 relay secret 到业务请求。 |
| 响应 | 不缓冲或改写 HTML；保留状态、Set-Cookie、Content-Type、Content-Encoding、缓存与 CSP 等端到端头，删除逐跳头。 |

现有插件依赖 HTTPS 判断设置 Secure Cookie（`lib/server.js:38-46`），因此 `X-Forwarded-Proto` 必须在真机验收中实际核验，不能只验页面能开。

### 3.6 SSE、WebSocket、流式响应、文件、超时与重定向

- **SSE**：直接返回上游 `response.body`，不得 `text()` / `arrayBuffer()` 后重发；不在 Worker 做 HTML/JSON/SSE 转换，不缓存业务响应。保留 `text/event-stream`、no-transform 和上游心跳。现有 SSE 会立即写连接帧并周期 ping（`lib/server.js:1935-1980`），验收必须证明首帧和后续帧都是增量到达。
- **WebSocket**：识别 `Upgrade: websocket`，保留握手所需 Upgrade/Connection 与 `Sec-WebSocket-*`，直接返回上游 101；文本、二进制、ping/pong、close 均双向透传。普通 HTTP 的逐跳头清理规则不能误删握手。
- **上传/下载**：请求体和响应体流式传递。Worker 对声明的 `Content-Length > 50 MiB` 返回 413，与现有实际上传上限一致（`lib/server.js:104-111,2463-2485`）；chunked 实际字节数仍由插件强制限制。Worker 不为计算长度而缓冲整个文件。
- **超时**：控制面 5 秒；普通代理等待响应头 15 秒。响应开始后不设置统一的 30/60 秒总时长，否则会误杀 SSE、WebSocket 和慢速 50 MiB 文件。长连接依靠心跳、断线重连和平台限制；后续如加空闲超时，必须按流分别设计，不能套总请求超时。
- **重定向**：相对 `Location` 原样返回；指向当前 quick Origin 的绝对 URL 改写为固定 relay Origin，避免泄露临时地址和换源；指向其他 Origin 的 Location 只作为浏览器导航原样返回，Worker 不自动跟随、不继续代理。
- **离线/错误**：无 target、过期、撤销、上游不可达分别返回明确的 503/410/502；离线页不包含 target、secret、内部堆栈或管理信息，并带短 `Retry-After`，不使用永久缓存。

### 3.7 限流、配额、并发与日预算

限额分四层，初始值均需压测校准：

| 层 | 初始软限额 | 初始硬限额/动作 |
|---|---|---|
| 单 id 业务请求 | 1,500/日，记录并观察 | 5,000/日后返回 429；管理注销始终可用 |
| 单 id 突发与长连接 | 120 请求/分钟；8 条 SSE/WS；2 个大文件上传 | 超出返回 429 或拒绝 Upgrade；已有流不批量强杀 |
| 注册与鉴权 | 同 IP 20 次注册/小时 | 同 id+IP 10 次鉴权失败/10 分钟后临时封锁；429 带 Retry-After |
| 全局 Free | 60,000 请求/UTC 日告警，停止新注册 | 80,000 后新业务请求 429，预留 20,000 给健康、注销和既有控制面 |

- 优先使用 Cloudflare 当前账号可用的原生限流/WAF 和分析能力；上线前核实其能否按 Host/id 计数。
- 进程内令牌桶只是单节点近似值，不能冒充全局配额。若平台能力不能覆盖，严格全局日配额需要独立一致计数组件（例如单独评估的 Durable Object）；Free 内测在这一点未解决前只能用邀请名额和保守阈值，不宣称精确硬限流。
- 不在每次请求中写 KV/D1 计数。分析事件采用采样和每日聚合，高基数 id 标签只保留每日 Top N。
- Paid 的全局阈值见第 5 节；达到硬阈值不是继续透支预算的理由。

---

## 4. 插件侧改动

### 4.1 当前代码对接线的影响

以下是 **[本仓库证据]**：

- `lib/tunnel.js:64-85` 的 quick 启动参数目前没有固定 Host 选项；A 需要增加可选 `originHostHeader`，仅 relay 开启时传 `--http-host-header`。
- `lib/tunnel-supervisor.js:25-32` 的 target 指纹不含 relay Host；新增字段必须进入指纹，否则开关 relay 后同 target 不会重建连接器。
- `lib/index.js:1374-1405` 只有 named 分支使用 `TunnelSupervisor`；quick 仍在 `lib/index.js:1408-1453` 走独立的三次启动循环。虽然监督器本身能处理通用 target，当前入口尚未统一。
- quick 的公开状态目前来自旧变量，named 才读 supervisor snapshot（`lib/index.js:4935-4969`）。A 若只在旧 quick 成功回调里塞一次注册，会漏掉以后自动恢复产生的新 URL。
- 配对页把 `tunnel.url` 直接拼成 `/mini?token=...`，named 仅改变“固定”文案（`lib/pairing.js:190-200`）；它需要知道“本次展示的是 relay 固定地址还是裸 quick 地址”。

因此实施 A 前先把 quick 也接入现有监督器，或提供等价的统一 URL 变化事件。**不要另造第二套 quick 重试状态机。**

### 4.2 设置与持久化

最小设置增量：

```text
tunnel.relay.enabled: boolean   // 默认 false；仅 mode=quick 时有效
```

- Worker 控制面地址和公共后缀首版随插件发布，不在手机设置页开放任意 endpoint，降低误配和 secret 被送到恶意服务器的风险；staging 通过构建/受控配置切换。
- `tunnel.enabled=false` 时不因 relay 开关单独启动隧道；named 模式忽略并解释 relay 不适用。
- id/secret 放独立身份文件，不进 `settings.json`，不回传浏览器；状态只返回 id、固定 URL、阶段、错误码、下次重试和到期时间。
- 默认关闭，用户开启时展示“固定地址由我方 Worker 转发、可见明文、不是 E2EE”的明确确认。

### 4.3 RelayProvider：只管理注册，不管理 cloudflared

建议新增 `lib/relay-provider.js`，边界与 TunnelSupervisor 分开：

```text
RelayProvider
  attach(quickUrl) -> Promise<snapshot>  // 同 URL 去重；新 URL 串行替换；含首次登记与心跳
  detach({ unregister }) -> Promise<void> // 取消心跳/重试/在途请求；尽力注销
  snapshot() -> RelaySnapshot            // 不含 secret
```

内部状态建议：`off → waiting-tunnel → registering → active → degraded/paused → off`。

必须实现：

1. **串行与代次保护**：quick URL 从 A 变 B 时，A 的迟到响应不能把注册表或本地状态改回 A；所有请求带 generation，attach/detach 后旧结果作废。
2. **超时与重试**：网络/5xx 采用 5 秒起步、最高 5 分钟、±20% 抖动；429 遵守 `Retry-After`；401/403/目标 400 不自动重试，也不自动重置 id。
3. **心跳**：active 后每 15 分钟刷新 TTL；目标变化立即 attach，不等下个心跳。
4. **注册后验证**：第一次或 target 改变时，经固定 URL 调现有版本探测，200 才把 relay 标为 active；固定地址失败但裸 quick 健康时，不重启 cloudflared。
5. **回退**：首次登记失败，配对条目使用裸 quick，同时显示 relay 错误；曾 active 的短暂心跳失败，在 TTL 宽限内保留固定地址，超过阈值再标 degraded。不能把 Worker 故障误判成 quick 进程故障。
6. **停止**：relay 开关关闭、切到 named、整个公网停止时 `detach({unregister:true})`；插件卸载给注销最多 2 秒，超时由 TTL 清理。普通 quick 重连不先注销身份。
7. **日志**：错误只保留状态码和分类；对 id 可做短散列，绝不写 secret、手机 token、Cookie、完整查询串或完整 target。

### 4.4 与 TunnelSupervisor / pairing 的接口

推荐事件顺序：

```text
设置开启 quick + relay
  → TunnelSupervisor.start({ mode:"quick", port, originHostHeader:fixedHost })
  → running + quickUrl
  → RelayProvider.attach(quickUrl)
  → register 成功 + 固定 URL 端到端探测成功
  → pairing 显示固定 relay 条目
```

quick URL 任何变化都重复 attach；named 模式不创建 provider。

状态模型不要把两种 URL 混成一个字段：

- `tunnel.url`：真实 quick target，仅供诊断和探测；
- `relay.publicUrl`：固定展示地址；
- `pairing` 最终条目：relay active 时为 `kind:"public-relay"`、`url:<固定>/mini?token=...`；否则保留原 `kind:"public"` 裸 quick 条目。
- relay 的 `publicHealthy` 与 tunnel 的 `publicHealthy` 分开，前端能说清“隧道正常，中继异常”。

C 的 named 配对逻辑不变；现有局域网、Tailscale、自建 frp 不经过 RelayProvider。

---

## 5. Free / Paid 容量估算

### 5.1 计费基线与假设

本节按任务给定的规划基线，不声称来自参考仓库或实时官方报价：

- Workers Free：100,000 请求/天，10 ms CPU/请求。
- Workers Paid：5 美元/月，含 10,000,000 请求/月。
- KV、D1、日志/分析、超额请求及其他资源另算；实际上线前必须以我方 Cloudflare 控制台和官方当前文档复核。参考项目的账单/套餐信息：**仓库中未提供**。

> 参考项目的 quick 路径没有 15 分钟心跳，target 的 GC 是 90 天；本节的 96 次/日心跳是**我们的设计假设**，不是参考项目的实际请求量。若采用参考项目的“启动/变化才注册”，后台请求会明显更低，但 target 失效恢复更慢。

定义“活跃实例/日”：一台电脑整天在线，一台手机中度使用。以下是容量模型假设，不是实测：

| 来源 | 假设 | 请求/实例/日 |
|---|---:|---:|
| 注册心跳 | 每 15 分钟一次，24 小时在线 | 96 |
| 固定地址端到端健康检查 | 每 15 分钟一次 | 96 |
| 三次冷加载 | 每次 25 个页面/静态/API 请求 | 75 |
| 普通业务 API | 一天累计 | 165 |
| SSE / WebSocket | 建连或重连合计 10 次 | 10 |
| **合计** | 后台 192 + 用户流量 250 | **442** |

公式：

```text
理论实例数 = 套餐请求额度 ÷ 单实例请求量
建议实例数 = 理论实例数 × 70%   // 给突发、重连、监控和误差留 30%
Paid 使用 30 天月份；不能把 1,000 万当成每日额度。
```

| 使用画像 | 请求量 | Free 理论 / 建议 | Paid 理论 / 建议（30 天） |
|---|---:|---:|---:|
| 只在线，不用手机 | 192/日 | 520 / **364** | 1,736 / **1,215** |
| 中度活跃，上述模型 | 442/日 | 226 / **158** | 754 / **528** |
| 重度使用 | 用户流量 2,000 + 后台 192 = 2,192/日 | 45 / **31** | 152 / **106** |

结论：Free 公开运营不能按“注册用户数”估容量，因为一直在线的后台请求也计费。首发可把**每日中度活跃实例软上限设为 100**，同时看真实后台比例再调整；不是宣称 Free 只能服务 100 个注册用户。

### 5.2 软/硬限额与升级触发

- Free：60,000/日软告警，80,000/日硬限制；连续 3 天超过 60,000，或按 7 日均值预测月需求超过 700 万，提前进入 Paid 评审。
- Paid：700 万/月软告警，850 万/月硬限制并压测扩容；达到后评估超额用量或更高套餐，价格不得凭空填写。
- 任一环境：普通代理 CPU p95 持续 15 分钟超过 7 ms、频繁 CPU 超限、429/5xx 异常或长连接大面积掉线，也触发扩容/优化，不只看请求总数。
- Paid 回滚到 Free 前必须先降低真实用量；用量已高于 Free 时，直接降级就是一次故障，不是有效回滚。

### 5.3 SSE / WebSocket 的计数与 CPU 风险

- 一次 SSE 建连、一次 WebSocket Upgrade 各按一个 HTTP 请求规划；流内每条消息/heartbeat 不按新 HTTP 请求计算，但 EventSource/WS 每次重连都会再计一次。实际计费以 Cloudflare 当前规则复核。
- 长连接的墙钟时长不等于 CPU 时间；等待网络通常不应按同样时长消耗 CPU。但 Worker 若逐帧处理、缓冲、解压、序列化或详细记日志，会增加 CPU 和持续时间风险。
- 普通代理只做 target 读取、头处理和 body 流式返回；HMAC 只发生在低频注册，不在每个业务请求计算。
- 初始 SLO：普通请求 CPU p95 < 5 ms、无 p99 超过 10 ms 的持续趋势；SSE 首帧 < 2 秒，30 分钟测试无缓冲；WS 30 分钟双向稳定。真实账单和 CPU 指标若与假设不符，先改模型再放量。

---

## 6. 安全、隐私与合规

### 6.1 信任边界

1. Worker 在两段 TLS 之间处理明文 HTTP，可见 URL、查询 token、Cookie、指令、回复和文件内容；**不是 E2EE**。Cloudflare 本身也处于传输信任边界内。
2. secret 只保护注册表所有权，不是手机访问凭据，也不能代替现有设备撤销。id 不是秘密。
3. secret 泄露后，攻击者可把已知 id 指向自己的 quick tunnel，形成固定域名钓鱼；必须提供管理撤销和插件身份重置。
4. target 与临时 URL 也按敏感配置处理；公共 resolve、离线页和日志均不能泄露。
5. Worker 不加 CORS 泛放行，不把公网 Host 加入“本机可信”名单，不因请求来自 cloudflared 就豁免鉴权。

现有文档已提示“经代理后来源 IP 可能像本机”的风险（`docs/国内中继方案框架.md:281-288`）。A 上线前必须逐条拒绝公网访问仅本机管理路由，尤其是 `/mini-remote/*`；不得只凭 `remoteAddress` 判定安全。

### 6.2 日志与滥用

- 默认不记录正文、查询串、Cookie、Authorization、secret、完整 target 或文件内容。
- 数据面只记录时间、requestId、方法、路径模板、状态码、耗时、CPU、字节数和 id 的每日加盐散列；原始 IP 不进业务日志。
- 注册/撤销低频管理日志保留必要审计，管理操作另记操作者；设定最短必要保留期和删除流程。
- 防止被用于公开代理、扫描、大文件分发、凭据爆破和绕过封禁：target 白名单、手动重定向、速率/并发/体积极限、每日配额和撤销缺一不可。
- 插件口令错误限流仍要保留；由于源 IP 经 Cloudflare 后可能失去区分度，Worker 必须承担第一层 IP/id 限流。

### 6.3 条款与合规门槛

以下是工程风险提示，不是法律意见：

- 上线前审查 Cloudflare Workers、Tunnel/quick tunnel、可接受使用、代理/滥用、隐私和套餐条款；不得把“技术上能代理”写成“条款允许任何代理用途”。
- 明确运营主体、隐私政策、数据类别、处理目的、保留期、第三方/跨境传输、用户删除与安全事件联系方式。
- 面向中国大陆公众提供服务等场景，需专业确认 ICP/备案、公安联网备案、经营许可与数据跨境要求；未确认前仅邀请制技术验证。
- 不宣传“绝对匿名”“端到端加密”“永不记录”或“永久免费”。Free 套餐没有我方可控 SLA，quick tunnel 也可能限流、变更或停止。

---

## 7. 可观测性与运维

### 7.1 指标与告警

| 维度 | 最小指标 | 初始告警 |
|---|---|---|
| 请求 | 总量、控制面/数据面、状态码、方法、429、5xx | 5 分钟 5xx > 2%；429 突增 |
| CPU/时延 | p50/p95/p99 CPU、响应头时延、上游错误 | p95 CPU > 7 ms 持续 15 分钟 |
| 注册表 | 注册成功率、失败分类、心跳延迟、过期 target、D1/KV 错误 | 15 分钟成功率 < 95%；任何撤销写 KV 失败 |
| 数据面健康 | 缓存命中、offline 503、上游 502、target 年龄 | offline 比例突增；大量 target 超过 45 分钟 |
| 单 id | 日请求、峰值、长连接数、上传量、Top N | 超过 1,500/日或异常流量画像 |
| 套餐 | 日/月请求、KV/D1 用量、日志量 | Free 60%/80%；Paid 70%/85% |

不要把单节点“当前 WebSocket 数”当全局准确值；用连接 open/close 事件聚合，并允许断线造成的小误差。

### 7.2 Free 阶段低成本做法

- 以 Cloudflare 控制台的 Workers、KV、D1 指标为主；若当前套餐提供分析事件/通知，则按上表配置，不另建大型可观测性平台。
- 控制面全量结构化日志但严格脱敏；数据面只记录错误和约 1% 采样，SSE/WS 不按消息记日志。
- 一个外部免费可用性探测每 5 分钟访问 `/health`；它不代替真实 quick 全链路探测，也不暴露逐 id 状态。
- 每日一份低基数汇总：请求、错误、p95 CPU、注册失败、Top 20 id 散列、后台/业务请求占比。禁止为省钱把原始 URL 写进免费日志。
- 运维手册至少包含：撤销 id、关闭新注册、全局停止代理、恢复裸 quick 指引、KV/D1 故障、密钥 pepper 轮换、配额耗尽和隐私事件处理。

---

## 8. 验收测试与通过标准

### 8.1 单元测试

| 用例 | 可判断的通过标准 |
|---|---|
| 身份生成与文件 | id/secret 符合新格式和熵长度；原子重写不丢文件；Unix 为 0600；浏览器 payload、日志和二维码均无 secret |
| target 白名单 | 合法 quick Origin 通过；http、用户信息、端口、路径/query/hash、裸域、api 子域、伪后缀、IP、尾点全部拒绝，且没有上游调用 |
| 注册状态机 | 首次成功、同 target 去重、新 target 更新、心跳续期；401/403/400 不重试，429 遵守 Retry-After，5xx 有界退避 |
| 并发代次 | A→B 更新时 A 的迟到响应被丢弃；detach 后任何在途响应、定时器都不能复活 provider |
| quick 生命周期 | quick 每次 URL 变化只注册一次；named 从不注册；relay Host 改变会进入 target 指纹并重建连接器 |
| 回退与配对 | 首次注册失败显示裸 quick；active 短暂故障在宽限期保留固定地址；relay active 时二维码是固定 Origin + `/mini?token=...` |
| 停止与注销 | 关闭 relay、切 named、停止公网都会发一次注销；超时/失败不阻塞本地停止，后续无心跳 |

### 8.2 Worker 集成测试

用我们自己的 Worker 测试配置和隔离 KV/D1 命名空间，不使用参考项目不存在的部署文件：

1. **身份与映射**：创建后 D1 只有哈希；错误 secret 得 403；同 secret 可刷新；不同 secret 不能抢已有/已过期 id。
2. **撤销与过期**：unregister 后同节点 10 秒内不再代理，跨节点 90 秒内返回离线/410；过期 target 不代理，旧身份仍只能由原 secret 恢复。
3. **路径与查询**：`/mini/api/state?a=1&a=2&q=%2F&x=a+b` 到上游逐项一致；响应 Set-Cookie、状态码和二进制内容不变。
4. **Host/Origin**：上游看到 quick authority；cloudflared 后的本机服务看到固定 relay Host 和 `X-Forwarded-Proto:https`；浏览器 Origin 不被改成临时域。
5. **SSRF/开放代理**：第 8.1 节全部恶意 target，以及 3xx 到 `http://127.0.0.1`、其他域和带凭据 URL，均不发生第二次 fetch；公共路由不能指定 target。
6. **流式响应**：测试源逐块发送，第一块在发送最后一块前已到客户端，证明 Worker 没有整包缓冲。
7. **重定向**：相对 Location 不变；同 quick Origin 绝对 Location 改为固定 Origin；外部 Location 不触发 Worker 请求外部站点。
8. **日志**：构造带 token、Cookie、Authorization 和 secret 的请求，自动扫描日志/分析事件，敏感值出现次数必须为 0。

### 8.3 真机与网络验收

| 场景 | 通过标准 |
|---|---|
| 普通页面 | 手机 4G/5G 与 Wi-Fi 各完成扫码、页面加载、发指令、收最终回复；刷新和重开固定书签不重配；旧 quick/C 路线回归通过 |
| SSE | 首帧 2 秒内到；逐条消息即时可见；连续 30 分钟无整段缓冲；杀网 30 秒恢复后 EventSource 自动重连且状态重放正确 |
| WebSocket / 镜像 | 101 成功，文本/二进制双向、ping/pong 和 close 正常；远程窗口连续 30 分钟；撤销设备后现有连接按现有语义被关闭 |
| 大文件 | 50 MiB 上传和下载各一次，哈希一致，无 Worker 整包内存增长或 CPU 持续超限；51 MiB 得 413；慢速传输不被固定总超时误杀 |
| quick URL 改变 | 杀 cloudflared 并等到新 URL；同一固定书签在注册和探测完成后恢复，无需重新配对；旧 target 不再被使用 |
| Worker 故障 | 阻断 register/代理时，电脑端明确显示中继异常并给裸 quick 回退；quick 本身不因 Worker 故障被重启；恢复后固定地址自动可用 |
| 撤销/泄露 | 管理撤销后按第 8.2 节时限拒绝代理；重置身份得到新地址，旧地址不再恢复，界面明确要求重新配对 |
| TTL | 模拟插件崩溃、无法注销；45 分钟后 target 不再代理；身份未被他人认领，原实例可用心跳恢复 |
| Host/HTTPS | 固定域下 Cookie 带 Secure， host-only Cookie 不漂到 quick 域；仅本机管理接口从公网全部得到 401/403/404 中既定的拒绝结果 |
| Free 限额演练 | 在隔离测试账号/命名空间用轻量请求跑到处置点：60,000 触发告警，80,000 新业务 429，注销/管理仍可用，UTC 次日按设计恢复；不拿生产用户做耗尽实验 |
| CPU/长连接 | 压测普通代理、SSE、WS 混合流量，普通 CPU p95 < 5 ms；无持续 10 ms 超限；请求模型与真实控制台计数偏差有记录并修正容量公式 |

---

## 9. 分阶段上线

| 阶段 | 范围与目标 | 退出条件 | 回滚 |
|---|---|---|---|
| 0. 原型 | 一个测试 Worker、隔离 D1/KV、1 个 id；打通 register/proxy、Host、SSE、WS | 第 8.1、8.2 全过；无 secret/查询日志；50 MiB 与重定向通过 | 插件 relay 关闭，删除测试通配路由；保留裸 quick |
| 1. 内测 | 5–10 个明确邀请实例，真实手机跑 7 天；验证断线、撤销、TTL、客服流程 | 无 P0/P1 安全问题；全链路成功请求占比 ≥99%（计划断网除外）；CPU SLO 达标；撤销演练达标 | 停止新注册，撤销异常 id；插件给裸 quick 二维码并说明旧固定书签需临时换码 |
| 2. Free 限量 | 默认仍关闭，仅邀请开启；中度活跃实例软上限 100，执行 60k/80k 阈值和日度成本复盘 | 连续 14 天未越软预算、无失控滥用、错误率和 CPU 达标；隐私/条款审查完成 | 关新注册或全局只读/停代理；插件回退裸 quick。不能把已有固定 Origin 的 Cookie 迁走 |
| 3. Paid 扩容 | 达到升级触发点后启用 Paid，按实测值分批放到建议容量；完善严格配额和告警 | 30 天用量低于 700 万软线或有经批准的超额预算；SLO、单位成本和客服量可持续 | 优先限新注册和重度滥用，保留 Paid 维持存量；用量未降前不得直接退回 Free |

每阶段都必须有可执行的“停止新注册”和“撤销单 id”开关；全局 kill switch 生效后要验证，而不是只写在 runbook 里。

---

## 10. 成本与风险清单

### 10.1 成本项

| 项目 | 规划口径 |
|---|---|
| 域名/DNS/TLS | `example.com` 的注册续费、DNS 和通配子域证书实际价格另查；只使用一层 `<id>.relay.example.com`，先验证证书覆盖 |
| Workers | Free 0 元规划基线；Paid 按 5 美元/月、含 1,000 万请求/月估算；超额和增值项以我方控制台为准 |
| KV / D1 | 身份行、target 行、读写和存储分别核价；96 次心跳/在线实例/日同时产生控制面读取，不占“零成本”假设 |
| 日志/分析/监控 | 采样、保留期、外部可用性探测和通知费用另列；先控制高基数和日志量 |
| 工程运维 | Worker 部署回滚、KV/D1 迁移、密钥管理、安全审计、值班、撤销和故障演练 |
| 客服与合规 | 固定地址失效、跨 Origin 重配、Cloudflare 可达性、隐私咨询、条款/备案与事件处置 |

参考项目的 Worker 源码已可核对；真实账单、D1/DO 用量和套餐选择：**仓库中未提供**，不能拿它的存在证明本方案必然便宜。

### 10.2 主要风险

| 风险 | 影响 | 首要控制 |
|---|---|---|
| quick tunnel 可用性/条款变化 | A 整体失效或需重构 | 保留 C、裸 quick、Tailscale、自建 frp；不把 A 设为唯一公网路线 |
| Worker 或注册表故障 | 固定书签不可用 | 明确离线页、裸 quick 回退、健康监控；承认旧书签不能自动换源 |
| KV/Cache 一致性问题 | 新旧 target 短暂并存、撤销延迟 | 短缓存、TTL、代次保护、撤销演练；不承诺即时全局一致 |
| secret 泄露 / id 被抢 | 固定域钓鱼 | D1 唯一身份、HMAC、失败限流、管理撤销、身份重置 |
| SSRF / 开放代理 / 大流量滥用 | 安全和账单事故 | 严格 target 白名单、手动重定向、限速/并发/日预算、注销通道 |
| SSE/WS 被缓冲或总超时杀掉 | 手机实时功能和远程窗口不可用 | 流式返回、专用 Upgrade 分支、30 分钟真机测试，不设统一总时长 |
| CPU 或请求配额超预期 | 限流、额外成本、全局不可用 | 不在数据面做哈希/数据库写/正文处理；真实指标修正模型，预留 30% |
| Host/Origin/Cookie 处理错误 | 配对失效、CSRF/CORS 异常或管理面暴露 | 固定 Host 由 cloudflared 重建、保留 Origin、 Secure 与公网拒绝测试 |
| 明文可见与隐私承诺不符 | 用户信任和合规风险 | 默认关闭、明确非 E2EE、最小日志、隐私/条款专业审查 |
| 中国大陆可达性和跨境不确定 | 特定用户长期体验差 | 分地区实测；提供国内自建等替代，不做自动跨境切换承诺 |
| 中心化运营与客服负担 | 项目从插件变成持续服务 | 邀请制、清晰 SLO、运行手册、单位成本复盘；C 保持去中心化选择 |

**最终建议**：先做 Phase 0/1，不直接承诺公开免费服务。只有当“安全转发 + 可撤销 + 可限流 + 可回退 + 可观测”五项同时通过，A 才进入 Free 限量；否则继续以已经完成的 C 和现有连接方式为主。
