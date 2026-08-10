CREATE OR REPLACE FUNCTION app.protect_generation_capacity_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF NEW.capacity_policy_version IS DISTINCT FROM OLD.capacity_policy_version
    OR NEW.workspace_concurrency_limit IS DISTINCT FROM OLD.workspace_concurrency_limit
    OR NEW.workspace_rate_limit_per_minute IS DISTINCT FROM OLD.workspace_rate_limit_per_minute
    OR NEW.channel_concurrency_limit IS DISTINCT FROM OLD.channel_concurrency_limit
    OR NEW.channel_rate_limit_per_minute IS DISTINCT FROM OLD.channel_rate_limit_per_minute THEN
    RAISE EXCEPTION 'generation attempt capacity snapshot is immutable';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER generation_attempt_capacity_immutable
BEFORE UPDATE ON generation_attempts
FOR EACH ROW EXECUTE FUNCTION app.protect_generation_capacity_snapshot();

CREATE OR REPLACE FUNCTION app.release_terminal_capacity_lease()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, app AS $$
BEGIN
  IF NEW.status IN ('succeeded', 'failed', 'canceled')
    AND OLD.status NOT IN ('succeeded', 'failed', 'canceled') THEN
    DELETE FROM provider_channel_capacity_leases WHERE holder_id = NEW.id;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER generation_attempt_terminal_capacity_release
AFTER UPDATE OF status ON generation_attempts
FOR EACH ROW EXECUTE FUNCTION app.release_terminal_capacity_lease();

CREATE OR REPLACE FUNCTION app.validate_channel_capacity_lease()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
DECLARE
  attempt_channel uuid;
  attempt_capability generation_capability;
  attempt_state attempt_status;
BEGIN
  SELECT attempt.channel_id, job.capability, attempt.status
  INTO attempt_channel, attempt_capability, attempt_state
  FROM generation_attempts attempt
  JOIN generation_jobs job ON job.id = attempt.job_id AND job.workspace_id = attempt.workspace_id
  WHERE attempt.id = NEW.holder_id
  FOR UPDATE OF attempt, job;
  IF NOT FOUND
    OR attempt_channel IS DISTINCT FROM NEW.channel_id
    OR attempt_capability IS DISTINCT FROM NEW.capability
    OR attempt_state IN ('succeeded', 'failed', 'canceled')
    OR NEW.lease_expires_at <= NEW.acquired_at THEN
    RAISE EXCEPTION 'invalid provider channel capacity lease';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER provider_channel_capacity_lease_valid
BEFORE INSERT OR UPDATE ON provider_channel_capacity_leases
FOR EACH ROW EXECUTE FUNCTION app.validate_channel_capacity_lease();

CREATE OR REPLACE FUNCTION app.protect_capacity_policy_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
BEGIN
  RAISE EXCEPTION 'capacity policy versions are append-only';
END
$$;

CREATE TRIGGER provider_capacity_policy_append_only
BEFORE UPDATE OR DELETE ON provider_channel_capacity_policies
FOR EACH ROW EXECUTE FUNCTION app.protect_capacity_policy_version();

REVOKE EXECUTE ON FUNCTION app.protect_generation_capacity_snapshot() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.populate_generation_attempt_capacity_snapshot() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.release_terminal_capacity_lease() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.validate_channel_capacity_lease() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION app.protect_capacity_policy_version() FROM PUBLIC;

ALTER TABLE provider_channel_capacity_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_channel_capacity_policies FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_channel_capacity_policies_service
ON provider_channel_capacity_policies FOR ALL
USING (app.is_service_role()) WITH CHECK (app.is_service_role());

ALTER TABLE provider_channel_capacity_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_channel_capacity_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_channel_capacity_leases_service
ON provider_channel_capacity_leases FOR ALL
USING (app.is_service_role()) WITH CHECK (app.is_service_role());

ALTER TABLE generation_capacity_rate_windows ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_capacity_rate_windows FORCE ROW LEVEL SECURITY;
CREATE POLICY generation_capacity_rate_windows_service
ON generation_capacity_rate_windows FOR ALL
USING (app.is_service_role()) WITH CHECK (app.is_service_role());
