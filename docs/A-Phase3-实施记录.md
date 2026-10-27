# A 方案 Phase 3 实施记录（插件接入）

> 日期：2026-10-27。范围：把插件侧 RelayProvider 接到 staging Worker；未在真机上重启加载。

## 已完成

### 本机身份

`lib/relay-identity.js`：

- 26 位 base32 id；
- 43 位 base64url secret；
- `$DSH_HOME/dsh-mini-remote/relay-identity.json`，0600；
- 文件损坏抛错，不悄悄换 id。

### Worker 客户端

`lib/relay-client.js`：

- 固定 endpoint `https://relay.dsh-mini-remote.com`；
- `PUT /api/relay/v1/register`；
- `POST /api/relay/v1/unregister`；
- 8 秒超时；
- 保留状态码、错误和 `Retry-After`。

### 插件接线

`lib/index.js`：

- quick supervisor 进入 running 后自动 `RelayProvider.attach(quickUrl)`；
- quick URL 变化自动重新登记；
- 15 分钟心跳、45 分钟 TTL 由 RelayProvider 管；
- 固定地址探测失败只标 degraded，不重启 quick；
- 停止公网/关闭 relay 时尽力 unregister；
- named/C/frp 不经过 RelayProvider；
- 设置新增 `tunnel.relayEnabled`、`tunnel.relayInviteCode`；
- 邀请码留空保存不会覆盖已存值。

### 配对与 UI

`lib/pairing.js`：

- relay active/degraded 时显示 `public-relay` 条目；
- 标签「公网（固定中继）」；
- 没有 relay 时仍显示裸 quick；
- 状态里带 `relay`，但只有 `hasInviteCode`，不回显邀请码。

`client/client.js`：

- 快速隧道下面新增「固定地址中继（A）」；
- 开关、邀请码输入、保存按钮；
- 显示 waiting/active/degraded/paused；
- 明确提示中继可见明文、不是 E2EE。

## 验证

```text
npm test                 1247/1247
node client/verify.mjs   148/148
```

新增测试：

- 身份生成/复用/损坏；
- 注册 PUT、邀请码、注销 POST、429 保留；
- A 中继 active 时配对显示固定地址；
- UI 打开 relay 时 POST 带 `relayEnabled`。

## 未做

- 重启 DSH 后的真机插件接入；
- 真实邀请码首次开通；
- SSE/WebSocket/大文件经插件 RelayProvider 的端到端；
- Cloudflare Access；
- 精确全局配额。
