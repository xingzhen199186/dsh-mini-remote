# A 方案 Phase 2 实施记录（数据面初版）

> 日期：2026-10-27。范围：Worker 数据面初版 + staging 通配路由。**尚未做真实手机长连接验收。**

## 已完成

`worker/src/index.js`：

- 控制面只接受 `relay.dsh-mini-remote.com`；
- 数据面按 Host 解析 `<id>.dsh-mini-remote.com`；
- 未知 Host / 非法 id 返回 404，不代理；
- KV 无 target 返回 503 离线页；
- revoked 返回 410；
- 转发原路径和查询串；
- 重写 Host 到 quick 目标；
- 清理 `cf-*` / `x-forwarded-*` / `x-real-ip`；
- 保留 Origin/Referer；
- `redirect: manual`，不跟随外部重定向；
- 同 quick Origin 的绝对 Location 改写回固定 Origin；
- 请求体/响应体流式传递；
- WebSocket Upgrade 分支保留。

## Staging

- Worker：`dsh-mini-relay`
- 控制面：`https://relay.dsh-mini-remote.com/health` → 200
- 路由：
  - `relay.dsh-mini-remote.com` custom domain；
  - `*.dsh-mini-remote.com/*` zone route。
- **数据面还差一条 DNS 记录**：`*.dsh-mini-remote.com` AAAA `100::`，Proxied。
  没有这条，`<id>.dsh-mini-remote.com` 会在 TLS 握手阶段失败。

## 测试

```text
npm test                 1242/1242
node client/verify.mjs   147/147
```

Worker 测试 14 项，新增：

- 数据面按 Host 解析 id；
- 路径/查询串保持；
- Host 重写；
- 转发头清理；
- 无 target 503；
- revoked 410；
- 未知 Host/非法 id 不代理。

## 明确未做

- 真实手机经 `<id>.dsh-mini-remote.com` 的端到端；
- SSE 30 分钟、WebSocket 30 分钟、50 MiB 文件真机；
- Cache API 静态资源缓存；
- Cloudflare Access JWT；
- 插件 RelayProvider 接生产 endpoint（Phase 3）；
- 精确全局配额。


## 真实数据面验收（2026-10-27）

- 临时 quick 隧道：`https://catalyst-warranties-moment-egg.trycloudflare.com`
- 测试 id：`cdefghijklmnopqrstuvwxyzab`
- 固定地址：`https://cdefghijklmnopqrstuvwxyzab.dsh-mini-remote.com`
- 直接访问 quick：401（需要应用 token，说明隧道活着）
- 经固定地址 `/mini`：200，页面约 334 KB
- 经固定地址 `/mini/api/version?token=...`：200，返回 `dshVersion: 0.2.1-rc.3`
- 经固定地址 `/mini/api/stream?token=...`：200，`content-type: text/event-stream`，首个事件 `connected`，收到 `state` 数据
- 撤销测试 id 后固定地址：410
- 测试 id 已撤销，临时 quick 隧道已停止，无 cloudflared 残留

未测：WebSocket/远程窗口、50 MiB 文件、30 分钟长稳。
