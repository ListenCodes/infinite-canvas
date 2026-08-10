import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";

import {
  adminAuditLogSchema,
  adminJobSchema,
  adminModelConfigInputSchema,
  adminModelConfigResponseSchema,
  adminUserSchema,
  adminUserFeaturesRequestSchema,
  adminUserFeaturesResponseSchema,
  adminUserStatusRequestSchema,
  adminUserStatusResponseSchema,
  adminWalletAdjustmentRequestSchema,
  adminWalletAdjustmentResponseSchema,
  providerChannelInputSchema,
  providerChannelMutationResponseSchema,
  providerChannelSchema,
  providerCredentialInputSchema,
  providerCredentialResponseSchema,
  unknownResolutionRequestSchema,
  unknownResolutionResponseSchema,
} from "@infinite-canvas/contracts";
import { jsonParameter } from "@infinite-canvas/db";
import { assertPublicAddress, validateRemoteMediaUrl } from "@infinite-canvas/domain";

import type { Sql, TransactionSql } from "../database.js";
import { setServiceContext, setUserContext } from "../database.js";
import { AppError } from "../errors.js";
import type { IdFactory } from "../ids.js";
import { assertIdempotencyKey, idempotencyRequestHash } from "../request-idempotency.js";

export const walletAdjustmentSchema = adminWalletAdjustmentRequestSchema;
export const providerChannelInput = providerChannelInputSchema;
export const providerCredentialSchema = providerCredentialInputSchema;
export const modelConfigSchema = adminModelConfigInputSchema;
export const unknownResolutionSchema = unknownResolutionRequestSchema;

interface PlatformIdempotencyRow {
  id: string;
  request_hash: string;
  status: "processing" | "completed" | "failed";
  response_body: unknown;
}

type AdminPageScope = "users" | "jobs" | "audit";
interface AdminPageCursor {
  createdAt: string;
  id: string;
}

export function encodeAdminCursor(scope: AdminPageScope, cursor: AdminPageCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, scope, ...cursor }), "utf8").toString("base64url");
}

export function decodeAdminCursor(scope: AdminPageScope, value?: string): AdminPageCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      parsed.v !== 1 || parsed.scope !== scope ||
      typeof parsed.createdAt !== "string" || !Number.isFinite(Date.parse(parsed.createdAt)) ||
      typeof parsed.id !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(parsed.id)
    ) throw new Error("invalid cursor");
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new AppError(400, "invalid_admin_cursor", "Admin pagination cursor is invalid");
  }
}

function adminUserProjection(row: any) {
  return adminUserSchema.parse({
    userId: row.user_id,
    displayName: row.display_name,
    status: row.status,
    platformRole: row.platform_role,
    featureFlags: {
      projects: row.cloud_projects_enabled,
      imageGeneration: row.cloud_image_enabled,
      videoGeneration: row.cloud_video_enabled,
      credits: row.cloud_credits_enabled,
    },
    lastLoginAt: row.last_login_at?.toISOString?.() ?? row.last_login_at ?? null,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    available: row.available,
    reserved: row.reserved,
    workspaces: row.workspaces,
  });
}

function adminJobProjection(row: any) {
  return adminJobSchema.parse({
    jobId: row.id,
    workspaceId: row.workspace_id,
    batchId: row.batch_id,
    capability: row.capability,
    status: row.status,
    version: row.version,
    attemptId: row.attempt_id,
    attemptNo: row.attempt_no,
    channelId: row.channel_id,
    providerTaskId: row.provider_task_id,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    evidence: row.evidence_json ?? {},
    businessDeadlineAt: row.business_deadline_at?.toISOString?.() ?? row.business_deadline_at,
    outcomeUnknownAt: row.outcome_unknown_at?.toISOString?.() ?? row.outcome_unknown_at ?? null,
    reconcileAfter: row.reconcile_after?.toISOString?.() ?? row.reconcile_after ?? null,
    releaseAfter: row.release_after?.toISOString?.() ?? row.release_after ?? null,
    reservationStatus: row.reservation_status,
    reservedCredits: row.reserved_credits,
    outbox: row.outbox_events,
    ledgerKinds: row.ledger_kinds,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  });
}

function adminAuditProjection(row: any) {
  return adminAuditLogSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    actorUserId: row.actor_user_id,
    actorType: row.actor_type,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    reason: row.reason,
    beforeSummary: row.before_summary,
    afterSummary: row.after_summary,
    correlationId: row.correlation_id,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
  });
}

