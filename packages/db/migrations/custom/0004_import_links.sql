ALTER TABLE projects
  ADD CONSTRAINT projects_import_fk
  FOREIGN KEY (workspace_id, import_id)
  REFERENCES imports (workspace_id, id)
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE assets
  ADD CONSTRAINT assets_import_fk
  FOREIGN KEY (workspace_id, import_id)
  REFERENCES imports (workspace_id, id)
  DEFERRABLE INITIALLY DEFERRED;
