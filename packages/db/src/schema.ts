import { sql } from "drizzle-orm";
import { bigint, bigserial, boolean, check, foreignKey, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";

const utc = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const profileStatus = pgEnum("profile_status", ["active", "disabled"]);
export const platformRole = pgEnum("platform_role", ["user", "admin"]);
export const workspaceStatus = pgEnum("workspace_status", ["active", "suspended", "deleted"]);
export const workspaceRole = pgEnum("workspace_role", ["owner", "editor", "viewer"]);
export const memberStatus = pgEnum("member_status", ["active", "disabled"]);
export const generationCapability = pgEnum("generation_capability", ["image", "video"]);
export const batchStatus = pgEnum("batch_status", ["queued", "running", "succeeded", "partial_succeeded", "failed", "canceled"]);
export const jobStatus = pgEnum("job_status", ["queued", "dispatching", "running", "waiting_provider", "materializing", "succeeded", "failed", "cancel_requested", "canceled", "outcome_unknown"]);
export const attemptStatus = pgEnum("attempt_status", ["created", "claimed", "submitting", "accepted", "materializing", "succeeded", "failed", "canceled", "outcome_unknown"]);
export const assetStatus = pgEnum("asset_status", ["uploading", "verifying", "ready", "rejected", "deleted"]);
export const assetKind = pgEnum("asset_kind", ["image", "video", "audio", "import"]);
export const channelStatus = pgEnum("channel_status", ["active", "paused", "disabled"]);
export const credentialStatus = pgEnum("credential_status", ["active", "rotating", "disabled"]);
export const modelStatus = pgEnum("model_status", ["active", "disabled"]);
export const reservationStatus = pgEnum("reservation_status", ["reserved", "settled", "released"]);
export const outboxStatus = pgEnum("outbox_status", ["pending", "sending", "sent", "dead"]);
export const idempotencyStatus = pgEnum("idempotency_status", ["processing", "completed", "failed"]);
export const importStatus = pgEnum("import_status", ["uploaded", "validating", "importing", "published", "failed", "deleted"]);

export const profiles = pgTable("profiles", {
  userId: uuid("user_id").primaryKey(),
  displayName: text("display_name").notNull(),
  status: profileStatus("status").notNull().default("active"),
  platformRole: platformRole("platform_role").notNull().default("user"),
  cloudProjectsEnabled: boolean("cloud_projects_enabled").notNull().default(false),
  cloudImageEnabled: boolean("cloud_image_enabled").notNull().default(false),
  cloudVideoEnabled: boolean("cloud_video_enabled").notNull().default(false),
  cloudCreditsEnabled: boolean("cloud_credits_enabled").notNull().default(false),
  lastLoginAt: utc("last_login_at"),
  createdAt: utc("created_at").notNull().defaultNow(),
  updatedAt: utc("updated_at").notNull().defaultNow(),
});

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey(),
  ownerUserId: uuid("owner_user_id").notNull().references(() => profiles.userId),
  name: text("name").notNull(),
  status: workspaceStatus("status").notNull().default("active"),
  createdAt: utc("created_at").notNull().defaultNow(),
  updatedAt: utc("updated_at").notNull().defaultNow(),
}, (table) => [unique("workspaces_id_owner_unique").on(table.id, table.ownerUserId)]);

