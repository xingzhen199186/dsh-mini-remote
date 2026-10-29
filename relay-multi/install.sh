#!/usr/bin/env bash
#
# relay-multi：用户自建多用户中继的安装/卸载脚本。
# 只支持干净的 Ubuntu 22.04/24.04 VPS；本脚本会安装 Nginx、Certbot、frps 和系统服务。
#
set -euo pipefail

DOMAIN=""
ADMIN_HOST=""
EMAIL=""
MAX_TENANTS=20
CHECK_ONLY=0
UNINSTALL=0
EXISTING_NGINX=0
PURGE=0

APP_DIR="/opt/relay-multi"
DATA_DIR="/var/lib/relay-multi"
LOG_DIR="/var/log/relay-multi"
CONF_DIR="/etc/relay-multi"
TENANT_DIR="${CONF_DIR}/tenants"
ENV_FILE="${CONF_DIR}/relay.env"
HELPER_CFG="${CONF_DIR}/helper.json"
DB_FILE="${DATA_DIR}/control.db"
HELPER_BIN="/usr/local/lib/relay-multi/helper"
TEMPLATE_DIR="/usr/local/lib/relay-multi/templates"
ACME_ROOT="/var/www/relay-multi-acme"
FRP_VERSION="0.71.1"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FRPS_BIN="/usr/local/bin/frps"
CONTROL_PORT=8787

say() { printf '%s\n' "$*"; }
warn() { printf '注意：%s\n' "$*" >&2; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法：
  sudo ./install.sh --domain relay.example.com --admin-host admin.relay.example.com \
    --email admin@example.com [--max-tenants 20]
  sudo ./install.sh --check --domain ... --admin-host ... --email ...
  sudo ./install.sh --uninstall [--purge]

说明：
  --domain       租户域名后缀，例如 relay.example.com；DNS 需要 *.relay.example.com
  --admin-host   管理后台域名，必须是 --domain 的子域名
  --email        Let's Encrypt 通知邮箱
  --max-tenants  首次安装的最大租户数，1..100，默认 20
  --check        只做预检，不修改系统
  --existing-nginx  机器上已有 Nginx/站点；只追加 relay-multi 配置，不接管 80/443
  --uninstall    停服务并移除程序、Nginx 和 helper；保留数据库与租户配置
  --purge        与 --uninstall 一起用，连数据目录、配置和 relay 用户一起删除
EOF
}

need_arg() {
  [ -n "${2:-}" ] || die "参数 $1 缺少值"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) need_arg "$1" "${2:-}"; DOMAIN="${2,,}"; shift 2 ;;
    --admin-host) need_arg "$1" "${2:-}"; ADMIN_HOST="${2,,}"; shift 2 ;;
    --email) need_arg "$1" "${2:-}"; EMAIL="${2:-}"; shift 2 ;;
    --max-tenants) need_arg "$1" "${2:-}"; MAX_TENANTS="${2:-}"; shift 2 ;;
    --check) CHECK_ONLY=1; shift ;;
    --existing-nginx) EXISTING_NGINX=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "不认识的参数：$1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "请用 sudo 运行。"
[ "$PURGE" -eq 0 ] || [ "$UNINSTALL" -eq 1 ] || die "--purge 只能和 --uninstall 一起用。"
command -v systemctl >/dev/null 2>&1 || die "这台机器没有 systemd。"
[ -f /etc/os-release ] || die "读不到 /etc/os-release。"
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || die "第一版只支持 Ubuntu 22.04/24.04。"

