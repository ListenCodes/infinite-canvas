CREATE TABLE "generation_capacity_rate_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"channel_id" uuid,
	"capability" "generation_capability" NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"used" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_capacity_rate_windows_scope" CHECK (num_nonnulls("generation_capacity_rate_windows"."workspace_id", "generation_capacity_rate_windows"."channel_id") = 1),
	CONSTRAINT "generation_capacity_rate_windows_minute_aligned" CHECK ("generation_capacity_rate_windows"."window_started_at" = date_bin(interval '1 minute', "generation_capacity_rate_windows"."window_started_at", timestamptz '1970-01-01 00:00:00+00')),
	CONSTRAINT "generation_capacity_rate_windows_used_positive" CHECK ("generation_capacity_rate_windows"."used" > 0)
);
--> statement-breakpoint
ALTER TABLE "generation_capacity_rate_windows" ADD CONSTRAINT "generation_capacity_rate_windows_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_capacity_rate_windows" ADD CONSTRAINT "generation_capacity_rate_windows_channel_id_provider_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."provider_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_capacity_rate_windows_workspace_unique" ON "generation_capacity_rate_windows" USING btree ("workspace_id","capability","window_started_at") WHERE "generation_capacity_rate_windows"."workspace_id" is not null and "generation_capacity_rate_windows"."channel_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_capacity_rate_windows_channel_unique" ON "generation_capacity_rate_windows" USING btree ("channel_id","capability","window_started_at") WHERE "generation_capacity_rate_windows"."channel_id" is not null and "generation_capacity_rate_windows"."workspace_id" is null;--> statement-breakpoint
CREATE INDEX "generation_capacity_rate_windows_expiry_idx" ON "generation_capacity_rate_windows" USING btree ("window_started_at");--> statement-breakpoint
ALTER TABLE "provider_channel_capacity_leases" ADD CONSTRAINT "provider_channel_capacity_leases_valid_expiry" CHECK ("provider_channel_capacity_leases"."lease_expires_at" > "provider_channel_capacity_leases"."acquired_at");
