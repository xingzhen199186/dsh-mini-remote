# relay-multi

让用户在自己的 Ubuntu VPS、自己的域名上，运行一套**多用户 FRP 中继**。

这是一份可安装的服务器软件，不是我们运营的第三条第公网线路：

- 服务器、域名、DNS、流量、证书都由用户自己持有；
- 我们只提供安装包、升级方式和文档；
- 控制面、管理后台、SQLite 都装在用户自己的机器上；
- 第一版每个租户一个独立 frps 进程、独立 token、独立 Nginx server block。

> 第一版是可跑通核心流程的骨架。它不会自动升级，不会自动修复租户，也不会替用户申请泛域名证书。

## 前提

- Ubuntu 22.04 或 24.04，x86_64 或 arm64；
- 一台干净的 VPS，80/443 可访问；
- 一个域名，例如 `relay.example.com`；
- DNS 至少有三类解析：

```text
relay.example.com              A/AAAA  → VPS
admin.relay.example.com        A/AAAA  → VPS
*.relay.example.com            A/AAAA  → VPS
```

第一版使用 HTTP-01 证书。租户第一次开通时，root helper 会为：

```text
<id>.relay.example.com
frp-<id>.relay.example.com
```

分别申请证书，所以这两个名字必须能通过 80 端口完成验证。

管理后台地址：

```text
https://admin.relay.example.com
```

## 安装

把整个 `relay-multi/` 目录传到服务器，先预检，再安装：

```bash
sudo ./install.sh --check \
  --domain relay.example.com \
  --admin-host admin.relay.example.com \
  --email admin@example.com

sudo ./install.sh \
  --domain relay.example.com \
  --admin-host admin.relay.example.com \
  --email admin@example.com \
  --max-tenants 20

# 机器上已经有 Nginx / 其它站点时，加 --existing-nginx：
sudo ./install.sh --existing-nginx \
  --domain relay.example.com \
  --admin-host admin.relay.example.com \
  --email admin@example.com \
  --max-tenants 20
```

安装脚本会：

- 检查 Ubuntu 版本、DNS、80/443 和基础命令；
- 安装 Nginx、Certbot、Python venv；
- 下载固定版本 frps；
- 创建 `relay` 系统用户和 `/etc/relay-multi`、`/var/lib/relay-multi`；
- 安装控制面、root helper 和 sudoers 白名单；
- 初始化 SQLite，首次创建管理员并只打印一次初始密码；
- 安装 Nginx 基础配置、ACME 入口和管理后台证书；
- 安装 `relay-control.service` 和 `frps@.service`；
- 启动控制面并跑 `/health`、SQLite、Nginx 自检。

`--existing-nginx` 只追加 `00-relay-*` / `zz-relay-*` 配置，不接管 80/443，不删除现有默认站点；适合在已有 Nginx 的机器上试装。

重复执行安装脚本是安全的：数据库、密钥、管理员密码和租户配置不会被覆盖。`--max-tenants` 只在第一次安装时作为默认值；之后以管理后台的配置为准。

### 管理员密码

首次安装会打印一次：

```text
管理员用户名：admin
管理员初始密码：……
```

密码只以 PBKDF2 哈希存进 SQLite，不写明文文件。忘记密码时，在服务器上重置：

```bash
cd /opt/relay-multi
printf '%s' '新的至少12位密码' | \
  sudo -u relay env PYTHONPATH=/opt/relay-multi \
  /opt/relay-multi/venv/bin/python -m control.cli \
  set-admin --db /var/lib/relay-multi/control.db --username admin --password-stdin
```

关键在 `cd /opt/relay-multi` 和 `PYTHONPATH=/opt/relay-multi`：`control` 是 `/opt/relay-multi` 下的包，不在 Python 默认搜索路径里。

### 卸载

```bash
sudo ./install.sh --uninstall
```

会停止控制面和所有租户 frps，移除程序、systemd 单元、sudoers、helper、Nginx 的 relay-multi 配置，但保留：

```text
/var/lib/relay-multi/control.db
/etc/relay-multi/
```

彻底删除数据和 `relay` 用户：

```bash
sudo ./install.sh --uninstall --purge
```

