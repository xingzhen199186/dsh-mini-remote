# A 中继：用量监控

> 目标：每天看一眼 Workers / D1 / KV 的 Free 用量，不依赖 Cloudflare 付费账单通知。

## 为什么不用 Cloudflare 通知

2026-10-27 实际查看：Cloudflare 的 `Account & billing` 只有：

- Billing budget alert
- Usage based billing

它们是付费账单/超阈值通知，不是 Workers Free 每日额度告警。  
`Monitors` 功能在 Cloudflare 文档里存在（Alerts > Monitors，可对 SQL API 数据集设阈值），但当前账户的 Monitors 页面没有 `Create a Monitor` 按钮；Jev 浏览器两次尝试都停在侧栏，无法创建。因此改用只读 GraphQL 查询。

## 运行

```powershell
cd "I:\极简遥控器\极简遥控器"
node worker/scripts/relay-usage.mjs
```

输出示例：

```text
A 中继用量 2026-10-27
Workers 请求          710 /     100000  0.7%
D1 读取行              208 /    5000000  0.0%
D1 写入行              272 /     100000  0.3%
KV 请求               296 /     100000  0.3%
Workers 错误   0
D1 查询       read=130 write=152
KV 数据量     37748 bytes
```

超过 50% 标记 `·`，超过 80% 标记 `⚠` 并以退出码 1 结束。

## Token

优先读：

```text
CLOUDFLARE_API_TOKEN
```

没设时读本机 wrangler 的 OAuth token。  
不会打印 token，也不会修改 Cloudflare 资源。

## 建议

- 内测期每天跑一次；
- Workers 到 50,000 次/天开始注意；
- 到 80,000 次/天先停新邀请，查是不是被刷；
- 需要真正自动告警时，再接 Windows 计划任务或外部 cron。


## 官方文档

- [Monitors](https://developers.cloudflare.com/notifications/monitors/)
- [Platform Notifications](https://developers.cloudflare.com/notifications/notification-available/)
- [SQL API datasets](https://developers.cloudflare.com/analytics/sql-api/datasets/)

`Usage Based Billing` 只面向 Professional 及以上 / Pay-as-you-go，不是 Free 的每日额度告警。
