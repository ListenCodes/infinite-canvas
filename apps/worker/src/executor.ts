import type {
  GenerationWorkflowInput,
  ProviderSubmitResult,
} from "@infinite-canvas/contracts";
import { ProviderRequestNotSubmittedError } from "@infinite-canvas/provider-adapters";

import type { GenerationRepository } from "./repository.js";
import type { ObjectStorage } from "./storage.js";
import type {
  AttemptExecution,
  ExecutionContext,
  MaterializedAsset,
} from "./types.js";

export class RetryableExecutionError extends Error {}
export class NonRetryableExecutionError extends Error {}

export interface ExecutionResult {
  [key: string]: string | number | undefined;
  outcome:
    | "duplicate"
    | "terminal"
    | "succeeded"
    | "failed"
    | "outcome_unknown"
    | "pending";
  assetId?: string;
  nextPollDelayMs?: number;
}

type ExecutionRepository = Pick<
  GenerationRepository,
  | "claim"
  | "load"
  | "markSubmitting"
  | "resetForRetry"
  | "markAccepted"
  | "markMaterializing"
  | "markMaterialized"
  | "markUnknown"
  | "fail"
  | "isCancelRequested"
  | "confirmCanceled"
  | "complete"
  | "convergeFailure"
>;

type AssetStorage = Pick<ObjectStorage, "materialize" | "recoverMaterialized">;

function evidenceMediaUrl(execution: AttemptExecution): URL | undefined {
  const values = execution.evidence?.mediaUrls;
  return Array.isArray(values) && typeof values[0] === "string"
    ? new URL(values[0])
    : undefined;
}

function evidenceMaterializedAsset(
  execution: AttemptExecution,
): MaterializedAsset | undefined {
  const value = execution.evidence?.materializedAsset;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record.objectKey !== "string" ||
    typeof record.mime !== "string" ||
    typeof record.bytes !== "string" ||
    typeof record.sha256 !== "string"
  )
    return undefined;
  if (record.kind !== "image" && record.kind !== "video") return undefined;
  return {
    objectKey: record.objectKey,
    mime: record.mime,
    bytes: BigInt(record.bytes),
    sha256: record.sha256,
    kind: record.kind,
  };
}

export class GenerationExecutor {
  constructor(
    private readonly repository: ExecutionRepository,
    private readonly storage: AssetStorage,
  ) {}

  async convergeFailure(
    input: GenerationWorkflowInput,
    message: string,
    executorClaimId: string,
    dispatchToken: string,
  ): Promise<void> {
    await this.repository.convergeFailure(input, message, executorClaimId, dispatchToken);
  }

