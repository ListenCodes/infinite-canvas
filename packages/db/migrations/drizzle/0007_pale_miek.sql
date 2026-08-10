ALTER TABLE "profiles" ADD COLUMN "cloud_projects_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "cloud_image_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "cloud_video_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "cloud_credits_enabled" boolean DEFAULT false NOT NULL;