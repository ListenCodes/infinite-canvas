CREATE TABLE "platform_idempotency_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "idempotency_status" DEFAULT 'processing' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "platform_idempotency_actor_operation_key_unique" UNIQUE("actor_user_id","operation","key")
);
--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD COLUMN "executor_dispatch_token" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_idempotency_requests" ADD CONSTRAINT "platform_idempotency_requests_actor_user_id_profiles_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "platform_idempotency_expiry_idx" ON "platform_idempotency_requests" USING btree ("expires_at");