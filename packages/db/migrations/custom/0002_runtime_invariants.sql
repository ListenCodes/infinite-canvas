ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_current_attempt_fk"
  FOREIGN KEY ("workspace_id", "current_attempt_id")
  REFERENCES "generation_attempts" ("workspace_id", "id")
  DEFERRABLE INITIALLY DEFERRED;

DROP INDEX "outbox_events_pending_idx";
CREATE INDEX "outbox_events_pending_idx"
  ON "outbox_events" ("available_at", "created_at")
  WHERE "status" IN ('pending', 'sending');

CREATE SCHEMA IF NOT EXISTS app;

CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

CREATE FUNCTION app.is_service_role() RETURNS boolean
LANGUAGE sql STABLE
AS $$
  -- session_user is preserved across SECURITY DEFINER calls; current_user is not.
  SELECT session_user IN ('postgres', 'service_role', 'infinite_canvas_service')
    AND current_setting('app.service_role', true) = 'on'
$$;

CREATE FUNCTION app.is_platform_admin() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app.is_service_role() OR EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = app.current_user_id()
      AND platform_role = 'admin'
      AND status = 'active'
  )
$$;

CREATE FUNCTION app.has_workspace_access(
  target_workspace_id uuid,
  allowed_roles workspace_role[] DEFAULT ARRAY['owner'::workspace_role, 'editor'::workspace_role, 'viewer'::workspace_role]
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT app.is_service_role() OR EXISTS (
    SELECT 1 FROM workspace_members
    WHERE workspace_id = target_workspace_id
      AND user_id = app.current_user_id()
      AND status = 'active'
      AND role = ANY(allowed_roles)
  )
$$;

CREATE FUNCTION app.reject_immutable_change() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER wallet_entries_immutable
  BEFORE UPDATE OR DELETE ON wallet_entries
  FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_change();
CREATE TRIGGER platform_risk_entries_immutable
  BEFORE UPDATE OR DELETE ON platform_risk_entries
  FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_change();
CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION app.reject_immutable_change();

CREATE FUNCTION app.prevent_profile_privilege_escalation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT app.is_service_role() AND (
    NEW.user_id IS DISTINCT FROM OLD.user_id OR
    NEW.platform_role IS DISTINCT FROM OLD.platform_role OR
    NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    RAISE EXCEPTION 'protected profile fields require service role' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER profiles_protected_fields
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION app.prevent_profile_privilege_escalation();

CREATE FUNCTION app.notify_generation_event() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify(
    'generation_job_events',
    json_build_object('workspaceId', NEW.workspace_id, 'sequence', NEW.sequence::text)::text
  );
  RETURN NEW;
END
$$;

CREATE TRIGGER generation_job_events_notify
  AFTER INSERT ON generation_job_events
  FOR EACH ROW EXECUTE FUNCTION app.notify_generation_event();

CREATE FUNCTION app.claim_outbox(p_worker_id text, p_limit integer DEFAULT 50)
RETURNS SETOF outbox_events
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.is_service_role() THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'outbox claim limit must be between 1 and 500' USING ERRCODE = '22023';
  END IF;

  UPDATE outbox_events
  SET status = 'pending', locked_by = NULL, locked_at = NULL, updated_at = now()
  WHERE status = 'sending' AND locked_at < now() - interval '60 seconds';

  RETURN QUERY
  WITH candidates AS (
    SELECT id
    FROM outbox_events
    WHERE status = 'pending' AND available_at <= now()
    ORDER BY available_at, created_at
    FOR UPDATE SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE outbox_events AS event
  SET status = 'sending',
      attempts = event.attempts + 1,
      locked_by = p_worker_id,
      locked_at = now(),
      updated_at = now()
  FROM candidates
  WHERE event.id = candidates.id
  RETURNING event.*;
END
$$;

CREATE FUNCTION app.claim_generation_attempt(p_attempt_id uuid, p_executor_claim_id text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  current_status attempt_status;
  current_claim text;
  current_attempt_id uuid;
BEGIN
  IF NOT app.is_service_role() THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;

  SELECT attempt.status, attempt.executor_claim_id, job.current_attempt_id
  INTO current_status, current_claim, current_attempt_id
  FROM generation_attempts AS attempt
  JOIN generation_jobs AS job
    ON job.workspace_id = attempt.workspace_id AND job.id = attempt.job_id
  WHERE attempt.id = p_attempt_id
  FOR UPDATE OF attempt, job;

  IF NOT FOUND OR current_attempt_id IS DISTINCT FROM p_attempt_id OR
     current_status IN ('succeeded', 'failed', 'canceled') THEN
    RETURN 'terminal';
  END IF;
  IF current_claim = p_executor_claim_id AND current_status NOT IN ('succeeded', 'failed', 'canceled') THEN
    RETURN 'claimed';
  END IF;
  IF current_status <> 'created' OR current_claim IS NOT NULL THEN
    RETURN 'duplicate';
  END IF;

  UPDATE generation_attempts
  SET status = 'claimed', executor_claim_id = p_executor_claim_id, claimed_at = now(), updated_at = now()
  WHERE id = p_attempt_id AND status = 'created' AND executor_claim_id IS NULL;

  IF FOUND THEN RETURN 'claimed'; END IF;
  RETURN 'duplicate';
END
$$;

CREATE FUNCTION app.reserve_credits(
  p_reservation_id uuid,
  p_wallet_entry_id uuid,
  p_workspace_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_amount bigint,
  p_expires_at timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  existing credit_reservations%ROWTYPE;
  wallet wallet_accounts%ROWTYPE;
BEGIN
  IF NOT app.is_service_role() THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_amount < 0 THEN
    RAISE EXCEPTION 'reservation amount must be nonnegative' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO existing FROM credit_reservations WHERE attempt_id = p_attempt_id FOR UPDATE;
  IF FOUND THEN
    IF existing.workspace_id <> p_workspace_id OR existing.job_id <> p_job_id OR existing.amount <> p_amount THEN
      RAISE EXCEPTION 'reservation idempotency conflict' USING ERRCODE = '23505';
    END IF;
    RETURN existing.id;
  END IF;

  UPDATE wallet_accounts
  SET available = available - p_amount,
      reserved = reserved + p_amount,
      version = version + 1,
      updated_at = now()
  WHERE workspace_id = p_workspace_id AND available >= p_amount
  RETURNING * INTO wallet;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'insufficient credits' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO credit_reservations (id, workspace_id, job_id, attempt_id, amount, expires_at)
  VALUES (p_reservation_id, p_workspace_id, p_job_id, p_attempt_id, p_amount, p_expires_at);
  INSERT INTO wallet_entries (
    id, workspace_id, kind, amount, available_after, reserved_after,
    reference_type, reference_id, idempotency_key
  ) VALUES (
    p_wallet_entry_id, p_workspace_id, 'reserve', 0, wallet.available, wallet.reserved,
    'attempt', p_attempt_id, 'reserve:' || p_attempt_id::text
  );
  RETURN p_reservation_id;
END
$$;

CREATE FUNCTION app.settle_reservation(p_attempt_id uuid, p_wallet_entry_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  reservation credit_reservations%ROWTYPE;
  wallet wallet_accounts%ROWTYPE;
BEGIN
  IF NOT app.is_service_role() THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO reservation FROM credit_reservations WHERE attempt_id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'P0002'; END IF;
  IF reservation.status = 'settled' THEN RETURN false; END IF;
  IF reservation.status <> 'reserved' THEN RAISE EXCEPTION 'reservation already released' USING ERRCODE = '55000'; END IF;

  UPDATE wallet_accounts
  SET reserved = reserved - reservation.amount, version = version + 1, updated_at = now()
  WHERE workspace_id = reservation.workspace_id AND reserved >= reservation.amount
  RETURNING * INTO wallet;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet reservation invariant violated' USING ERRCODE = 'P0003'; END IF;

  UPDATE credit_reservations SET status = 'settled', settled_at = now() WHERE id = reservation.id;
  INSERT INTO wallet_entries (
    id, workspace_id, kind, amount, available_after, reserved_after,
    reference_type, reference_id, idempotency_key
  ) VALUES (
    p_wallet_entry_id, reservation.workspace_id, 'settle', -reservation.amount,
    wallet.available, wallet.reserved, 'attempt', p_attempt_id, 'settle:' || p_attempt_id::text
  );
  RETURN true;
END
$$;

CREATE FUNCTION app.release_reservation(
  p_attempt_id uuid,
  p_wallet_entry_id uuid,
  p_release_kind text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  reservation credit_reservations%ROWTYPE;
  wallet wallet_accounts%ROWTYPE;
BEGIN
  IF NOT app.is_service_role() THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO reservation FROM credit_reservations WHERE attempt_id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'P0002'; END IF;
  IF reservation.status = 'released' THEN RETURN false; END IF;
  IF reservation.status <> 'reserved' THEN RAISE EXCEPTION 'reservation already settled' USING ERRCODE = '55000'; END IF;

  UPDATE wallet_accounts
  SET available = available + reservation.amount,
      reserved = reserved - reservation.amount,
      version = version + 1,
      updated_at = now()
  WHERE workspace_id = reservation.workspace_id AND reserved >= reservation.amount
  RETURNING * INTO wallet;
  IF NOT FOUND THEN RAISE EXCEPTION 'wallet reservation invariant violated' USING ERRCODE = 'P0003'; END IF;

  UPDATE credit_reservations
  SET status = 'released', released_at = now(), release_kind = p_release_kind
  WHERE id = reservation.id;
  INSERT INTO wallet_entries (
    id, workspace_id, kind, amount, available_after, reserved_after,
    reference_type, reference_id, idempotency_key
  ) VALUES (
    p_wallet_entry_id, reservation.workspace_id, 'release', 0,
    wallet.available, wallet.reserved, 'attempt', p_attempt_id, 'release:' || p_attempt_id::text
  );
  RETURN true;
END
$$;

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_job_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_job_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_risk_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY profile_read ON profiles FOR SELECT
  USING (app.is_service_role() OR user_id = app.current_user_id() OR app.is_platform_admin());
CREATE POLICY profile_update ON profiles FOR UPDATE
  USING (app.is_service_role() OR user_id = app.current_user_id())
  WITH CHECK (app.is_service_role() OR user_id = app.current_user_id());
CREATE POLICY profile_insert ON profiles FOR INSERT WITH CHECK (app.is_service_role());

CREATE POLICY workspace_read ON workspaces FOR SELECT USING (app.has_workspace_access(id));
CREATE POLICY workspace_insert ON workspaces FOR INSERT WITH CHECK (app.is_service_role());
CREATE POLICY workspace_update ON workspaces FOR UPDATE
  USING (app.has_workspace_access(id, ARRAY['owner'::workspace_role]))
  WITH CHECK (app.has_workspace_access(id, ARRAY['owner'::workspace_role]));

CREATE POLICY member_read ON workspace_members FOR SELECT USING (app.has_workspace_access(workspace_id));
CREATE POLICY member_write ON workspace_members FOR ALL
  USING (app.has_workspace_access(workspace_id, ARRAY['owner'::workspace_role]))
  WITH CHECK (app.has_workspace_access(workspace_id, ARRAY['owner'::workspace_role]));

CREATE POLICY project_read ON projects FOR SELECT USING (app.has_workspace_access(workspace_id));
CREATE POLICY project_write ON projects FOR ALL
  USING (app.has_workspace_access(workspace_id, ARRAY['owner'::workspace_role, 'editor'::workspace_role]))
  WITH CHECK (app.has_workspace_access(workspace_id, ARRAY['owner'::workspace_role, 'editor'::workspace_role]));
CREATE POLICY project_version_read ON project_versions FOR SELECT USING (app.has_workspace_access(workspace_id));
CREATE POLICY project_version_write ON project_versions FOR INSERT
  WITH CHECK (app.has_workspace_access(workspace_id, ARRAY['owner'::workspace_role, 'editor'::workspace_role]));
CREATE POLICY asset_read ON assets FOR SELECT USING (app.has_workspace_access(workspace_id));
CREATE POLICY asset_write ON assets FOR ALL
  USING (app.has_workspace_access(workspace_id, ARRAY['owner'::workspace_role, 'editor'::workspace_role]))
  WITH CHECK (app.has_workspace_access(workspace_id, ARRAY['owner'::workspace_role, 'editor'::workspace_role]));

CREATE POLICY provider_channel_admin ON provider_channels FOR ALL
  USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());
CREATE POLICY provider_credential_admin ON provider_credentials FOR ALL
  USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());
CREATE POLICY model_config_admin ON model_configs FOR ALL
  USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());
CREATE POLICY model_price_admin ON model_prices FOR ALL
  USING (app.is_platform_admin()) WITH CHECK (app.is_platform_admin());

CREATE POLICY wallet_read ON wallet_accounts FOR SELECT USING (app.has_workspace_access(workspace_id));
CREATE POLICY wallet_service_write ON wallet_accounts FOR ALL
  USING (app.is_service_role()) WITH CHECK (app.is_service_role());
CREATE POLICY wallet_entry_read ON wallet_entries FOR SELECT USING (app.has_workspace_access(workspace_id));
CREATE POLICY wallet_entry_service_write ON wallet_entries FOR INSERT WITH CHECK (app.is_service_role());

CREATE POLICY idempotency_access ON idempotency_requests FOR ALL
  USING (app.has_workspace_access(workspace_id, ARRAY['owner'::workspace_role, 'editor'::workspace_role]))
  WITH CHECK (app.has_workspace_access(workspace_id, ARRAY['owner'::workspace_role, 'editor'::workspace_role]));

CREATE POLICY batch_read ON generation_batches FOR SELECT USING (app.has_workspace_access(workspace_id));
CREATE POLICY batch_service_write ON generation_batches FOR ALL
  USING (app.is_service_role()) WITH CHECK (app.is_service_role());
CREATE POLICY job_read ON generation_jobs FOR SELECT USING (app.has_workspace_access(workspace_id));
CREATE POLICY job_service_write ON generation_jobs FOR ALL
  USING (app.is_service_role()) WITH CHECK (app.is_service_role());
CREATE POLICY attempt_read ON generation_attempts FOR SELECT USING (app.has_workspace_access(workspace_id));
CREATE POLICY attempt_service_write ON generation_attempts FOR ALL
  USING (app.is_service_role()) WITH CHECK (app.is_service_role());
CREATE POLICY target_read ON generation_job_targets FOR SELECT USING (app.has_workspace_access(workspace_id));
CREATE POLICY target_service_write ON generation_job_targets FOR ALL
  USING (app.is_service_role()) WITH CHECK (app.is_service_role());
CREATE POLICY reservation_read ON credit_reservations FOR SELECT USING (app.has_workspace_access(workspace_id));
CREATE POLICY reservation_service_write ON credit_reservations FOR ALL
  USING (app.is_service_role()) WITH CHECK (app.is_service_role());
CREATE POLICY event_read ON generation_job_events FOR SELECT USING (app.has_workspace_access(workspace_id));
CREATE POLICY event_service_write ON generation_job_events FOR INSERT WITH CHECK (app.is_service_role());
CREATE POLICY outbox_service ON outbox_events FOR ALL
  USING (app.is_service_role()) WITH CHECK (app.is_service_role());

CREATE POLICY import_read ON imports FOR SELECT
  USING (app.is_service_role() OR user_id = app.current_user_id() OR app.is_platform_admin());
CREATE POLICY import_write ON imports FOR ALL
  USING (app.is_service_role() OR user_id = app.current_user_id())
  WITH CHECK (app.is_service_role() OR user_id = app.current_user_id());
CREATE POLICY risk_admin ON platform_risk_entries FOR SELECT USING (app.is_platform_admin());
CREATE POLICY risk_service_write ON platform_risk_entries FOR INSERT WITH CHECK (app.is_service_role());
CREATE POLICY audit_read ON audit_logs FOR SELECT
  USING (app.is_platform_admin() OR (workspace_id IS NOT NULL AND app.has_workspace_access(workspace_id, ARRAY['owner'::workspace_role])));
CREATE POLICY audit_service_write ON audit_logs FOR INSERT WITH CHECK (app.is_service_role());
