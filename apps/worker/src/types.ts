import type { GenerationCapability, GenerationWorkflowInput } from "@infinite-canvas/contracts";
import type { FrozenGenerationInput, MediaProviderAdapter, ProviderContext } from "@infinite-canvas/provider-adapters";

export interface AttemptExecution {
  input: GenerationWorkflowInput;
  status: string;
  providerTaskId: string | null;
  providerIdempotencySupported: boolean;
  businessDeadlineAt: Date;
  evidence: Record<string, unknown> | null;
  generation: FrozenGenerationInput;
  provider: ProviderContext;
  adapter: MediaProviderAdapter;
}

export interface MaterializedAsset {
  objectKey: string;
  mime: string;
  bytes: bigint;
  sha256: string;
  kind: GenerationCapability;
}

export interface ExecutionContext {
  workflowRunId: string;
  dispatchToken: string;
  signal: AbortSignal;
}
