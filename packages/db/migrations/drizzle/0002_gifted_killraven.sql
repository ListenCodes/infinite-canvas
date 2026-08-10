ALTER TABLE "generation_jobs" ADD COLUMN "input_snapshot" jsonb;--> statement-breakpoint
UPDATE "generation_jobs" SET "input_snapshot" = '{}'::jsonb WHERE "input_snapshot" IS NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ALTER COLUMN "input_snapshot" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD COLUMN "output_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_workspace_id_output_asset_id_assets_workspace_id_id_fk" FOREIGN KEY ("workspace_id","output_asset_id") REFERENCES "public"."assets"("workspace_id","id") ON DELETE no action ON UPDATE no action;
