CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE audit_entries (
  id              UUID        NOT NULL DEFAULT gen_random_uuid(),
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  entity_type     TEXT        NOT NULL,
  entity_id       UUID,
  action          TEXT        NOT NULL,
  outcome         TEXT        NOT NULL,
  outcome_reason  TEXT,
  changed_by      UUID,
  source_ip       INET,
  user_agent      TEXT,
  request_id      TEXT,
  previous_value  JSONB,
  new_value       JSONB,
  metadata        JSONB,
  PRIMARY KEY (id, changed_at)
);

SELECT create_hypertable(
  'audit_entries',
  'changed_at',
  chunk_time_interval => INTERVAL '7 days'
);

-- Auditor query patterns: "all actions on entity X", "all actions by user Y",
-- "all failures of action Z", "all events from IP subnet /24"
CREATE INDEX idx_audit_entity ON audit_entries (entity_type, entity_id, changed_at DESC);
CREATE INDEX idx_audit_actor  ON audit_entries (changed_by,              changed_at DESC);
CREATE INDEX idx_audit_action ON audit_entries (action, outcome,         changed_at DESC);
CREATE INDEX idx_audit_ip     ON audit_entries (source_ip,               changed_at DESC);

-- SOC 2 minimum: 1 year retention. TimescaleDB drops_chunks() operates on time
-- boundaries, not row-level DELETEs, so it bypasses any row-level REVOKE.
SELECT add_retention_policy('audit_entries', INTERVAL '1 year');

-- Default privileges (set in bootstrap_roles.sql) granted db_app the full
-- SELECT/INSERT/UPDATE/DELETE set. Trim it to append-only here so the SOC 2
-- immutability boundary is enforced at the DB layer, not the app.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_entries FROM db_app;
GRANT SELECT ON audit_entries TO db_auditor;
