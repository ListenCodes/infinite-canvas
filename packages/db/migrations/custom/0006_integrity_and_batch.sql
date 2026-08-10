DO $$
DECLARE
  mismatch_count bigint;
BEGIN
  SELECT count(*) INTO mismatch_count
  FROM generation_jobs job
  JOIN generation_attempts attempt ON attempt.id = job.current_attempt_id
  WHERE job.current_attempt_id IS NOT NULL
    AND (attempt.workspace_id <> job.workspace_id OR attempt.job_id <> job.id);
  IF mismatch_count > 0 THEN
    RAISE EXCEPTION 'Cannot add current-attempt ownership constraint: % mismatched generation_jobs rows', mismatch_count;
  END IF;

  SELECT count(*) INTO mismatch_count
  FROM credit_reservations reservation
  JOIN generation_attempts attempt ON attempt.id = reservation.attempt_id
  WHERE attempt.workspace_id <> reservation.workspace_id OR attempt.job_id <> reservation.job_id;
  IF mismatch_count > 0 THEN
    RAISE EXCEPTION 'Cannot add reservation ownership constraint: % mismatched credit_reservations rows', mismatch_count;
  END IF;

  SELECT count(*) INTO mismatch_count
  FROM generation_batches batch
  JOIN idempotency_requests request ON request.id = batch.idempotency_request_id
  WHERE request.workspace_id <> batch.workspace_id;
  IF mismatch_count > 0 THEN
    RAISE EXCEPTION 'Cannot add batch idempotency ownership constraint: % mismatched generation_batches rows', mismatch_count;
  END IF;

  SELECT count(*) INTO mismatch_count
  FROM generation_job_targets target
  JOIN generation_jobs job
    ON job.workspace_id = target.workspace_id AND job.id = target.job_id
  JOIN generation_batches batch
    ON batch.workspace_id = job.workspace_id AND batch.id = job.batch_id
  WHERE target.project_id <> batch.project_id;
  IF mismatch_count > 0 THEN
    RAISE EXCEPTION 'Cannot enforce target project ownership: % mismatched generation_job_targets rows', mismatch_count;
  END IF;
END
$$;

ALTER TABLE generation_attempts
  ADD CONSTRAINT generation_attempts_workspace_job_id_unique UNIQUE (workspace_id, job_id, id);

