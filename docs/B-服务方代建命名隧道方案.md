# B：服务方代建 Cloudflare 命名隧道方案

> 状态：完整方案框架 / 设计评审稿，2026-10-27。用户已决定启动 B 的方案设计；本文不表示已开发、部署或开通任何 Cloudflare 资源。
>
> 范围：只定义架构、契约、安全、容量、运营和实施验收；不包含实现代码，不变更 A、C、Worker、插件或 DSH。
>
> 证据口径：**[参考项目证据]** 指已核对的本地 `ref-a/` 与 GitHub `zhu1090093659/dsh-web` 远端源码；**[截图线索]** 指用户转述的 pair-server 截图流程，未获得其源码；**[工程推断]** 指本项目设计建议；**[估算]** 指容量或成本模型；**[待验证]** 指必须由控制台、官方文档、PoC 或用户决策确认，不能当作既定事实。

---

## 0. 结论先行

B 可行，且与 A 的价值不同：**B 用服务方的一次性资源配置，换掉 A 的长期 Worker 数据面代理。**

推荐形态如下：

1. 用户只输入一次性激活码。控制面完成 Tunnel、固定 hostname、ingress、proxied CNAME 和每实例 tunnel token 的准备；用户不接触 Cloudflare 控制台。
2. 配对完成后的数据路径为：

   ```text
   手机 HTTPS
     → <固定 hostname> 的 Cloudflare 边缘
     → 服务方账户中的命名隧道
     → 用户电脑上的 cloudflared
     → 127.0.0.1:<插件端口>
   ```

   业务请求不经过我方 Worker，也不逐请求读写我方 D1/KV。Worker 只承担激活、续期、状态、回收和运营控制。
3. **保留 A Worker 和 C。**A 继续服务选择 quick + Worker 的用户；C 继续服务愿意管理自己 Cloudflare 账户的用户。B 不是替代全部路线的唯一默认项。
4. **B 控制面建议与 A 数据面 Worker 分离部署。**不要为了复用而把账户级 Cloudflare API token 放进处理公共流量的 A Worker。可复用 Access、审计规范和运营经验，但不共享高权限 secret 的暴露面。
5. **B 的公网 hostname 不能命中 A 的 Worker 通配路由或 Custom Domain。**否则“数据不经过 Worker”可能不成立。若现有 A 路由无法排除 B hostname，B 使用独立 zone；不能只创建一个 CNAME 就宣称已经直连命名隧道。
6. 激活码、clientSecret、tunnel token、手机配对 token 是四种不同凭据，不得混用：
   - 激活码：一次性开通资格；
   - clientSecret：实例访问 B 控制面的长期凭据；
   - tunnel token：cloudflared 连接指定 Tunnel 的凭据；
   - 手机配对 token：现有插件的短期配对凭据。
7. **推荐 clientSecret 由插件本地生成，服务端只登记哈希。**这样首次响应丢失后，插件仍能凭同一 clientSecret 和幂等号恢复，不必重放激活码或由服务端保存可回看的明文。若必须严格采用截图中的“服务端同时下发 clientSecret”，需另设恢复凭据，见第 17 节开放决策。
8. D1 是租约和操作的真相；Cloudflare API 不是 D1 事务的一部分。必须用“先建控制记录、分步记录资源 ID、可重入收敛、孤儿对账”处理半失败，不能用一次 try/catch 假装原子完成。
9. `release` 不应被描述为安全断开。参考实现的 release 只改数据库状态，Tunnel 和 CNAME 仍在；安全泄露处置必须显式阻断公网入口并处理 tunnel token。
10. 按任务给定的 **1,000 Tunnel/账户**规划基线，容量按所有未删除 Tunnel 计算，包括 claimed、active、released、孤儿和测试资源，而不是只算 active。建议 700 软线、800 停新增评审、900 硬停新 claim，保留恢复余量；实际限额 **[待验证]**。
11. B 大幅降低 Worker 请求量，但不把成本变为零：域名、控制面 Workers/D1、Cloudflare Tunnel/Zero Trust 套餐、日志、对账、安全事件和客服仍存在。Workers Paid 也不会自动提高 Tunnel 配额。
12. 先做独立 staging 的 PoC，再做 5–10 实例内测；未完成 token 泄漏演练、孤儿回收、DNS 冲突保护和回退验收，不公开发放激活码。

---

## 1. 范围、已知证据与不能假设的事项

### 1.1 已核对的参考材料

**[参考项目证据]**

- A 的四份文档明确了 quick + Worker 的数据面、邀请准入、运营台、容量模型、失败回退，以及“B 不属于 A”的边界。
- `ref-a/relay-control.js` 与远端 `market/worker/src/relay-control.js` 一致地展示了服务方代建 remote-managed Tunnel 的基本路径：find-or-create Tunnel、写 ingress、find-or-create/update CNAME、读取并返回 tunnel token。
- `ref-a/relay.js` 展示 quick 注册表和 Worker 反代；`relay-bridge.js` 展示另一条 Durable Object 传输，不是 B 的必要组件。
- `0007_relay_registry.sql` 是 quick 身份/target/限流表；`0009_relay_leases.sql` 是 named lease；`0010_relay_lease_mode.sql` 增加 quick/named/bridge 的模式选择。
- `ref-a/wrangler.jsonc` 的注释给出参考权限口径：指定账户的 `Cloudflare Tunnel: Edit`，以及指定 zone 的 `DNS: Edit`；账户级 API token 只存在 Worker secret。

### 1.2 截图能提供和不能提供的证据

**[截图线索]**用户转述的 pair-server 思路是：

```text
一次性激活码
  → 服务方建 Tunnel
  → 分配 *.jiulingssh.xyz
  → 创建 DNS CNAME
  → 下发 tunnel token + clientSecret
  → 插件自动下载 cloudflared
  → 配对后服务方退出数据路径
```

本产品流程与 B 一致，本文吸收其“低门槛开通”和“两类实例凭据”的思想。但没有 pair-server 源码、API 契约、权限配置和运维记录，因此不能声称：

- 与其协议兼容；
- 其 clientSecret 的生成、存储和轮换方式已经安全；
- 其真实 token、secret、域名配置或配额可以直接复用；
- 截图证明了生产 SLO、成本或合规性。

`jiulingssh.xyz` 在本文只作为截图所示后缀记录；是否拥有、是否用于生产、是否与 A 路由冲突均为 **[待验证]**。正文用 `<id>.<B域后缀>` 表示固定 hostname。

---

## 2. A / B / C 的边界与选择条件

| 维度 | A：固定 Worker + quick | B：服务方代建 named Tunnel | C：用户自建 named Tunnel |
|---|---|---|---|
| 用户准备 | 无需 Cloudflare 账户；邀请阶段需资格 | 无需 Cloudflare 账户；需一次性激活码 | 自己的 Cloudflare 账户、域名、Tunnel 和 token |
| 固定地址 | 有 | 有 | 有 |
| 配对后的业务数据面 | 手机 → 我方 Worker → quick → 本机 | 手机 → Cloudflare 边缘 → named Tunnel → 本机 | 手机 → 用户自己的 Cloudflare 配置 → 本机 |
| 我方是否逐请求代理 | 是 | 否 | 否 |
| 我方持有的高权限 | A 身份/注册表和管理凭据 | 另增账户 Tunnel 与 zone DNS 写权限 | 不需要持有用户账户 API token |
| 主要故障依赖 | quick、Worker、注册表、Cloudflare 边缘 | Cloudflare 边缘/Tunnel、本地 cloudflared；控制面只在管理时依赖 | 用户自己的配置和 Cloudflare |
| 主要运营负担 | 代理流量、滥用、配额、明文可见 | 账户资源、token、DNS、回收、孤儿和客服 | 插件兼容与用户配置支持 |
| 更适合 | 最低配置、接受 Worker 数据面和 quick 依赖 | 要低门槛，同时减少 quick/Worker 数据面依赖 | 要自控账户、配置和数据路径 |

### 2.1 选择建议

**[工程推断]**

