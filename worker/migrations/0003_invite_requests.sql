-- 共享固定地址的邮箱自助申请。只存 HMAC 和掩码，不存明文邮箱/IP。
CREATE TABLE IF NOT EXISTS relay_invite_requests (
  request_id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL UNIQUE,
  email_masked TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'fulfilled', 'revoked')),
  verify_hash TEXT,
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER,
  invite_hash TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  verified_at INTEGER,
  fulfilled_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS relay_invite_requests_ip_created ON relay_invite_requests (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS relay_invite_requests_state ON relay_invite_requests (state, created_at);
