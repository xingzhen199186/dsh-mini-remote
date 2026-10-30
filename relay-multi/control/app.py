"""relay-multi 控制面：FastAPI + SQLite。"""

from __future__ import annotations

import base64
import html
import json
import re
import secrets
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel

from .database import Database, consume_rate
from .helper import HelperError, SudoHelper
from .security import random_tenant_id, random_token, secret_hash, verify_password
from .settings import Settings
from .ticket import build_join_url, build_ticket

TENANT_ID_RE = re.compile(r"^[a-z2-7]{26}$")
SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{43}$")
REQUEST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
DAY_MS = 24 * 60 * 60 * 1000
STATE_COUNTED = ("active", "provisioning", "released", "failed")
ADMIN_HTML = Path(__file__).with_name("admin.html").read_text(encoding="utf-8")


class AppError(Exception):
    def __init__(self, status: int, code: str, message: str, headers: dict | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.headers = headers or {}


class ClaimBody(BaseModel):
    inviteCode: str | None = None
    clientSecret: str
    originPort: int
    claimRequestId: str


class TenantBody(BaseModel):
    id: str
    clientSecret: str


class InviteBody(BaseModel):
    expiresInDays: int | None = None


class ConfigBody(BaseModel):
    allowRegistration: bool | None = None
    inviteRequired: bool | None = None
    maxTenants: int | None = None


def now_ms() -> int:
    return int(time.time() * 1000)


def tenant_view(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "publicHost": row["public_host"],
        "controlHost": row["control_host"],
        "frpsPort": 443,
        "transport": "wss",
        "state": row["state"],
        "createdAt": row["created_at"],
        "claimedAt": row["claimed_at"],
        "lastSeenAt": row["last_seen_at"],
        "releasedAt": row["released_at"],
        "revokedAt": row["revoked_at"],
    }


def read_config(conn: sqlite3.Connection) -> dict[str, Any]:
    rows = conn.execute("SELECT key, value FROM config").fetchall()
    values = {row["key"]: row["value"] for row in rows}
    try:
        max_tenants = int(values.get("maxTenants", "20"))
    except ValueError:
        max_tenants = 20
    return {
        "allowRegistration": values.get("allowRegistration", "0") == "1",
        "inviteRequired": values.get("inviteRequired", "1") == "1",
        "maxTenants": min(100, max(1, max_tenants)),
    }


def audit(conn: sqlite3.Connection, actor: str, action: str, target: str | None, detail: dict | None = None) -> None:
    conn.execute(
        "INSERT INTO audit (actor, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?)",
        (actor, action, target, json.dumps(detail, ensure_ascii=False) if detail else None, now_ms()),
    )


def start_op(conn: sqlite3.Connection, kind: str) -> str:
    run_id = str(uuid.uuid4())
    conn.execute(
        "INSERT INTO ops_runs (run_id, kind, status, started_at) VALUES (?, ?, 'running', ?)",
        (run_id, kind, now_ms()),
    )
    return run_id


def finish_op(conn: sqlite3.Connection, run_id: str, status: str, summary: dict) -> None:
    conn.execute(
        "UPDATE ops_runs SET status = ?, finished_at = ?, summary = ? WHERE run_id = ?",
        (status, now_ms(), json.dumps(summary, ensure_ascii=False), run_id),
    )


def create_app(settings: Settings, helper=None) -> FastAPI:
    db = Database(settings.db_path)
    db.initialize(settings.default_max_tenants)
    helper = helper or SudoHelper(settings.helper_path)

    app = FastAPI(title="relay-multi control", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.db = db
    app.state.helper = helper

    @app.exception_handler(AppError)
    async def app_error(_request: Request, exc: AppError):
        payload = {"ok": False, "error": exc.code, "message": exc.message}
        return JSONResponse(payload, status_code=exc.status, headers=exc.headers)

    def require_admin(request: Request) -> str:
        header = request.headers.get("authorization", "")
        if not header.lower().startswith("basic "):
            raise AppError(401, "auth_required", "需要管理员登录", {"WWW-Authenticate": 'Basic realm="relay-multi"'})
        try:
            decoded = base64.b64decode(header[6:].strip(), validate=True).decode("utf-8")
            username, _, password = decoded.partition(":")
        except (ValueError, UnicodeDecodeError):
            raise AppError(401, "auth_failed", "用户名或密码不对", {"WWW-Authenticate": 'Basic realm="relay-multi"'})

        conn = db.connect()
        try:
            row = conn.execute("SELECT password_hash FROM admins WHERE username = ?", (username,)).fetchone()
            valid = bool(row) and verify_password(password, row["password_hash"])
            if valid:
                return username
            ip = request.client.host if request.client else "unknown"
            retry = consume_rate(conn, f"admin-auth:{ip}", settings.auth_failure_limit, 600)
            if retry:
                raise AppError(429, "rate_limited", "登录失败次数太多，稍后再试", {"Retry-After": str(retry)})
            raise AppError(401, "auth_failed", "用户名或密码不对", {"WWW-Authenticate": 'Basic realm="relay-multi"'})
        finally:
            conn.close()

    def get_conn() -> sqlite3.Connection:
        return db.connect()

    def config_view() -> dict[str, Any]:
        conn = get_conn()
        try:
            return read_config(conn)
        finally:
            conn.close()

    def validate_claim(body: ClaimBody) -> str | None:
        if not SECRET_RE.fullmatch(body.clientSecret):
            raise AppError(400, "invalid_request", "clientSecret 格式不对")
        if not REQUEST_ID_RE.fullmatch(body.claimRequestId):
            raise AppError(400, "invalid_request", "claimRequestId 格式不对")
        if not isinstance(body.originPort, int) or not 1 <= body.originPort <= 65535:
            raise AppError(400, "invalid_request", "originPort 必须在 1..65535")
        invite = (body.inviteCode or "").strip()
        return invite or None

    def existing_claim(conn: sqlite3.Connection, body: ClaimBody) -> dict | None:
        row = conn.execute(
            "SELECT * FROM tenants WHERE claim_request_id = ?", (body.claimRequestId,)
        ).fetchone()
        if row is None:
            return None
        expected = secret_hash(settings.pepper, "client", f"{row['id']}:{body.clientSecret}")
        if not secrets.compare_digest(expected, row["client_secret_hash"]):
            raise AppError(403, "auth_failed", "这个 claimRequestId 不属于当前 clientSecret")
        if row["state"] == "provisioning":
            raise AppError(409, "provisioning_incomplete", "这个租户还在创建中，稍后用同一个 claimRequestId 查询")
        if row["state"] == "failed":
            raise AppError(409, "tenant_failed", "这个租户创建失败，请联系管理员")
        if row["state"] == "revoked":
            raise AppError(410, "tenant_revoked", "这个租户已经被管理员撤销")
        view = tenant_view(row)
        view.update({"ok": True, "tokenIssued": False})
        return view

    @app.get("/", include_in_schema=False)
    def root():
        return RedirectResponse("/admin", status_code=307)

    @app.get("/join/{code}", response_class=HTMLResponse, include_in_schema=False)
    def join_page(code: str):
        safe = html.escape(code)
        return HTMLResponse(
            "<!doctype html><meta charset='utf-8'><title>加入中继</title>"
            "<style>body{font:16px/1.6 system-ui;max-width:680px;margin:12vh auto;padding:0 24px}"
            "code{background:#f3f4f6;padding:3px 6px;border-radius:5px;word-break:break-all}</style>"
            "<h1>加入这个中继</h1>"
            "<p>请在 DSH 的「自建多用户中继」里粘贴下面这条邀请链接：</p>"
            f"<p><code>https://{html.escape(settings.admin_url.split('://')[-1])}/join/{safe}</code></p>"
            "<p class='muted'>链接一次性使用，过期失效。不要在公开群里转发。</p>"
        )

    @app.get("/health")
    def health():
        conn = get_conn()
        try:
            conn.execute("SELECT 1").fetchone()
        finally:
            conn.close()
        return {"ok": True, "version": "0.1.0", "db": "ok"}

    @app.get("/admin", response_class=HTMLResponse, dependencies=[Depends(require_admin)])
    def admin_page():
        return HTMLResponse(ADMIN_HTML, headers={"Cache-Control": "no-store"})

    @app.get("/admin/api/qr")
    def admin_qr(data: str, _actor: str = Depends(require_admin)):
        if not data.startswith("https://") or len(data) > 2048:
            raise AppError(400, "invalid_request", "二维码内容必须是 https 链接")
        try:
            import io
            import qrcode
            image = qrcode.make(data)
            buffer = io.BytesIO()
            image.save(buffer, format="PNG")
            return Response(content=buffer.getvalue(), media_type="image/png")
        except Exception:
            raise AppError(503, "qr_unavailable", "二维码生成组件未安装，请安装 qrcode[pil]")

    @app.get("/admin/api/overview")
    def admin_overview(_actor: str = Depends(require_admin)):
        conn = get_conn()
        try:
            counts = {row["state"]: int(row["n"]) for row in conn.execute(
                "SELECT state, COUNT(*) AS n FROM tenants GROUP BY state"
            ).fetchall()}
            now = now_ms()
            invite_rows = conn.execute(
                "SELECT CASE WHEN used_at IS NOT NULL THEN 'used' "
                "WHEN expires_at <= ? THEN 'expired' ELSE 'available' END AS state, COUNT(*) AS n "
                "FROM invites GROUP BY state",
                (now,),
            ).fetchall()
            invites = {row["state"]: int(row["n"]) for row in invite_rows}
            config = read_config(conn)
            used = int(conn.execute(
                f"SELECT COUNT(*) AS n FROM tenants WHERE state IN ({','.join('?' for _ in STATE_COUNTED)})",
                STATE_COUNTED,
            ).fetchone()["n"])
            return {
                "ok": True,
                "tenants": counts,
                "invites": invites,
                "capacity": {"used": used, "maxTenants": config["maxTenants"]},
                "config": config,
            }
        finally:
            conn.close()

    @app.get("/admin/api/tenants")
    def admin_tenants(_actor: str = Depends(require_admin)):
        conn = get_conn()
        try:
            rows = conn.execute("SELECT * FROM tenants ORDER BY created_at DESC").fetchall()
            return {"ok": True, "tenants": [tenant_view(row) for row in rows]}
        finally:
            conn.close()

    @app.get("/admin/api/invites")
    def admin_invites(_actor: str = Depends(require_admin)):
        conn = get_conn()
        try:
            now = now_ms()
            rows = conn.execute("SELECT * FROM invites ORDER BY created_at DESC").fetchall()
            invites = []
            for row in rows:
                state = "used" if row["used_at"] else ("expired" if row["expires_at"] <= now else "available")
                invites.append({
                    "id": row["invite_id"],
                    "state": state,
                    "createdAt": row["created_at"],
                    "expiresAt": row["expires_at"],
                    "usedAt": row["used_at"],
                    "usedByTenantId": row["used_by_tenant_id"],
                })
            return {"ok": True, "invites": invites}
        finally:
            conn.close()

    @app.get("/admin/api/audit")
    def admin_audit(_actor: str = Depends(require_admin)):
        conn = get_conn()
        try:
            rows = conn.execute("SELECT * FROM audit ORDER BY id DESC LIMIT 100").fetchall()
            items = []
            for row in rows:
                try:
                    detail = json.loads(row["detail"]) if row["detail"] else None
                except json.JSONDecodeError:
                    detail = None
                items.append({
                    "id": row["id"],
                    "actor": row["actor"],
                    "action": row["action"],
                    "target": row["target"],
                    "detail": detail,
                    "createdAt": row["created_at"],
                })
            return {"ok": True, "audit": items}
        finally:
            conn.close()

    @app.get("/admin/api/config")
    def admin_config_get(_actor: str = Depends(require_admin)):
        return {"ok": True, **config_view()}

    @app.post("/admin/api/config")
    def admin_config_set(body: ConfigBody, actor: str = Depends(require_admin)):
        if body.allowRegistration is None and body.inviteRequired is None and body.maxTenants is None:
            raise AppError(400, "invalid_request", "至少要改一项配置")
        if body.maxTenants is not None and not 1 <= body.maxTenants <= 100:
            raise AppError(400, "invalid_request", "maxTenants 必须在 1..100")
        conn = get_conn()
        try:
            before = read_config(conn)
            after = dict(before)
            updates: dict[str, str] = {}
            if body.allowRegistration is not None:
                updates["allowRegistration"] = "1" if body.allowRegistration else "0"
                after["allowRegistration"] = body.allowRegistration
            if body.inviteRequired is not None:
                updates["inviteRequired"] = "1" if body.inviteRequired else "0"
                after["inviteRequired"] = body.inviteRequired
            if body.maxTenants is not None:
                updates["maxTenants"] = str(body.maxTenants)
                after["maxTenants"] = body.maxTenants
            for key, value in updates.items():
                conn.execute(
                    "INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                    (key, value, now_ms()),
                )
            audit(conn, actor, "config.update", None, {"before": before, "after": after})
            conn.commit()
            return {"ok": True, **after}
        finally:
            conn.close()

    @app.post("/admin/api/invites")
    def admin_invite_create(payload: InviteBody | None = None, actor: str = Depends(require_admin)):
        days = payload.expiresInDays if payload and payload.expiresInDays is not None else 7
        if not 1 <= days <= 30:
            raise AppError(400, "invalid_request", "邀请码有效期必须在 1..30 天")
        code = random_token(32)
        invite_id = str(uuid.uuid4())
        created = now_ms()
        expires = created + days * DAY_MS
        conn = get_conn()
        try:
            conn.execute(
                "INSERT INTO invites (invite_id, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?)",
                (invite_id, secret_hash(settings.pepper, "invite", code), created, expires),
            )
            audit(conn, actor, "invite.create", invite_id, {"expiresAt": expires})
            conn.commit()
            return {
                "ok": True,
                "id": invite_id,
                "code": code,
                "ticket": build_ticket(settings.admin_url, code, expires),
                "joinUrl": build_join_url(settings.admin_url, code),
                "expiresAt": expires,
            }
        finally:
            conn.close()

    @app.post("/admin/api/tenants/{tenant_id}/revoke")
    def admin_revoke(tenant_id: str, actor: str = Depends(require_admin)):
        if not TENANT_ID_RE.fullmatch(tenant_id):
            raise AppError(400, "invalid_request", "租户 id 格式不对")
        conn = get_conn()
        try:
            row = conn.execute("SELECT * FROM tenants WHERE id = ?", (tenant_id,)).fetchone()
            if row is None:
                raise AppError(404, "not_found", "没有这个租户")
            if row["state"] == "revoked":
                return {"ok": True, "tenant": tenant_view(row)}
            run_id = start_op(conn, "revoke")
            conn.commit()
        finally:
            conn.close()

        try:
            helper.delete_tenant(tenant_id)
            helper.reload_nginx()
        except HelperError:
            conn = get_conn()
            try:
                finish_op(conn, run_id, "failed", {"tenantId": tenant_id, "error": "helper_failed"})
                audit(conn, actor, "tenant.revoke.failed", tenant_id, {"error": "helper_failed"})
                conn.commit()
            finally:
                conn.close()
            raise AppError(502, "helper_failed", "root helper 删除租户失败，请检查服务器日志")

        conn = get_conn()
        try:
            revoked_at = now_ms()
            conn.execute(
                "UPDATE tenants SET state = 'revoked', revoked_at = ? WHERE id = ?",
                (revoked_at, tenant_id),
            )
            finish_op(conn, run_id, "succeeded", {"tenantId": tenant_id})
            audit(conn, actor, "tenant.revoke", tenant_id, None)
            conn.commit()
            row = conn.execute("SELECT * FROM tenants WHERE id = ?", (tenant_id,)).fetchone()
            return {"ok": True, "tenant": tenant_view(row)}
        finally:
            conn.close()

    @app.post("/api/claim")
    def claim(body: ClaimBody, request: Request):
        invite_code = validate_claim(body)

        conn = get_conn()
        try:
            existing = existing_claim(conn, body)
            if existing is not None:
                return existing
            config = read_config(conn)
        finally:
            conn.close()

        if invite_code is None:
            if config["inviteRequired"]:
                raise AppError(403, "invite_required", "这个中继要求邀请码")
            if not config["allowRegistration"]:
                raise AppError(403, "registration_closed", "这个中继没有开放注册")

        ip = request.client.host if request.client else "unknown"
        conn = get_conn()
        try:
            retry = consume_rate(conn, f"claim:ip:{ip}", settings.claim_ip_limit, 3600)
            if not retry:
                retry = consume_rate(conn, "claim:global", settings.claim_global_limit, 86400)
        finally:
            conn.close()
        if retry:
            raise AppError(429, "rate_limited", "开通请求太频繁，稍后再试", {"Retry-After": str(retry)})

        created = now_ms()
        tenant_id = None
        control_port = None
        vhost_port = None
        run_id = None
        conn = get_conn()
        try:
            conn.execute("BEGIN IMMEDIATE")
            existing = existing_claim(conn, body)
            if existing is not None:
                conn.rollback()
                return existing

            used = int(conn.execute(
                f"SELECT COUNT(*) AS n FROM tenants WHERE state IN ({','.join('?' for _ in STATE_COUNTED)})",
                STATE_COUNTED,
            ).fetchone()["n"])
            if used >= config["maxTenants"]:
                raise AppError(409, "capacity_exhausted", "这个中继的租户名额已经用完")

            invite_row = None
            if invite_code is not None:
                invite_row = conn.execute(
                    "SELECT * FROM invites WHERE code_hash = ?",
                    (secret_hash(settings.pepper, "invite", invite_code),),
                ).fetchone()
                if invite_row is None:
                    raise AppError(403, "invite_invalid", "邀请码无效")
                if invite_row["used_at"] is not None:
                    raise AppError(409, "invite_used", "邀请码已经使用")
                if int(invite_row["expires_at"]) <= created:
                    raise AppError(410, "invite_expired", "邀请码已经过期")

            occupied = {
                int(row["control_port"])
                for row in conn.execute("SELECT control_port FROM tenants").fetchall()
            }
            for index in range(1, 101):
                candidate = 7100 + index
                if candidate not in occupied:
                    control_port = candidate
                    vhost_port = 8100 + index
                    break
            if control_port is None:
                raise AppError(409, "capacity_exhausted", "这个中继的端口已经用完")

            for _ in range(5):
                candidate = random_tenant_id()
                if conn.execute("SELECT 1 FROM tenants WHERE id = ?", (candidate,)).fetchone() is None:
                    tenant_id = candidate
                    break
            if tenant_id is None:
                raise AppError(409, "claim_conflict", "生成租户标识冲突，请重试")

            if invite_row is not None:
                changed = conn.execute(
                    "UPDATE invites SET used_at = ?, used_by_tenant_id = ? "
                    "WHERE invite_id = ? AND used_at IS NULL AND expires_at > ?",
                    (created, tenant_id, invite_row["invite_id"], created),
                ).rowcount
                if changed != 1:
                    raise AppError(409, "invite_used", "邀请码已经使用")

            client_hash = secret_hash(settings.pepper, "client", f"{tenant_id}:{body.clientSecret}")
            conn.execute(
                "INSERT INTO tenants "
                "(id, public_host, control_host, control_port, vhost_port, token_hash, state, "
                "client_secret_hash, claim_request_id, origin_port, created_at) "
                "VALUES (?, ?, ?, ?, ?, '', 'provisioning', ?, ?, ?, ?)",
                (
                    tenant_id,
                    f"{tenant_id}.{settings.domain}",
                    f"frp-{tenant_id}.{settings.domain}",
                    control_port,
                    vhost_port,
                    client_hash,
                    body.claimRequestId,
                    body.originPort,
                    created,
                ),
            )
            run_id = start_op(conn, "claim")
            audit(conn, "plugin", "tenant.create", tenant_id, {"invite": invite_row is not None})
            conn.commit()
        except AppError:
            conn.rollback()
            raise
        except sqlite3.IntegrityError:
            conn.rollback()
            existing = existing_claim(conn, body)
            if existing is not None:
                return existing
            raise AppError(409, "claim_conflict", "claimRequestId 或资源冲突，请换一个请求号")
        finally:
            conn.close()

        try:
            frp_token = helper.create_tenant(tenant_id, control_port, vhost_port)
            if not isinstance(frp_token, str) or len(frp_token.strip()) < 20:
                raise HelperError("empty token")
            frp_token = frp_token.strip()
        except Exception:
            conn = get_conn()
            try:
                conn.execute("UPDATE tenants SET state = 'failed' WHERE id = ?", (tenant_id,))
                finish_op(conn, run_id, "failed", {"tenantId": tenant_id, "error": "helper_failed"})
                audit(conn, "plugin", "tenant.create.failed", tenant_id, {"error": "helper_failed"})
                conn.commit()
            finally:
                conn.close()
            raise AppError(502, "helper_failed", "root helper 创建中继失败，请联系管理员")

        token_digest = secret_hash(settings.pepper, "frp-token", frp_token)
        conn = get_conn()
        try:
            claimed_at = now_ms()
            conn.execute(
                "UPDATE tenants SET state = 'active', token_hash = ?, claimed_at = ?, last_seen_at = ? "
                "WHERE id = ?",
                (token_digest, claimed_at, claimed_at, tenant_id),
            )
            finish_op(conn, run_id, "succeeded", {"tenantId": tenant_id})
            audit(conn, "plugin", "tenant.claim", tenant_id, {"transport": "wss"})
            conn.commit()
            row = conn.execute("SELECT * FROM tenants WHERE id = ?", (tenant_id,)).fetchone()
        finally:
            conn.close()
        result = tenant_view(row)
        result.update({"ok": True, "tokenIssued": True, "frpToken": frp_token})
        return result

    @app.post("/api/status")
    def status(body: TenantBody):
        if not TENANT_ID_RE.fullmatch(body.id) or not SECRET_RE.fullmatch(body.clientSecret):
            raise AppError(400, "invalid_request", "id 或 clientSecret 格式不对")
        conn = get_conn()
        try:
            row = conn.execute("SELECT * FROM tenants WHERE id = ?", (body.id,)).fetchone()
            expected = secret_hash(settings.pepper, "client", f"{body.id}:{body.clientSecret}")
            if row is None or not secrets.compare_digest(expected, row["client_secret_hash"]):
                raise AppError(403, "auth_failed", "id 或 clientSecret 不对")
            conn.execute("UPDATE tenants SET last_seen_at = ? WHERE id = ?", (now_ms(), body.id))
            conn.commit()
            return {"ok": True, "tenant": tenant_view(row)}
        finally:
            conn.close()

    @app.post("/api/release")
    def release(body: TenantBody):
        if not TENANT_ID_RE.fullmatch(body.id) or not SECRET_RE.fullmatch(body.clientSecret):
            raise AppError(400, "invalid_request", "id 或 clientSecret 格式不对")
        conn = get_conn()
        try:
            row = conn.execute("SELECT * FROM tenants WHERE id = ?", (body.id,)).fetchone()
            expected = secret_hash(settings.pepper, "client", f"{body.id}:{body.clientSecret}")
            if row is None or not secrets.compare_digest(expected, row["client_secret_hash"]):
                raise AppError(403, "auth_failed", "id 或 clientSecret 不对")
            if row["state"] == "revoked":
                raise AppError(410, "tenant_revoked", "这个租户已经被管理员撤销")
            if row["state"] == "active":
                released_at = now_ms()
                conn.execute(
                    "UPDATE tenants SET state = 'released', released_at = ? WHERE id = ?",
                    (released_at, body.id),
                )
                audit(conn, "plugin", "tenant.release", body.id, None)
                conn.commit()
                row = conn.execute("SELECT * FROM tenants WHERE id = ?", (body.id,)).fetchone()
            return {"ok": True, "tenant": tenant_view(row)}
        finally:
            conn.close()

    return app
