-- Phase 1: relay identities, invites, rate limits, audit.
CREATE TABLE IF NOT EXISTS relay_identities (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active', -- active | revoked
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS relay_identities_last_seen ON relay_identities (last_seen_at);

CREATE TABLE IF NOT EXISTS relay_invites (
  code_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  note TEXT
);

CREATE TABLE IF NOT EXISTS relay_rate_limit (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE IF NOT EXISTS relay_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  reason TEXT,
  at INTEGER NOT NULL
);
