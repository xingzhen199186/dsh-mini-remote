#!/usr/bin/env bash
#
# dsh-mini-remote 自建中继：frps + Caddy 的一次性安装脚本。
#
# 只做三件事：装 frps、装 Caddy、生成 token。不改用户已有的 Nginx。
# 80/443 已被占用时直接退出，并告诉用户该手工贴哪一段。
#
# 用法：
#   sudo ./install.sh --host remote.example.com --control-host frp.example.com
#   sudo ./install.sh --host remote.example.com --control-host frp.example.com --token <token>
#   sudo ./install.sh --check --host remote.example.com --control-host frp.example.com
#   sudo ./install.sh --uninstall
#
set -euo pipefail

FRP_VERSION="0.71.1"
CADDY_VERSION="2.10.2"
PUBLIC_HOST=""
CONTROL_HOST=""
TOKEN=""
EMAIL=""
CHECK_ONLY=0
UNINSTALL=0
FORCE=0
FRP_DIR="/etc/frp"
CADDY_DIR="/etc/caddy"
FRPS_BIN="/usr/local/bin/frps"
CADDY_BIN="/usr/local/bin/caddy"
FRPS_UNIT="/etc/systemd/system/frps.service"
CADDY_UNIT="/etc/systemd/system/caddy.service"

die() { printf '错误：%s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

usage() {
  cat <<'EOF'
用法：
  sudo ./install.sh --host remote.example.com --control-host frp.example.com [--token <token>] [--email <email>]
  sudo ./install.sh --check --host remote.example.com --control-host frp.example.com
  sudo ./install.sh --uninstall

说明：
  --host          对外访问的完整域名，例如 remote.example.com
  --control-host  frp 控制域名，例如 frp.example.com；A 端只出站 443
  --token         frp token；不填就自动生成
  --email         Let's Encrypt 通知邮箱，可空
  --check         只体检，不安装、不改文件
  --force         已安装过时允许覆盖（会重新生成 token）
  --uninstall     停止并移除 frps/Caddy（保留 /etc/frp 配置）
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --host) PUBLIC_HOST="${2:-}"; shift 2 ;;
    --control-host) CONTROL_HOST="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    --force) FORCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "不认识的参数：$1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "请用 sudo 运行。"
command -v systemctl >/dev/null 2>&1 || die "这台机器没有 systemd，暂不支持。"
[ -f /etc/os-release ] || die "读不到 /etc/os-release，暂不支持。"
. /etc/os-release
case "${ID:-}" in
  ubuntu|debian) ;;
  *) die "第一版只支持 Ubuntu/Debian；当前是 ${ID:-未知}。RHEL 系请等第二版。" ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) FRP_ARCH="amd64"; CADDY_ARCH="amd64" ;;
  aarch64|arm64) FRP_ARCH="arm64"; CADDY_ARCH="arm64" ;;
  *) die "不支持的架构：$ARCH" ;;
esac

port_busy() {
  local port="$1"
  ss -ltn "( sport = :$port )" 2>/dev/null | grep -q LISTEN
}

check() {
  say "系统：${PRETTY_NAME:-$ID}"
  say "架构：$ARCH"
  command -v curl >/dev/null 2>&1 || die "需要 curl"
  command -v tar >/dev/null 2>&1 || die "需要 tar"
  if port_busy 80 || port_busy 443; then
    die "80 或 443 已被占用。第一版不自动改现有 Nginx；请换一台干净 VPS，或按 README 手工贴片段。"
  fi
  say "80/443 空闲。"
  if [ -n "$PUBLIC_HOST" ]; then
    say "公网域名：$PUBLIC_HOST"
    if command -v getent >/dev/null 2>&1; then
      getent hosts "$PUBLIC_HOST" || say "提示：这个域名现在解析不出来；先加 DNS，再签证书。"
    fi
  fi
  if [ -n "$CONTROL_HOST" ]; then
    say "控制域名：$CONTROL_HOST"
    if command -v getent >/dev/null 2>&1; then
      getent hosts "$CONTROL_HOST" || say "提示：这个域名现在解析不出来；先加 DNS，再签证书。"
    fi
  fi
  say "检查通过。"
}

if [ "$CHECK_ONLY" -eq 1 ]; then
  check
  exit 0
fi

if [ "$UNINSTALL" -eq 1 ]; then
  systemctl disable --now frps 2>/dev/null || true
  systemctl disable --now caddy 2>/dev/null || true
  rm -f "$FRPS_UNIT" "$CADDY_UNIT"
  systemctl daemon-reload || true
  rm -f "$FRPS_BIN" "$CADDY_BIN"
  say "已停止并移除 frps/Caddy；$FRP_DIR 配置保留。"
  say "要彻底删除，手工执行：rm -rf $FRP_DIR $CADDY_DIR"
  exit 0
