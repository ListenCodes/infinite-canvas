CREATE TYPE "public"."asset_kind" AS ENUM('image', 'video', 'audio', 'import');--> statement-breakpoint
CREATE TYPE "public"."asset_status" AS ENUM('uploading', 'ready', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('created', 'claimed', 'submitting', 'accepted', 'materializing', 'succeeded', 'failed', 'canceled', 'outcome_unknown');--> statement-breakpoint
CREATE TYPE "public"."batch_status" AS ENUM('queued', 'running', 'succeeded', 'partial_succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."channel_status" AS ENUM('active', 'paused', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."credential_status" AS ENUM('active', 'rotating', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."generation_capability" AS ENUM('image', 'video');--> statement-breakpoint
CREATE TYPE "public"."idempotency_status" AS ENUM('processing', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."import_status" AS ENUM('uploaded', 'validating', 'importing', 'published', 'failed', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('queued', 'dispatching', 'running', 'waiting_provider', 'materializing', 'succeeded', 'failed', 'cancel_requested', 'canceled', 'outcome_unknown');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."model_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'sending', 'sent', 'dead');--> statement-breakpoint
CREATE TYPE "public"."platform_role" AS ENUM('user', 'admin');--> statement-breakpoint
CREATE TYPE "public"."profile_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."reservation_status" AS ENUM('reserved', 'settled', 'released');--> statement-breakpoint
CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."workspace_status" AS ENUM('active', 'suspended', 'deleted');--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"status" "asset_status" DEFAULT 'uploading' NOT NULL,
	"object_key" text NOT NULL,
	"mime" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "assets_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "assets_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "assets_bytes_nonnegative" CHECK ("assets"."bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid,
	"actor_user_id" uuid,
	"actor_type" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"reason" text,
	"before_summary" jsonb,
	"after_summary" jsonb,
	"correlation_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_reservations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"status" "reservation_status" DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"release_kind" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_reservations_attempt_unique" UNIQUE("attempt_id"),
	CONSTRAINT "credit_reservations_amount_nonnegative" CHECK ("credit_reservations"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "generation_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"channel_id" uuid NOT NULL,
	"credential_version" integer NOT NULL,
	"adapter_type" text NOT NULL,
	"adapter_version" integer NOT NULL,
	"status" "attempt_status" DEFAULT 'created' NOT NULL,
	"executor_claim_id" text,
	"executor_run_id" text,
	"provider_task_id" text,
	"provider_idempotency_supported" boolean DEFAULT false NOT NULL,
	"request_fingerprint" text NOT NULL,
	"business_deadline_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"outcome_unknown_at" timestamp with time zone,
	"reconcile_after" timestamp with time zone,
	"release_after" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_code" text,
	"error_message" text,
	"evidence_json" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_attempts_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "generation_attempts_job_attempt_unique" UNIQUE("job_id","attempt_no"),
	CONSTRAINT "generation_attempts_no_positive" CHECK ("generation_attempts"."attempt_no" > 0),
	CONSTRAINT "generation_attempts_versions_positive" CHECK ("generation_attempts"."credential_version" > 0 and "generation_attempts"."adapter_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "generation_batches" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "generation_capability" NOT NULL,
	"requested_count" integer NOT NULL,
	"status" "batch_status" DEFAULT 'queued' NOT NULL,
	"idempotency_request_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "generation_batches_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "generation_batches_idempotency_unique" UNIQUE("idempotency_request_id"),
	CONSTRAINT "generation_batches_count_range" CHECK ("generation_batches"."requested_count" between 1 and 15)
);
--> statement-breakpoint
CREATE TABLE "generation_job_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"project_id" uuid,
	"batch_id" uuid,
	"job_id" uuid,
	"attempt_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_job_targets" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"node_id" text NOT NULL,
	"slot_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "generation_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"batch_id" uuid NOT NULL,
	"slot_index" integer NOT NULL,
	"capability" "generation_capability" NOT NULL,
	"model_config_id" uuid NOT NULL,
	"model_snapshot" jsonb NOT NULL,
	"price_snapshot" jsonb NOT NULL,
	"estimated_credits" bigint NOT NULL,
	"status" "job_status" DEFAULT 'queued' NOT NULL,
	"current_attempt_id" uuid,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "generation_jobs_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "generation_jobs_batch_slot_unique" UNIQUE("batch_id","slot_index"),
	CONSTRAINT "generation_jobs_slot_nonnegative" CHECK ("generation_jobs"."slot_index" >= 0),
	CONSTRAINT "generation_jobs_credits_nonnegative" CHECK ("generation_jobs"."estimated_credits" >= 0),
	CONSTRAINT "generation_jobs_version_nonnegative" CHECK ("generation_jobs"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "idempotency_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" "idempotency_status" DEFAULT 'processing' NOT NULL,
	"response_status" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_requests_scope_key_unique" UNIQUE("workspace_id","operation","key")
);
--> statement-breakpoint
CREATE TABLE "imports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_export_id" uuid NOT NULL,
	"schema_version" integer NOT NULL,
	"status" "import_status" DEFAULT 'uploaded' NOT NULL,
	"object_key" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"counts_json" jsonb NOT NULL,
	"error_code" text,
	"error_message" text,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "imports_user_export_unique" UNIQUE("user_id","client_export_id")
);
--> statement-breakpoint
CREATE TABLE "model_configs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"model" text NOT NULL,
	"capability" "generation_capability" NOT NULL,
	"adapter_type" text NOT NULL,
	"adapter_version" integer NOT NULL,
	"config_version" integer NOT NULL,
	"limits_json" jsonb NOT NULL,
	"concurrency_limit" integer DEFAULT 1 NOT NULL,
	"status" "model_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_configs_version_unique" UNIQUE("channel_id","model","capability","config_version"),
	CONSTRAINT "model_configs_versions_positive" CHECK ("model_configs"."adapter_version" > 0 and "model_configs"."config_version" > 0),
	CONSTRAINT "model_configs_concurrency_positive" CHECK ("model_configs"."concurrency_limit" > 0)
);
--> statement-breakpoint
CREATE TABLE "model_prices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"model_config_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"conditions_json" jsonb NOT NULL,
	"credit_amount" bigint NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_prices_model_version_unique" UNIQUE("model_config_id","version"),
	CONSTRAINT "model_prices_amount_nonnegative" CHECK ("model_prices"."credit_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_dedupe_unique" UNIQUE("dedupe_key"),
	CONSTRAINT "outbox_events_attempts_nonnegative" CHECK ("outbox_events"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "platform_risk_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"amount" bigint NOT NULL,
	"reason" text NOT NULL,
	"evidence_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_risk_entries_attempt_unique" UNIQUE("attempt_id"),
	CONSTRAINT "platform_risk_entries_amount_nonnegative" CHECK ("platform_risk_entries"."amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"status" "profile_status" DEFAULT 'active' NOT NULL,
	"platform_role" "platform_role" DEFAULT 'user' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot_json" jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_versions_project_version_unique" UNIQUE("project_id","version")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" text NOT NULL,
	"document_json" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "projects_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "projects_version_positive" CHECK ("projects"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "provider_channels" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"base_url" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"status" "channel_status" DEFAULT 'active' NOT NULL,
	"health_status" text DEFAULT 'unknown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"channel_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"encrypted_secret" text NOT NULL,
	"encrypted_data_key" text NOT NULL,
	"nonce" text NOT NULL,
	"key_id" text NOT NULL,
	"secret_suffix" text NOT NULL,
	"status" "credential_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	CONSTRAINT "provider_credentials_channel_version_unique" UNIQUE("channel_id","version")
);
--> statement-breakpoint
CREATE TABLE "wallet_accounts" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"available" bigint DEFAULT 0 NOT NULL,
	"reserved" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_accounts_available_nonnegative" CHECK ("wallet_accounts"."available" >= 0),
	CONSTRAINT "wallet_accounts_reserved_nonnegative" CHECK ("wallet_accounts"."reserved" >= 0),
	CONSTRAINT "wallet_accounts_version_nonnegative" CHECK ("wallet_accounts"."version" >= 0)
);
--> statement-breakpoint
CREATE TABLE "wallet_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount" bigint NOT NULL,
	"available_after" bigint NOT NULL,
	"reserved_after" bigint NOT NULL,
	"reference_type" text NOT NULL,
	"reference_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"actor_user_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_entries_idempotency_unique" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "wallet_entries_balances_nonnegative" CHECK ("wallet_entries"."available_after" >= 0 and "wallet_entries"."reserved_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "workspace_role" NOT NULL,
	"status" "member_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" "workspace_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_id_owner_unique" UNIQUE("id","owner_user_id")
);
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_profiles_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_workspace_id_job_id_generation_jobs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."generation_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_reservations" ADD CONSTRAINT "credit_reservations_workspace_id_attempt_id_generation_attempts_workspace_id_id_fk" FOREIGN KEY ("workspace_id","attempt_id") REFERENCES "public"."generation_attempts"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD CONSTRAINT "generation_attempts_channel_id_provider_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."provider_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD CONSTRAINT "generation_attempts_workspace_id_job_id_generation_jobs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."generation_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_batches" ADD CONSTRAINT "generation_batches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_batches" ADD CONSTRAINT "generation_batches_idempotency_request_id_idempotency_requests_id_fk" FOREIGN KEY ("idempotency_request_id") REFERENCES "public"."idempotency_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_batches" ADD CONSTRAINT "generation_batches_created_by_profiles_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_batches" ADD CONSTRAINT "generation_batches_workspace_id_project_id_projects_workspace_id_id_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_job_events" ADD CONSTRAINT "generation_job_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_job_targets" ADD CONSTRAINT "generation_job_targets_workspace_id_job_id_generation_jobs_workspace_id_id_fk" FOREIGN KEY ("workspace_id","job_id") REFERENCES "public"."generation_jobs"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_job_targets" ADD CONSTRAINT "generation_job_targets_workspace_id_project_id_projects_workspace_id_id_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_model_config_id_model_configs_id_fk" FOREIGN KEY ("model_config_id") REFERENCES "public"."model_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_workspace_id_batch_id_generation_batches_workspace_id_id_fk" FOREIGN KEY ("workspace_id","batch_id") REFERENCES "public"."generation_batches"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_requests" ADD CONSTRAINT "idempotency_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imports" ADD CONSTRAINT "imports_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_configs" ADD CONSTRAINT "model_configs_channel_id_provider_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."provider_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_prices" ADD CONSTRAINT "model_prices_model_config_id_model_configs_id_fk" FOREIGN KEY ("model_config_id") REFERENCES "public"."model_configs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_risk_entries" ADD CONSTRAINT "platform_risk_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_risk_entries" ADD CONSTRAINT "platform_risk_entries_attempt_id_generation_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."generation_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_created_by_profiles_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_versions" ADD CONSTRAINT "project_versions_workspace_id_project_id_projects_workspace_id_id_fk" FOREIGN KEY ("workspace_id","project_id") REFERENCES "public"."projects"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_updated_by_profiles_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_channel_id_provider_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."provider_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_workspace_id_wallet_accounts_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."wallet_accounts"("workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_actor_user_id_profiles_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_profiles_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_user_id_profiles_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."profiles"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_workspace_status_idx" ON "assets" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_workspace_created_idx" ON "audit_logs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_reservations_status_expiry_idx" ON "credit_reservations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "generation_attempts_provider_task_unique" ON "generation_attempts" USING btree ("channel_id","provider_task_id") WHERE "generation_attempts"."provider_task_id" is not null;--> statement-breakpoint
CREATE INDEX "generation_job_events_workspace_sequence_idx" ON "generation_job_events" USING btree ("workspace_id","sequence");--> statement-breakpoint
CREATE INDEX "generation_job_events_job_sequence_idx" ON "generation_job_events" USING btree ("job_id","sequence");--> statement-breakpoint
CREATE INDEX "generation_job_targets_project_slot_idx" ON "generation_job_targets" USING btree ("project_id","node_id","slot_id");--> statement-breakpoint
CREATE INDEX "generation_jobs_workspace_status_created_idx" ON "generation_jobs" USING btree ("workspace_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idempotency_requests_expiry_idx" ON "idempotency_requests" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "imports_workspace_status_idx" ON "imports" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "projects_workspace_updated_idx" ON "projects" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "wallet_entries_workspace_created_idx" ON "wallet_entries" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "workspace_members_user_idx" ON "workspace_members" USING btree ("user_id","status");