- 选 A：用户愿意接受“我方 Worker 可见中转流量”，且希望尽量少持有长期 Cloudflare 资源。
- 选 B：用户需要固定地址和 named Tunnel，但没有能力或意愿管理 Cloudflare；服务方也已准备好承担账户级安全与持续运营。
- 选 C：用户已有 Cloudflare 能力，重视账户和资源所有权，或不愿把 tunnel token 的签发权交给服务方。
- B 控制面故障时，已运行的 B 数据面通常可继续；A/C 是否需要启用，应由用户明确选择。不同路线是不同 Origin，不能透明迁移 Cookie、书签或配对状态。
- 不引入参考项目的 Durable Object bridge 作为 B 的组成。它会新增协议、连接器、背压和 DO 成本，与“named Tunnel 直连”不是同一方案。

### 2.2 B 仍不是端到端加密

我方 Worker 不再看到配对后的业务明文，但 Cloudflare 边缘仍终止用户 HTTPS，cloudflared 再把流量送到本机服务。B 减少的是**我方数据面可见性和故障点**，不是取消 Cloudflare 的信任边界，也不替代插件的口令、设备会话、设备撤销和本机路由门禁。

---

## 3. 与截图项目、参考项目 B 的异同

| 主题 | 参考项目 B 的证据 | 截图线索 | 本方案 |
|---|---|---|---|
| 开通 | 插件以 id/secret 自服务 `PUT /api/relay/claim`；首次带重复的新 secret | 一次性激活码 | invited 激活码 + 原子 claim + clientSecret 控制鉴权 |
| Tunnel | remote-managed，名称 `dsh-relay-<id>` | 服务方代建 | 同构，但使用自己的受控前缀和独立资源清单 |
| ingress | `<id>.dsh-market.com → http://127.0.0.1:<port>`，末尾 `http_status:404` | 自动配置 | 同构；只接受整数回环端口，不接受任意外部 service URL |
| DNS | proxied CNAME 到 `<tunnel-id>.cfargotunnel.com` | 固定子域 + CNAME | 同构；增加全记录类型冲突检查和未知记录不覆盖 |
| tunnel token | 每次成功 claim 都调用 token API 并返回 | 下发 | 初次/明确恢复时下发；普通 renew 不返回，不存明文 |
| clientSecret | 使用 lease 的 id/secret，不是截图所示的双秘密模型 | token + clientSecret | 明确区分控制凭据和连接凭据，分别轮换与处置 |
| 生命周期 | active/released；release 留资源，retire 删除；90 天 GC | 未提供 | invited/claimed/active/released/retired + 操作记录 + 墓碑 + 对账 |
| 数据面 | 部署另有 quick Worker 和可选 DO bridge | 配对后不经服务方 | B 只用 named Tunnel；hostname 不得命中 A Worker |
| 运营 | 未见面向运营者的后台、配额、对账和泄露演练证据 | 未提供 | 最小后台、审计、配额、孤儿清理、客服和回滚为上线门槛 |

### 3.1 不能直接照抄参考实现的地方

**[参考项目证据 + 工程推断]**

1. 参考 claim 是匿名自服务身份模型，不等于一次性激活码准入；B 不能公开匿名创建账户资源。
2. 参考 release 只写 `released`，不删除或禁用 Tunnel/CNAME，因此不能当作“立即安全撤销”。
3. 参考 retire 删除 lease 行；本方案保留不含秘密的墓碑，防止旧 hostname 被重新认领。
4. 参考 DNS 查找只查询 CNAME，并会把同名 CNAME 收敛到目标；本方案还要检查 A/AAAA/TXT 等冲突，未知记录一律不接管。
5. 参考以名称 find-or-create 可支持重试，但没有本方案所需的激活码、操作 ID、分步检查点、跨租户恢复约束和未知资源隔离。
6. 参考 token API 的 GET 是读取当前 token，不应把“再次 GET”称作轮换或撤销。真实轮换能力 **[待验证]**。
7. 参考 90 天清理是一种策略，不是本项目的既定用户承诺；本方案的 released 保留期和失联回收期需用户拍板并公布。
8. 参考的 quick/bridge 回退和“最新 connector socket 替换”不能套到 named Tunnel。多个 cloudflared 使用同一 token 可能形成副本/负载分担，不能假设“新连接必然顶替旧连接”。

---

## 4. 控制面与数据面架构

### 4.1 组件划分

**[工程推断]**

| 组件 | 职责 | 明确不负责 |
|---|---|---|
| B Pair Worker | claim、renew、status、release、retire、管理 API；调用 Cloudflare API | 不代理手机业务请求；不保存账户 token 到数据库 |
| D1 | 激活码、lease、操作、资源清单、墓碑、管理审计 | 不存明文激活码/clientSecret/tunnel token；不做每业务请求读写 |
| KV（可选） | 非权威开关、短期读缓存、限流提示 | 不作为一次性消费、租约所有权或回收的唯一真相 |
| Cron / 有界任务执行器 | 半失败重试、到期回收、资源对账、旧审计/限流清理 | 不自动删除无法证明归属的 Cloudflare 资源 |
| Cloudflare 账户与指定 zone | 承载 Tunnel、ingress、CNAME 和边缘数据面 | 不把账户级 API token 下发给插件 |
| 插件 | 本地 secret、cloudflared 生命周期、健康探测、配对二维码、用户回退 | 不获得账户 API 权限，不决定其他租户资源 |
| A Worker | 继续承担 A 用户的 quick 反代与 A 控制面 | 不承载 B 数据面；建议不持有 B 账户写 token |

### 4.2 是否保留 A Worker

结论：**保留，而且独立回滚。**建议把 B 控制面做成独立 Worker/独立 secret 集合；A 的现有运维 Access 和审计模式可以复用，但以下不共用：

- 不把 B 的 `Cloudflare Tunnel: Edit` / `DNS: Edit` token 加到 A 公共代理 Worker；
- 不让 B hostname 走 A 的通配路由；
- 不让 B 的 retire、DNS 修复影响 A 注册表；
- B staging 与生产使用不同 D1、资源前缀和凭据，最好使用不同账户或至少不同 zone 与 API token。

### 4.3 域名和 TLS 约束

- 固定 hostname 采用单标签 `<id>.<B域后缀>`，不引入多级通配证书假设。
- CNAME 必须为 proxied，目标严格为预期 `<tunnel-id>.cfargotunnel.com`。
- 上线前实际验证 Universal SSL/证书覆盖、DNS 传播、Worker 路由优先级和 WebSocket/SSE；不凭参考项目域名推断本域名已配置。
- 若 A 已对整个 zone 配置通配 Worker 路由，优先给 B 使用独立 zone；其他路由方案必须真机证明 Worker 完全不在 B 数据路径。

---

## 5. 激活码、身份、租约数据模型与状态机

### 5.1 四类凭据与标识

| 名称 | 推荐生成与保存 | 用途 | 不能做什么 |
|---|---|---|---|
| activationCode | 服务端 CSPRNG；D1 只存 HMAC 哈希；明文只在创建时显示一次 | 首次 claim | 不能作为长期 renew 凭据，不进二维码/URL/日志 |
| leaseId / id | 服务端在 invited 时生成高熵随机单标签；公开 hostname 的一部分 | 定位租约和资源名称 | 不是秘密，不凭它单独操作资源 |
| clientSecret | **推荐插件生成 32 字节随机值**；插件本地保存；D1 存带 pepper 的 HMAC | renew/status/release/retire 和 claim 恢复 | 不能启动 cloudflared，不能作为手机访问凭据 |
| tunnel token | Cloudflare 为指定 Tunnel 提供；Worker 只在需要时读取；插件本地保存 | cloudflared 建连 | 不能调用 B 管理 API，不能写入 D1/日志/命令行 |
| 手机配对 token | 沿用插件现有配对机制 | 手机首次配对 | 与以上三种完全分离 |

激活码与 clientSecret 使用带版本的服务端 pepper 做 HMAC-SHA-256，并做等长比较和失败限流。随机高熵秘密不需要用弱口令模型处理；pepper 只放 Workers Secret。

### 5.2 D1 逻辑表

以下是字段职责，不是 SQL 实现：

