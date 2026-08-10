ALTER TABLE "assets" ADD COLUMN "verification_token" uuid;--> statement-breakpoint
UPDATE "assets" SET "status" = 'uploading', "updated_at" = now()
WHERE "status" = 'verifying' AND "verification_token" IS NULL;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_verification_token_status_check"
CHECK (("assets"."status" = 'verifying') = ("assets"."verification_token" is not null)) NOT VALID;--> statement-breakpoint
ALTER TABLE "assets" VALIDATE CONSTRAINT "assets_verification_token_status_check";
