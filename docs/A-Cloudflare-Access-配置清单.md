# A 中继：Cloudflare Access 配置清单

> 目标：给 `https://relay.dsh-mini-remote.com/admin/*` 加一层 Cloudflare 登录；
> 命令行仍用 Access service token + Worker 的 `ADMIN_TOKEN`。
>
> 当前状态：Worker 已支持读取 `Cf-Access-Authenticated-User-Email` 作为审计 actor；
> **Access 应用尚未在控制台创建**。

## 1. 创建 Access 应用

打开：

```text
https://one.dash.cloudflare.com/
```

路径：

```text
Access
→ Applications
→ Add an application
→ Self-hosted
```

填写：

```text
Application name：dsh-mini-relay admin
Session duration：8 hours（或 24 hours）
Application domain：relay.dsh-mini-remote.com
Path：admin
```

注意 Path 只填 `admin`，不要填 `/admin`，也不要填 `/*`；  
这样只保护后台，不挡 `/health` 和 `/api/relay/v1/*`。

## 2. 加登录策略

Policy：

```text
Action：Allow
Include：Emails
Value：xingzhen19910806@gmail.com
Login method：One-time PIN
```

保存后，浏览器打开：

```text
https://relay.dsh-mini-remote.com/admin/relay/v1/identities
```

应该先看到 Cloudflare 登录页，而不是 Worker 的 401。

## 3. 创建 CLI 服务令牌

```text
Access
→ Service Auth
→ Service Tokens
→ Create Service Token
```

名称：

```text
dsh-relay-cli
```

复制：

```text
Client ID
Client Secret
```

然后在刚才的 Access 应用里再加一条策略：

```text
Action：Service Auth
Include：Service Token
Value：dsh-relay-cli
```

## 4. 命令行使用

```powershell
$env:RELAY_ADMIN_URL='https://relay.dsh-mini-remote.com'
$env:RELAY_ADMIN_TOKEN=(Get-Content worker/.staging-secrets.json | ConvertFrom-Json).ADMIN_TOKEN
$env:RELAY_ACCESS_CLIENT_ID='<Client ID>'
$env:RELAY_ACCESS_CLIENT_SECRET='<Client Secret>'

node worker/scripts/relay-admin.mjs list
```

CLI 会同时带：

```text
CF-Access-Client-Id
CF-Access-Client-Secret
Authorization: Bearer <ADMIN_TOKEN>
```

## 5. 验收

| 检查 | 通过标准 |
|---|---|
| 浏览器打开 `/admin/...` | 先跳 Cloudflare 登录，不是直接 401 |
| 未登录直接 curl `/admin/...` | 被 Access 挡住 |
| CLI 带 Access 服务令牌 + ADMIN_TOKEN | 200 |
| CLI 不带 Access 服务令牌 | 被 Access 挡住 |
| `/health` | 仍然公开 200 |
| `/api/relay/v1/register` | 仍然只认 id/secret，不经过 Access |
| `<id>.dsh-mini-remote.com` | 不受 Access 影响，正常代理 |

## 6. 注意

- `workers_dev` 已关闭，避免绕过自定义域名直接访问 Worker；
- Worker 仍然要求 `ADMIN_TOKEN`，Access 是外层第二道门；
- 不要在 URL 里放管理密码；
- Access 服务令牌只存在本机环境变量或密码管理器，不提交仓库。
