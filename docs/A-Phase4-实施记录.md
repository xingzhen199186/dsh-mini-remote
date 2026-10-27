# A 方案 Phase 4 实施记录（运营硬化开始）

> 日期：2026-10-27。范围：Free 邀请内测前的运营开关。尚未开放更多邀请。

## 已完成

### 数据面全局停用

Worker `handleProxy` 现在先读 `relay-config`：

- `proxyEnabled=false` 时，所有 `<id>.dsh-mini-remote.com` 返回 503 离线页，`x-relay-offline: disabled`；
- 不调用上游；
- 管理面 `/admin/*` 仍可用，便于恢复；
- `POST /admin/relay/v1/config {proxyEnabled:true}` 恢复。

### 已有运营能力

- 邀请码一次性；
- 关闭新注册；
- 单 id 撤销；
- 全局停代理；
- 审计；
- CLI。

## 验证

```text
npm test                 1250/1250
node client/verify.mjs   148/148
```

Worker 测试 15 项，新增“全局停代理不转发、管理面可恢复”。

## 当前状态

- A 控制面 200；
- 当前用户固定地址 `/mini/api/version` 200；
- Worker 版本已部署。

## 未做

- Cloudflare Access（当前 admin 仍用 service token）；
- 按 id 日配额/并发限制；
- 更多邀请实例；
- WebSocket/文件/长稳真机；
- 可视化后台。
