DROP FUNCTION app.claim_generation_attempt(uuid, text);

CREATE FUNCTION app.claim_generation_attempt(
  p_workspace_id uuid,
  p_project_id uuid,
  p_batch_id uuid,
  p_job_id uuid,
  p_attempt_id uuid,
  p_channel_id uuid,
  p_capability generation_capability,
  p_executor_claim_id text
)
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
  JOIN generation_batches AS batch
    ON batch.workspace_id = job.workspace_id AND batch.id = job.batch_id
  WHERE attempt.id = p_attempt_id
    AND attempt.workspace_id = p_workspace_id
    AND attempt.job_id = p_job_id
    AND attempt.channel_id = p_channel_id
    AND job.batch_id = p_batch_id
    AND job.capability = p_capability
    AND batch.project_id = p_project_id
  FOR UPDATE OF attempt, job, batch;

  IF NOT FOUND OR current_attempt_id IS DISTINCT FROM p_attempt_id OR
     current_status IN ('succeeded', 'failed', 'canceled') THEN
    RETURN 'terminal';
  END IF;
  IF current_claim = p_executor_claim_id AND current_status NOT IN ('succeeded', 'failed', 'canceled') THEN
    RETURN 'claimed';
  END IF;
  IF current_claim IS NOT NULL THEN
    RETURN 'duplicate';
  END IF;

  IF current_status = 'created' THEN
    UPDATE generation_attempts
    SET status = 'claimed', executor_claim_id = p_executor_claim_id,
        executor_run_id = p_executor_claim_id, claimed_at = now(), updated_at = now()
    WHERE id = p_attempt_id AND status = 'created' AND executor_claim_id IS NULL;
  ELSIF current_status IN ('claimed', 'submitting', 'accepted', 'materializing') THEN
    UPDATE generation_attempts
    SET executor_claim_id = p_executor_claim_id, executor_run_id = p_executor_claim_id,
        claimed_at = coalesce(claimed_at, now()), updated_at = now()
    WHERE id = p_attempt_id AND status = current_status AND executor_claim_id IS NULL;
  ELSE
    RETURN 'duplicate';
  END IF;

  IF FOUND THEN RETURN 'claimed'; END IF;
  RETURN 'duplicate';
END
$$;

REVOKE ALL ON FUNCTION app.claim_generation_attempt(uuid, uuid, uuid, uuid, uuid, uuid, generation_capability, text) FROM PUBLIC;

DO $$
DECLARE
  runtime_role text;
BEGIN
  FOR runtime_role IN
    SELECT member.rolname
    FROM pg_roles service_group
    JOIN pg_auth_members membership ON membership.roleid = service_group.oid
    JOIN pg_roles member ON member.oid = membership.member
    WHERE service_group.rolname = 'infinite_canvas_service'
      AND has_table_privilege(member.oid, 'generation_attempts', 'UPDATE')
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION app.claim_generation_attempt(uuid, uuid, uuid, uuid, uuid, uuid, generation_capability, text) TO %I',
      runtime_role
    );
  END LOOP;
END
$$;
