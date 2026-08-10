ALTER TABLE "projects" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "client_project_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_profiles_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_client_binding_unique" ON "projects" USING btree ("workspace_id","created_by","client_project_id");