valid_host() {
  [[ "$1" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]
}

valid_email() {
  [[ "$1" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]
}

port_busy() {
  command -v ss >/dev/null 2>&1 || return 1
  ss -ltnH "sport = :$1" 2>/dev/null | grep -q .
}

stop_all_frps() {
  local units
  units="$(systemctl list-units --type=service --all 'frps@*.service' --no-legend 2>/dev/null | awk '{print $1}')"
  if [ -n "$units" ]; then
    # shellcheck disable=SC2086
    systemctl disable --now $units 2>/dev/null || true
  fi
}

uninstall() {
  say "停止控制面与租户 frps…"
  systemctl disable --now relay-control 2>/dev/null || true
  stop_all_frps

  say "移除 systemd 单元、sudo 规则与 helper…"
  rm -f /etc/systemd/system/relay-control.service /etc/systemd/system/frps@.service
  systemctl daemon-reload 2>/dev/null || true
  rm -f /etc/sudoers.d/relay-multi
  rm -f "$HELPER_BIN"
  rm -rf "$TEMPLATE_DIR" "$APP_DIR"

  say "移除 relay-multi 的 Nginx 配置…"
  rm -f /etc/nginx/conf.d/00-relay-*.conf
  rm -f /etc/nginx/conf.d/zz-relay-*.conf
  if [ -e "${CONF_DIR}/install-mode" ] && [ "$(cat "${CONF_DIR}/install-mode")" = "existing" ]; then
    say "已有 Nginx 模式：不动 sites-enabled/default。"
  elif [ -e "${CONF_DIR}/nginx-default-site.backup" ]; then
    rm -f /etc/nginx/sites-enabled/default
    cp -a "${CONF_DIR}/nginx-default-site.backup" /etc/nginx/sites-enabled/default
  elif [ -f "${CONF_DIR}/nginx-default-disabled" ] && [ -f /etc/nginx/sites-available/default ]; then
    ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
  fi
  if command -v nginx >/dev/null 2>&1; then
    if nginx -t 2>/dev/null; then
      systemctl reload nginx 2>/dev/null || true
    else
      warn "Nginx 配置检查没通过；请检查 /etc/nginx/conf.d/。"
    fi
  fi

  if [ "$PURGE" -eq 1 ]; then
    say "清除数据、配置、证书申请目录和 relay 用户…"
    rm -rf "$CONF_DIR" "$DATA_DIR" "$LOG_DIR" "$ACME_ROOT"
    userdel relay 2>/dev/null || true
  else
    say "已保留 ${DATA_DIR} 和 ${CONF_DIR}（租户配置与数据库）。"
  fi
  say "卸载完成。Let's Encrypt 证书目录没有删除，避免影响同一台机器上的其它站点。"
  exit 0
}

if [ "$UNINSTALL" -eq 1 ]; then
  uninstall
fi

[ "${VERSION_ID:-}" = "22.04" ] || [ "${VERSION_ID:-}" = "24.04" ] \
  || die "当前 Ubuntu ${VERSION_ID:-未知}；第一版只支持 22.04/24.04。"

valid_host "$DOMAIN" || die "--domain 不是合法域名。"
valid_host "$ADMIN_HOST" || die "--admin-host 不是合法域名。"
[ "$ADMIN_HOST" != "$DOMAIN" ] || die "--admin-host 不能和 --domain 相同。"
case "$ADMIN_HOST" in
  *".${DOMAIN}") ;;
  *) die "--admin-host 必须是 ${DOMAIN} 的子域名。" ;;
esac
valid_email "$EMAIL" || die "--email 不像邮箱地址。"
[[ "$MAX_TENANTS" =~ ^[0-9]+$ ]] || die "--max-tenants 必须是整数。"
[ "$MAX_TENANTS" -ge 1 ] && [ "$MAX_TENANTS" -le 100 ] || die "--max-tenants 必须在 1..100。"

[ -f "${SRC_DIR}/control/app.py" ] || die "安装包缺少 control/app.py。"
[ -f "${SRC_DIR}/templates/frps.toml" ] || die "安装包缺少 templates/。"
[ -f "${SRC_DIR}/helper/relay-multi-helper" ] || die "安装包缺少 helper。"

preflight() {
  say "预检：Ubuntu ${VERSION_ID} / 最大租户 ${MAX_TENANTS}"
  command -v python3 >/dev/null 2>&1 || die "需要 python3。"
  python3 - <<'PY' || die "需要 Python 3.10 或更高版本。"
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY
  for command in curl tar openssl getent; do
    command -v "$command" >/dev/null 2>&1 || die "缺少命令：$command"
  done
  if [ "$EXISTING_NGINX" -eq 1 ]; then
    command -v nginx >/dev/null 2>&1 || die "--existing-nginx 需要机器上已安装 Nginx。"
    say "  已有 Nginx 模式：只追加 relay-multi 配置，不接管 80/443。"
  elif [ ! -f "$ENV_FILE" ]; then
    port_busy 80 && die "80 端口已被占用。第一版要求干净 VPS；已有 Nginx 请加 --existing-nginx。"
    port_busy 443 && die "443 端口已被占用。第一版要求干净 VPS；已有 Nginx 请加 --existing-nginx。"
  fi

  local server_ip resolved host
  server_ip="$(curl -4 -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
  for host in "$DOMAIN" "$ADMIN_HOST"; do
    resolved="$(getent ahostsv4 "$host" 2>/dev/null | awk 'NR==1{print $1}')"
    [ -n "$resolved" ] || die "${host} 还没有 A 记录，先配置 DNS。"
    if [ -n "$server_ip" ] && [ "$resolved" != "$server_ip" ]; then
      die "${host} 解析到 ${resolved}，但本机公网 IP 是 ${server_ip}。"
    fi
    say "  ${host} → ${resolved}"
  done
  say "请同时把 *.${DOMAIN} 指向这台机器；否则租户证书申请会失败。"
  say "预检通过。"
}