  async execute(
    input: GenerationWorkflowInput,
    context: ExecutionContext,
  ): Promise<ExecutionResult> {
    const executorClaimId = context.workflowRunId;
    const claim = await this.repository.claim(input, executorClaimId, context.dispatchToken);
    if (claim === "duplicate") return { outcome: "duplicate" };
    if (claim === "terminal") return { outcome: "terminal" };

    let execution: AttemptExecution;
    try {
      execution = await this.repository.load(
        input,
        context.signal,
        executorClaimId,
      );
      execution.adapter.validate(execution.generation);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Generation input could not be loaded or validated";
      await this.repository.fail(
        input,
        "worker_validation_failed",
        message,
        executorClaimId,
      );
      return { outcome: "failed" };
    }

    if (["succeeded", "failed", "canceled"].includes(execution.status))
      return { outcome: "terminal" };
    if (execution.status === "outcome_unknown")
      return { outcome: "outcome_unknown" };
    const identity = {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      attemptId: input.attemptId,
      capability: input.capability,
    };
    let materializedAsset = evidenceMaterializedAsset(execution);
    let shouldSubmit = false;
    if (execution.status === "submitting") {
      materializedAsset ??= await this.storage.recoverMaterialized(identity);
      if (materializedAsset) {
        await this.repository.markMaterialized(
          input,
          materializedAsset,
          executorClaimId,
        );
        const assetId = await this.repository.complete(
          input,
          materializedAsset,
          executorClaimId,
        );
        return { outcome: "succeeded", assetId };
      }
      if (!execution.providerIdempotencySupported) {
        await this.repository.markUnknown(
          input,
          "Worker resumed after submission began without a confirmed provider response",
          executorClaimId,
        );
        return { outcome: "outcome_unknown" };
      }
      shouldSubmit = true;
    }

    let mediaUrl = evidenceMediaUrl(execution);
    if (execution.status === "materializing" && !materializedAsset) {
      materializedAsset = await this.storage.recoverMaterialized(identity);
    }
    if (materializedAsset) {
      await this.repository.markMaterialized(
        input,
        materializedAsset,
        executorClaimId,
      );
      const assetId = await this.repository.complete(
        input,
        materializedAsset,
        executorClaimId,
      );
      return { outcome: "succeeded", assetId };
    }
    if (!mediaUrl && execution.status === "claimed") {
      if (execution.businessDeadlineAt.getTime() <= Date.now()) {
        await this.repository.fail(
          input,
          "business_deadline_exceeded",
          "Generation deadline expired before provider submission",
          executorClaimId,
        );
        return { outcome: "failed" };
      }
      if (await this.repository.isCancelRequested(input, executorClaimId)) {
        await this.repository.confirmCanceled(input, executorClaimId);
        return { outcome: "terminal" };
      }
      if (!(await this.repository.markSubmitting(input, executorClaimId)))
        return { outcome: "terminal" };
      if (await this.repository.isCancelRequested(input, executorClaimId)) {
        await this.repository.confirmCanceled(input, executorClaimId);
        return { outcome: "terminal" };
      }
      shouldSubmit = true;
    }
    if (shouldSubmit) {
      const result = await this.submit(execution);
      if (result.outcome === "rejected") {
        if (result.retryable && result.acceptance === "not_accepted") {
          await this.repository.resetForRetry(
            input,
            result.errorCode,
            result.message,
            executorClaimId,
          );
          throw new RetryableExecutionError(result.message);
        }
        await this.repository.fail(
          input,
          result.errorCode,
          result.message,
          executorClaimId,
        );
        return { outcome: "failed" };
      }
      if (result.outcome === "outcome_unknown") {
        await this.repository.markUnknown(
          input,
          result.message,
          executorClaimId,
        );
        return { outcome: "outcome_unknown" };
      }
      if (result.outcome === "accepted") {
        await this.repository.markAccepted(
          input,
          result.providerTaskId,
          executorClaimId,
        );
        execution = await this.repository.load(
          input,
          context.signal,
          executorClaimId,
        );
      } else {
        mediaUrl = result.mediaUrls[0]
          ? new URL(result.mediaUrls[0])
          : undefined;
      }
    }

    if (
      !mediaUrl &&
      (execution.status === "accepted" || execution.providerTaskId)
    ) {
      if (execution.businessDeadlineAt.getTime() <= Date.now()) {
        await this.repository.markUnknown(
          input,
          "Generation deadline expired while the provider task was still pending",
          executorClaimId,
        );
        return { outcome: "outcome_unknown" };
      }
      if (!execution.providerTaskId || !execution.adapter.poll) {
        await this.repository.markUnknown(
          input,
          "Provider task cannot be resumed by this adapter",
          executorClaimId,
        );
        throw new NonRetryableExecutionError("Provider task cannot be resumed");
      }
      for (;;) {
        if (
          (await this.repository.isCancelRequested(input, executorClaimId)) &&
          execution.adapter.cancel
        ) {
          const cancellation = await execution.adapter.cancel(
            execution.providerTaskId,
            execution.provider,
          );
          if (cancellation === "canceled") {
            await this.repository.confirmCanceled(input, executorClaimId);
            return { outcome: "terminal" };
          }
        }
        const state = await execution.adapter.poll(
          execution.providerTaskId,
          execution.provider,
        );
        if (state.status === "pending") {
          return { outcome: "pending", nextPollDelayMs: state.nextPollDelayMs };
        }
        if (state.status === "failed") {
          await this.repository.fail(
            input,
            state.errorCode,
            state.message,
            executorClaimId,
          );
          return { outcome: "failed" };
        }
        if (state.status === "canceled") {
          await this.repository.confirmCanceled(input, executorClaimId);
          return { outcome: "terminal" };
        }
        mediaUrl = state.mediaUrls[0];
        break;
      }
    }

    if (!mediaUrl) mediaUrl = evidenceMediaUrl(execution);
    if (!mediaUrl) {
      await this.repository.fail(
        input,
        "provider_empty_result",
        "Provider returned no media URL",
        executorClaimId,
      );
      return { outcome: "failed" };
    }
    if (mediaUrl.protocol !== "data:")
      await this.repository.markMaterializing(input, mediaUrl, executorClaimId);
    const asset = await this.storage.materialize(
      mediaUrl,
      identity,
      execution.provider,
    );
    await this.repository.markMaterialized(input, asset, executorClaimId);
    const assetId = await this.repository.complete(
      input,
      asset,
      executorClaimId,
    );
    return { outcome: "succeeded", assetId };
  }

  private async submit(
    execution: AttemptExecution,
  ): Promise<ProviderSubmitResult> {
    try {
      return await execution.adapter.submit(
        execution.generation,
        execution.provider,
      );
    } catch (error) {
      if (error instanceof ProviderRequestNotSubmittedError) {
        return {
          outcome: "rejected",
          errorCode: error.errorCode,
          message: error.message,
          retryable: error.retryable,
          acceptance: "not_accepted",
        };
      }
      const message =
        error instanceof Error
          ? error.message
          : "Provider submission failed without a response";
      return { outcome: "outcome_unknown", message };
    }
  }
}
