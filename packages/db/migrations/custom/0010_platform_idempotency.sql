ALTER TABLE platform_idempotency_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_idempotency_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY platform_idempotency_service_all
  ON platform_idempotency_requests FOR ALL
  USING (app.is_service_role())
  WITH CHECK (app.is_service_role());
