ALTER TABLE "assets" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "assets" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "import_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "source_id" text;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_import_source_unique" UNIQUE("workspace_id","import_id","source_id");--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_workspace_id_unique" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_import_source_unique" UNIQUE("workspace_id","import_id","source_id");