ALTER TABLE generation_jobs DROP CONSTRAINT generation_jobs_current_attempt_fk;
ALTER TABLE generation_jobs
  ADD CONSTRAINT generation_jobs_current_attempt_fk
  FOREIGN KEY (workspace_id, id, current_attempt_id)
  REFERENCES generation_attempts (workspace_id, job_id, id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE credit_reservations
  ADD CONSTRAINT credit_reservations_job_attempt_fk
  FOREIGN KEY (workspace_id, job_id, attempt_id)
  REFERENCES generation_attempts (workspace_id, job_id, id);

ALTER TABLE idempotency_requests
  ADD CONSTRAINT idempotency_requests_workspace_id_unique UNIQUE (workspace_id, id);
ALTER TABLE generation_batches
  ADD CONSTRAINT generation_batches_workspace_idempotency_fk
  FOREIGN KEY (workspace_id, idempotency_request_id)
  REFERENCES idempotency_requests (workspace_id, id);

WITH normalized AS (
  SELECT id, coalesce(outcome_unknown_at, updated_at, now()) AS unknown_at
  FROM generation_attempts
  WHERE status = 'outcome_unknown'
)
UPDATE generation_attempts attempt
SET outcome_unknown_at = normalized.unknown_at,
    release_after = least(
      coalesce(attempt.release_after, normalized.unknown_at + interval '24 hours'),
      normalized.unknown_at + interval '24 hours'
    ),
    reconcile_after = least(
      coalesce(attempt.reconcile_after, normalized.unknown_at + interval '1 hour'),
      coalesce(attempt.release_after, normalized.unknown_at + interval '24 hours'),
      normalized.unknown_at + interval '24 hours'
    )
FROM normalized
WHERE attempt.id = normalized.id;

ALTER TABLE generation_attempts
  ADD CONSTRAINT generation_attempts_unknown_deadline_check CHECK (
    status <> 'outcome_unknown' OR (
      outcome_unknown_at IS NOT NULL
      AND
      release_after IS NOT NULL
      AND release_after <= outcome_unknown_at + interval '24 hours'
      AND reconcile_after IS NOT NULL
      AND reconcile_after <= release_after
    )
  );

CREATE FUNCTION app.preserve_unknown_deadline() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.status = 'outcome_unknown' AND NEW.status = 'outcome_unknown' AND (
    NEW.outcome_unknown_at IS DISTINCT FROM OLD.outcome_unknown_at OR
    NEW.release_after IS DISTINCT FROM OLD.release_after
  ) THEN
    RAISE EXCEPTION 'outcome_unknown deadlines are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER generation_attempts_preserve_unknown_deadline
  BEFORE UPDATE ON generation_attempts
  FOR EACH ROW EXECUTE FUNCTION app.preserve_unknown_deadline();

CREATE FUNCTION app.validate_generation_target() RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  expected_project_id uuid;
BEGIN
  SELECT batch.project_id INTO expected_project_id
  FROM generation_jobs job
  JOIN generation_batches batch
    ON batch.workspace_id = job.workspace_id AND batch.id = job.batch_id
  WHERE job.workspace_id = NEW.workspace_id AND job.id = NEW.job_id;
  IF expected_project_id IS NULL OR expected_project_id <> NEW.project_id THEN
    RAISE EXCEPTION 'generation target project must match its batch project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER generation_job_targets_project_matches_batch
  AFTER INSERT OR UPDATE ON generation_job_targets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.validate_generation_target();

DROP POLICY import_read ON imports;
DROP POLICY import_write ON imports;
CREATE POLICY import_read ON imports FOR SELECT
  USING (
    (app.is_service_role() OR user_id = app.current_user_id())
    AND app.has_workspace_access(workspace_id)
  );
CREATE POLICY import_write ON imports FOR ALL
  USING (
    (app.is_service_role() OR user_id = app.current_user_id())
    AND app.has_workspace_access(workspace_id, ARRAY['owner'::workspace_role, 'editor'::workspace_role])
  )
  WITH CHECK (
    (app.is_service_role() OR user_id = app.current_user_id())
    AND app.has_workspace_access(workspace_id, ARRAY['owner'::workspace_role, 'editor'::workspace_role])
  );

CREATE FUNCTION app.refresh_generation_batch(p_batch_id uuid) RETURNS batch_status
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  next_status batch_status;
  changed generation_batches%ROWTYPE;
BEGIN
  IF NOT app.is_service_role() THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  SELECT CASE
    WHEN bool_and(status = 'succeeded') THEN 'succeeded'::batch_status
    WHEN bool_and(status = 'canceled') THEN 'canceled'::batch_status
    WHEN bool_and(status IN ('failed', 'canceled')) THEN 'failed'::batch_status
    WHEN bool_and(status IN ('succeeded', 'failed', 'canceled')) AND bool_or(status = 'succeeded') THEN 'partial_succeeded'::batch_status
    WHEN bool_or(status <> 'queued') THEN 'running'::batch_status
    ELSE 'queued'::batch_status
  END INTO next_status
  FROM generation_jobs WHERE batch_id = p_batch_id;

  UPDATE generation_batches
  SET status = next_status, updated_at = now()
  WHERE id = p_batch_id AND status IS DISTINCT FROM next_status
  RETURNING * INTO changed;

  IF FOUND THEN
    INSERT INTO generation_job_events (
      workspace_id, aggregate_type, aggregate_id, project_id, batch_id, type, payload
    ) VALUES (
      changed.workspace_id, 'batch', changed.id, changed.project_id, changed.id,
      'generation.batch.updated', jsonb_build_object('status', changed.status)
    );
    RETURN changed.status;
  END IF;
  RETURN next_status;
END
$$;

CREATE OR REPLACE FUNCTION app.release_reservation(
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
    reference_type, reference_id, idempotency_key, reason
  ) VALUES (
    p_wallet_entry_id, reservation.workspace_id,
    CASE WHEN p_release_kind = 'outcome_unknown_24h_timeout' THEN 'release_after_unknown_timeout' ELSE 'release' END,
    0, wallet.available, wallet.reserved, 'attempt', p_attempt_id,
    'release:' || p_attempt_id::text, p_release_kind
  );
  RETURN true;
END
$$;
