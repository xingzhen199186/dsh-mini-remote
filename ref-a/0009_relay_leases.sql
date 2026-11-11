-- dsh-market: relay named-tunnel leases.
--
-- The additive control plane (src/relay-control.js) keeps one lease per relay
-- identity: the remote-managed tunnel it owns, the exact proxied CNAME that
-- routes its hostname into that tunnel, and the local origin port its ingress
-- points at. relay_registrations keeps serving the quick-tunnel path until the
-- migration removes it; a row here survives release (state 'released') because
-- the hostname is the phone's bookmark, and only retire or the 90-day cron GC
-- removes the account resources behind it.
CREATE TABLE IF NOT EXISTS relay_leases (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL,
  -- The account-owned tunnel; NULL only for a lease that never converged.
  tunnel_id TEXT,
  hostname TEXT NOT NULL,
  origin_port INTEGER NOT NULL,
  plugin_version TEXT,
  -- 'active' while claims refresh it, 'released' after the offline action.
  state TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  -- The GC clock: a row unseen for 90 days is recovered (same TTL as the
  -- registry).
  last_seen_at INTEGER NOT NULL,
  released_at INTEGER
);

-- The cron GC scans by the TTL column, and the retire path looks a lease up by
-- id alone (the primary key).
CREATE INDEX IF NOT EXISTS relay_leases_last_seen ON relay_leases (last_seen_at);
