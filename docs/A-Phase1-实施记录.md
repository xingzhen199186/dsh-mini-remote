# A 方案 Phase 1 实施记录

> 日期：2026-10-27。范围：Worker 控制面 + 最小运营控制。**未部署，未接数据面。**

## 已完成

### Worker 控制面

`worker/src/index.js`：

- `GET /health`；
- `PUT /api/relay/v1/register`；
- `POST /api/relay/v1/unregister`；
- `GET /admin/relay/v1/identities`；
- `POST /admin/relay/v1/invites`；
- `POST /admin/relay/v1/revoke`；
- `POST /admin/relay/v1/config`；
- `GET /admin/relay/v1/audit`。

### 数据

`worker/migrations/0001_init.sql`：

```text
relay_identities   身份、secret 哈希、状态、时间
relay_invites      邀请哈希、过期、使用时间
relay_rate_limit   固定窗口限流
relay_audit        管理动作审计
```

- secret / 邀请码用 HMAC-SHA-256 + `RELAY_PEPPER`；
- KV target TTL 45 分钟；
- 注册限流：30 次/IP/分钟、6 次/id/分钟；
- 撤销是墓碑，同 secret 不能恢复；
- unregister 只删 target，身份仍可由同 secret 恢复；
- 关闭注册只挡新身份，已有身份仍可心跳。

### 运营 CLI

`worker/scripts/relay-admin.mjs`：

```bash
node worker/scripts/relay-admin.mjs list
node worker/scripts/relay-admin.mjs invite --note "首批"
node worker/scripts/relay-admin.mjs revoke <id> --reason "abuse"
node worker/scripts/relay-admin.mjs config --registration=false
node worker/scripts/relay-admin.mjs audit
```

### staging 模板

- `worker/wrangler.jsonc`：D1、KV、vars、observability；D1/KV id 是占位符；
- `worker/README.md`：部署步骤、绑定、CLI、已验证项和未做项。

## 验证

```text
npm test                 1239/1239
node client/verify.mjs   147/147
```

Worker 测试 11 项，使用 Node 内置 SQLite 模拟 D1，覆盖：

- 无邀请不能创建；
- 邀请一次性；
- 同 secret 刷新 target；
- 错误 secret 不覆盖；
- 撤销后不能恢复；
- unregister 后可恢复；
- target 白名单；
- 关闭注册不影响老身份；
- 限流 429；
- admin 鉴权和列表不返回 secret。

## 明确未做

- 数据面代理（Phase 2）；
- Cache API（Phase 2）；
- Cloudflare Access JWT 校验（当前是 service token；生产前必须加 Access）；
- 精确全局配额；
- 插件侧 `RelayProvider` 接生产 endpoint（Phase 3）；
- 邀请 UI；
- B/claim、DO bridge、多区域。

## 部署前需要

- staging 域名；
- Cloudflare 账号的 Workers/D1/KV 权限；
- D1 和 KV 的实际 id；
- `RELAY_PEPPER`、`ADMIN_TOKEN` 两个 secret；
- 是否用 Cloudflare Access 保护 `/admin/*` 的决定。
