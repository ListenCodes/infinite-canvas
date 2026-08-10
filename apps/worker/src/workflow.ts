import { NonRetryableError, type DurableContext, type HatchetClient, type JsonValue } from "@hatchet-dev/typescript-sdk/v1/index.js";
import { generationWorkflowInputSchema, localDataImportWorkflowInputSchema } from "@infinite-canvas/contracts";
import { z } from "zod";

import { GenerationExecutor, NonRetryableExecutionError, type ExecutionResult } from "./executor.js";
import { ImportExecutor, InvalidImportError } from "./import-executor.js";

export const MEDIA_GENERATION_WORKFLOW_V1 = "media-generation-v1";
export const MEDIA_GENERATION_TASK_V1 = "orchestrate-media-generation-v1";
export const MEDIA_GENERATION_STEP_TASK_V1 = "execute-media-generation-step-v1";
export const MEDIA_GENERATION_WORKER_V1 = "media-generation-worker-v1";
export const MEDIA_GENERATION_FAILURE_TASK_V1 = "converge-media-generation-failure-v1";
export const LOCAL_DATA_IMPORT_WORKFLOW_V1 = "local-data-import-v1";
export const LOCAL_DATA_IMPORT_TASK_V1 = "execute-local-data-import-v1";

export const dispatchedGenerationWorkflowInputSchema = generationWorkflowInputSchema.extend({ dispatchToken: z.uuid() });
export type DispatchedGenerationWorkflowInput = z.infer<typeof dispatchedGenerationWorkflowInputSchema>;
const generationStepInputSchema = dispatchedGenerationWorkflowInputSchema.extend({ executorClaimId: z.string().min(1) });
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

export function createMediaGenerationWorkflow(hatchet: HatchetClient, executor: GenerationExecutor) {
  const executionTask = hatchet.task<GenerationStepInput, ExecutionResult>({
    name: MEDIA_GENERATION_STEP_TASK_V1,
    version: "1",
    inputValidator: generationStepInputSchema,
    retries: 3,
    backoff: { factor: 2, maxSeconds: 60 },
    executionTimeout: "5m",
    scheduleTimeout: "24h",
    fn: async (rawInput, context) => {
      const stepInput = generationStepInputSchema.parse(rawInput);
      try {
        return await executor.execute(generationWorkflowInputSchema.parse(stepInput), {
          workflowRunId: stepInput.executorClaimId,
          dispatchToken: stepInput.dispatchToken,
          signal: context.abortController.signal,
        });
      } catch (error) {
        if (error instanceof NonRetryableExecutionError) throw new NonRetryableError(error.message);
        throw error;
      }
    },
  });
  const workflow = hatchet.workflow<DispatchedGenerationWorkflowInput>({
    name: MEDIA_GENERATION_WORKFLOW_V1,
    version: "1",
    inputValidator: dispatchedGenerationWorkflowInputSchema,
    idempotency: {
      strategy: "status",
      expression: "input.dispatchToken",
      fallbackTtlMs: 48 * 60 * 60 * 1000,
    },
  });
  workflow.durableTask({
    name: MEDIA_GENERATION_TASK_V1,
    retries: 3,
    backoff: { factor: 2, maxSeconds: 60 },
    executionTimeout: "45m",
    scheduleTimeout: "24h",
    fn: async (rawInput: DispatchedGenerationWorkflowInput, context: DurableContext<DispatchedGenerationWorkflowInput>) => {
      const input = dispatchedGenerationWorkflowInputSchema.parse(rawInput);
      let pollNumber = 0;
      for (;;) {
        const result = await context.spawnChild(executionTask, {
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
    name: MEDIA_GENERATION_FAILURE_TASK_V1,
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
  return { workflow, executionTask };
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