Let's Encrypt 证书目录不会由脚本删除，避免影响同一台机器上的其它站点。`/usr/local/bin/frps` 也保留，避免误删同一台机器上其它项目共用的二进制；确定不再使用时请手工删除。

## 使用流程

1. 浏览器打开 `https://admin.relay.example.com`。
2. 浏览器弹出 Basic Auth，输入安装时打印的 `admin` 和密码。
3. 在「邀请」页创建邀请码。邀请码只显示一次，服务端只保存哈希。
4. 把邀请票发给朋友；管理员自己也可以用安装时打印的自用邀请票。
5. 朋友在插件里粘贴邀请票，不需要知道控制台地址。
6. 控制面创建租户，root helper 创建 frps、Nginx、证书，返回：

```json
{
  "id": "26位小写base32",
  "publicHost": "<id>.relay.example.com",
  "controlHost": "frp-<id>.relay.example.com",
  "frpsPort": 443,
  "transport": "wss",
  "frpToken": "只返回这一次"
}
```

第一版插件侧仍需按这套返回手工/后续接线配置 frpc。本任务只交付服务器端骨架。

## 管理后台

后台包含五个区域：

- 总览：租户状态、容量、邀请码数量；
- 租户：地址、状态、撤销；
- 邀请：创建邀请码、有效期、使用情况；
- 配置：允许注册、必须邀请码、最大租户数；
- 审计：邀请、配置、开通、释放、撤销记录。

后台全部走 Basic Auth。默认配置：

```text
allowRegistration = false
inviteRequired = true
maxTenants = 20
```

撤销租户会调用 root helper 删除 frps 与 Nginx 配置，保留审计和数据库记录；不会删除其它租户。

## API

插件端：

```text
GET  /health
POST /api/claim     { inviteCode?, clientSecret, originPort, claimRequestId }
POST /api/status    { id, clientSecret }
POST /api/release   { id, clientSecret }
```

管理端（全部 Basic Auth）：

```text
GET  /admin
GET  /admin/api/overview
GET  /admin/api/tenants
GET  /admin/api/invites
GET  /admin/api/audit
GET  /admin/api/config
POST /admin/api/config
POST /admin/api/invites  → { code, ticket, expiresAt }
POST /admin/api/tenants/{id}/revoke
```

### 注册开关

- 没有邀请码时，先看 `inviteRequired`：为真返回 `invite_required`；
- 再看 `allowRegistration`：为假返回 `registration_closed`；
- 两者都放行时才创建自助租户。

默认 `inviteRequired=true`、`allowRegistration=false`，所以默认行为是**必须有邀请码**。

### token 只显示一次

`frpToken` 只在第一次成功 claim 的响应里出现。服务端只存它的哈希；同一个 `claimRequestId` 重试会返回同一个租户和地址，但**不会再次返回 token**。

这是第一版的取舍：响应丢失时不能靠重试取回 token。管理员撤销该租户、重新发邀请码，是明确的恢复路径。

### 限流与容量

默认：

- 每个 IP 每小时 5 次新开通；
- 全局每天 50 次新开通；
- 最多 20 个租户（安装参数，可在后台改到 1..100）。

容量统计 `active + provisioning + released + failed`。撤销后的租户不再占名额，但 URI 和端口不会复用。

同一 `claimRequestId` 的幂等重试不消耗新名额。

### release 的语义

`/api/release` 只把租户状态改为 `released`，并记录时间；**不会停止 frps、不会删除 Nginx 或 token**。真正的资源删除由管理员在后台撤销。这样用户误点停止时不会立刻拆掉固定地址。

## 内部结构

```text
Nginx :443
  ├── admin.<domain>             → 127.0.0.1:8787
  ├── frp-<id>.<domain>          → 127.0.0.1:7100+N
  └── <id>.<domain>              → 127.0.0.1:8100+N

控制面（用户 relay 运行）
  ├── FastAPI :8787（只绑回环）
  ├── SQLite
  ├── 管理后台 / API / 审计 / 限流
  └── sudo → root helper

root helper
  ├── create-tenant <id> <control-port> <vhost-port>
  ├── delete-tenant <id>
  └── reload-nginx
```

helper 只接受这三个固定动作，自己校验 26 位 base32 id、端口范围、端口关系、路径和已有配置冲突，不执行任意 shell。

