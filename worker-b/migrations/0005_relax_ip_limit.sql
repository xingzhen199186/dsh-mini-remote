-- 放宽 IP 限制：邮箱仍然只能申请一次；同一 IP 允许有限次申请。
-- 旧表把 ip_hash 设成 UNIQUE，SQLite 不能直接去掉，所以重建一次。
CREATE TABLE b_invite_requests_v2 (
  request_id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL UNIQUE,
  email_masked TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
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

INSERT INTO b_invite_requests_v2 (
  request_id, email_hash, email_masked, ip_hash, state, verify_hash,
  verify_attempts, last_sent_at, lease_id, code_id, created_at, expires_at,
  verified_at, fulfilled_at, revoked_at
)
SELECT
  request_id, email_hash, email_masked, ip_hash, state, verify_hash,
  verify_attempts, last_sent_at, lease_id, code_id, created_at, expires_at,
  verified_at, fulfilled_at, revoked_at
FROM b_invite_requests;

DROP TABLE b_invite_requests;
ALTER TABLE b_invite_requests_v2 RENAME TO b_invite_requests;

CREATE INDEX b_invite_requests_ip_created ON b_invite_requests (ip_hash, created_at);
CREATE INDEX b_invite_requests_state ON b_invite_requests (state, created_at);
CREATE INDEX b_invite_requests_lease ON b_invite_requests (lease_id);
