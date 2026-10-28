# B 控制面（第一版）

独立的 Cloudflare Worker + D1，负责服务方代建命名隧道的控制面。**不代理业务流量**。

## 配置

- Worker：`dsh-b-relay`
- 控制面：`control.dsh-everywhere.com`
- 数据面：`<id>.dsh-everywhere.com`（命名隧道 CNAME）
- D1：`dsh-b-relay`（id `9c05b031-0c09-490f-97a4-b214084e50e0`）
- 已部署 Worker：`dsh-b-relay`（control.dsh-everywhere.com）
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


## 2026-10-28 首次真机 E2E

- 管理 API 建激活码：200；
- claim：200，state=active，返回 tunnelToken；
- cloudflared 用 `TUNNEL_TOKEN` + `--protocol http2 --edge-ip-version 4`；
- `<id>.dsh-everywhere.com/mini/api/version`：200；
- 说明数据不经过 A Worker；
- retire 第一次因 Tunnel 仍有活动连接返回 502；等待连接关闭后重试/直接清理成功。
