CREATE TABLE b_ops_runs (
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  summary TEXT
);

CREATE INDEX b_ops_runs_started ON b_ops_runs (started_at);

CREATE TABLE b_reconcile_findings (
  finding_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES b_ops_runs (run_id),
  lease_id TEXT,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  kind TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX b_reconcile_findings_run ON b_reconcile_findings (run_id, created_at);
CREATE INDEX b_reconcile_findings_lease ON b_reconcile_findings (lease_id, created_at);
