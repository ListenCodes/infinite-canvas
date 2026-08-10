CREATE TABLE "provider_channel_capacity_leases" (
	"channel_id" uuid NOT NULL,
	"capability" "generation_capability" NOT NULL,
	"holder_id" uuid NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_channel_capacity_leases_pk" PRIMARY KEY("channel_id","capability","holder_id"),
	CONSTRAINT "provider_channel_capacity_leases_holder_unique" UNIQUE("holder_id")
);
--> statement-breakpoint
CREATE TABLE "provider_channel_capacity_policies" (
	"channel_id" uuid NOT NULL,
	"capability" "generation_capability" NOT NULL,
	"version" integer NOT NULL,
	"concurrency_limit" integer NOT NULL,
	"rate_limit_per_minute" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_channel_capacity_policies_pk" PRIMARY KEY("channel_id","capability","version"),
	CONSTRAINT "provider_channel_capacity_policies_positive" CHECK ("provider_channel_capacity_policies"."version" > 0 and "provider_channel_capacity_policies"."concurrency_limit" > 0 and "provider_channel_capacity_policies"."rate_limit_per_minute" > 0)
);
--> statement-breakpoint
ALTER TABLE "provider_channels" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_configs" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generation_jobs" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generation_attempts" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox_events" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "provider_channel_capacity_policies" (
	"channel_id", "capability", "version", "concurrency_limit", "rate_limit_per_minute"
)
SELECT "channel_id", "capability", 1, greatest(1, min("concurrency_limit")), 60
FROM "model_configs"
GROUP BY "channel_id", "capability";--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD COLUMN "capacity_policy_version" integer;--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD COLUMN "workspace_concurrency_limit" integer;--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD COLUMN "workspace_rate_limit_per_minute" integer;--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD COLUMN "channel_concurrency_limit" integer;--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD COLUMN "channel_rate_limit_per_minute" integer;--> statement-breakpoint
CREATE FUNCTION app.populate_generation_attempt_capacity_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, app AS $$
DECLARE
	job_capability generation_capability;
	policy_version integer;
	policy_concurrency integer;
	policy_rate integer;
	expected_workspace_concurrency integer;
	expected_workspace_rate integer;
	snapshot_fields integer;
BEGIN
	SELECT capability INTO job_capability
	FROM generation_jobs
	WHERE id = NEW.job_id AND workspace_id = NEW.workspace_id;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'generation attempt job identity is invalid';
	END IF;

	expected_workspace_concurrency := CASE WHEN job_capability = 'image' THEN 3 ELSE 2 END;
	expected_workspace_rate := CASE WHEN job_capability = 'image' THEN 30 ELSE 10 END;
	snapshot_fields := num_nonnulls(
		NEW.capacity_policy_version,
		NEW.workspace_concurrency_limit,
		NEW.workspace_rate_limit_per_minute,
		NEW.channel_concurrency_limit,
		NEW.channel_rate_limit_per_minute
	);

	IF snapshot_fields = 0 THEN
		SELECT version, concurrency_limit, rate_limit_per_minute
		INTO policy_version, policy_concurrency, policy_rate
		FROM provider_channel_capacity_policies
		WHERE channel_id = NEW.channel_id AND capability = job_capability
		ORDER BY version DESC LIMIT 1;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'generation attempt has no channel capacity policy';
		END IF;
		NEW.capacity_policy_version := policy_version;
		NEW.workspace_concurrency_limit := expected_workspace_concurrency;
		NEW.workspace_rate_limit_per_minute := expected_workspace_rate;
		NEW.channel_concurrency_limit := policy_concurrency;
		NEW.channel_rate_limit_per_minute := policy_rate;
	ELSIF snapshot_fields <> 5 THEN
		RAISE EXCEPTION 'generation attempt capacity snapshot must be complete';
	ELSE
		SELECT concurrency_limit, rate_limit_per_minute
		INTO policy_concurrency, policy_rate
		FROM provider_channel_capacity_policies
		WHERE channel_id = NEW.channel_id AND capability = job_capability
			AND version = NEW.capacity_policy_version;
		IF NOT FOUND
			OR NEW.workspace_concurrency_limit <> expected_workspace_concurrency
			OR NEW.workspace_rate_limit_per_minute <> expected_workspace_rate
			OR NEW.channel_concurrency_limit <> policy_concurrency
			OR NEW.channel_rate_limit_per_minute <> policy_rate THEN
			RAISE EXCEPTION 'generation attempt capacity snapshot does not match its policy';
		END IF;
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER generation_attempt_capacity_snapshot_default
BEFORE INSERT ON generation_attempts
FOR EACH ROW EXECUTE FUNCTION app.populate_generation_attempt_capacity_snapshot();--> statement-breakpoint
UPDATE "generation_attempts" AS attempt
SET "capacity_policy_version" = policy."version",
	"workspace_concurrency_limit" = CASE WHEN job."capability" = 'image' THEN 3 ELSE 2 END,
	"workspace_rate_limit_per_minute" = CASE WHEN job."capability" = 'image' THEN 30 ELSE 10 END,
	"channel_concurrency_limit" = policy."concurrency_limit",
	"channel_rate_limit_per_minute" = policy."rate_limit_per_minute"
