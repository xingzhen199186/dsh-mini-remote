"""邀请票：把控制台地址和邀请码打包成一条用户不需要理解的不透明字符串。"""

from __future__ import annotations

import base64
import json

PREFIX = "relay1."


def build_ticket(admin_url: str, code: str, expires_at: int) -> str:
    payload = {
        "v": 1,
        "u": str(admin_url).rstrip("/"),
        "c": str(code),
        "e": int(expires_at),
    }
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return PREFIX + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def build_join_url(admin_url: str, code: str) -> str:
    return f"{str(admin_url).rstrip('/')}/join/{code}"