每租户：

```text
控制端口：7100 + N
vhost 端口：8100 + N
配置：/etc/relay-multi/tenants/<id>.toml
systemd：frps@<id>.service
Nginx：/etc/nginx/conf.d/zz-relay-<id>-control.conf
       /etc/nginx/conf.d/zz-relay-<id>-data.conf
```

frps 只监听 `127.0.0.1`，公网入口由 Nginx 终止 TLS。

## 安全边界

- 邀请码和 frp token 只存 HMAC-SHA-256 哈希；
- clientSecret 只存带 `RELAY_PEPPER` 的 HMAC；
- Basic Auth 密码只存 PBKDF2-SHA256 哈希；
- 管理后台和所有管理 API 需要 Basic Auth；
- claim/撤销都写审计；日志不打印 token、邀请码和密码；
- root helper 由 sudoers 限定给 `relay` 用户，helper 内部再次校验输入；
- 控制面默认只绑 `127.0.0.1:8787`；
- 默认要求邀请码，自助注册默认关闭。

## 第一版边界

已实现：

- 安装/卸载脚本骨架；
- 控制面、SQLite、Basic Auth 管理后台；
- 邀请码、租户、审计、配置；
- claim/status/release；
- 每租户 frps/token/Nginx 模板；
- root helper 与 sudoers；
- 控制面测试。

暂不做：

- 自动升级、自动对账、租户凭据轮换；
- 多管理员与角色权限；
- 泛域名证书、DNS 自动配置；
- 自助注册的邮箱验证或防滥用；
- token 丢失后的自助恢复；
- 插件端自动接线到这套返回格式；
- 真实服务器安装、真实证书、真实 frps 联调。

## 开发测试

测试只使用临时 SQLite 和 fake helper，不调用 sudo/systemd/Nginx/Certbot，也不会执行 `install.sh`：

```bash
python -m pytest relay-multi/tests -q
```

安装脚本与 helper 的静态检查（不会执行它们）：

```bash
bash -n relay-multi/install.sh
python3 - <<'PY'
import ast
ast.parse(open('relay-multi/helper/relay-multi-helper', encoding='utf-8').read())
print('helper syntax ok')
PY
```

## 故障排查

```bash
systemctl status relay-control
journalctl -u relay-control -n 100 --no-pager
systemctl status 'frps@*'
nginx -t
/opt/relay-multi/venv/bin/python -m control.cli \
  check-db --db /var/lib/relay-multi/control.db
```

常见问题：

- 管理后台打不开：先确认 `admin.<domain>` 解析、80/443 可访问、Nginx 证书存在；
- claim 返回 `invite_required`：后台创建邀请码，或临时关闭「必须邀请码」；
- claim 返回 `registration_closed`：后台打开「允许无邀请码注册」；
- claim 返回 `capacity_exhausted`：撤销不用租户，或在后台提高上限；
- helper 失败：检查 `journalctl -u relay-control`，再手工确认 `sudo -u relay sudo -n /usr/local/lib/relay-multi/helper reload-nginx`；
- 租户证书失败：确认 `*.<domain>` DNS、80 端口和 Let's Encrypt 请求次数。

## 上线前的安全边界

这版已经补了这些基础防护：

- 管理后台的写操作会校验 `Origin` / `Referer`，拒绝跨站提交；
- 管理请求按 IP 限速，登录失败另有更严格的限速；
- 控制面响应带 `nosniff`、`DENY`、`no-referrer` 等安全头；
- 每个租户的 frps 限制最多 10 个代理；
- 租户数据页带 `nosniff` 和 `no-referrer`，但不加 `DENY`，否则远程窗口的 iframe 会被挡。

仍然建议在 Nginx 或云防火墙前加一层：

```text
管理域名只允许固定 IP / Cloudflare Access / VPN 访问
```

不要把管理后台直接暴露给所有人。Basic Auth 不是 MFA，管理密码泄露等于所有租户失守。

当前仍未做：

- 多管理员与角色权限；
- 管理后台 MFA；
- 每租户带宽/连接数配额；
- 自动 token 轮换；
- 失败登录告警。

这些是下一步，不要把它们误认为已经具备。