| 表 | 关键字段 | 约束与用途 |
|---|---|---|
| `b_leases` | leaseId、hostname、state、clientSecretHash、secretVersion、originPort、tunnelName、tunnelId、dnsRecordId、dnsTarget、configVersion、credentialVersion、created/claimed/activated/lastSeen/released/retiredAt、rowVersion | leaseId、hostname 唯一；tunnelId/dnsRecordId 在存在时唯一；墓碑行长期保留必要标识 |
| `b_activation_codes` | codeId、codeHash、leaseId、state、batchId、createdAt、expiresAt、claimedAt、revokedAt | 一码绑定一个 lease；只存哈希；限制未使用邀请数量与过期时间 |
| `b_operations` | operationId、leaseId、type、requestFingerprint、state、currentStep、retryCount、nextRetryAt、lastErrorCode、created/updatedAt | `(leaseId, operationId)` 唯一；同 lease 的变更操作串行；不记任何秘密或 Cloudflare 原始敏感响应 |
| `b_resource_inventory` | environment、resourceType、resourceId、leaseId、firstSeen、lastReconciled、driftState | 对账清单；记录 Tunnel/DNS/ingress 的归属与漂移，不记录 token |
| `b_admin_audit` | actor、action、leaseId/codeId、reason、requestId、before/after 状态、result、createdAt | 所有管理写操作和危险补偿可追踪；秘密永不入审计 |
| `b_rate_limits` | bucket、windowStart、count | 仅用于低频控制面；按 IP、lease、激活码和全局任务限额；定期清理 |

KV 只保存可重建的开关或缓存。激活码消费、clientSecret 绑定、lease 状态与 operation 创建必须在同一 D1 原子写入路径完成。

### 5.3 核心状态机

```text
invited
  │ 有效激活码 + 首次原子 claim
  ▼
claimed ───────────────┐
  │ 资源分步收敛成功    │ Cloudflare/存储半失败：保持 claimed，有界重试
  ▼                    │
active ◄───────────────┘
  │ 用户主动释放 / 到期策略
  ▼
released
  │ 保留期内重新激活 → active
  │ 明确 retire / 保留期满并完成外部删除
  ▼
retired（终态，保留墓碑，不重新发放 hostname）
```

各状态的精确含义：

- **invited**：激活码和 lease/hostname 已预留，未创建 Tunnel、CNAME，也未持有 clientSecret。
- **claimed**：激活码已消费，clientSecret 已绑定，资源可能部分存在；所有重试都必须幂等。它不是可对外宣称的“已开通”。
- **active**：Tunnel、ingress、CNAME 和控制记录均已收敛，可以发放/恢复该实例 token。**不代表 cloudflared 当前在线**；连接器健康另记。
- **released**：用户或策略停止续期，hostname 在保留期内不给别人。默认保留资源以便恢复，但这不是安全撤销；安全事件走“立即阻断 + retire/轮换”流程。
- **retired**：公网 DNS 和 Tunnel 已按顺序删除或确认不存在，控制面保留墓碑。不能 renew，不能由新激活码接管旧 hostname。

管理封禁、 token 泄露等可设置与状态正交的 `blockedReason`/处置标记；不要在文档或实现中把 released 当成已阻断。

### 5.4 幂等规则

1. 首次 claim 携带激活码、插件生成的 clientSecret、claimRequestId、originPort 和请求指纹。
2. D1 原子完成“邀请有效 → code=claimed + lease=claimed + clientSecretHash + operation”。
3. 同一激活码的并发不同 clientSecret 只有一个能成功；其他请求不能重绑或读取资源。
4. 首次响应丢失后，插件用相同激活码、clientSecret 和 claimRequestId 重试；服务端识别相同操作，不再次消费邀请、不重复建 Tunnel。
5. 已绑定 lease 的恢复请求至少验证 clientSecret。只有 operationId 而没有 clientSecret 不能补发 token。
6. 同一 operationId 携带不同端口、不同 clientSecret 或不同请求指纹，返回 `idempotency_conflict`，不悄悄改变原操作。
7. 每步外部成功后尽快记录资源 ID；记录失败也由后续对账按确定性 Tunnel 名称和已有 operation 恢复。
8. renew 只更新必要状态和 lastSeen；同 lease 的 ingress 修改、token 恢复、release/retire 都进入串行操作，避免迟到响应覆盖新状态。

---

## 6. 控制面 API 设计

统一前缀建议为 `/api/b/v1`。所有请求走 HTTPS、`Cache-Control: no-store`，JSON 限制 4 KiB；秘密不放 query string。除首次 claim 外，clientSecret 使用 Authorization Bearer 或等价请求头，响应不泛化 CORS。

### 6.1 插件 API

| API | 鉴权与输入 | 成功语义 | 关键约束 |
|---|---|---|---|
| `POST /claim` | 首次：activationCode + clientSecret + claimRequestId + originPort；恢复：同一身份与幂等信息 | 已收敛时返回 leaseId、hostname、publicUrl、tunnel token、config/credentialVersion、renewAfter；进行中可返回 202 | 可重入；只在首次或明确恢复时返回 token；不返回账户 token |
| `POST /renew` | leaseId + clientSecret + operationId + originPort/pluginVersion/健康摘要 | 返回 state、hostname、renewAfter、configVersion、是否需恢复/轮换 | 默认不调用 Cloudflare 写 API、不返回 token；端口变化进入串行配置任务 |
| `POST /status` | leaseId + clientSecret | 返回控制面状态、publicUrl、blocked/retired、配置版本、建议动作 | 不返回 token、clientSecret、内部错误或其他租户信息；retired 可用 410 |
| `POST /release` | leaseId + clientSecret + operationId | 幂等进入 released，返回保留截止时间和恢复语义 | 不宣称切断数据面；插件先停本地 cloudflared |
| `POST /retire` | leaseId + clientSecret + operationId + 明确确认 | 202 启动回收；完成后 retired | DNS → Tunnel → 墓碑终态；重复请求安全；高危操作有审计 |
| `GET /health` | 无参数 | 只返回版本与基本存活 | 不返回账户、zone、配额明细、lease 或 token 状态 |

若实现选择全程同步 claim，也必须保留相同的 operationId 和恢复语义；202 只是避免多次 Cloudflare API 调用造成超时的推荐形态，不是放松幂等的理由。

### 6.2 管理 API

管理路由与插件路由分离，由 Cloudflare Access 和独立 service token 保护，至少包括：

- 创建/停用邀请批次、查看未消费/已过期邀请的元数据；
- lease/operation/resource 列表与详情，但不显示任何明文秘密；
- 暂停新 claim、暂停 Cloudflare 写任务、全局停止 B 控制面；
- 单 lease 阻断、恢复非泄露封禁、强制 retire、请求 token 处置；
- 手动触发对账、处理 DNS 冲突和未知孤儿；
- 查看审计、配额和失败任务。

高风险操作要求 reason、二次确认和 requestId；生产强制 retire、批量清理可逐步加双人复核。

### 6.3 初始限流与退避

以下为 **[估算]**，需在 PoC 校准：

| 对象 | 初始建议 | 目的 |
|---|---|---|
| claim / IP | 5 次/小时，突发另限 | 防止激活码爆破和账户资源消耗 |
| claim / 激活码 | 5 次失败/15 分钟后暂时锁定 | 一码只成功一次；失败也有成本 |
| 鉴权失败 / lease | 10 次/10 分钟 | 防 clientSecret 爆破与租户枚举 |
| renew / lease | 20 次/天；正常每 24 小时一次并加抖动 | 防止失控循环打满 D1 |
| status / lease | 60 次/小时 | 允许排障，禁止高频轮询 |
| release/retire / lease | 10 次/天 | 防恶意或故障重复任务 |
| Cloudflare 写任务 | 每 lease 串行；全局小规模有界并发，初始 2–5 | 遵守账户 API 速率并限制半失败面 |

429 必须带 Retry-After；网络/5xx 采用有界指数退避和抖动，鉴权失败、冲突、配额耗尽不自动重试。

### 6.4 错误契约

统一返回机器可读 `code`、`retryable`、`requestId`，必要时加 `retryAfter`；不回传 Cloudflare token、账户/zone ID、秘密、堆栈或原始上游报文。