export const workspaceMembers = pgTable("workspace_members", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  userId: uuid("user_id").notNull().references(() => profiles.userId),
  role: workspaceRole("role").notNull(),
  status: memberStatus("status").notNull().default("active"),
  createdAt: utc("created_at").notNull().defaultNow(),
  updatedAt: utc("updated_at").notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.userId] }),
  index("workspace_members_user_idx").on(table.userId, table.status),
]);

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  createdBy: uuid("created_by").references(() => profiles.userId),
  clientProjectId: text("client_project_id"),
  title: text("title").notNull(),
  documentJson: jsonb("document_json").notNull(),
  version: integer("version").notNull().default(1),
  updatedBy: uuid("updated_by").notNull().references(() => profiles.userId),
  importId: uuid("import_id"),
  sourceId: text("source_id"),
  createdAt: utc("created_at").notNull().defaultNow(),
  updatedAt: utc("updated_at").notNull().defaultNow(),
  deletedAt: utc("deleted_at"),
}, (table) => [
  unique("projects_workspace_id_unique").on(table.workspaceId, table.id),
  unique("projects_import_source_unique").on(table.workspaceId, table.importId, table.sourceId),
  uniqueIndex("projects_client_binding_unique").on(table.workspaceId, table.createdBy, table.clientProjectId),
  check("projects_version_positive", sql`${table.version} > 0`),
  index("projects_workspace_updated_idx").on(table.workspaceId, table.updatedAt),
]);

export const projectVersions = pgTable("project_versions", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  projectId: uuid("project_id").notNull(),
  version: integer("version").notNull(),
  snapshotJson: jsonb("snapshot_json").notNull(),
  reason: text("reason").notNull(),
  createdBy: uuid("created_by").notNull().references(() => profiles.userId),
  createdAt: utc("created_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }),
  unique("project_versions_project_version_unique").on(table.projectId, table.version),
]);

export const assets = pgTable("assets", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  kind: assetKind("kind").notNull(),
  status: assetStatus("status").notNull().default("uploading"),
  objectKey: text("object_key").notNull(),
  mime: text("mime").notNull(),
  bytes: bigint("bytes", { mode: "bigint" }).notNull(),
  sha256: text("sha256").notNull(),
  verificationToken: uuid("verification_token"),
  importId: uuid("import_id"),
  sourceId: text("source_id"),
  width: integer("width"),
  height: integer("height"),
  durationMs: bigint("duration_ms", { mode: "bigint" }),
  createdAt: utc("created_at").notNull().defaultNow(),
  updatedAt: utc("updated_at").notNull().defaultNow(),
  deletedAt: utc("deleted_at"),
}, (table) => [
  unique("assets_workspace_id_unique").on(table.workspaceId, table.id),
  unique("assets_object_key_unique").on(table.objectKey),
  unique("assets_import_source_unique").on(table.workspaceId, table.importId, table.sourceId),
  check("assets_bytes_nonnegative", sql`${table.bytes} >= 0`),
  check("assets_verification_token_status_check", sql`(${table.status} = 'verifying') = (${table.verificationToken} is not null)`),
  index("assets_workspace_status_idx").on(table.workspaceId, table.status, table.createdAt),
]);

export const providerChannels = pgTable("provider_channels", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  type: text("type").notNull(),
  baseUrl: text("base_url").notNull(),
  capabilities: jsonb("capabilities").notNull(),
  status: channelStatus("status").notNull().default("active"),
  healthStatus: text("health_status").notNull().default("unknown"),
  createdAt: utc("created_at").notNull().defaultNow(),
  updatedAt: utc("updated_at").notNull().defaultNow(),
});

export const providerCredentials = pgTable("provider_credentials", {
  id: uuid("id").primaryKey(),
  channelId: uuid("channel_id").notNull().references(() => providerChannels.id),
  version: integer("version").notNull(),
  encryptedSecret: text("encrypted_secret").notNull(),
  encryptedDataKey: text("encrypted_data_key").notNull(),
  nonce: text("nonce").notNull(),
  keyId: text("key_id").notNull(),
  secretSuffix: text("secret_suffix").notNull(),
  status: credentialStatus("status").notNull().default("active"),
  createdAt: utc("created_at").notNull().defaultNow(),
  disabledAt: utc("disabled_at"),
}, (table) => [unique("provider_credentials_channel_version_unique").on(table.channelId, table.version)]);

