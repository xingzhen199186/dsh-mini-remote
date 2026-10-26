# 中继方案：先 C，后 A

## 目标

给用户多一条“固定公网地址”的路，但不把项目变成必须依赖的中心化服务。

- **C**：用户自己的 Cloudflare 命名隧道。用户有 Cloudflare 账号和域名，插件只负责运行隧道。
- **A**：固定 Worker 中继 + 插件 quick tunnel。用户不需要 Cloudflare 账号，插件把临时隧道注册到一个固定子域名。

两条路都保留现有的局域网、Tailscale、quick tunnel、自建 frp。

## C：用户命名隧道

### 用户流程

1. 域名接入 Cloudflare；
2. Cloudflare Zero Trust 创建命名隧道；
3. Public Hostname 指向 `http://127.0.0.1:3090`；
4. 复制 tunnel token；
5. 插件填 token + 固定公网地址；
6. 插件启动 `cloudflared`，手机二维码使用固定地址。

### 插件内部

```text
settings.tunnel = {
  enabled: boolean,
  mode: 'quick' | 'named',
  cloudflaredPath: string,
  namedToken: string,   // secret，不回显
  publicUrl: string,    // https://dsh.example.com
}
```

- named 模式用 `TUNNEL_TOKEN` 环境变量传 token，不放进 argv；
- 固定地址来自 `publicUrl`，不从日志猜；
- 启动后探测 `publicUrl/mini/api/version`，连续失败才判死；
- 退出/重启沿用 quick 的退避策略；
- 配对条目 `kind: public`，文案标明“固定地址”。

### 安全边界

- Cloudflare 在边缘终止 TLS，能看到明文；不是端到端加密；
- token 只存插件配置，读取时脱敏；
- 固定域名必须与 Cloudflare Public Hostname 一致；
- 不自动改用户的 Cloudflare 配置。

## A：固定 Worker 中继

### 结构

```text
手机 → relay.example.com Worker
     → 当前 quick tunnel
     → 插件 3090
```

### 插件

- 首次生成 `id`（8 字节 hex）+ `secret`（32 字节 base64url）；
- 每次 quick tunnel 启动后 `PUT /api/relay/register`；
- 停止/关闭时 `POST /api/relay/unregister`；
- 二维码使用 `https://<id>.relay.example.com`；
- 注册失败回退到临时地址，不阻塞隧道。

### Worker

- `register(id, secret, target)`：只接受 `https://*.trycloudflare.com`；
- `unregister(id, secret)`；
- 按 Host 解析 id，反代到 target；
- 不记录正文，只保留最小运行指标；
- 限流、过期、撤销。

### 与 C 的关系

两者共用接口：

```text
RelayProvider
  start() -> publicUrl
  stop()
  status()
```

C 的 provider 是 `cloudflared named`；A 的 provider 是 `quick + registry`。手机端只认最终 URL。

## 实施顺序

1. C 后端 + 设置（已完成）；
2. C 前端 + 配对（已完成）；
3. C 测试与文档（已完成）；
4. A 设计评审（待做）；
5. A Worker + 插件注册表（待做）；
6. A 端到端验证（待做）。

## 不做

- 不做服务方代建 Cloudflare 命名隧道（B）；
- 不做原生手机 App；
- 不把 quick tunnel 换成唯一公网方案。
