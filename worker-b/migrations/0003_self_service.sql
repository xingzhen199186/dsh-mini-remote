CREATE TABLE b_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO b_config (key, value, updated_at) VALUES
  ('registrationEnabled', '1', CAST(strftime('%s', 'now') AS INTEGER) * 1000),
  ('inviteRequired', '1', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

ALTER TABLE b_leases ADD COLUMN claim_request_id TEXT;

CREATE UNIQUE INDEX b_leases_claim_request_id
  ON b_leases (claim_request_id)
  WHERE claim_request_id IS NOT NULL;