export const modelConfigs = pgTable("model_configs", {
  id: uuid("id").primaryKey(),
  channelId: uuid("channel_id").notNull().references(() => providerChannels.id),
  model: text("model").notNull(),
  capability: generationCapability("capability").notNull(),
  adapterType: text("adapter_type").notNull(),
  adapterVersion: integer("adapter_version").notNull(),
  configVersion: integer("config_version").notNull(),
  limitsJson: jsonb("limits_json").notNull(),
  concurrencyLimit: integer("concurrency_limit").notNull().default(1),
  providerIdempotencySupported: boolean("provider_idempotency_supported").notNull().default(false),
  status: modelStatus("status").notNull().default("active"),
  createdAt: utc("created_at").notNull().defaultNow(),
}, (table) => [
  unique("model_configs_version_unique").on(table.channelId, table.model, table.capability, table.configVersion),
  check("model_configs_versions_positive", sql`${table.adapterVersion} > 0 and ${table.configVersion} > 0`),
  check("model_configs_concurrency_positive", sql`${table.concurrencyLimit} > 0`),
]);

export const modelPrices = pgTable("model_prices", {
  id: uuid("id").primaryKey(),
  modelConfigId: uuid("model_config_id").notNull().references(() => modelConfigs.id),
  version: integer("version").notNull(),
  conditionsJson: jsonb("conditions_json").notNull(),
  creditAmount: bigint("credit_amount", { mode: "bigint" }).notNull(),
  effectiveAt: utc("effective_at").notNull(),
  retiredAt: utc("retired_at"),
  createdAt: utc("created_at").notNull().defaultNow(),
}, (table) => [
  unique("model_prices_model_version_unique").on(table.modelConfigId, table.version),
  check("model_prices_amount_nonnegative", sql`${table.creditAmount} >= 0`),
]);

export const walletAccounts = pgTable("wallet_accounts", {
  workspaceId: uuid("workspace_id").primaryKey().references(() => workspaces.id),
  available: bigint("available", { mode: "bigint" }).notNull().default(sql`0`),
  reserved: bigint("reserved", { mode: "bigint" }).notNull().default(sql`0`),
  version: integer("version").notNull().default(0),
  updatedAt: utc("updated_at").notNull().defaultNow(),
}, (table) => [
  check("wallet_accounts_available_nonnegative", sql`${table.available} >= 0`),
  check("wallet_accounts_reserved_nonnegative", sql`${table.reserved} >= 0`),
  check("wallet_accounts_version_nonnegative", sql`${table.version} >= 0`),
]);

export const idempotencyRequests = pgTable("idempotency_requests", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  operation: text("operation").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  status: idempotencyStatus("status").notNull().default("processing"),
  responseStatus: integer("response_status"),
  responseBody: jsonb("response_body"),
  createdAt: utc("created_at").notNull().defaultNow(),
  updatedAt: utc("updated_at").notNull().defaultNow(),
  expiresAt: utc("expires_at").notNull(),
}, (table) => [
  unique("idempotency_requests_scope_key_unique").on(table.workspaceId, table.operation, table.key),
  index("idempotency_requests_expiry_idx").on(table.expiresAt),
]);

export const platformIdempotencyRequests = pgTable("platform_idempotency_requests", {
  id: uuid("id").primaryKey(),
  actorUserId: uuid("actor_user_id").notNull().references(() => profiles.userId),
  operation: text("operation").notNull(),
  key: text("key").notNull(),
  requestHash: text("request_hash").notNull(),
  status: idempotencyStatus("status").notNull().default("processing"),
  responseStatus: integer("response_status"),
  responseBody: jsonb("response_body"),
  createdAt: utc("created_at").notNull().defaultNow(),
  updatedAt: utc("updated_at").notNull().defaultNow(),
  expiresAt: utc("expires_at").notNull(),
}, (table) => [
  unique("platform_idempotency_actor_operation_key_unique").on(table.actorUserId, table.operation, table.key),
  index("platform_idempotency_expiry_idx").on(table.expiresAt),
]);

