ALTER TYPE "public"."asset_status" ADD VALUE 'verifying' BEFORE 'ready';--> statement-breakpoint
ALTER TYPE "public"."asset_status" ADD VALUE 'rejected' BEFORE 'deleted';--> statement-breakpoint
ALTER TABLE "model_configs" ADD COLUMN "provider_idempotency_supported" boolean DEFAULT false NOT NULL;