if [ "$CHECK_ONLY" -eq 1 ]; then
  preflight
  exit 0
fi
preflight

say "安装系统依赖（Nginx、Certbot、Python venv）…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq nginx certbot python3-venv python3-pip curl ca-certificates tar openssl sudo >/dev/null

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) FRP_ARCH="amd64" ;;
  aarch64|arm64) FRP_ARCH="arm64" ;;
  *) die "不支持的架构：$ARCH" ;;
esac

if [ ! -x "$FRPS_BIN" ]; then
  say "下载 frps ${FRP_VERSION}…"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "${TMP_DIR:-}"' EXIT
  ARCHIVE="frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz"
  curl -fsSL --retry 3 -o "${TMP_DIR}/${ARCHIVE}" \
    "https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${ARCHIVE}"
  tar -xzf "${TMP_DIR}/${ARCHIVE}" -C "$TMP_DIR"
  install -m 0755 "${TMP_DIR}/frp_${FRP_VERSION}_linux_${FRP_ARCH}/frps" "$FRPS_BIN"
fi

if ! id -u relay >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$DATA_DIR" --shell /usr/sbin/nologin relay
fi
install -d -o root -g relay -m 0750 "$CONF_DIR" "$TENANT_DIR"
install -d -o relay -g relay -m 0750 "$DATA_DIR" "$LOG_DIR"
install -d -o root -g root -m 0755 "$APP_DIR" "$TEMPLATE_DIR" "$ACME_ROOT"

say "安装控制面代码…"
rm -rf "${APP_DIR}/control"
install -d -o root -g root -m 0755 "${APP_DIR}/control"
cp -a "${SRC_DIR}/control/." "${APP_DIR}/control/"
find "$APP_DIR/control" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
install -m 0755 "${SRC_DIR}/helper/relay-multi-helper" "$HELPER_BIN"
install -m 0644 "${SRC_DIR}/templates/"* "$TEMPLATE_DIR/"
install -m 0644 "${SRC_DIR}/templates/relay-control.service" /etc/systemd/system/relay-control.service
install -m 0644 "${SRC_DIR}/templates/frps@.service" /etc/systemd/system/frps@.service

say "安装 Python 依赖…"
if [ ! -x "${APP_DIR}/venv/bin/python" ]; then
  python3 -m venv "${APP_DIR}/venv"
fi
"${APP_DIR}/venv/bin/pip" install --quiet --upgrade pip
"${APP_DIR}/venv/bin/pip" install --quiet -r "${APP_DIR}/control/requirements.txt"
chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"

if [ -f "$ENV_FILE" ]; then
  EXISTING_DOMAIN="$(sed -n 's/^RELAY_DOMAIN=//p' "$ENV_FILE" | head -n1)"
  [ "$EXISTING_DOMAIN" = "$DOMAIN" ] \
    || die "这台机器已经用 ${EXISTING_DOMAIN:-未知域名} 安装过，不能直接换域名；请先 --uninstall --purge。"
fi

if [ ! -f "$ENV_FILE" ]; then
  say "生成控制面密钥…"
  PEPPER="$(openssl rand -hex 32)"
  cat > "$ENV_FILE" <<EOF
RELAY_DB=${DB_FILE}
RELAY_PEPPER=${PEPPER}
RELAY_DOMAIN=${DOMAIN}
RELAY_ADMIN_USER=admin
RELAY_DEFAULT_MAX_TENANTS=${MAX_TENANTS}
RELAY_HELPER=${HELPER_BIN}
EOF
  chown root:relay "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
else
  say "检测到已有安装：保留数据库、密钥和现有租户，更新程序与模板。"
fi

cat > "$HELPER_CFG" <<EOF
{"domain":"${DOMAIN}","email":"${EMAIL}","acme_root":"${ACME_ROOT}"}
EOF
chown root:root "$HELPER_CFG"
chmod 0600 "$HELPER_CFG"

say "初始化 SQLite…"
(cd "$APP_DIR" && runuser -u relay -- "$APP_DIR/venv/bin/python" -m control.cli \
  init-db --db "$DB_FILE" --max-tenants "$MAX_TENANTS" >/dev/null)
chown relay:relay "$DB_FILE" 2>/dev/null || true

ADMIN_CREATED=0
if [ "$(cd "$APP_DIR" && runuser -u relay -- "$APP_DIR/venv/bin/python" -m control.cli has-admin --db "$DB_FILE" --username admin)" != "yes" ]; then
  ADMIN_PASSWORD="$(openssl rand -hex 16)"
  printf '%s' "$ADMIN_PASSWORD" | (cd "$APP_DIR" && runuser -u relay -- "$APP_DIR/venv/bin/python" -m control.cli set-admin --db "$DB_FILE" --username admin --password-stdin >/dev/null)
  ADMIN_CREATED=1
