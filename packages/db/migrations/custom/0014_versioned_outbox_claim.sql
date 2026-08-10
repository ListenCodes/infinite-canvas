CREATE OR REPLACE FUNCTION app.claim_outbox(p_worker_id text, p_limit integer DEFAULT 50)
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
      AND (
        topic <> 'generation.job.requested'
        OR payload->>'schemaVersion' = '1'
      )
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

CREATE FUNCTION app.claim_outbox(
  p_worker_id text,
  p_generation_schema_version integer,
  p_limit integer
)
RETURNS SETOF outbox_events
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT app.is_service_role() THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF p_generation_schema_version < 1 THEN
    RAISE EXCEPTION 'generation schema version must be positive' USING ERRCODE = '22023';
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
      AND (
        topic <> 'generation.job.requested'
        OR payload->>'schemaVersion' = p_generation_schema_version::text
        OR (
          p_generation_schema_version = 2
          AND (
            payload->>'schemaVersion' IS NULL
            OR payload->>'schemaVersion' !~ '^[1-9][0-9]*$'
          )
        )
      )
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

REVOKE ALL ON FUNCTION app.claim_outbox(text, integer, integer) FROM PUBLIC;

DO $$
DECLARE
  runtime_role name;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'infinite_canvas_service') THEN
    FOR runtime_role IN
      SELECT member.rolname
      FROM pg_roles service
      JOIN pg_auth_members membership ON membership.roleid = service.oid
      JOIN pg_roles member ON member.oid = membership.member
      WHERE service.rolname = 'infinite_canvas_service'
        AND has_table_privilege(member.oid, 'outbox_events', 'UPDATE')
    LOOP
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION app.claim_outbox(text, integer, integer) TO %I',
        runtime_role
      );
    END LOOP;
  END IF;
END
$$;
