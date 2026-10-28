CREATE TABLE b_leases (
  lease_id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('invited', 'claimed', 'active', 'released', 'retired')),
  client_secret_hash TEXT,
  secret_version INTEGER NOT NULL DEFAULT 0,
  origin_port INTEGER,
  tunnel_name TEXT NOT NULL,
  tunnel_id TEXT,
  dns_record_id TEXT,
  dns_target TEXT,
  config_version INTEGER NOT NULL DEFAULT 0,
  credential_version INTEGER NOT NULL DEFAULT 1,
  blocked_reason TEXT,
  created_at INTEGER NOT NULL,
  claimed_at INTEGER,
  activated_at INTEGER,
  last_seen_at INTEGER,
  released_at INTEGER,
  retired_at INTEGER,
  row_version INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX b_leases_tunnel_id ON b_leases (tunnel_id) WHERE tunnel_id IS NOT NULL;
CREATE UNIQUE INDEX b_leases_dns_record_id ON b_leases (dns_record_id) WHERE dns_record_id IS NOT NULL;
CREATE INDEX b_leases_state ON b_leases (state);

CREATE TABLE b_activation_codes (
  code_id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  lease_id TEXT NOT NULL UNIQUE REFERENCES b_leases (lease_id),
  state TEXT NOT NULL CHECK (state IN ('invited', 'claimed', 'revoked')),
  batch_id TEXT,
  note TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  claimed_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX b_activation_codes_expiry ON b_activation_codes (state, expires_at);

CREATE TABLE b_operations (
  operation_id TEXT NOT NULL,
  lease_id TEXT NOT NULL REFERENCES b_leases (lease_id),
  type TEXT NOT NULL,
  request_fingerprint TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'succeeded', 'failed')),
  current_step TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (lease_id, operation_id)
);

CREATE INDEX b_operations_pending ON b_operations (state, next_retry_at);

CREATE TABLE b_resource_inventory (
  environment TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('tunnel', 'dns', 'ingress')),
  resource_id TEXT NOT NULL,
  lease_id TEXT NOT NULL REFERENCES b_leases (lease_id),
  owning_operation_id TEXT,
  first_seen_at INTEGER NOT NULL,
  last_reconciled_at INTEGER NOT NULL,
  drift_state TEXT NOT NULL,
  PRIMARY KEY (environment, resource_type, resource_id)
);

CREATE INDEX b_resource_inventory_lease ON b_resource_inventory (lease_id);

CREATE TABLE b_admin_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  lease_id TEXT,
  code_id TEXT,
  reason TEXT,
  request_id TEXT NOT NULL,
  before_state TEXT,
  after_state TEXT,
  result TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX b_admin_audit_lease ON b_admin_audit (lease_id, created_at);

CREATE TABLE b_rate_limits (
  bucket TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
