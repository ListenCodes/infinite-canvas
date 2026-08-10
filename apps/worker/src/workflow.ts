import { ConcurrencyLimitStrategy, NonRetryableError, type DurableContext, type HatchetClient, type JsonValue } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { generationWorkflowInputSchema, localDataImportWorkflowInputSchema } from "@infinite-canvas/contracts";
import { z } from "zod";

import { GenerationExecutor, NonRetryableExecutionError, type ExecutionResult } from "./executor.js";
import { ImportExecutor, InvalidImportError } from "./import-executor.js";
import type { GenerationRepository } from "./repository.js";

export const MEDIA_GENERATION_WORKFLOW_V2 = "media-generation-v2";
export const MEDIA_GENERATION_TASK_V2 = "orchestrate-media-generation-v2";
export const MEDIA_GENERATION_IMAGE_STEP_TASK_V2 = "execute-image-generation-step-v2";
export const MEDIA_GENERATION_VIDEO_STEP_TASK_V2 = "execute-video-generation-step-v2";
export const MEDIA_GENERATION_WORKER_V2 = "media-generation-worker-v2";
export const MEDIA_GENERATION_FAILURE_TASK_V2 = "converge-media-generation-failure-v2";
export const LOCAL_DATA_IMPORT_WORKFLOW_V1 = "local-data-import-v1";
export const LOCAL_DATA_IMPORT_TASK_V1 = "execute-local-data-import-v1";

export const dispatchedGenerationWorkflowInputSchema = generationWorkflowInputSchema.safeExtend({ dispatchToken: z.uuid() });
export type DispatchedGenerationWorkflowInput = z.infer<typeof dispatchedGenerationWorkflowInputSchema>;
const generationStepInputSchema = dispatchedGenerationWorkflowInputSchema.safeExtend({ executorClaimId: z.string().min(1) });
interface GenerationStepInput extends DispatchedGenerationWorkflowInput {
  [key: string]: JsonValue;
  executorClaimId: string;
}

function durablePollDelay(attemptId: string, pollNumber: number, providerDelayMs: number): number {
  const base = pollNumber <= 1 ? 3_000 : pollNumber <= 5 ? 10_000 : 30_000;
  const seed = [...`${attemptId}:${pollNumber}`].reduce((value, character) => (value * 33 + character.charCodeAt(0)) >>> 0, 5381);
  const jitter = 0.9 + (seed % 201) / 1000;
  return Math.max(providerDelayMs, Math.round(base * jitter));
}

type CapacityCoordinator = Pick<
  GenerationRepository,
  "acquireChannelCapacity" | "consumeProviderRateCapacity" | "releaseChannelCapacity"
>;

export function createMediaGenerationWorkflow(
  hatchet: HatchetClient,
  executor: GenerationExecutor,
  capacity: CapacityCoordinator,
) {
  const executionTask = (capability: "image" | "video") => hatchet.task<GenerationStepInput, ExecutionResult>({
    name: capability === "image" ? MEDIA_GENERATION_IMAGE_STEP_TASK_V2 : MEDIA_GENERATION_VIDEO_STEP_TASK_V2,
    version: "1",
    inputValidator: generationStepInputSchema,
    concurrency: {
      expression: `'workspace:' + input.workspaceId + ':${capability}'`,
      maxRuns: capability === "image" ? 3 : 2,
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    },
    slotCost: capability === "image" ? 1 : 2,
    retries: 3,
    backoff: { factor: 2, maxSeconds: 60 },
    executionTimeout: "5m",
    scheduleTimeout: "24h",
    fn: async (rawInput, context) => {
      const stepInput = generationStepInputSchema.parse(rawInput);
      if (stepInput.capability !== capability) throw new NonRetryableError("Generation task capability does not match its workflow input");
      try {
        const result = await executor.execute(generationWorkflowInputSchema.parse(stepInput), {
          workflowRunId: stepInput.executorClaimId,
          dispatchToken: stepInput.dispatchToken,
          signal: context.abortController.signal,
        }, {
          acquireLease: () => capacity.acquireChannelCapacity(
            stepInput,
            stepInput.dispatchToken,
            stepInput.executorClaimId,
          ),
          consumeProviderRequest: () => capacity.consumeProviderRateCapacity(
            stepInput,
            stepInput.dispatchToken,
            stepInput.executorClaimId,
          ),
        });
        if (["terminal", "succeeded", "failed"].includes(result.outcome)) {
          await capacity.releaseChannelCapacity(stepInput, stepInput.dispatchToken);
        }
        return result;
      } catch (error) {
        if (error instanceof NonRetryableExecutionError) throw new NonRetryableError(error.message);
        throw error;
      }
    },
  });
  const imageExecutionTask = executionTask("image");
  const videoExecutionTask = executionTask("video");
  const workflow = hatchet.workflow<DispatchedGenerationWorkflowInput>({
    name: MEDIA_GENERATION_WORKFLOW_V2,
    version: "2",
    inputValidator: dispatchedGenerationWorkflowInputSchema,
    idempotency: {
      strategy: "status",
      expression: "input.dispatchToken",
      fallbackTtlMs: 48 * 60 * 60 * 1000,
    },
  });
  workflow.durableTask({
    name: MEDIA_GENERATION_TASK_V2,
    retries: 3,
    backoff: { factor: 2, maxSeconds: 60 },
    executionTimeout: "45m",
    scheduleTimeout: "24h",
    fn: async (rawInput: DispatchedGenerationWorkflowInput, context: DurableContext<DispatchedGenerationWorkflowInput>) => {
      const input = dispatchedGenerationWorkflowInputSchema.parse(rawInput);
      let pollNumber = 0;
      for (;;) {
        const childTask = input.capability === "image" ? imageExecutionTask : videoExecutionTask;
        const result = await context.spawnChild(childTask, {
          ...input,
          executorClaimId: context.workflowRunId(),
        }, {
          key: `${input.attemptId}:step:${pollNumber}`,
        });
        if (result.outcome !== "pending") return result;
        pollNumber += 1;
        await context.sleepFor(durablePollDelay(input.attemptId, pollNumber, result.nextPollDelayMs ?? 0));
      }
    },
  });
  workflow.onFailure({
    name: MEDIA_GENERATION_FAILURE_TASK_V2,
    retries: 5,
    fn: async (rawInput, context) => {
      const dispatchedInput = dispatchedGenerationWorkflowInputSchema.parse(rawInput);
      const input = generationWorkflowInputSchema.parse(dispatchedInput);
      const errors = context.errors();
      const message = Object.values(errors).join("; ") || "Media generation workflow failed";
      await executor.convergeFailure(input, message, context.workflowRunId(), dispatchedInput.dispatchToken);
      return { converged: true };
    },
  });
  return { workflow, executionTasks: [imageExecutionTask, videoExecutionTask] };
}

export function createLocalDataImportWorkflow(hatchet: HatchetClient, executor: ImportExecutor) {
  return hatchet.task({
    name: LOCAL_DATA_IMPORT_WORKFLOW_V1,
    version: "1",
    inputValidator: localDataImportWorkflowInputSchema,
    idempotency: { strategy: "status", expression: "input.importId", fallbackTtlMs: 48 * 60 * 60 * 1000 },
    retries: 3,
    executionTimeout: "30m",
    scheduleTimeout: "24h",
    fn: async (rawInput) => {
      try {
        return await executor.execute(localDataImportWorkflowInputSchema.parse(rawInput));
      } catch (error) {
        if (error instanceof InvalidImportError) throw new NonRetryableError(error.message);
        throw error;
      }
    },
  });
}
