-- 自助申请邀请码：一个邮箱、一个 IP 各只能申请一次。
-- 只存 HMAC 和掩码，不存明文邮箱/IP。
CREATE TABLE b_invite_requests (
  request_id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL UNIQUE,
  email_masked TEXT NOT NULL,
  ip_hash TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'verified', 'fulfilled', 'revoked')),
  verify_hash TEXT,
  verify_attempts INTEGER NOT NULL DEFAULT 0,
  last_sent_at INTEGER,
  lease_id TEXT,
  code_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  verified_at INTEGER,
  fulfilled_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX b_invite_requests_state ON b_invite_requests (state, created_at);
CREATE INDEX b_invite_requests_lease ON b_invite_requests (lease_id);