export const generationBatches = pgTable("generation_batches", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  projectId: uuid("project_id").notNull(),
  kind: generationCapability("kind").notNull(),
  requestedCount: integer("requested_count").notNull(),
  status: batchStatus("status").notNull().default("queued"),
  idempotencyRequestId: uuid("idempotency_request_id").notNull().references(() => idempotencyRequests.id),
  createdBy: uuid("created_by").notNull().references(() => profiles.userId),
  createdAt: utc("created_at").notNull().defaultNow(),
  updatedAt: utc("updated_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }),
  unique("generation_batches_workspace_id_unique").on(table.workspaceId, table.id),
  unique("generation_batches_idempotency_unique").on(table.idempotencyRequestId),
  check("generation_batches_count_range", sql`${table.requestedCount} between 1 and 15`),
]);

export const generationJobs = pgTable("generation_jobs", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  batchId: uuid("batch_id").notNull(),
  slotIndex: integer("slot_index").notNull(),
  capability: generationCapability("capability").notNull(),
  modelConfigId: uuid("model_config_id").notNull().references(() => modelConfigs.id),
  modelSnapshot: jsonb("model_snapshot").notNull(),
  priceSnapshot: jsonb("price_snapshot").notNull(),
  inputSnapshot: jsonb("input_snapshot").notNull(),
  estimatedCredits: bigint("estimated_credits", { mode: "bigint" }).notNull(),
  status: jobStatus("status").notNull().default("queued"),
  currentAttemptId: uuid("current_attempt_id"),
  outputAssetId: uuid("output_asset_id"),
  version: integer("version").notNull().default(0),
  createdAt: utc("created_at").notNull().defaultNow(),
  updatedAt: utc("updated_at").notNull().defaultNow(),
  terminalAt: utc("terminal_at"),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.batchId], foreignColumns: [generationBatches.workspaceId, generationBatches.id] }),
  foreignKey({ columns: [table.workspaceId, table.outputAssetId], foreignColumns: [assets.workspaceId, assets.id] }),
  unique("generation_jobs_workspace_id_unique").on(table.workspaceId, table.id),
  unique("generation_jobs_batch_slot_unique").on(table.batchId, table.slotIndex),
  check("generation_jobs_slot_nonnegative", sql`${table.slotIndex} >= 0`),
  check("generation_jobs_credits_nonnegative", sql`${table.estimatedCredits} >= 0`),
  check("generation_jobs_version_nonnegative", sql`${table.version} >= 0`),
  index("generation_jobs_workspace_status_created_idx").on(table.workspaceId, table.status, table.createdAt),
]);

export const generationAttempts = pgTable("generation_attempts", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  jobId: uuid("job_id").notNull(),
  attemptNo: integer("attempt_no").notNull(),
  channelId: uuid("channel_id").notNull().references(() => providerChannels.id),
  credentialVersion: integer("credential_version").notNull(),
  adapterType: text("adapter_type").notNull(),
  adapterVersion: integer("adapter_version").notNull(),
  status: attemptStatus("status").notNull().default("created"),
  executorDispatchToken: uuid("executor_dispatch_token").notNull().defaultRandom(),
  executorClaimId: text("executor_claim_id"),
  executorRunId: text("executor_run_id"),
  providerTaskId: text("provider_task_id"),
  providerIdempotencySupported: boolean("provider_idempotency_supported").notNull().default(false),
  requestFingerprint: text("request_fingerprint").notNull(),
  businessDeadlineAt: utc("business_deadline_at").notNull(),
  claimedAt: utc("claimed_at"),
  submittedAt: utc("submitted_at"),
  outcomeUnknownAt: utc("outcome_unknown_at"),
  reconcileAfter: utc("reconcile_after"),
  releaseAfter: utc("release_after"),
  completedAt: utc("completed_at"),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  evidenceJson: jsonb("evidence_json"),
  createdAt: utc("created_at").notNull().defaultNow(),
  updatedAt: utc("updated_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.jobId], foreignColumns: [generationJobs.workspaceId, generationJobs.id] }),
  unique("generation_attempts_workspace_id_unique").on(table.workspaceId, table.id),
  unique("generation_attempts_job_attempt_unique").on(table.jobId, table.attemptNo),
  uniqueIndex("generation_attempts_provider_task_unique").on(table.channelId, table.providerTaskId).where(sql`${table.providerTaskId} is not null`),
  check("generation_attempts_no_positive", sql`${table.attemptNo} > 0`),
  check("generation_attempts_versions_positive", sql`${table.credentialVersion} > 0 and ${table.adapterVersion} > 0`),
]);