fi

say "安装 sudo helper 白名单…"
cat > /etc/sudoers.d/relay-multi <<EOF
relay ALL=(root) NOPASSWD: ${HELPER_BIN} create-tenant *, ${HELPER_BIN} delete-tenant *, ${HELPER_BIN} reload-nginx
EOF
chmod 0440 /etc/sudoers.d/relay-multi
visudo -cf /etc/sudoers.d/relay-multi >/dev/null || die "sudoers 校验失败。"

say "配置 Nginx 与管理后台证书…"
install -d -o root -g root -m 0755 "$ACME_ROOT"
if [ "$EXISTING_NGINX" -eq 1 ]; then
  printf 'existing\n' > "${CONF_DIR}/install-mode"
else
  printf 'clean\n' > "${CONF_DIR}/install-mode"
  if [ -L /etc/nginx/sites-enabled/default ] || [ -f /etc/nginx/sites-enabled/default ]; then
    cp -a /etc/nginx/sites-enabled/default "${CONF_DIR}/nginx-default-site.backup" 2>/dev/null || true
    rm -f /etc/nginx/sites-enabled/default
    : > "${CONF_DIR}/nginx-default-disabled"
  fi
fi
cat > /etc/nginx/conf.d/00-relay-map.conf <<'EOF'
server_names_hash_bucket_size 128;
server_names_hash_max_size 4096;

map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF
cat > /etc/nginx/conf.d/00-relay-acme.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN} *.${DOMAIN};
    root ${ACME_ROOT};
    location /.well-known/acme-challenge/ { try_files \$uri =404; }
    location / { return 404; }
}
EOF
cat > /etc/nginx/conf.d/00-relay-admin-http.conf <<EOF
server {
    listen 80;
    server_name ${ADMIN_HOST};
    root ${ACME_ROOT};
    location /.well-known/acme-challenge/ { try_files \$uri =404; }
    location / { return 404; }
}
EOF
nginx -t >/dev/null || die "Nginx 初始配置检查失败。"
systemctl reload nginx || systemctl restart nginx

if [ ! -f "/etc/letsencrypt/live/${ADMIN_HOST}/fullchain.pem" ]; then
  certbot certonly --webroot -w "$ACME_ROOT" -d "$ADMIN_HOST" \
    --email "$EMAIL" --agree-tos -n --keep-until-expiring >/dev/null
fi

rm -f /etc/nginx/conf.d/00-relay-admin-http.conf
cat > /etc/nginx/conf.d/00-relay-admin.conf <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name ${ADMIN_HOST};
    location /.well-known/acme-challenge/ { root ${ACME_ROOT}; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${ADMIN_HOST};
    ssl_certificate     /etc/letsencrypt/live/${ADMIN_HOST}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${ADMIN_HOST}/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:${CONTROL_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
EOF
nginx -t >/dev/null || die "Nginx 最终配置检查失败。"
systemctl reload nginx

say "启动 relay-control…"
systemctl daemon-reload
systemctl enable relay-control
systemctl restart relay-control

say "自检…"
healthy=0
for _ in $(seq 1 20); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${CONTROL_PORT}/health" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
[ "$healthy" -eq 1 ] || die "控制面没有通过 /health 自检；看 journalctl -u relay-control。"
systemctl is-active --quiet relay-control || die "relay-control 没有运行。"
nginx -t >/dev/null || die "Nginx 自检失败。"
DB_CHECK="$(cd "$APP_DIR" && runuser -u relay -- "$APP_DIR/venv/bin/python" -m control.cli check-db --db "$DB_FILE")"
[ "$DB_CHECK" = "ok" ] || die "SQLite 自检失败：${DB_CHECK}"

say ""
say "安装完成。"
say "管理后台：https://${ADMIN_HOST}"
if [ "$ADMIN_CREATED" -eq 1 ]; then
  say "管理员用户名：admin"
  say "管理员初始密码：${ADMIN_PASSWORD}"
  say "密码只显示这一次；请立刻保存到密码管理器。"
else
  say "管理员账号已存在，本次没有改动密码。"
fi
say "租户地址：https://<id>.${DOMAIN}"
say "控制地址：frp-<id>.${DOMAIN}:443（wss）"
say ""
say "下一步：登录后台创建一个邀请码，发给要使用的中继用户。"
say "卸载：sudo ./install.sh --uninstall（保留数据）；彻底删除加 --purge。"
