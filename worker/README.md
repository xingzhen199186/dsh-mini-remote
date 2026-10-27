# A 固定中继 Worker（Phase 1 控制面）

> 当前只实现身份、邀请、target 登记、撤销和运营开关；**不代理手机流量**。
> 数据面（HTTP/SSE/WebSocket/文件）在 Phase 2。

## 结构

```text
worker/
  src/index.js          控制面入口
  migrations/0001_init.sql
  wrangler.jsonc        staging 模板，D1/KV id 是占位符
  scripts/relay-admin.mjs
```

## 绑定与 secret

| 名称 | 类型 | 用途 |
|---|---|---|
| `DB` | D1 | 身份、邀请、限流、审计 |
| `RELAY_KV` | KV | target（45 分钟 TTL）和运营配置 |
| `RELAY_PEPPER` | Secret | 身份/邀请哈希的 HMAC pepper |
| `ADMIN_TOKEN` | Secret | Phase 1 管理 API；生产前置 Cloudflare Access |
| `RELAY_PUBLIC_SUFFIX` | Var | 固定子域后缀；当前规划 `.dsh-mini-remote.com` |
| `RELAY_CONTROL_HOST` | Var | 控制面/后台主机名；当前规划 `relay.dsh-mini-remote.com` |
| `RELAY_INVITE_REQUIRED` | Var | `1` 时必须邀请；内测保持 `1` |

## 部署（staging）

```bash
npx wrangler d1 create dsh-mini-relay
npx wrangler kv namespace create RELAY_KV
# 把返回的 id 填进 wrangler.jsonc
npx wrangler d1 migrations apply dsh-mini-relay --remote
npx wrangler secret put RELAY_PEPPER
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

先不要绑定正式域名；用 `workers.dev` 或 staging 子域验证。

## 管理 CLI

```bash
export RELAY_ADMIN_URL=https://dsh-mini-relay.<account>.workers.dev
export RELAY_ADMIN_TOKEN=...
node worker/scripts/relay-admin.mjs invite --note "first batch"
node worker/scripts/relay-admin.mjs list
node worker/scripts/relay-admin.mjs revoke <id> --reason "abuse"
node worker/scripts/relay-admin.mjs config --registration=false
```

## 已验证

- 无邀请不能创建身份；
- 邀请只能消费一次；
- 同 id/secret 可刷新 target；
- 错误 secret 拒绝且不覆盖 target；
- 撤销后同 secret 不能恢复；
- unregister 只停 target，可恢复；
- target 白名单拒绝 http、端口、路径、query、IP、二级子域；
- 关闭注册不影响已有身份心跳；
- 同 id 超过 6 次/分钟 429；
- admin 无 token 401，列表不返回 secret。

## 未做

- 数据面代理；
- Cache API（Phase 2 接入）；
- Cloudflare Access JWT 校验（当前是 service token，生产前必须加 Access）；
- 精确全局配额；
- B/claim、DO bridge。
