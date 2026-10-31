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

## 自助申请邀请码（2026-11-01）

公开申请页：

```text
https://control.dsh-everywhere.com/request
```

流程：

1. 用户填邮箱；
2. 服务器发 6 位验证码（10 分钟有效）；
3. 用户回填验证码；
4. 服务器创建 `invited` 租约并返回邀请码；
5. 用户把邀请码粘贴到 DSH「专属固定地址」里 claim。

限制：

- 一个邮箱只能申请一次（Gmail 会去掉 `+tag` 和点号再比较）；
- 同一 IP 30 天内最多 2 个申请；
- 一次性邮箱域名直接拒绝；
- 申请接口每 IP 每天 3 次、全局每天 100 次；
- 验证码最多试 5 次；
- 租约仍受 `SELF_SERVICE_CAPACITY = 900` 限制。

需要配置的 Secrets：

```text
RESEND_API_KEY      Resend 发信 key
TURNSTILE_SECRET    Turnstile 服务端校验 key（不配则不校验）
```

需要配置的 Vars：

```text
B_MAIL_FROM               发信人，例如 dsh-mini-remote <no-reply@dsh-everywhere.com>
B_TURNSTILE_SITE_KEY      申请页的 Turnstile site key；留空则不显示人机验证
```

管理接口：

```text
GET    /admin/b/v1/requests
DELETE /admin/b/v1/requests/{applicationId}
```

删除申请记录只删申请本身，不删已经生成的租约；已 fulfilled 的申请删掉后，同一邮箱/IP 可以重新申请（管理员显式操作）。

注意：同一 IP 30 天内最多 2 个，兼顾家庭/小团队；被误伤时由管理员删除申请记录。
