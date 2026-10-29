"""SQLite 数据层。每个请求开一条短连接，适合 20 个租户的规模。"""

from __future__ import annotations

import sqlite3
import time
from pathlib import Path

from .security import hash_password

SCHEMA = """
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS admins (
  username TEXT PRIMARY KEY,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
  invite_id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_by_tenant_id TEXT
);
CREATE INDEX IF NOT EXISTS invites_expiry ON invites (used_at, expires_at);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  public_host TEXT NOT NULL UNIQUE,
  control_host TEXT NOT NULL UNIQUE,
  control_port INTEGER NOT NULL UNIQUE,
  vhost_port INTEGER NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('provisioning', 'active', 'released', 'revoked', 'failed')),
  client_secret_hash TEXT NOT NULL,
  claim_request_id TEXT NOT NULL UNIQUE,
  origin_port INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  last_seen_at INTEGER,
  released_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS tenants_state ON tenants (state);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_created ON audit (created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE IF NOT EXISTS ops_runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  summary TEXT
);
"""

DEFAULT_CONFIG = {
    "allowRegistration": "0",
    "inviteRequired": "1",
}


class Database:
    def __init__(self, path: str):
        self.path = path

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 5000")
        return conn

    def initialize(self, default_max_tenants: int = 20) -> None:
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        conn = self.connect()
        try:
            conn.executescript(SCHEMA)
            now = int(time.time() * 1000)
            for key, value in DEFAULT_CONFIG.items():
                conn.execute(
                    "INSERT OR IGNORE INTO config (key, value, updated_at) VALUES (?, ?, ?)",
                    (key, value, now),
                )
            conn.execute(
                "INSERT OR IGNORE INTO config (key, value, updated_at) VALUES ('maxTenants', ?, ?)",
                (str(default_max_tenants), now),
            )
            conn.commit()
        finally:
            conn.close()

    def has_admin(self, username: str) -> bool:
        conn = self.connect()
        try:
            return conn.execute(
                "SELECT 1 FROM admins WHERE username = ?", (username,)
            ).fetchone() is not None
        finally:
            conn.close()

    def set_admin(self, username: str, password: str | None = None, password_hash: str | None = None) -> None:
        encoded = password_hash or hash_password(password or "")
        conn = self.connect()
        try:
            conn.execute(
                "INSERT INTO admins (username, password_hash, created_at) VALUES (?, ?, ?) "
                "ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash",
                (username, encoded, int(time.time() * 1000)),
            )
            conn.commit()
        finally:
            conn.close()

    def integrity_check(self) -> str:
        conn = self.connect()
        try:
            row = conn.execute("PRAGMA integrity_check").fetchone()
            return str(row[0]) if row else "unknown"
        finally:
            conn.close()


def consume_rate(
    conn: sqlite3.Connection,
    bucket: str,
    maximum: int,
    window_seconds: int,
    now_ms: int | None = None,
) -> int:
    """返回需要等待的秒数；0 表示允许。计数先写入，失败尝试也占额度。"""
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    window_ms = window_seconds * 1000
    window_start = now // window_ms * window_ms
    conn.execute(
        "INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1) "
        "ON CONFLICT(bucket, window_start) DO UPDATE SET count = count + 1",
        (bucket, window_start),
    )
    conn.commit()
    row = conn.execute(
        "SELECT count FROM rate_limits WHERE bucket = ? AND window_start = ?",
        (bucket, window_start),
    ).fetchone()
    if row is None or int(row["count"]) <= maximum:
        return 0
    return max(1, (window_start + window_ms - now + 999) // 1000)
