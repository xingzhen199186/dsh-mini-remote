# A 中继运维台

> 地址：https://relay.dsh-mini-remote.com/admin  
> 由 Cloudflare Access 保护，只允许白名单邮箱登录。

## 能做什么

- 看活跃实例、已撤销实例、未用邀请；
- 看数据面是否开启；
- 开关新注册；
- 开关数据面转发（关闭后所有固定地址返回离线页）；
- 开关每日用量采集；
- 新建 7 天邀请码；未使用、未过期的邀请码会列在页面里，可复制；
- 查看实例列表、最近心跳、撤销实例；
- 查看最近审计；
- 点「立即采集」抓一次 Workers / D1 / KV 用量。

## 每日任务

Worker Cron：

```text
10 0 * * * UTC
```

即北京时间每天 08:10。

需要先给 Worker 配置一个只读 token：

```text
CF_ANALYTICS_TOKEN
```

权限只需：

```text
Account → Account Analytics → Read
```

配置方式：

```powershell
cd "I:\极简遥控器\极简遥控器"
npx wrangler secret put CF_ANALYTICS_TOKEN -c worker/wrangler.jsonc
```

粘贴 token 后回车。不要把 token 提交到仓库。

没有配置 token 时，页面会显示：

```text
未配置 CF_ANALYTICS_TOKEN，无法查询 Cloudflare 用量。
```

其他功能不受影响。

## 认证

- 浏览器：Cloudflare Access 登录后，Worker 读取 Access 注入的邮箱，并对照 `ADMIN_EMAILS`；
- CLI：继续用 `ADMIN_TOKEN` + Access service token；
- `workers_dev` 已关闭，避免绕过自定义域名。

## 已验证

- 浏览器打开 `/admin` 显示运维台；
- 活跃实例、撤销列表、审计、邀请按钮都在；
- Worker 测试 17 项通过。


## 邀请码回看（2026-10-27 调整）

原来邀请码只存 hash，页面只显示一次。用户反馈没必要，已改为：

- 新邀请码同时存 hash 和明文；
- 运维台列出未使用、未过期的邀请码；
- 页面由 Cloudflare Access 保护；
- 迁移 `0002_invite_code.sql` 已应用；
- 迁移前创建的旧码无法恢复，页面显示「旧码不可查看」。


## 自服务注册（2026-10-27 增加）

运维台「运营开关」里新增：

```text
新实例必须带邀请码（关闭后为自服务注册）
```

- 默认开启：和现在一样，首次注册要邀请码；
- 关闭：插件只凭本机 id/secret 和 target 就能注册，不需要邀请码；
- 已有实例不受影响；
- 邀请码仍可继续生成，作为控量工具。

开放前至少要确认：

- 数据面全局停用开关可用；
- 单 id 撤销可用；
- 每日用量监控正常；
- 能接受被陌生人消耗 Workers/D1/KV 配额。

建议首批 5–10 个仍用邀请码；等限流和用量数据稳定后再关掉。