export const generationJobTargets = pgTable("generation_job_targets", {
  jobId: uuid("job_id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  projectId: uuid("project_id").notNull(),
  nodeId: text("node_id").notNull(),
  slotId: text("slot_id").notNull(),
  createdAt: utc("created_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.jobId], foreignColumns: [generationJobs.workspaceId, generationJobs.id] }),
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }),
  index("generation_job_targets_project_slot_idx").on(table.projectId, table.nodeId, table.slotId),
]);

export const creditReservations = pgTable("credit_reservations", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull(),
  jobId: uuid("job_id").notNull(),
  attemptId: uuid("attempt_id").notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  status: reservationStatus("status").notNull().default("reserved"),
  expiresAt: utc("expires_at").notNull(),
  settledAt: utc("settled_at"),
  releasedAt: utc("released_at"),
  releaseKind: text("release_kind"),
  createdAt: utc("created_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.jobId], foreignColumns: [generationJobs.workspaceId, generationJobs.id] }),
  foreignKey({ columns: [table.workspaceId, table.attemptId], foreignColumns: [generationAttempts.workspaceId, generationAttempts.id] }),
  unique("credit_reservations_attempt_unique").on(table.attemptId),
  check("credit_reservations_amount_nonnegative", sql`${table.amount} >= 0`),
  index("credit_reservations_status_expiry_idx").on(table.status, table.expiresAt),
]);

export const walletEntries = pgTable("wallet_entries", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => walletAccounts.workspaceId),
  kind: text("kind").notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  availableAfter: bigint("available_after", { mode: "bigint" }).notNull(),
  reservedAfter: bigint("reserved_after", { mode: "bigint" }).notNull(),
  referenceType: text("reference_type").notNull(),
  referenceId: uuid("reference_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  actorUserId: uuid("actor_user_id").references(() => profiles.userId),
  reason: text("reason"),
  createdAt: utc("created_at").notNull().defaultNow(),
}, (table) => [
  unique("wallet_entries_idempotency_unique").on(table.workspaceId, table.idempotencyKey),
  check("wallet_entries_balances_nonnegative", sql`${table.availableAfter} >= 0 and ${table.reservedAfter} >= 0`),
  index("wallet_entries_workspace_created_idx").on(table.workspaceId, table.createdAt),
]);