async function claimPlatformRequest(
  transaction: TransactionSql,
  createId: IdFactory,
  actorUserId: string,
  operation: string,
  key: string,
  payload: unknown,
): Promise<PlatformIdempotencyRow> {
  assertIdempotencyKey(key);
  const requestHash = idempotencyRequestHash(payload);
  let rows = await transaction<PlatformIdempotencyRow[]>`
    insert into platform_idempotency_requests (
      id, actor_user_id, operation, key, request_hash, expires_at
    ) values (
      ${createId()}, ${actorUserId}, ${operation}, ${key}, ${requestHash}, now() + interval '7 days'
    ) on conflict (actor_user_id, operation, key) do nothing
    returning id, request_hash, status, response_body
  `;
  if (!rows[0]) {
    rows = await transaction<PlatformIdempotencyRow[]>`
      select id, request_hash, status, response_body
      from platform_idempotency_requests
      where actor_user_id = ${actorUserId} and operation = ${operation} and key = ${key}
      for update
    `;
  }
  const request = rows[0];
  if (!request || request.request_hash !== requestHash)
    throw new AppError(409, "idempotency_key_conflict", "Idempotency-Key was already used with a different request");
  if (request.status === "failed")
    throw new AppError(409, "idempotency_request_failed", "The previous request with this key failed");
  return request;
}

async function completePlatformRequest(
  transaction: TransactionSql,
  requestId: string,
  responseBody: unknown,
): Promise<void> {
  await transaction`
    update platform_idempotency_requests
    set status = 'completed', response_status = 200,
        response_body = ${jsonParameter(transaction, responseBody)}, updated_at = now()
    where id = ${requestId}
  `;
}