FROM "generation_jobs" AS job, "provider_channel_capacity_policies" AS policy
WHERE job."id" = attempt."job_id"
	AND policy."channel_id" = attempt."channel_id"
	AND policy."capability" = job."capability"
	AND NOT EXISTS (
		SELECT 1
		FROM "provider_channel_capacity_policies" AS candidate
		WHERE candidate."channel_id" = policy."channel_id"
			AND candidate."capability" = policy."capability"
			AND candidate."version" > policy."version"
	);--> statement-breakpoint
ALTER TABLE "generation_attempts" ALTER COLUMN "capacity_policy_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_attempts" ALTER COLUMN "workspace_concurrency_limit" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_attempts" ALTER COLUMN "workspace_rate_limit_per_minute" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_attempts" ALTER COLUMN "channel_concurrency_limit" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_attempts" ALTER COLUMN "channel_rate_limit_per_minute" SET NOT NULL;--> statement-breakpoint
UPDATE "outbox_events" AS event
SET "payload" = event."payload" || jsonb_build_object(
	'capacity', jsonb_build_object(
		'policyVersion', attempt."capacity_policy_version",
		'workspaceConcurrencyLimit', attempt."workspace_concurrency_limit",
		'workspaceRateLimitPerMinute', attempt."workspace_rate_limit_per_minute",
		'channelConcurrencyLimit', attempt."channel_concurrency_limit",
		'channelRateLimitPerMinute', attempt."channel_rate_limit_per_minute"
	)
)
FROM "generation_attempts" AS attempt
WHERE event."topic" = 'generation.job.requested'
	AND event."payload"->>'attemptId' = attempt."id"::text;--> statement-breakpoint
ALTER TABLE "provider_channel_capacity_leases" ADD CONSTRAINT "provider_channel_capacity_leases_channel_id_provider_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."provider_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_channel_capacity_leases" ADD CONSTRAINT "provider_channel_capacity_leases_holder_id_generation_attempts_id_fk" FOREIGN KEY ("holder_id") REFERENCES "public"."generation_attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_channel_capacity_policies" ADD CONSTRAINT "provider_channel_capacity_policies_channel_id_provider_channels_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."provider_channels"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "provider_channel_capacity_leases_expiry_idx" ON "provider_channel_capacity_leases" USING btree ("channel_id","capability","lease_expires_at");--> statement-breakpoint
CREATE INDEX "provider_channel_capacity_policies_latest_idx" ON "provider_channel_capacity_policies" USING btree ("channel_id","capability","version");--> statement-breakpoint
ALTER TABLE "generation_attempts" ADD CONSTRAINT "generation_attempts_capacity_positive" CHECK ("generation_attempts"."capacity_policy_version" > 0 and "generation_attempts"."workspace_concurrency_limit" > 0 and "generation_attempts"."workspace_rate_limit_per_minute" > 0 and "generation_attempts"."channel_concurrency_limit" > 0 and "generation_attempts"."channel_rate_limit_per_minute" > 0);--> statement-breakpoint
ALTER TABLE "provider_channels" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "model_configs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generation_jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generation_attempts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox_events" FORCE ROW LEVEL SECURITY;