| HTTP | code 示例 | 插件动作 |
|---|---|---|
| 400 | `invalid_request`、`invalid_origin_port` | 修正输入，不自动重试 |
| 401/403 | `auth_failed`、`lease_blocked` | 不循环重试；进入恢复/客服流程 |
| 409 | `activation_already_claimed`、`idempotency_conflict`、`state_conflict` | 同操作可按契约恢复；不同身份禁止重绑 |
| 409 | `dns_conflict`、`resource_conflict`、`unknown_resource` | 不覆盖外部资源，转人工对账 |
| 410 | `activation_expired`、`lease_retired` | 停止重试，提示新邀请或重新配对 |
| 429 | `rate_limited` | 遵守 Retry-After |
| 503 | `capacity_exhausted` | 停新增；不由插件反复试配额 |
| 502/503 | `cf_api_unavailable`、`storage_unavailable`、`provisioning_incomplete` | 有界退避；已有本地 B 数据面不因此重启 |

---

## 7. Cloudflare API token 最小权限、secret 保管与审计

### 7.1 最小权限

**[参考项目证据]**参考部署注释使用：

- Account → **Cloudflare Tunnel: Edit**，只限服务方指定账户；
- Zone → **DNS: Edit**，只限 B 使用的指定 zone。

**[待验证]**实施时以当前 Cloudflare token 模板和实际 API 调用验证权限名称及是否还需只读 Zone 权限。若必须增加，只增加已证明必要的 Read，不直接扩大为账户或全 zone 管理。

明确不授予：Workers 写、其他 zone DNS 写、Registrar、SSL/TLS 管理、Cache Purge、账户成员/账单、Zero Trust 全域写、日志读取等与 B 无关权限。A 的 `Account Analytics: Read` token 与 B 写 token 分开，不复用。

如平台支持，增加 token TTL、客户端 IP 限制、定期轮换和 staging/prod 分离。账户和 zone ID 属敏感配置，不出现在插件响应、公开文档或普通日志中。

### 7.2 secret 保管

- 账户 API token 只放 B Worker 的 Workers Secret；不进 git、D1、KV、插件包、前端、二维码、错误正文或命令行。
- 激活码/clientSecret 在 D1 只存 HMAC；tunnel token 默认不落 D1/KV。
- Worker 日志禁止记录 Authorization、请求正文、Cloudflare 原始响应全文和 token 读取结果。
- 部署权限与生产 Worker 代码同样属于信任边界：限制 CI/人员、启用 2FA、评审依赖和部署变更。
- 轮换顺序：创建同范围新 token → 更新 staging 验证 → 更新生产 secret → 验证 claim/对账 → 撤销旧 token → 检查审计。不能让新旧两个高权限 token 长期并存。

### 7.3 审计

每次 Cloudflare 变更至少关联：operationId、leaseId、动作、资源类型与资源 ID、结果、requestId、操作者和时间。审计不记录 token。Cloudflare 账户审计日志与我方 D1 审计互相补充；对账要识别“控制台手工改动”和“未知 API 使用”。

---

## 8. Tunnel、ingress、CNAME、token 的全生命周期

### 8.1 创建与收敛顺序

**[工程推断]**每个 lease 使用确定性 Tunnel 名称和固定 hostname，按以下顺序收敛：

1. **前置检查**：验证 lease=claimed、clientSecret、operation、配额和 B 域路由；任何失败都发生在创建资源前。
2. **Tunnel**：优先按 D1 tunnelId 查；无 ID 时按受控精确名称查。不存在才创建 remote-managed Tunnel。发现同名但无法证明归属的资源，报 `resource_conflict`，不直接接管。
3. **记录检查点**：创建或确认 Tunnel 后立即保存 tunnelId。若创建成功但响应丢失，重试按确定性名称找到它，而不是盲建第二个。
4. **ingress**：写入固定 hostname → `http://127.0.0.1:<合法端口>`，末尾保留 `http_status:404` catch-all。保存 configVersion；不得允许插件提交任意外部 service、回环以外管理目标或额外 hostname。
5. **DNS 冲突检查**：查询同名全部相关记录类型。没有记录才创建 proxied CNAME；只有能证明属于本 lease 的漂移 CNAME 才修复。任何未知 A/AAAA/CNAME/TXT 等冲突均停止，不覆盖。
6. **CNAME**：目标必须是本 lease 的 `<tunnel-id>.cfargotunnel.com`，保存 dnsRecordId 和 target。
7. **token**：资源准备完成后才读取 tunnel token。读取失败保持 claimed/恢复中，不发送“已开通”。
8. **完成**：D1 记录全部资源 ID 并转 active，再以 no-store 响应下发必要凭据。响应丢失由同身份、同幂等操作恢复。

外部 API 失败时，优先保留检查点并有界重试，不遇到临时 5xx 就立刻删除重建。永久失败只清理能证明属于本 lease 的资源；无法证明归属的资源进入隔离清单。

### 8.2 token 的读取、恢复、轮换与撤销

- 普通 renew 不读取、不返回 token；减少秘密暴露和 Cloudflare API 调用。
- 本地 tunnel token 丢失但 clientSecret 仍在，可发起明确恢复操作；服务端验证后按已验证的平台能力重新提供。
- **再次读取同一个 token 不是轮换。**Cloudflare 是否提供当前可调用的 rotate/revoke 能力、旧 token 何时失效、连接如何受影响均为 **[待验证]**。
- 若没有可验证的轮换接口，泄露处置只能先阻断公网入口，再通过删除并重建 Tunnel、更新 CNAME/ingress、发放新 token 完成换新。此过程有中断，必须演练。
- token 泄露时先移除/阻断 CNAME 或采取等价平台级阻断，再处理 Tunnel；仅停止我方插件进程不能阻止持有 token 的攻击者在别处运行 cloudflared。
- clientSecret 泄露按控制面泄露处置：阻断控制操作、轮换 clientSecret，并检查是否发生过 token 恢复、端口改变、release/retire；若 tunnel token 也可能暴露，按两类同时泄露处理。

### 8.3 release 与 retire

- release 是产品层的“停用/保留”，默认保留固定 hostname 和资源一个明确宽限期；插件停止本地连接器，服务端停止正常 renew。
- 若产品按钮文案是“立即关闭公网”，则必须同时有真实入口阻断动作，不能只调用参考式 release。
- retire 的顺序固定为：**删除/阻断本 lease CNAME → 删除本 lease Tunnel → 确认外部资源不存在 → 标记 retired 并保留墓碑**。
- 任一步失败都保留操作和剩余资源 ID，下一轮继续；已不存在的资源视为该步成功。D1 更新失败不能造成无记录孤儿。
- retired 的 hostname 不重新分配。确需同名恢复属于新 provisioning 事件，必须重新签发凭据并审计，不是撤回墓碑。

### 8.4 孤儿对账

对账同时做两个方向：

| 发现 | 处置 |
|---|---|
| D1 有 claimed，Cloudflare 缺部分资源 | 按 operation 继续收敛；不重复创建已有部分 |
| Cloudflare 有受控前缀 Tunnel/CNAME，D1 无对应有效 lease | 先隔离和告警；在最近 operation 宽限期内不删除，之后仅对可证明孤儿者按 retire 顺序清理 |
| D1 有 active，但 CNAME 指向别的 Tunnel | 标 drift，暂停该 hostname 的恢复/发 token；确认归属后修复 |
| ingress 端口/hostname 与 D1 不符 | 记录 drift，按最新合法操作收敛；无操作时人工确认 |
| 同名未知记录或非本服务资源 | 永不自动覆盖/删除，转人工 |
| retired 墓碑仍有外部资源 | 继续回收并告警 |
| released 超保留期 | 按已公布政策通知并 retire；不能静默无限占配额 |

建议增量对账每小时、全量对账每日执行，实际频率按 Cloudflare list API 分页与限流调整。清理任务必须有本次上限、全局并发和失败退避，不能一次故障形成删除风暴。

### 8.5 1,000 Tunnel 配额与 DNS 冲突

**[待验证]**任务给定 1,000 Tunnel/账户作为规划基线；需要确认当前账户实际额度、是否包含已逻辑删除未清理对象、是否跨环境共享，以及 Workers/Zero Trust 套餐是否影响它。

容量计数：

```text
占用数 = active + claimed + released 保留 + 已发现孤儿 + 本账户其他/测试 Tunnel
可用余量 = 实际配额 - 占用数
```

- 每个 lease 一条 Tunnel、一个固定 hostname、一条 CNAME、一个有序 ingress 配置。
- DNS 名称冲突必须在创建 Tunnel 前做一次预检、创建后写入前再检查，减少与人工/并发操作的竞态；第二次冲突需回收或隔离刚创建的自有资源。
- 同名不同 Tunnel、同一 Tunnel 被多个 lease 引用、dnsRecordId 与目标不匹配均视为异常，不自动选择“看起来最新”的资源。