function encrypt(key: Buffer, nonce: Buffer, value: Buffer): string {
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  return Buffer.concat([cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString("base64");
}

async function assertPublicBaseUrl(value: string): Promise<URL> {
  try {
    const url = validateRemoteMediaUrl(value);
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (addresses.length === 0) throw new AppError(422, "provider_url_unresolvable", "Provider URL could not be resolved");
    for (const address of addresses) assertPublicAddress(address.address);
    return url;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, "provider_url_rejected", "Provider URL must resolve to a public HTTP(S) address");
  }
}

export class AdminService {
  constructor(
    private readonly sql: Sql,
    private readonly masterKeyBase64: string,
    private readonly largeDebitThreshold: bigint,
    private readonly createId: IdFactory,
    private readonly generationWritesEnabled = true,
  ) {}

  async assertAdmin(userId: string): Promise<void> {
    const rows = await this.sql.begin(async (transaction) => {
      await setUserContext(transaction, userId);
      return transaction<{ allowed: boolean }[]>`
        select exists(
          select 1 from profiles where user_id = ${userId} and status = 'active' and platform_role = 'admin'
        ) as allowed
      `;
    });
    if (!rows[0]?.allowed) throw new AppError(403, "admin_required", "Platform administrator access is required");
  }

  private async lockAndAssertActiveAdmin(
    transaction: TransactionSql,
    actorUserId: string,
    additionalUserIds: readonly string[] = [],
  ): Promise<void> {
    const userIds = [...new Set([actorUserId, ...additionalUserIds])].sort();
    for (const userId of userIds) {
      await transaction`select pg_advisory_xact_lock(hashtextextended(${`account-auth:${userId}`}, 0))`;
    }
    const actors = await transaction<{ allowed: boolean }[]>`
      select exists(
        select 1 from profiles
        where user_id = ${actorUserId} and status = 'active' and platform_role = 'admin'
      ) as allowed
    `;
    if (!actors[0]?.allowed)
      throw new AppError(
        403,
        "admin_required",
        "Platform administrator access is required",
      );
  }

  async users(): Promise<readonly unknown[]> {
    return (await this.usersPage({ limit: 500 })).items;
  }

  async usersPage(query: { cursor?: string | undefined; limit: number }) {
    const cursor = decodeAdminCursor("users", query.cursor);
    const rows = await this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      return transaction`
        select profile.user_id, profile.display_name, profile.status, profile.platform_role,
               profile.cloud_projects_enabled, profile.cloud_image_enabled,
               profile.cloud_video_enabled, profile.cloud_credits_enabled,
               profile.last_login_at, profile.created_at,
               coalesce(sum(wallet.available), 0)::text as available,
               coalesce(sum(wallet.reserved), 0)::text as reserved,
               coalesce(jsonb_agg(distinct jsonb_build_object(
                 'workspaceId', workspace.id, 'name', workspace.name, 'role', member.role
               )) filter (where workspace.id is not null), '[]'::jsonb) as workspaces
        from profiles profile
        left join workspace_members member on member.user_id = profile.user_id and member.status = 'active'
        left join wallet_accounts wallet on wallet.workspace_id = member.workspace_id
        left join workspaces workspace on workspace.id = member.workspace_id
        where (${cursor?.createdAt ?? null}::timestamptz is null or
               (profile.created_at, profile.user_id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        group by profile.user_id order by profile.created_at desc, profile.user_id desc
        limit ${query.limit + 1}
      `;
    });
    const pageRows = rows.slice(0, query.limit) as any[];
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(adminUserProjection),
      nextCursor: rows.length > query.limit && last
        ? encodeAdminCursor("users", { createdAt: last.created_at.toISOString(), id: last.user_id })
        : null,
    };
  }

  async setUserStatus(actorUserId: string, userId: string, raw: unknown) {
    const input = adminUserStatusRequestSchema.parse(raw);
    if (actorUserId === userId) throw new AppError(409, "admin_self_disable_forbidden", "Administrators cannot change their own account status");
    const result = await this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      await transaction`select pg_advisory_xact_lock(hashtext('infinite_canvas.platform_admin_status'))`;
      await this.lockAndAssertActiveAdmin(transaction, actorUserId, [userId]);
      const profiles = await transaction<{ status: "active" | "disabled"; platform_role: "user" | "admin" }[]>`
        select status, platform_role from profiles where user_id = ${userId} for update
      `;
      const current = profiles[0];
      if (!current) throw new AppError(404, "user_not_found", "User was not found");
      const statusChanged = current.status !== input.status;
      if (statusChanged && input.status === "disabled" && current.platform_role === "admin") {
        const admins = await transaction<{ count: string }[]>`
          select count(*)::text as count from profiles where platform_role = 'admin' and status = 'active'
        `;
        if (BigInt(admins[0]?.count ?? "0") <= 1n) throw new AppError(409, "last_admin_disable_forbidden", "The last active administrator cannot be disabled");
      }
      if (statusChanged) {
        await transaction`update profiles set status = ${input.status}::profile_status, updated_at = now() where user_id = ${userId}`;
      }
      const workspaces = await transaction<{ workspace_id: string }[]>`
        select workspace_id from workspace_members where user_id in (${userId}, ${actorUserId})
        order by (user_id = ${userId}) desc, (role = 'owner') desc, created_at limit 1
      `;
      const workspaceId = workspaces[0]?.workspace_id;
      if (!workspaceId) throw new AppError(409, "data_invariant_violation", "No workspace is available for authentication synchronization");
      const syncEventId = this.createId();
      await transaction`
        insert into outbox_events (id, workspace_id, topic, aggregate_id, dedupe_key, payload)
        values (${syncEventId}, ${workspaceId}, 'account.auth.sync_requested', ${userId},
                ${`account-auth:${userId}:${syncEventId}`}, ${transaction.json({ userId })})
      `;
      await transaction`
        insert into audit_logs (id, actor_user_id, actor_type, action, target_type, target_id, reason, before_summary, after_summary, correlation_id)
        values (${this.createId()}, ${actorUserId}, 'admin', ${statusChanged ? "user.status.change" : "user.auth.resync"}, 'user', ${userId}, ${input.reason},
                ${transaction.json({ status: current.status })}, ${transaction.json({ status: input.status })},
                ${`user-status:${userId}:${this.createId()}`})
      `;
      return adminUserStatusResponseSchema.parse({ userId, status: input.status });
    });
    return result;
  }

  async setUserFeatures(actorUserId: string, userId: string, raw: unknown) {
    const input = adminUserFeaturesRequestSchema.parse(raw);
    const flags = input.featureFlags;
    if (
      (flags.imageGeneration || flags.videoGeneration) &&
      (!flags.projects || !flags.credits)
    ) {
      throw new AppError(
        422,
        "validation_failed",
        "Generation features require cloud projects and credits",
      );
    }
    return this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      await this.lockAndAssertActiveAdmin(transaction, actorUserId, [userId]);
      const profiles = await transaction<
        {
          cloud_projects_enabled: boolean;
          cloud_image_enabled: boolean;
          cloud_video_enabled: boolean;
          cloud_credits_enabled: boolean;
        }[]
      >`
        select cloud_projects_enabled, cloud_image_enabled,
               cloud_video_enabled, cloud_credits_enabled
        from profiles where user_id = ${userId} for update
      `;
      const current = profiles[0];
      if (!current)
        throw new AppError(404, "user_not_found", "User was not found");
      await transaction`
        update profiles
        set cloud_projects_enabled = ${flags.projects},
            cloud_image_enabled = ${flags.imageGeneration},
            cloud_video_enabled = ${flags.videoGeneration},
            cloud_credits_enabled = ${flags.credits},
            updated_at = now()
        where user_id = ${userId}
      `;
      await transaction`
        insert into audit_logs (
          id, actor_user_id, actor_type, action, target_type, target_id,
          reason, before_summary, after_summary, correlation_id
        ) values (
          ${this.createId()}, ${actorUserId}, 'admin', 'user.features.change',
          'user', ${userId}, ${input.reason},
          ${transaction.json({
            projects: current.cloud_projects_enabled,
            imageGeneration: current.cloud_image_enabled,
            videoGeneration: current.cloud_video_enabled,
            credits: current.cloud_credits_enabled,
          })},
          ${transaction.json(flags)},
          ${`user-features:${userId}:${this.createId()}`}
        )
      `;
      return adminUserFeaturesResponseSchema.parse({
        userId,
        featureFlags: flags,
      });
    });
  }

  async adjustWallet(actorUserId: string, raw: unknown, idempotencyKey: string) {
    const input = walletAdjustmentSchema.parse(raw);
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new AppError(400, "invalid_idempotency_key", "A valid Idempotency-Key is required");
    const amount = BigInt(input.amount);
    if (amount < 0n && -amount >= this.largeDebitThreshold && !input.confirmLargeDebit) {
      throw new AppError(409, "large_debit_confirmation_required", "Large negative adjustments require explicit confirmation");
    }
    return this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      await this.lockAndAssertActiveAdmin(transaction, actorUserId);
      const operation = "admin.wallet.adjust";
      const requestHash = createHash("sha256").update(JSON.stringify({ amount: input.amount, reason: input.reason, workspaceId: input.workspaceId })).digest("hex");
      let requests = await transaction<{ id: string; request_hash: string; status: string; response_body: unknown }[]>`
        insert into idempotency_requests (id, workspace_id, operation, key, request_hash, expires_at)
        values (${this.createId()}, ${input.workspaceId}, ${operation}, ${idempotencyKey}, ${requestHash}, now() + interval '7 days')
        on conflict (workspace_id, operation, key) do nothing
        returning id, request_hash, status, response_body
      `;
      if (!requests[0]) {
        requests = await transaction<{ id: string; request_hash: string; status: string; response_body: unknown }[]>`
          select id, request_hash, status, response_body from idempotency_requests
          where workspace_id = ${input.workspaceId} and operation = ${operation} and key = ${idempotencyKey}
          for update
        `;
      }
      const request = requests[0];
      if (!request || request.request_hash !== requestHash) throw new AppError(409, "idempotency_key_conflict", "Idempotency-Key was already used with a different adjustment");
      if (request.status === "completed") return adminWalletAdjustmentResponseSchema.parse(request.response_body);
      const wallets = await transaction<{ available: string; reserved: string }[]>`
        update wallet_accounts
        set available = available + ${input.amount}::bigint, version = version + 1, updated_at = now()
        where workspace_id = ${input.workspaceId} and available + ${input.amount}::bigint >= 0
        returning available::text, reserved::text
      `;
      const wallet = wallets[0];
      if (!wallet) throw new AppError(409, "wallet_adjustment_rejected", "Adjustment would make the available balance negative");
      const entryId = this.createId();
      await transaction`
        insert into wallet_entries (
          id, workspace_id, kind, amount, available_after, reserved_after,
          reference_type, reference_id, idempotency_key, actor_user_id, reason
        ) values (
          ${entryId}, ${input.workspaceId}, 'admin_adjust', ${input.amount}::bigint,
          ${wallet.available}::bigint, ${wallet.reserved}::bigint,
          'admin_adjustment', ${entryId}, ${`admin:${idempotencyKey}`}, ${actorUserId}, ${input.reason}
        )
      `;
      await transaction`
        insert into audit_logs (
          id, workspace_id, actor_user_id, actor_type, action, target_type, target_id, reason, after_summary, correlation_id
        ) values (
          ${this.createId()}, ${input.workspaceId}, ${actorUserId}, 'admin', 'wallet.adjust', 'wallet',
          ${input.workspaceId}, ${input.reason},
          ${transaction.json({ amount: input.amount, available: wallet.available, reserved: wallet.reserved })},
          ${`admin-wallet:${idempotencyKey}`}
        )
      `;
      const response = adminWalletAdjustmentResponseSchema.parse({ workspaceId: input.workspaceId, available: wallet.available, reserved: wallet.reserved });
      await transaction`
        update idempotency_requests set status = 'completed', response_status = 200,
          response_body = ${transaction.json(response)}, updated_at = now()
        where id = ${request.id}
      `;
      return response;
    });
  }

  async channels(): Promise<readonly unknown[]> {
    const rows = await this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      return transaction`
        select channel.id, channel.name, channel.type, channel.base_url, channel.capabilities,
               channel.status, channel.health_status,
               credential.version as credential_version, credential.secret_suffix,
               coalesce(capacity.policies, '[]'::jsonb) as capacity_policies
        from provider_channels channel
        left join lateral (
          select version, secret_suffix from provider_credentials
          where channel_id = channel.id order by version desc limit 1
        ) credential on true
        left join lateral (
          select jsonb_agg(jsonb_build_object(
            'capability', policy.capability,
            'version', policy.version,
            'concurrencyLimit', policy.concurrency_limit,
            'rateLimitPerMinute', policy.rate_limit_per_minute
          ) order by policy.capability) as policies
          from provider_channel_capacity_policies policy
          where policy.channel_id = channel.id
            and not exists (
              select 1 from provider_channel_capacity_policies newer
              where newer.channel_id = policy.channel_id
                and newer.capability = policy.capability
                and newer.version > policy.version
            )
        ) capacity on true
        order by channel.created_at
      `;
    });
    return rows.map((row: any) => providerChannelSchema.parse({
      id: row.id,
      name: row.name,
      type: row.type,
      baseUrl: row.base_url,
      capabilities: row.capabilities,
      status: row.status,
      healthStatus: row.health_status,
      credentialVersion: row.credential_version,
      secretSuffix: row.secret_suffix,
      capacityPolicies: Array.isArray(row.capacity_policies) ? row.capacity_policies : [],
    }));
  }

  async saveChannel(actorUserId: string, raw: unknown, idempotencyKey: string) {
    const input = providerChannelInputSchema.parse(raw);
    const baseUrl = await assertPublicBaseUrl(input.baseUrl);
    const id = input.id ?? this.createId();
    return this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      await this.lockAndAssertActiveAdmin(transaction, actorUserId);
      const request = await claimPlatformRequest(
        transaction,
        this.createId,
        actorUserId,
        input.id ? `provider.channel.update:${input.id}` : "provider.channel.create",
        idempotencyKey,
        input,
      );
      if (request.status === "completed")
        return providerChannelMutationResponseSchema.parse(request.response_body);
      await transaction`
        insert into provider_channels (id, name, type, base_url, capabilities)
        values (${id}, ${input.name}, ${input.type}, ${baseUrl.toString()}, ${transaction.json(input.capabilities)})
        on conflict (id) do update
          set name = excluded.name, type = excluded.type, base_url = excluded.base_url,
              capabilities = excluded.capabilities, updated_at = now()
      `;
      await transaction`
        insert into audit_logs (
          id, actor_user_id, actor_type, action, target_type, target_id, after_summary, correlation_id
        ) values (
          ${this.createId()}, ${actorUserId}, 'admin', ${input.id ? "provider.channel.update" : "provider.channel.create"},
          'provider_channel', ${id},
          ${transaction.json({ name: input.name, type: input.type, capabilities: input.capabilities })},
          ${`provider-channel:${id}:${this.createId()}`}
        )
      `;
      const response = providerChannelMutationResponseSchema.parse({ id });
      await completePlatformRequest(transaction, request.id, response);
      return response;
    });
  }

  async rotateCredential(actorUserId: string, channelId: string, raw: unknown, idempotencyKey: string) {
    const { secret } = providerCredentialSchema.parse(raw);
    const masterKey = Buffer.from(this.masterKeyBase64, "base64");
    const dataKey = randomBytes(32);
    const nonce = randomBytes(12);
    try {
      return await this.sql.begin(async (transaction) => {
        await setServiceContext(transaction);
        await this.lockAndAssertActiveAdmin(transaction, actorUserId);
        const request = await claimPlatformRequest(
          transaction,
          this.createId,
          actorUserId,
          `provider.credential.rotate:${channelId}`,
          idempotencyKey,
          { channelId, secret },
        );
        if (request.status === "completed")
          return providerCredentialResponseSchema.parse(request.response_body);
        const channels = await transaction<{ id: string }[]>`select id from provider_channels where id = ${channelId} for update`;
        if (!channels[0]) throw new AppError(404, "provider_channel_not_found", "Provider channel was not found");
        const versions = await transaction<{ version: number }[]>`
          select coalesce(max(version), 0) + 1 as version from provider_credentials where channel_id = ${channelId}
        `;
        const version = versions[0]?.version ?? 1;
        await transaction`update provider_credentials set status = 'rotating' where channel_id = ${channelId} and status = 'active'`;
        await transaction`
          insert into provider_credentials (
            id, channel_id, version, encrypted_secret, encrypted_data_key, nonce, key_id, secret_suffix
          ) values (
            ${this.createId()}, ${channelId}, ${version},
            ${encrypt(dataKey, nonce, Buffer.from(secret, "utf8"))},
            ${encrypt(masterKey, nonce, dataKey)}, ${nonce.toString("base64")}, 'local-master-v1', ${secret.slice(-4)}
          )
        `;
        await transaction`
          update provider_credentials set status = 'disabled', disabled_at = now()
          where channel_id = ${channelId} and version < ${version}
        `;
        await transaction`
          insert into audit_logs (
            id, actor_user_id, actor_type, action, target_type, target_id, after_summary, correlation_id
          ) values (
            ${this.createId()}, ${actorUserId}, 'admin', 'provider.credential.rotate', 'provider_channel', ${channelId},
            ${transaction.json({ version, secretSuffix: secret.slice(-4) })},
            ${`provider-credential:${channelId}:${version}`}
          )
        `;
        const response = providerCredentialResponseSchema.parse({ channelId, version, secretSuffix: secret.slice(-4) });
        await completePlatformRequest(transaction, request.id, response);
        return response;
      });
    } finally {
      dataKey.fill(0);
    }
  }

  async createModel(actorUserId: string, channelId: string, raw: unknown, idempotencyKey: string) {
    const input = modelConfigSchema.parse(raw);
    return this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      await this.lockAndAssertActiveAdmin(transaction, actorUserId);
      const request = await claimPlatformRequest(
        transaction,
        this.createId,
        actorUserId,
        `model_config.create:${channelId}`,
        idempotencyKey,
        { channelId, ...input },
      );
      if (request.status === "completed")
        return adminModelConfigResponseSchema.parse(request.response_body);
      const channels = await transaction<{ type: string; capabilities: unknown }[]>`
        select type, capabilities from provider_channels where id = ${channelId} for update
      `;
      const channel = channels[0];
      const capabilities = Array.isArray(channel?.capabilities) ? channel.capabilities : [];
      if (!channel) throw new AppError(404, "provider_channel_not_found", "Provider channel was not found");
      if (channel.type !== input.adapterType || !capabilities.includes(input.capability)) {
        throw new AppError(422, "provider_channel_incompatible", "Model adapter and capability must match the provider channel");
      }
      const versions = await transaction<{ version: number }[]>`
        select coalesce(max(config_version), 0) + 1 as version
        from model_configs where channel_id = ${channelId} and model = ${input.model} and capability = ${input.capability}
      `;
      const configVersion = versions[0]?.version ?? 1;
      await transaction`select pg_advisory_xact_lock(hashtextextended(${`capacity-policy:${channelId}:${input.capability}`}, 0))`;
      const currentCapacity = await transaction<{
        version: number; concurrency_limit: number; rate_limit_per_minute: number;
      }[]>`
        select version, concurrency_limit, rate_limit_per_minute
        from provider_channel_capacity_policies
        where channel_id = ${channelId} and capability = ${input.capability}
        order by version desc limit 1
      `;
      const previousCapacity = currentCapacity[0];
      const capacityChanged = !previousCapacity ||
        previousCapacity.concurrency_limit !== input.concurrencyLimit ||
        previousCapacity.rate_limit_per_minute !== input.rateLimitPerMinute;
      const capacityVersion = capacityChanged ? (previousCapacity?.version ?? 0) + 1 : previousCapacity.version;
      if (capacityChanged) {
        await transaction`
          insert into provider_channel_capacity_policies (
            channel_id, capability, version, concurrency_limit, rate_limit_per_minute
          ) values (
            ${channelId}, ${input.capability}, ${capacityVersion}, ${input.concurrencyLimit}, ${input.rateLimitPerMinute}
          )
        `;
      }
      const modelConfigId = this.createId();
      await transaction`
        insert into model_configs (
          id, channel_id, model, capability, adapter_type, adapter_version,
          config_version, limits_json, concurrency_limit, provider_idempotency_supported
        ) values (
          ${modelConfigId}, ${channelId}, ${input.model}, ${input.capability}, ${input.adapterType},
          ${input.adapterVersion}, ${configVersion}, ${jsonParameter(transaction, input.limits)}, ${input.concurrencyLimit},
          ${input.providerIdempotencySupported}
        )
      `;
      await transaction`
        insert into model_prices (id, model_config_id, version, conditions_json, credit_amount, effective_at)
        values (${this.createId()}, ${modelConfigId}, 1, '{}'::jsonb, ${input.creditAmount}::bigint, now())
      `;
      await transaction`
        insert into audit_logs (
          id, actor_user_id, actor_type, action, target_type, target_id, after_summary, correlation_id
        ) values (
          ${this.createId()}, ${actorUserId}, 'admin', 'model_config.create', 'model_config', ${modelConfigId},
          ${transaction.json({
            channelId, model: input.model, capability: input.capability, adapterType: input.adapterType,
            adapterVersion: input.adapterVersion, configVersion, concurrencyLimit: input.concurrencyLimit,
            rateLimitPerMinute: input.rateLimitPerMinute, capacityVersion,
            providerIdempotencySupported: input.providerIdempotencySupported, creditAmount: input.creditAmount,
          })},
          ${`model-config:${modelConfigId}`}
        )
      `;
      const response = adminModelConfigResponseSchema.parse({ modelConfigId, configVersion });
      await completePlatformRequest(transaction, request.id, response);
      return response;
    });
  }

  async resolveUnknown(actorUserId: string, attemptId: string, raw: unknown, idempotencyKey: string) {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)) throw new AppError(400, "invalid_idempotency_key", "A valid Idempotency-Key is required");
    const input = unknownResolutionSchema.parse(raw);
    if (
      !this.generationWritesEnabled &&
      (input.resolution === "accepted" || input.resolution === "provider_succeeded")
    ) {
      throw new AppError(
        503,
        "generation_writes_paused",
        "Recovery dispatch is paused for a controlled worker handoff",
      );
    }
    let mediaUrl: string | undefined;
    if (input.resolution === "provider_succeeded") {
      try {
        mediaUrl = validateRemoteMediaUrl(input.mediaUrl).toString();
      } catch {
        throw new AppError(422, "provider_url_rejected", "Media URL must be a public HTTP(S) address");
      }
    }
    return this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      await this.lockAndAssertActiveAdmin(transaction, actorUserId);
      const rows = await transaction<{
        workspace_id: string; project_id: string; batch_id: string; job_id: string; attempt_no: number;
        capability: string; channel_id: string; status: string; version: number;
        capacity_policy_version: number; workspace_concurrency_limit: number;
        workspace_rate_limit_per_minute: number; channel_concurrency_limit: number;
        channel_rate_limit_per_minute: number;
      }[]>`
        select attempt.workspace_id, batch.project_id, job.batch_id, job.id as job_id, attempt.attempt_no,
               job.capability, attempt.channel_id, attempt.status, job.version,
               attempt.capacity_policy_version, attempt.workspace_concurrency_limit,
               attempt.workspace_rate_limit_per_minute, attempt.channel_concurrency_limit,
               attempt.channel_rate_limit_per_minute
        from generation_attempts attempt
        join generation_jobs job on job.workspace_id = attempt.workspace_id and job.id = attempt.job_id
        join generation_batches batch on batch.workspace_id = job.workspace_id and batch.id = job.batch_id
        where attempt.id = ${attemptId} and job.current_attempt_id = attempt.id
        for update of attempt, job
      `;
      const current = rows[0];
      if (!current) throw new AppError(404, "generation_attempt_not_found", "Generation attempt was not found");
      const operation = `unknown.resolve:${attemptId}`;
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      let requests = await transaction<{ id: string; request_hash: string; status: string; response_body: unknown }[]>`
        insert into idempotency_requests (id, workspace_id, operation, key, request_hash, expires_at)
        values (${this.createId()}, ${current.workspace_id}, ${operation}, ${idempotencyKey}, ${hash}, now() + interval '7 days')
        on conflict (workspace_id, operation, key) do nothing
        returning id, request_hash, status, response_body
      `;
      if (!requests[0]) {
        requests = await transaction<{ id: string; request_hash: string; status: string; response_body: unknown }[]>`
          select id, request_hash, status, response_body from idempotency_requests
          where workspace_id = ${current.workspace_id} and operation = ${operation} and key = ${idempotencyKey} for update
        `;
      }
      const request = requests[0];
      if (!request || request.request_hash !== hash) throw new AppError(409, "idempotency_key_conflict", "Idempotency-Key was used for another resolution");
      if (request.status === "completed") return unknownResolutionResponseSchema.parse(request.response_body);
      if (current.status !== "outcome_unknown") throw new AppError(409, "generation_attempt_not_unknown", "Only an outcome_unknown attempt can be resolved");

      let status: "failed" | "waiting_provider" | "materializing";
      if (input.resolution === "not_accepted" || input.resolution === "provider_failed") {
        await transaction`select app.release_reservation(${attemptId}, ${this.createId()}, ${`manual_${input.resolution}`})`;
        await transaction`
          update generation_attempts set status = 'failed', completed_at = now(), error_code = ${`manual_${input.resolution}`},
            error_message = ${input.reason}, evidence_json = ${jsonParameter(transaction, input.evidence)}, updated_at = now()
          where id = ${attemptId}
        `;
        status = "failed";
      } else {
        const attemptStatus = input.resolution === "accepted" ? "accepted" : "materializing";
        const dispatchToken = this.createId();
        await transaction`
          update generation_attempts set status = ${attemptStatus}::attempt_status,
            provider_task_id = ${input.resolution === "accepted" ? input.providerTaskId : null},
            evidence_json = ${transaction.json({ ...input.evidence, ...(mediaUrl ? { mediaUrls: [mediaUrl] } : {}) })},
            business_deadline_at = case
              when ${input.resolution === "accepted"} then greatest(business_deadline_at, now() + interval '30 minutes')
              else business_deadline_at
            end,
            executor_dispatch_token = ${dispatchToken}::uuid,
            executor_claim_id = null, executor_run_id = null, error_code = null, error_message = null,
            reconcile_after = null, release_after = null, updated_at = now()
          where id = ${attemptId}
        `;
        await transaction`
          update outbox_events
          set status = 'sent', sent_at = coalesce(sent_at, now()),
              last_error = 'superseded by an administrator reconciliation dispatch generation',
              locked_by = null, locked_at = null, updated_at = now()
          where workspace_id = ${current.workspace_id} and aggregate_id = ${current.job_id}
            and topic = 'generation.job.requested' and status in ('pending', 'sending')
            and payload->>'attemptId' = ${attemptId}
            and dispatch_started_token is not null
            and dispatch_started_token <> ${dispatchToken}::uuid
        `;
        status = input.resolution === "accepted" ? "waiting_provider" : "materializing";
        await transaction`
          insert into outbox_events (id, workspace_id, topic, aggregate_id, dedupe_key, payload)
          values (
            ${this.createId()}, ${current.workspace_id}, 'generation.job.requested', ${current.job_id},
            ${`generation.job.reconciled:${attemptId}:${idempotencyKey}`},
            ${transaction.json({
              schemaVersion: 2, workflowName: "media-generation-v2", workspaceId: current.workspace_id,
              projectId: current.project_id, batchId: current.batch_id, jobId: current.job_id,
              attemptId, capability: current.capability, channelId: current.channel_id,
              capacity: {
                policyVersion: current.capacity_policy_version,
                workspaceConcurrencyLimit: current.workspace_concurrency_limit,
                workspaceRateLimitPerMinute: current.workspace_rate_limit_per_minute,
                channelConcurrencyLimit: current.channel_concurrency_limit,
                channelRateLimitPerMinute: current.channel_rate_limit_per_minute,
              },
            })}
          )
        `;
      }
      const jobs = await transaction<{ version: number }[]>`
        update generation_jobs set status = ${status}::job_status, version = version + 1,
          terminal_at = case when ${status}::job_status = 'failed' then now() else null end, updated_at = now()
        where id = ${current.job_id} and current_attempt_id = ${attemptId}
        returning version
      `;
      const job = jobs[0];
      if (!job) throw new AppError(409, "generation_attempt_changed", "Generation attempt changed during resolution");
      await transaction`
        insert into audit_logs (id, workspace_id, actor_user_id, actor_type, action, target_type, target_id, reason, after_summary, correlation_id)
        values (${this.createId()}, ${current.workspace_id}, ${actorUserId}, 'admin', 'outcome_unknown.resolve', 'attempt', ${attemptId},
                ${input.reason}, ${jsonParameter(transaction, { resolution: input.resolution, evidence: input.evidence })}, ${`unknown-resolve:${attemptId}:${idempotencyKey}`})
      `;
      await transaction`
        insert into generation_job_events (workspace_id, aggregate_type, aggregate_id, project_id, batch_id, job_id, attempt_id, type, payload)
        values (${current.workspace_id}, 'job', ${current.job_id}, ${current.project_id}, ${current.batch_id}, ${current.job_id}, ${attemptId},
                'generation.job.state_changed', ${transaction.json({ status, attemptNo: current.attempt_no, jobVersion: job.version })})
      `;
      await transaction`select app.refresh_generation_batch(${current.batch_id})`;
      const response = unknownResolutionResponseSchema.parse({ attemptId, status });
      await transaction`update idempotency_requests set status = 'completed', response_status = 200, response_body = ${transaction.json(response)}, updated_at = now() where id = ${request.id}`;
      return response;
    });
  }

  async jobs(): Promise<readonly unknown[]> {
    return (await this.jobsPage({ limit: 500 })).items;
  }

  async jobsPage(query: { cursor?: string | undefined; limit: number }) {
    const cursor = decodeAdminCursor("jobs", query.cursor);
    const rows = await this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      return transaction`
        select job.id, job.workspace_id, job.batch_id, job.capability, job.status, job.version,
               attempt.id as attempt_id, attempt.attempt_no, attempt.channel_id, attempt.provider_task_id,
               attempt.error_code, attempt.error_message, attempt.evidence_json, attempt.business_deadline_at,
               attempt.outcome_unknown_at, attempt.reconcile_after, attempt.release_after,
               reservation.status as reservation_status, reservation.amount::text as reserved_credits,
               coalesce((
                 select jsonb_agg(jsonb_build_object(
                   'status', event.status,
                   'dedupeKey', event.dedupe_key,
                   'lastError', event.last_error,
                   'updatedAt', event.updated_at
                 ) order by event.created_at desc)
                 from outbox_events event
                 where event.workspace_id = job.workspace_id and event.aggregate_id = job.id
                   and event.payload->>'attemptId' = attempt.id::text
               ), '[]'::jsonb) as outbox_events,
               coalesce((
                 select jsonb_agg(entry.kind order by entry.created_at)
                 from wallet_entries entry
                 where entry.workspace_id = job.workspace_id and entry.reference_type = 'attempt'
                   and entry.reference_id = attempt.id
               ), '[]'::jsonb) as ledger_kinds,
               job.created_at, job.updated_at
        from generation_jobs job
        join generation_attempts attempt on attempt.id = job.current_attempt_id
        left join credit_reservations reservation on reservation.attempt_id = attempt.id
        where (${cursor?.createdAt ?? null}::timestamptz is null or
               (job.created_at, job.id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        order by job.created_at desc, job.id desc limit ${query.limit + 1}
      `;
    });
    const pageRows = rows.slice(0, query.limit) as any[];
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(adminJobProjection),
      nextCursor: rows.length > query.limit && last
        ? encodeAdminCursor("jobs", { createdAt: last.created_at.toISOString(), id: last.id })
        : null,
    };
  }

  async audit(): Promise<readonly unknown[]> {
    return (await this.auditPage({ limit: 500 })).items;
  }

  async auditPage(query: { cursor?: string | undefined; limit: number }) {
    const cursor = decodeAdminCursor("audit", query.cursor);
    const rows = await this.sql.begin(async (transaction) => {
      await setServiceContext(transaction);
      return transaction`
        select * from audit_logs
        where (${cursor?.createdAt ?? null}::timestamptz is null or
               (created_at, id) < (${cursor?.createdAt ?? null}::timestamptz, ${cursor?.id ?? null}::uuid))
        order by created_at desc, id desc limit ${query.limit + 1}
      `;
    });
    const pageRows = rows.slice(0, query.limit) as any[];
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(adminAuditProjection),
      nextCursor: rows.length > query.limit && last
        ? encodeAdminCursor("audit", { createdAt: last.created_at.toISOString(), id: last.id })
        : null,
    };
  }
}