export const generationJobEvents = pgTable("generation_job_events", {
  sequence: bigserial("sequence", { mode: "bigint" }).primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  aggregateType: text("aggregate_type").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  projectId: uuid("project_id"),
  batchId: uuid("batch_id"),
  jobId: uuid("job_id"),
  attemptId: uuid("attempt_id"),
  type: text("type").notNull(),
  payload: jsonb("payload").notNull(),
  createdAt: utc("created_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.projectId], foreignColumns: [projects.workspaceId, projects.id] }),
  foreignKey({ columns: [table.workspaceId, table.batchId], foreignColumns: [generationBatches.workspaceId, generationBatches.id] }),
  foreignKey({ columns: [table.workspaceId, table.jobId], foreignColumns: [generationJobs.workspaceId, generationJobs.id] }),
  foreignKey({ columns: [table.workspaceId, table.attemptId], foreignColumns: [generationAttempts.workspaceId, generationAttempts.id] }),
  index("generation_job_events_workspace_sequence_idx").on(table.workspaceId, table.sequence),
  index("generation_job_events_job_sequence_idx").on(table.jobId, table.sequence),
]);

export const outboxEvents = pgTable("outbox_events", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  topic: text("topic").notNull(),
  aggregateId: uuid("aggregate_id").notNull(),
  dedupeKey: text("dedupe_key").notNull(),
  payload: jsonb("payload").notNull(),
  status: outboxStatus("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: utc("available_at").notNull().defaultNow(),
  lockedBy: text("locked_by"),
  lockedAt: utc("locked_at"),
  dispatchStartedToken: uuid("dispatch_started_token"),
  lastError: text("last_error"),
  sentAt: utc("sent_at"),
  createdAt: utc("created_at").notNull().defaultNow(),
  updatedAt: utc("updated_at").notNull().defaultNow(),
}, (table) => [
  unique("outbox_events_dedupe_unique").on(table.dedupeKey),
  check("outbox_events_attempts_nonnegative", sql`${table.attempts} >= 0`),
  index("outbox_events_pending_idx").on(table.status, table.availableAt),
]);

export const imports = pgTable("imports", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  userId: uuid("user_id").notNull().references(() => profiles.userId),
  clientExportId: uuid("client_export_id").notNull(),
  schemaVersion: integer("schema_version").notNull(),
  status: importStatus("status").notNull().default("uploaded"),
  objectKey: text("object_key").notNull(),
  manifestSha256: text("manifest_sha256").notNull(),
  countsJson: jsonb("counts_json").notNull(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  publishedAt: utc("published_at"),
  createdAt: utc("created_at").notNull().defaultNow(),
  updatedAt: utc("updated_at").notNull().defaultNow(),
}, (table) => [
  unique("imports_workspace_id_unique").on(table.workspaceId, table.id),
  unique("imports_user_export_unique").on(table.userId, table.clientExportId),
  index("imports_workspace_status_idx").on(table.workspaceId, table.status),
]);

export const importSourceMappings = pgTable("import_source_mappings", {
  importId: uuid("import_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
  entityType: text("entity_type").notNull(),
  sourceId: text("source_id").notNull(),
  targetId: uuid("target_id").notNull(),
  createdAt: utc("created_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.importId], foreignColumns: [imports.workspaceId, imports.id] }),
  primaryKey({ columns: [table.importId, table.entityType, table.sourceId] }),
  check("import_source_mappings_entity_type", sql`${table.entityType} in ('project', 'asset')`),
  index("import_source_mappings_target_idx").on(table.workspaceId, table.targetId),
]);

export const platformRiskEntries = pgTable("platform_risk_entries", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id),
  attemptId: uuid("attempt_id").notNull(),
  amount: bigint("amount", { mode: "bigint" }).notNull(),
  reason: text("reason").notNull(),
  evidenceJson: jsonb("evidence_json").notNull(),
  createdAt: utc("created_at").notNull().defaultNow(),
}, (table) => [
  foreignKey({ columns: [table.workspaceId, table.attemptId], foreignColumns: [generationAttempts.workspaceId, generationAttempts.id] }),
  unique("platform_risk_entries_attempt_unique").on(table.attemptId),
  check("platform_risk_entries_amount_nonnegative", sql`${table.amount} >= 0`),
]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id),
  actorUserId: uuid("actor_user_id").references(() => profiles.userId),
  actorType: text("actor_type").notNull(),
  action: text("action").notNull(),
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  reason: text("reason"),
  beforeSummary: jsonb("before_summary"),
  afterSummary: jsonb("after_summary"),
  correlationId: text("correlation_id").notNull(),
  createdAt: utc("created_at").notNull().defaultNow(),
}, (table) => [index("audit_logs_workspace_created_idx").on(table.workspaceId, table.createdAt)]);
