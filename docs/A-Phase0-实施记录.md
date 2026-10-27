# A 方案 Phase 0 实施记录

> 日期：2026-10-27。范围：只做 A 方案的 Phase 0 前置，不部署 Worker，不接生产中继，不改 C/frp/局域网行为。

## 已完成

### 1. quick 接入 TunnelSupervisor

- `lib/index.js` 的 quick 分支不再使用原来的“三次启动循环”；
- quick 和 named 都通过 `TunnelSupervisor` 启动、探测、退避重启、暂停；
- quick 的 URL 从 supervisor snapshot 同步，自动恢复产生新 URL 时不会漏掉；
- 删除了旧的 `startTunnelProbe` / `stopTunnelProbe` 定时器和旧状态变量；
- `tunnelStatusView()` 的 quick 分支改为读取 supervisor snapshot，返回 `phase`、`attempts`、`nextRetryAt`、`lastErrorKind`、`publicHealthy`；
- `bringTunnelDown()` 同时停止 quick/named 两个监督器，不再直接调用旧 handle 的 `stop()`。

### 2. originHostHeader

- `lib/tunnel.js` 新增 `quickTunnelArgs({ port, originHostHeader })`；
- 只有 `originHostHeader` 非空时才加 `--http-host-header`，普通 quick 不改变行为；
- `startTunnel()` 接受 `originHostHeader`；
- `TunnelSupervisor.targetFingerprint()` 把 `originHostHeader` 算进指纹，切换固定 Host 会重建连接器；
- settings 增加 `tunnel.originHostHeader` 默认值，暂不在 UI 暴露，留给 A 的 RelayProvider 接入时使用。

### 3. RelayProvider 纯状态机

新增 `lib/relay-provider.js`，不接生产 Worker：

```text
attach(quickUrl) -> 登记
detach({unregister}) -> 注销
snapshot()
```

已覆盖：

- 同 URL 去重；
- 新 URL 作废旧 generation，迟到响应不能覆盖；
- 5xx 指数退避；
- 429 遵守 `Retry-After`；
- 401/403 直接 paused，不自动重试；
- 15 分钟心跳；
- 45 分钟 TTL 过期；
- detach 尽力注销，且不复活；
- snapshot 不含 secret/token。

## 验证

```text
npm test                 1228/1228
node client/verify.mjs   147/147
```

新增/更新测试：

- `test/relay-provider.test.mjs`：10 项；
- `test/tunnel.test.mjs`：quick Host 参数；
- `test/tunnel-supervisor.test.mjs`：originHostHeader 进入指纹。

## 明确未做

- Worker、D1、KV、Cache API；
- 邀请/注册/撤销；
- RelayProvider 接生产 endpoint；
- pairing 固定 relay 条目；
- A 的设置页开关；
- B/claim、DO bridge、多区域。

这些按修订版方案进入 Phase 1 及以后。

## 风险与注意事项

- quick 现在也走监督器，行为变化最大的是“失败后自动重试”和“公网探测”；现有 quick/C/frp 回归已跑，但真机重启验证仍需在 DSH 重启后做。
- `originHostHeader` 字段暂未在 UI 暴露，普通用户不会看到，也不会误传。
- RelayProvider 只是状态机，尚未接任何 Worker，不会向外发请求。