---

## 9. 插件端方案

### 9.1 激活流程

```text
用户选择 B 并阅读服务边界
  → 输入一次性激活码
  → 插件检查本机端口和现有 named/quick 状态
  → 生成并安全保存 clientSecret、claimRequestId
  → claim / 等待资源收敛
  → 保存固定 hostname 与 tunnel token
  → 自动准备并校验 cloudflared
  → 以环境变量启动，不带 token 命令行参数
  → 固定公网 URL 端到端健康检查
  → 显示固定 hostname 的配对二维码
```

claim 成功但 cloudflared 下载失败时，不重复建 Tunnel；重试下载或让用户选择 A/C。只有固定公网 URL 实际可用后，才把条目标为 active。

### 9.2 本地 token 与 clientSecret 存储

- 分别存放于 `$DSH_HOME/dsh-mini-remote/` 下的专用受限文件或等效系统安全存储；Unix 文件权限 `0600`，Windows 使用仅当前用户可读的用户配置目录 ACL。
- 原子写入；不进入 settings.json、git、同步目录、二维码、浏览器状态、诊断包或普通备份。
- clientSecret 只用于插件到 B Worker 的 TLS 请求，绝不传给 cloudflared。
- cloudflared 的 tunnel token 通过**只传给子进程的 `TUNNEL_TOKEN` 环境变量**或当前版本官方支持的无参数秘密文件机制提供；不得把 token 放在 `cloudflared ... --token ...` 命令行，避免进入 ps、进程命令行和崩溃日志。
- 不使用系统级持久化环境变量命令保存 token。环境变量只是降低命令行暴露，不代表能防同一账户或管理员读取。
- 对日志、异常和诊断导出同时过滤原始值与常见编码形式；本地身份损坏时明确提示，不后台静默生成新 hostname。

`TUNNEL_TOKEN` 在目标 cloudflared 版本和各平台上的行为为 **[待验证]**；若改用 token 文件，仍须满足不进命令行、权限受限和可轮换。

### 9.3 cloudflared 生命周期

- 复用统一 TunnelSupervisor 思想：start、probe、retry、stop、状态快照和代次保护只有一套；B 不另造与 quick/named 冲突的进程树。
- 启动前确认本地插件端口有效；固定 hostname、originPort 和 credentialVersion 进入目标指纹。
- 正常重启复用已有 hostname/token，不重新 claim；启动后做轻量 renew/status，普通 renew 不重发 token。
- token 无效、401/403、资源冲突不进入无限重启；网络/5xx 采用有界退避。
- 切换路线、release、retire 或卸载时停止完整子进程树，取消在途请求和计时器；迟到的 claim 响应不能复活旧连接器。
- 自动下载只使用受控官方发布源、固定/允许版本、架构匹配、HTTPS 和校验和/签名校验；不能执行由任意激活响应指定的下载地址。
- 同一实例避免重复启动多个 cloudflared。若未来主动支持多副本 HA，需要独立设计，不把多副本误当成泄露检测机制。

### 9.4 固定 hostname 与配对二维码

二维码仍是 `https://<固定 hostname>/mini?token=<现有短期配对token>` 的产品形态，但：

- 不包含 activationCode、clientSecret、tunnel token 或账户信息；
- hostname 固定不代表二维码中的应用配对 token 永久有效，其 TTL 沿用插件现有规则；
- B 重启和 cloudflared 重连不改变 Origin，书签和 host-only Cookie 可保留；
- 切换 A、C、裸 quick 或自建 frp 会改变 Origin，必须给用户新二维码并说明重新配对。

### 9.5 失败回退 A / C

| 场景 | 插件行为 |
|---|---|
| 首次激活失败，尚无 B 数据面 | 显示可读原因；用户确认后可启用 A 或填写 C，不重复消耗邀请 |
| B 控制面故障，但本地 named Tunnel 健康 | 继续现有 B；显示控制面降级，不自动换 Origin |
| B 数据面故障 | 有界诊断；提供 A/C 新入口，不承诺旧固定书签自动跳转 |
| 本地 token 丢失但 clientSecret 在 | 走明确恢复，不新建第二个 Tunnel |
| clientSecret 丢失 | 控制面恢复需管理员验证或新邀请；不得仅凭公开 leaseId 重置 |
| B 被 retired / 封禁 | 停止重试；清理本地失效凭据前保留必要提示，用户选择新路线 |
| A/C 回退也失败 | 保留 LAN、Tailscale、自建 frp 等现有路线和诊断，不循环自动切换 |

任何回退都不能把 B secret 发送给 A Worker 或用户 C 的端点，也不能未经用户确认把现有 C 静默迁到服务方账户。

---

## 10. 安全威胁模型与处置

| 威胁 | 影响 | 预防 | 发现与处置 |
|---|---|---|---|
| tunnel token 泄漏 | 攻击者可在别处运行 connector，顶替/分担固定 hostname 的源站流量 | 不下发无关方、不入 D1/日志/ps、受限本地文件、普通 renew 不重发 | 立即阻断 CNAME/公网入口，冻结 lease；按验证过的轮换或重建 Tunnel 换新；检查设备会话，必要时撤销全部手机会话 |
| clientSecret 泄漏 | 控制面越权、DoS、token 恢复、配置改变 | HMAC、限流、每请求归属校验、管理恢复另审 | 暂停控制操作并轮换；审计 renew/status/retire/端口变化；怀疑 token 也泄露时合并处置 |
| 账户 API token 泄漏 | 账户内所有 Tunnel 和指定 zone DNS 被创建、修改或删除 | 最小账户/zone 权限、Workers Secret、独立 B Worker、部署控制、2FA | 立即在 Cloudflare 撤销 token，暂停所有写任务和 claim；更换新 token，全量对账 DNS/Tunnel/ingress，检查审计与异常部署；按事件流程通知 |
| 激活码滥用/爆破 | 配额耗尽、孤儿增加、成本和客服压力 | 高熵、一次性、过期、HMAC、邀请批次、IP/码/全局限额、创建前配额检查 | 撤销批次、暂停新 claim；只清理证明归属的资源；已有 active 不批量误伤 |
| 租户越权 | 读取/修改他人 lease 或 token | leaseId + clientSecret；服务端固定 hostname/tunnelId；无任意资源 ID 输入；统一鉴权失败 | 记录脱敏审计、封禁来源；检查信息泄露和操作日志；漏洞未修复前关闭相关接口 |
| DNS 劫持/误改 | 固定域名指向攻击者或其他 Tunnel，钓鱼与数据泄露 | zone 最小权限、未知记录不覆盖、精确 target、漂移对账、注册商 2FA/锁定 | 先阻断错误 hostname，再恢复正确记录；轮换可能泄露的凭据，检查账户 token 和手工变更 |
| Tunnel 被顶替 | 合法 hostname 由攻击者 connector 提供内容 | token 保密、限制恢复、异常健康监测 | 不假设 newest wins；按 token 泄露处理，阻断入口并轮换/重建 |
| ingress 被改成外部服务 | 服务被用作开放代理或攻击内网/外网 | 只接受整数回环端口；服务端生成 ingress；catch-all 404；配置对账 | 立即恢复受控配置、封禁 lease，检查账户 token 与客户端操作历史 |
| 手机配对/本机管理绕过 | 公网用户获得插件控制权限 | 沿用应用鉴权；不因来自 cloudflared 或回环地址就信任；公网 Host 不加入本机白名单 | 撤销设备会话、关闭公网入口、修复门禁；专项测试 `/mini/api/*`、`/mini-remote/*` |
| Worker/D1 供应链或日志泄露 | 多凭据、多租约同时暴露 | 最小日志、依赖与部署审查、独立环境、权限复核 | 停止写入和发码，撤销受影响凭据，保存最小调查证据并按保留政策清理污染数据 |

### 10.1 日志和隐私底线

B 控制面只记录必要元数据：时间、requestId、操作、lease 散列、状态、错误分类、资源 ID 和延迟。默认不记录来源 IP 明文、激活码、clientSecret、tunnel token、手机配对 token、Cookie、Authorization、业务 query/body 或用户文件内容。

