# B 控制面（第一版）

独立的 Cloudflare Worker + D1，负责服务方代建命名隧道的控制面。**不代理业务流量**。

## 配置

- Worker：`dsh-b-relay`
- 控制面：`control.dsh-everywhere.com`
- 数据面：`<id>.dsh-everywhere.com`（命名隧道 CNAME）
- D1：`dsh-b-relay`
- Secrets：`CF_API_TOKEN`、`B_PEPPER`、`ADMIN_TOKEN`

`CF_API_TOKEN` 权限：

```text
Account → Cloudflare Tunnel → Edit
Zone → DNS → Edit（只给 dsh-everywhere.com）
```

## API

- `POST /admin/b/v1/invites`（Bearer `ADMIN_TOKEN`）
- `GET /admin/b/v1/leases`
- `PUT /api/b/v1/claim`
- `POST /api/b/v1/status`
- `POST /api/b/v1/renew`
- `POST /api/b/v1/release`
- `POST /api/b/v1/retire`

## 测试

```bash
node --test worker-b/test/*.test.mjs
```

## 未完成

- 未部署；
- 30 天自动清理、后台对账、token 轮换未实现；
- `release` 只保留资源，不是公网入口安全阻断。