fi

[ -n "$PUBLIC_HOST" ] || die "缺少 --host，例如 remote.example.com"
[ -n "$CONTROL_HOST" ] || die "缺少 --control-host，例如 frp.example.com"
if [ -f "$FRPS_UNIT" ] && [ "$FORCE" -ne 1 ]; then
  die "已经安装过 frps。要覆盖请加 --force；要卸载请用 --uninstall。"
fi
[ "$PUBLIC_HOST" != "$CONTROL_HOST" ] || die "公网域名和控制域名不能是同一个：frp 的 wss 连接和网页流量需要按域名分开。"
check
command -v openssl >/dev/null 2>&1 || die "需要 openssl 生成 token"
if [ -z "$TOKEN" ]; then
  TOKEN="$(openssl rand -base64 32 | tr -d '\n=+/' | cut -c1-43)"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

say "下载 frps ${FRP_VERSION}…"
FRP_TGZ="frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz"
curl -fL --retry 3 -o "$TMP/$FRP_TGZ" \
  "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${FRP_TGZ}"
curl -fL --retry 3 -o "$TMP/frp_sha256.txt" \
  "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_sha256_checksums.txt"
( cd "$TMP" && grep "  ${FRP_TGZ}$" frp_sha256.txt | sha256sum -c - )
tar -xzf "$TMP/$FRP_TGZ" -C "$TMP"
install -m 0755 "$TMP/frp_${FRP_VERSION}_linux_${FRP_ARCH}/frps" "$FRPS_BIN"

say "下载 Caddy ${CADDY_VERSION}…"
CADDY_TGZ="caddy_${CADDY_VERSION}_linux_${CADDY_ARCH}.tar.gz"
curl -fL --retry 3 -o "$TMP/$CADDY_TGZ" \
  "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/${CADDY_TGZ}"
curl -fL --retry 3 -o "$TMP/caddy_sha256.txt" \
  "https://github.com/caddyserver/caddy/releases/download/v${CADDY_VERSION}/caddy_${CADDY_VERSION}_checksums.txt"
( cd "$TMP" && grep "  ${CADDY_TGZ}$" caddy_sha256.txt | sha256sum -c - )
tar -xzf "$TMP/$CADDY_TGZ" -C "$TMP"
install -m 0755 "$TMP/caddy" "$CADDY_BIN"

mkdir -p "$FRP_DIR" "$CADDY_DIR"
umask 077
cat > "$FRP_DIR/frps.toml" <<EOF
bindAddr = "127.0.0.1"
bindPort = 7000
vhostHTTPPort = 8080
transport.tls.force = false

auth.method = "token"
auth.token = "$TOKEN"

log.to = "console"
log.level = "info"
EOF
chmod 600 "$FRP_DIR/frps.toml"

cat > "$CADDY_DIR/Caddyfile" <<EOF
{
  email ${EMAIL:-admin@example.com}
}

# frp 控制连接：A 端只出站 443，wss 直接打这个域名。
${CONTROL_HOST} {
  reverse_proxy 127.0.0.1:7000
}

# 手机/B/远程窗口的网页流量。
${PUBLIC_HOST} {
  encode zstd gzip
  reverse_proxy 127.0.0.1:8080
}
EOF

cat > "$FRPS_UNIT" <<'EOF'
[Unit]
Description=dsh-mini-remote frps
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/frps -c /etc/frp/frps.toml
Restart=always
RestartSec=3
User=root
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

cat > "$CADDY_UNIT" <<'EOF'
[Unit]
Description=Caddy for dsh-mini-remote relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
Restart=always
RestartSec=3
User=root
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now frps
systemctl enable --now caddy

say ""
say "安装完成。"
say "公网地址：https://${PUBLIC_HOST}"
say "frp 控制：${CONTROL_HOST}:443（WebSocket + TLS）"
say "frp token：${TOKEN}"
say ""
say "把下面几项填进 A 端插件："
say "  中继服务器地址：${CONTROL_HOST}"
say "  控制端口：443"
say "  传输方式：wss"
say "  公网域名：${PUBLIC_HOST}"
say "  frp token：${TOKEN}"
say ""
say "token 只显示这一次；请立刻复制到插件里。"
say "DNS 必须先指向这台机器，Caddy 才能签下证书。"
