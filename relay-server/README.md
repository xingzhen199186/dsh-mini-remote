# 自建中继（frps + Caddy）

这是给 `dsh-mini-remote` 用的自建中继安装包。用户只需要一台国内 Linux 服务器和两个域名记录。

## 前提

- Ubuntu 20.04/22.04/24.04 或 Debian 11/12；
- x86_64 或 arm64；
- 80/443 空闲；
- 两个域名都解析到这台服务器：
  - `remote.example.com`：手机/B/远程窗口访问；
  - `frp.example.com`：A 端 frpc 的控制连接；
- 服务器安全组放行 80/443；第一版固定用 WebSocket + TLS，不开放 7000。

第一版**不会自动修改已有的 Nginx**。如果 80/443 已被占用，脚本会退出；请换一台干净 VPS，或按下面的“已有 Nginx”手工贴片段。

## 安装

把整个 `relay-server/` 目录传到服务器，执行：

```bash
sudo bash install.sh --check --host remote.example.com --control-host frp.example.com
sudo bash install.sh --host remote.example.com --control-host frp.example.com
```

安装脚本会：

- 下载固定版本的 frps 和 Caddy；
- 建 `frps.service`、`caddy.service`；
- 生成 frp token；
- 控制域名 443 转给本机 frps 的 7000；
- 公网域名 443 转给 frps 的 8080（再由 frps 按域名转给 A）；
- 自动申请两张证书。

安装完成后会打印：

```text
公网地址：https://remote.example.com
frp 控制：frp.example.com:443
frp token：...
```

把 token 复制到 A 端插件的「自建中继」里。**token 只显示一次。**

## A 端插件填写

```text
中继服务器地址：frp.example.com
控制端口：443
传输方式：wss
公网域名：remote.example.com
frp token：安装脚本输出的那一串
```

保存后点「开启」，再点「测试连接」。两个状态灯都变绿，手机/B/远程窗口就能用这个固定地址。

## 为什么是两个域名

frp 的 wss 控制连接和网页流量都走 443，靠域名分开最稳：

- `frp.example.com` → frps 控制端口；
- `remote.example.com` → frps 的 HTTP vhost → A 的 3090。

不要试图让一个域名同时承担两种流量，路径分流在不同 frp 版本上并不稳定。

## 已有 Nginx

脚本不会自动改。可以手工加两个独立文件，注意三件事：

- 文件名带 `zz-` 前缀，避免抢走默认 443 站点；
- 不要加 `http2`；
- 不要重复写 `listen [::]:443 ssl ipv6only=on;`。

控制域名参考：

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name frp.example.com;

    ssl_certificate     /etc/letsencrypt/live/frp.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/frp.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:7000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }
}
```

公网域名参考：

```nginx
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name remote.example.com;

    ssl_certificate     /etc/letsencrypt/live/remote.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/remote.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_buffering off;
        proxy_read_timeout 3600s;
        client_max_body_size 50m;
    }
}
```

然后：

```bash
sudo nginx -t && sudo nginx -s reload
```

## 卸载

```bash
sudo bash install.sh --uninstall
```

保留 `/etc/frp`；要彻底清除再手工删。

## 注意

- 域名对外提供服务涉及备案；请按当地要求办理。
- 不要把 frp token 发到公开地方。
- 自建中继改善的是“地址固定、稳定可达”，不是带宽；4Mbps 下远程窗口冷加载仍然要十几秒。

## 安装后安全自检

装完后按这几条确认，不通过就先别把地址发出去：

```bash
# 1. 7000 只应监听 127.0.0.1，不能出现在公网
ss -ltnp | grep -E ':(80|443|7000)\b'

# 2. 只放行 80/443；云厂商安全组也照此设置
sudo ufw status

# 3. 两个域名都应返回有效证书
curl -sS -o /dev/null -w '%{http_code}\n' https://remote.example.com/
curl -sS -o /dev/null -w '%{http_code}\n' https://frp.example.com/

# 4. frps 配置权限必须是 600
sudo stat -c '%a %n' /etc/frp/frps.toml
```

如果 token 可能泄露，按下面顺序轮换：

```bash
sudo sed -i 's/^auth.token = .*/auth.token = "新token"/' /etc/frp/frps.toml
sudo systemctl restart frps
```

然后把新 token 填回插件，旧 token 立即失效。不要把 token 写进群聊、截图或公开仓库。
