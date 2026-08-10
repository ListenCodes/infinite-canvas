ALTER TABLE import_source_mappings ENABLE ROW LEVEL SECURITY;

CREATE POLICY import_mapping_read ON import_source_mappings FOR SELECT
  USING (app.has_workspace_access(workspace_id));

CREATE POLICY import_mapping_service_write ON import_source_mappings FOR ALL
  USING (app.is_service_role()) WITH CHECK (app.is_service_role());
