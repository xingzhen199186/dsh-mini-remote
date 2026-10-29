"""密码、哈希与随机标识。只使用 Python 标准库。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

PBKDF2_ITERATIONS = 200_000
BASE32 = "abcdefghijklmnopqrstuvwxyz234567"


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, PBKDF2_ITERATIONS)
    return "pbkdf2_sha256${}${}${}".format(
        PBKDF2_ITERATIONS,
        base64.urlsafe_b64encode(salt).decode().rstrip("="),
        base64.urlsafe_b64encode(digest).decode().rstrip("="),
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        scheme, iterations, salt_text, digest_text = encoded.split("$", 3)
        if scheme != "pbkdf2_sha256":
            return False
        salt = _b64decode(salt_text)
        expected = _b64decode(digest_text)
        actual = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, int(iterations))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


def _b64decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def secret_hash(pepper: str, purpose: str, value: str) -> str:
    return hmac.new(
        pepper.encode(),
        f"{purpose}:{value}".encode(),
        hashlib.sha256,
    ).hexdigest()


def random_token(nbytes: int = 32) -> str:
    return secrets.token_urlsafe(nbytes)


def random_tenant_id() -> str:
    raw = secrets.token_bytes(16)
    bits = 0
    value = 0
    out = []
    for byte in raw:
        value = (value << 8) | byte
        bits += 8
        while bits >= 5:
            out.append(BASE32[(value >> (bits - 5)) & 31])
            bits -= 5
    if bits:
        out.append(BASE32[(value << (5 - bits)) & 31])
    return "".join(out)
