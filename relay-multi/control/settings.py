"""控制面配置。敏感值只从环境文件读取。"""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    db_path: str
    pepper: str
    domain: str = "relay.local"
    admin_url: str = ""
    admin_user: str = "admin"
    default_max_tenants: int = 20
    helper_path: str = "/usr/local/lib/relay-multi/helper"
    claim_ip_limit: int = 5
    claim_global_limit: int = 50
    auth_failure_limit: int = 10

    @classmethod
    def from_env(cls) -> "Settings":
        pepper = os.environ.get("RELAY_PEPPER", "")
        if not pepper:
            raise RuntimeError("缺少 RELAY_PEPPER；请从 /etc/relay-multi/relay.env 启动")
        max_tenants = _bounded_int(os.environ.get("RELAY_DEFAULT_MAX_TENANTS"), 20, 1, 100)
        domain = os.environ.get("RELAY_DOMAIN", "").strip().lower()
        if not domain:
            raise RuntimeError("缺少 RELAY_DOMAIN；请从 /etc/relay-multi/relay.env 启动")
        return cls(
            db_path=os.environ.get("RELAY_DB", "/var/lib/relay-multi/control.db"),
            pepper=pepper,
            domain=domain,
            admin_url=os.environ.get("RELAY_ADMIN_URL", f"https://admin.{domain}").rstrip("/"),
            admin_user=os.environ.get("RELAY_ADMIN_USER", "admin"),
            default_max_tenants=max_tenants,
            helper_path=os.environ.get("RELAY_HELPER", "/usr/local/lib/relay-multi/helper"),
            claim_ip_limit=_bounded_int(os.environ.get("RELAY_CLAIM_IP_LIMIT"), 5, 1, 1000),
            claim_global_limit=_bounded_int(os.environ.get("RELAY_CLAIM_GLOBAL_LIMIT"), 50, 1, 100000),
            auth_failure_limit=_bounded_int(os.environ.get("RELAY_AUTH_FAILURE_LIMIT"), 10, 1, 1000),
        )


def _bounded_int(value: str | None, fallback: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value) if value is not None else fallback
    except (TypeError, ValueError):
        return fallback
    return parsed if minimum <= parsed <= maximum else fallback