B 数据面不经过我方 Worker，因此我方不能用 Worker 日志宣称掌握全部业务请求；可用性来自插件自愿上报的健康摘要、Cloudflare Tunnel 指标和合成探测。隐私文案要分别说明控制面与 Cloudflare 数据面的责任边界，不宣传“零记录”“绝对安全”或“端到端加密”。

---

## 11. 成本与承载量

### 11.1 与 A 容量模型的根本差异

A 的每部手机业务请求都消耗 Worker 请求，并可能读 D1/KV；B 配对后不再如此。B 的主要量级变为：

- 每实例一条 Tunnel、一条 CNAME、一份 ingress；
- 每实例每日少量 renew/status；
- 首次 claim、恢复、release/retire 和对账的 Cloudflare API 调用；
- 账户级 1,000 Tunnel 配额、运营管理、数据面 Tunnel/Zero Trust 条款与客服。

因此不能沿用 A 的“442 请求/实例/日”计算 B 数据面，也不能由“B 不走 Worker”推导出“Cloudflare 数据面免费且无限”。

### 11.2 控制面请求估算

**[估算]**假设每个常在线实例平均每日：启动/恢复 1 次、周期 renew 1 次、status 1 次，共 3 个 Worker 请求；忽略小规模管理请求，另加 30% 重试和监控余量。

| 实例数 | 基础控制请求/日 | 加 30% 后/日 | 基础控制请求/30 天 |
|---:|---:|---:|---:|
| 100 | 300 | 390 | 9,000 |
| 700 | 2,100 | 2,730 | 63,000 |
| 1,000 | 3,000 | 3,900 | 90,000 |

按 A 文档的 Workers Free 100,000 请求/日规划基线，单看平均请求数，B 控制面远低于 A 数据面；但这不是“Free 必定承载 1,000”的结论，因为还要验证：

- claim/对账的 CPU、外部 API 等待与并发；
- D1 读写行、存储、cron 和日志限额；
- 邀请集中发放造成的日内突发；
- Cloudflare Tunnel 自身配额、条款、连接与带宽；
- 运营人力和安全事件。

Paid Workers 的 A 规划基线为 US$5/月、含 1,000 万请求/月，仅供复核起点；**[待验证]**实际套餐、D1/KV/日志价格和 Zero Trust/Tunnel 费用。Paid Workers 不自动增加 Tunnel 数。

### 11.3 Cloudflare API 工作量

**[估算]**一次顺利 claim 约需 5–7 次账户/zone API 调用：查/建 Tunnel、写配置、查/建 DNS、读取 token；冲突、分页、重试和对账会增加。

- 集中发放 100 个激活码，基础约 500–700 次 API 调用，必须分批排队，不能同时并发打满。
- renew 不应再执行完整 claim；否则每次启动都放大账户 API 和 token 暴露。
- 全量对账按分页 list 调用估算，不从“每 lease 一次”简单线性假设；实际以 API 返回和限流为准。

### 11.4 配额触发线

以下为 **[工程推断/估算]**的初始运营阈值：

| 信号 | 软线 | 更严处置 |
|---|---|---|
| 未删除 Tunnel 占用 | 600 告警并核对真实配额；700 停止扩量评审 | 800 停发新邀请并加速 released/孤儿清理；900 硬停新 claim，保留恢复与处置余量 |
| released/孤儿占比 | 超过总占用 10% 告警 | 超过 20% 暂停新增，先查回收为什么失效 |
| claim 失败 | 15 分钟成功率低于 95% 或冲突突增 | 暂停新 claim，保留现有 active，不自动重建整批资源 |
| Cloudflare API | 429/5xx 增加、任务积压超过 15 分钟 | 降低并发、延长退避，暂停非必要对账和新增 |
| Workers/D1/日志 | 达当前套餐 60% 告警 | 80% 停止扩量并评审 Paid/优化；不用数据面 0 请求掩盖控制面超限 |
| 客服/运营 | 工单、手工对账或泄露事件超过值班能力 | 停止发码和扩量，先修自恢复与运营闭环 |

达到 1,000 才处理就是故障。任何环境的共享占用都必须算入，staging 不应悄悄吃生产余量。

### 11.5 成本清单

| 成本项 | B 的估算口径 |
|---|---|
| 域名/DNS/TLS | 复用已有 zone 可降低增量；独立 zone 可能增加注册续费。证书覆盖和 DNS 增值项待核 |
| Workers | 只承担控制面；平均请求低，但 Paid/Free 由真实用量、CPU、日志和运营需求决定 |
| D1 / KV | D1 存 lease/操作/审计；KV 可选且不在数据热路径。按真实读写和保留期核价 |
| Tunnel / Zero Trust | 套餐、配额、连接、带宽和条款均需当前控制台/官方文档确认，不填虚构单价 |
| 监控/日志/外部探测 | 控制面日志、合成 B 链路、告警和保留期；不记录手机业务正文 |
| 工程与安全运营 | 部署、对账、token 轮换、账户审计、泄露响应、版本升级和回滚 |
| 客服与合规 | 邀请、连接失败、域名/地区网络、身份恢复、删除请求、隐私和可能的公开服务合规 |

单位经济至少同时看“每 active lease 月度基础设施成本”和“每 active lease 月度运营/客服时间”。Tunnel 数少而人工处置多，仍可能不可持续。

---

## 12. 失败模式与回滚

| 失败场景 | 系统状态与立即动作 | 恢复/回滚 |
|---|---|---|
| 激活码已消费，Cloudflare 尚未创建 | lease=claimed + operation 已存在 | 同 clientSecret/claimRequestId 重试，不重新发码、不重新消费 |
| Tunnel 创建成功但响应丢失 | D1 可能尚无 tunnelId | 按确定性名称查回；验证归属后记录，不盲建第二个 |
| ingress 成功、CNAME 失败 | 资源部分存在，保持 claimed，不发“开通成功” | 临时错误有界重试；永久冲突只清理证明自有的资源或转人工 |
| DNS 已建、token 读取失败 | 不发 token，记录可恢复操作 | 重试 token 获取；不要删除重建整条 Tunnel |
| Cloudflare 全部成功、D1 完成写入失败 | 可能形成外部孤儿 | 依靠已有 claimed operation 和名称/资源清单对账；禁止无记录直接返回成功 |
| active 响应在途中丢失 | 服务端 active，插件未收到 token | 同身份同操作恢复；不重建 Tunnel，不放开激活码给另一身份 |
| 插件收到 token 后崩溃 | 本地已有受限身份文件 | 重启复用，不重复 claim；文件不完整按损坏流程处理 |
| token 无效 | 本地连接器报鉴权/连接错误 | 有界检查 status 和版本；明确恢复或轮换，不自动反复删除重建 |
| Tunnel 被外部删除 | 固定 hostname 失效 | 对账确认后按同一 lease 重建、更新 CNAME 和 token；全程审计 |
| CNAME 被改/存在未知冲突 | 可能劫持或路由错误 | 先阻断/隔离，不覆盖未知记录；确认所有权后修复 |
| Cloudflare API 故障 | claim/变更失败，已有 B 数据面可不受控制面影响 | 暂停新任务、降低重试；插件继续使用健康本地 B，必要时用户选 A/C |
| Cloudflare 边缘/Tunnel 故障 | B 数据面不可用 | 公告依赖故障；用户明确切 A/C/其他路线，旧书签不自动迁移 |
| B Worker 或 D1 故障 | 控制面不可用，数据面仍可独立运行 | 不擦本地 token、不重启健康 tunnel；恢复后重放有界任务 |
| 配额耗尽 | 新 claim 无法创建 | 在创建前失败；清理 released/孤儿、评审扩容；现有 active 不批量删除 |
| 用户失联 | lastSeen 变旧，资源持续占用 | 按公布政策提醒、release、retire；无联系方式时也要有时限和公告，不静默无限保留 |
| clientSecret/tunnel token 均丢失 | 无法控制或安全恢复旧实例 | 管理员验证后 retire/重置或发新邀请；不得只凭 hostname 补发 |

### 12.1 回滚级别

