CREATE OR REPLACE FUNCTION app.is_service_role() RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT current_setting('app.service_role', true) = 'on'
    AND (
      session_user = 'postgres'
      OR session_user = 'infinite_canvas_service'
      OR EXISTS (
        SELECT 1
        FROM pg_roles service_group
        WHERE service_group.rolname = 'infinite_canvas_service'
          AND pg_has_role(session_user, service_group.oid, 'MEMBER')
      )
    )
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'workspaces', 'projects', 'project_versions',
    'assets', 'provider_channels', 'provider_credentials', 'model_configs', 'model_prices',
    'wallet_accounts', 'wallet_entries', 'idempotency_requests', 'generation_batches',
    'generation_jobs', 'generation_attempts', 'generation_job_targets', 'credit_reservations',
    'generation_job_events', 'outbox_events', 'imports', 'platform_risk_entries', 'audit_logs',
    'import_source_mappings'
  ] LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
  ALTER TABLE profiles NO FORCE ROW LEVEL SECURITY;
  ALTER TABLE workspace_members NO FORCE ROW LEVEL SECURITY;
END
$$;
