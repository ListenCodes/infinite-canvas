REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app FROM PUBLIC;
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

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
    LOOP
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION app.current_user_id(), app.is_service_role(), app.is_platform_admin(), app.has_workspace_access(uuid, workspace_role[]) TO %I',
        runtime_role
      );
    END LOOP;
  END IF;
END
$$;