- **L0 单任务**：重试或取消 claimed operation，保留可证明资源清单。
- **L1 单 lease**：阻断入口、限制恢复、release 或强制 retire；不影响其他用户。
- **L2 控制面降级**：关闭新邀请/claim 和 Cloudflare 写任务，已有健康 B 继续，status/release 尽量保留。
- **L3 插件路线回退**：用户主动选择 A/C/裸 quick/LAN/Tailscale/frp；重新扫码，明确 Origin 改变。
- **L4 服务终止**：停止发码，按政策批量 retire 和保留审计；不能只删 D1 让 1,000 个 Tunnel 成为孤儿。

B Worker 的版本回滚与 A Worker 完全分开。已 retired 的 Tunnel/token 不能靠代码回滚恢复，只能在明确新操作中重建同名资源并重新签发凭据。

---

## 13. 运营设计

### 13.1 最小运营后台

近期以 Cloudflare Access 保护的 admin API + CLI 即可，页面先做只读和低风险操作。必须能回答和执行：

- 邀请：批次、数量、过期、已消费/撤销元数据；默认不能回看明文；
- lease：状态、hostname、lastSeen、插件版本、配置版本、保留截止时间；
- 资源：tunnelId、dnsRecordId、target、ingress drift、最近对账；
- 操作：claimed 任务、当前步骤、重试次数、下一重试、脱敏错误；
- 处置：关闭新 claim、暂停写任务、单 lease 阻断/release/retire、请求轮换；
- 配额：active/claimed/released/孤儿/其他 Tunnel 的统一占用视图；
- 审计：操作者、reason、requestId、前后状态和 Cloudflare 结果。

后台永不显示账户 API token、clientSecret、tunnel token 或手机配对 token。直接改 D1/Cloudflare 控制台只能作为应急，也必须补审计；日常操作统一走 admin API。

### 13.2 指标与告警

| 维度 | 最小指标/告警 |
|---|---|
| 开通 | claim 成功率、202 积压、端到端开通耗时、每步骤失败、激活码失败率 |
| Cloudflare API | 状态码、429、延迟、写任务并发、token 读取失败、list 分页失败 |
| 资源 | 各状态 lease 数、实际 Tunnel 占用、DNS/ingress drift、未知孤儿、重复引用 |
| 租约 | lastSeen stale、released 将到期、retire 失败、墓碑仍有资源 |
| 数据面健康 | 插件健康摘要、固定 URL 探测、重连率、token 无效、地区错误；不以 Worker 请求代替 |
| 控制面 | Workers 请求/CPU/5xx、D1 错误、cron 成功、日志脱敏扫描 |
| 安全 | 鉴权爆破、跨租户失败、异常 token 恢复、非预期端口变化、管理员写操作 |
| 运营 | 工单分类、手工对账次数、回退 A/C 比例、单位实例支持时间 |

建立一个服务方自有的合成 B 实例，持续验证 claim 之外的固定 URL、HTTP、SSE/WebSocket 和重连；外部 `/health` 只能证明控制面存活，不能代表每条 Tunnel 健康。

### 13.3 清理 cron 与资源清单

建议任务：

- 每 1–5 分钟：处理少量 claimed/retire 操作，单 lease 串行、全局有界；
- 每小时：增量对账近期操作和异常 lease；
- 每日：全量 Tunnel/DNS 清单、released/失联政策、旧限流窗口和操作记录清理；
- 每日：配额、失败率、孤儿比例、客服和成本摘要；
- 定期：token 轮换、账户权限复核、泄露和全停演练。

资源清单至少包含 environment、leaseId、Tunnel 名称/ID、CNAME ID/target、ingress 版本、状态、owning operation、firstSeen/lastReconciled。未知资源只能隔离，不能因名称相似就自动删除。

### 13.4 客服与失联政策

标准工单至少覆盖：激活码无效/过期、claim 冲突、cloudflared 下载失败、token 无效、固定地址离线、DNS 冲突、身份文件丢失、重置/删除、地区网络不可用、回退 A/C。

诊断包由插件生成，默认只含版本、状态、错误码、时间和 lease 的短散列；用户确认后再提交，不含任何 secret、完整业务 URL 或文件内容。

失联期限、通知渠道、released 保留天数和 retired 后审计保留期都必须公开。没有用户联系方式时，不能承诺“提前通知一定送达”；应在激活前展示回收政策并保留可验证的服务公告。

---

## 14. 分阶段实施

| 阶段 | 范围 | 退出条件 | 回滚 |
|---|---|---|---|
| 0. 决策与官方验证 | 确认域/zone、路由隔离、API 权限、Tunnel 配额、token 轮换能力、clientSecret 方案、release 保留政策 | 所有 PoC 阻断项有实证；staging 与生产隔离；威胁模型评审通过 | 不创建生产资源，继续使用 A/C |
| 1. PoC | 独立 staging；1–3 个手工邀请；控制面、D1、Tunnel/ingress/CNAME、插件 token 存储和 cloudflared | 直接数据路径、幂等断点、DNS 冲突、release/retire、孤儿对账、无 secret 日志/ps 全通过 | 删除 staging 路由和自有资源；不碰 A/C |
| 2. 内测 | 默认关闭，仅 5–10 个邀请实例；真实 Windows/macOS、4G/5G/Wi-Fi；运行 7 天 | 无未解决 P0/P1；核心协议与重连达标；token/DNS/账户 token 泄露演练通过；客服可分类处理 | 停发码，单点或全局停控制面；用户明确回退 A/C |
| 3. 限量扩量 | 10 → 25 → 100 分批；至少 14 天真实指标；完善后台和对账 | 资源占用、孤儿比例、错误率、客服和单位成本均在阈值内；政策与合规无阻断 | 冻结新增，保留健康存量；必要时缩回邀请制 |
| 4. 扩量至软容量 | 100 → 700 分批，按实际 Tunnel 配额和 API 速率排队 | 每批均有容量/故障演练；未删除 Tunnel 低于软线；连续完整账期数据可承担 | 800/900 阈值自动停新增；不以降配造成存量故障 |
| 5. 公开或商业化复审 | 另行评审，不是默认终点 | SLO、隐私/条款、单位经济、值班、删除与泄露流程均成立 | 维持邀请或停止 B，保留 C/A 等路线 |

每阶段都必须实际演练“停止新 claim”“暂停 Cloudflare 写任务”“单 lease 阻断”“保留现有 active”“批量回收有界执行”，不能只写 runbook。

---

## 15. 验收测试清单

### 15.1 激活码、状态机与幂等

- [ ] 无码、错误码、过期码、撤销码均不能创建任何 Cloudflare 资源。
- [ ] 同一码被两个不同 clientSecret 并发 claim，恰好一个 lease 获胜；另一个不能重绑或读取 token。
- [ ] 同一 claim 在 D1 提交前后、每个 Cloudflare 调用前后、最终响应前后分别模拟崩溃；重试不重复消费邀请、不重复建 Tunnel。
- [ ] 相同 operationId + 不同请求指纹得到 `idempotency_conflict`；没有 clientSecret 不能凭 operationId 补发 token。
- [ ] invited → claimed → active → released → retired 的合法/非法跳转全覆盖；retired 不能 renew 或重新分配 hostname。
- [ ] active 只表示资源就绪，不被误报为 cloudflared 在线。

### 15.2 Cloudflare 资源与冲突

- [ ] Tunnel、ingress、CNAME 和 token 与正确 lease 一一对应；ingress 只有固定 hostname 到回环端口及 404 catch-all。
- [ ] 同名 A/AAAA/CNAME/TXT 和未知 Tunnel 均不被覆盖或接管；产生明确冲突和审计。
- [ ] 创建响应丢失后能按名称找回；重复 Tunnel、重复 DNS、错误 target、错误 proxied 均能检测。
- [ ] release 的产品语义与真实数据面行为一致，不谎称安全撤销。
- [ ] retire 在 DNS 删除、Tunnel 删除、D1 更新各点失败后均可继续；最终无外部孤儿且保留墓碑。
- [ ] D1 缺行、Cloudflare 多资源、配置漂移、退休残留、released 过期等对账正确；未知资源只隔离不自动删。
- [ ] 用隔离环境和配额替身验证 600/700/800/900 阈值及真实 quota 错误；不在生产制造 1,000  Tunnel 耗尽事故。

### 15.3 凭据与安全

- [ ] 响应、D1/KV、Workers 日志、审计、浏览器 payload、二维码、诊断包和异常文本均不含账户 token、激活码明文、clientSecret 或 tunnel token。
- [ ] Windows/macOS/Linux 进程列表看不到 tunnel token；Unix 文件为 0600，Windows ACL 仅授权用户可读。
- [ ] 普通 renew/status 不返回 tunnel token；跨 lease 的 claim/renew/status/release/retire 全部失败且不形成存在性 oracle。
- [ ] token 泄漏演练能先阻断公网，再完成经验证的轮换或重建；旧 token 不再能作为有效新连接凭据。
- [ ] clientSecret 泄漏能独立冻结和轮换，并审计是否发生过 token 恢复。
- [ ] staging 账户 API token 泄漏演练能立即撤销、停写、换 token、全量对账；不影响 A 的 analytics token。
- [ ] 公网 Host、Forwarded 头和回环来源均不能绕过插件应用鉴权或仅本机管理路由。

### 15.4 插件、协议与回退

- [ ] 用户只需激活码即可完成 B，不需要 Cloudflare 账户或控制台。
- [ ] cloudflared 自动下载来源、版本、架构和校验和/签名有效；损坏下载不会执行。
- [ ] 杀进程、重启电脑、断网、控制面离线后恢复，固定 hostname 不变且不新建第二个 Tunnel。
- [ ] 手机 4G/5G 与 Wi-Fi 完成扫码、刷新、书签、指令和最终回复；固定域 Secure/host-only Cookie 正确。
- [ ] HTTP 路径/query、SSE 首帧与 30 分钟流式、WebSocket 文本/二进制/ping/pong/close、50 MiB 文件和设备撤销按现有产品语义通过。
- [ ] 配对后临时阻断 B Worker，已建立且健康的 B 数据面仍能工作；证明业务请求不依赖 Worker，同时控制面降级可见。
- [ ] B 数据面失败时提供 A/C 新二维码并说明重新配对；无自动跨 Origin/Cookie 迁移、无 secret 跨路线发送。
- [ ] A quick、C named、裸 quick、LAN、Tailscale、自建 frp 的现有配对和生命周期回归通过。

### 15.5 运营与故障

- [ ] 关闭新 claim 只影响新增，健康 active 继续；暂停 Cloudflare 写任务不妨碍必要的管理读取和紧急阻断。
- [ ] Cloudflare API、Worker、D1 分别故障时，插件不会擦除本地 token 或无限重启健康连接器。
- [ ] 外部删除 Tunnel、修改 CNAME/ingress、用户失联和配额耗尽均有可执行 runbook 和实际恢复记录。
- [ ] 后台不能查看秘密；所有管理写操作有 actor、reason、requestId 和结果。
- [ ] 日志自动脱敏扫描、孤儿清理上限、告警、客服分类和删除请求流程通过。

---

## 16. 主要风险与不做事项

1. 不把“服务方代建”理解为一次性技术脚本；它是持续的账户安全、DNS、token、回收和客服责任。
2. 不在 A Worker 中直接叠加高权限 B token，不让 B 域名继续命中 A 数据面路由。
3. 不公开匿名 claim，不把激活码放进 URL/二维码，不沿用 A 运维台“邀请码明文可回看”作为 B 默认。
4. 不把 release 当安全 revoke，不把再次 GET token 当轮换，不把多个 connector 当 newest-wins。
5. 不自动覆盖同名 DNS，不自动删除未知 Tunnel，不在配额耗尽后让插件无限重试。
6. 不在命令行传 tunnel token，不把秘密写进设置、日志、诊断或 git。
7. 不做 B ↔ A ↔ C 的静默热切换，不承诺旧书签跨 Origin 自动恢复。
8. 不引入 DO bridge、多区域、复杂计费或公开 SLA 作为 PoC 前置。
9. 不宣传 E2EE、永久免费、国内必然可达或 1,000 个可长期无维护用户。

---

## 17. 开放问题：需要用户拍板或实证后才能定

以下均未定，不能在实施时默默选择：

### 17.1 产品与域名

1. **生产域和 zone**：是否确认使用截图中的 `jiulingssh.xyz`？其所有权、DNS 托管、注册商锁和现有记录是否满足？若与 A 通配路由冲突，是否接受独立 zone？
2. **B 的产品定位**：替代部分 A 高价值用户、与 A 并列供选择，还是未来成为默认？建议先并列邀请，不默认迁移。
3. **开通粒度**：一码对一台电脑、一个 DSH profile，还是允许同一用户多实例？这直接决定 Tunnel 配额和客服模型。
4. **本地端口**：自动发现当前插件端口，还是让用户确认？端口变化是否允许 renew 自动改 ingress？建议只允许受控端口变化并审计。
5. **回退默认值**：首次 B 失败默认建议 A 还是 C？建议根据用户是否已有 Cloudflare 配置提示，由用户确认，不自动切换。

### 17.2 凭据与恢复

6. **clientSecret 生成方**：本文推荐插件本地生成、服务端存哈希。若必须严格实现截图“服务方同时签发 token + clientSecret”，需要额外 claimRecoveryKey 或可证明等价的响应丢失恢复协议；由用户确认采用哪种。
7. **tunnel token 轮换能力**：当前账户/API 是否支持真正 rotate/revoke？若只能重建 Tunnel，是否接受短暂中断和相应自动化？PoC 必须给出实测结论。
8. **身份找回**：clientSecret 丢失时，管理员凭何种用户证明恢复？是否需要用户账号/邮箱/恢复码？不能凭公开 hostname 或一封无验证邮件补发。
9. **激活码是否可回看**：本文默认只显示一次、D1 只存哈希。若运营必须可回看，需要单独的加密保管、访问审计和泄露模型，不能直接复制 A 的明文列表。

### 17.3 生命周期与配额

10. **released 保留期**：7、30 还是 90 天？保留期内 CNAME/Tunnel 是否全保留，还是先断公网只保留可重建清单？这是成本、安全和体验的取舍。
11. **失联回收**：多久无 renew 视为失联？通过什么渠道提醒？retired 墓碑和审计保留多久？必须在发码前公开。
12. **1,000 配额**：当前账户真实上限是多少？released、孤儿、staging 是否共享？能否提高、审批周期多长？是否独立生产账户？
13. **DNS 冲突人工策略**：用户声称拥有某已有 hostname 时，是否允许管理员接管？需要什么证据和双人复核？默认永不自动覆盖。

### 17.4 技术与运营

14. **控制面部署边界**：是否接受独立 B Worker + 独立 D1/secret 的推荐？若坚持复用 A Worker，需单独证明账户 token 暴露面和回滚可接受。
15. **cloudflared 支持矩阵**：支持哪些 OS/架构、最低版本、更新频率和下载源？各平台无命令行 token 的方式需实测。
16. **套餐和预算**：Workers Free/Paid、D1/KV、Zero Trust/Tunnel、日志、域名与人力预算由谁承担？达到何阈值转 Paid 或停止新增？
17. **运营主体与合规**：谁持有 Cloudflare 账户和域名、谁响应安全事件、谁处理隐私/删除？公开或收费前的条款、隐私、备案/跨境要求需专业审查。
18. **可用性承诺**：是否只做邀请制无 SLA，还是未来提供付费 SLO？没有至少 30 天真实数据和值班能力前，不做可用性数字承诺。
19. **pair-server 兼容性**：是否只借鉴思路，还是必须兼容其 API/本地文件？若要求兼容，必须先取得源码和协议；当前按独立设计，不假设兼容。

---

## 18. 最终建议

先做第 17 节中影响安全与资源模型的六项前置：**域名/路由隔离、clientSecret 生成与恢复、真实 token 轮换能力、released/失联政策、实际 Tunnel 配额、独立 B 控制面与最小权限**。这些不定，写实现只会把歧义固化成 orphan 和凭据事故。

PoC 的成功标准不是“手机终于能打开页面”，而是同时证明：

- 一码只能开一个实例，任何断点重试都不会重复建 Tunnel；
- B 数据面确实不经 Worker，控制面故障不拖垮健康存量；
- token 不进日志/ps，泄露后能真实阻断并换新；
- DNS 冲突不覆盖他人资源，release/retire/孤儿对账可恢复；
- A/C 回退需要新 Origin 时，用户看得懂、能重新配对；
- 配额、审计、客服和成本有人负责。

以上全部通过后，B 才进入 5–10 实例内测；否则继续使用 A/C，不拿生产账户和用户固定地址做未验证实验。
