import type {
  AssetId,
  ChannelId,
  GenerationCapability,
  ProviderSubmitResult,
} from "@infinite-canvas/contracts";
import type { AddressResolver } from "@infinite-canvas/domain";

export interface FrozenGenerationInput {
  prompt: string;
  model: string;
  capability: GenerationCapability;
  parameters: Readonly<Record<string, string | number | boolean | null>>;
  referenceAssetIds: readonly AssetId[];
  referenceAssets: readonly {
    assetId: AssetId;
    url: URL;
    mime: string;
  }[];
}

export interface ProviderContext {
  channelId: ChannelId;
  baseUrl: URL;
  credential: string;
  signal: AbortSignal;
  idempotencyKey?: string;
  trustedMediaOrigins?: readonly string[];
  addressResolver?: AddressResolver;
  observeRequest?: (observation: {
    code: string;
    durationSeconds: number;
  }) => void;
}

export class ProviderRequestNotSubmittedError extends Error {
  readonly name = "ProviderRequestNotSubmittedError";

  constructor(
    readonly errorCode: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface ProviderStatePending {
  status: "pending";
  nextPollDelayMs: number;
}

export interface ProviderStateSucceeded {
  status: "succeeded";
  mediaUrls: readonly URL[];
}

export interface ProviderStateFailed {
  status: "failed";
  errorCode: string;
  message: string;
}

export interface ProviderStateCanceled {
  status: "canceled";
}

export type ProviderState =
  | ProviderStatePending
  | ProviderStateSucceeded
  | ProviderStateFailed
  | ProviderStateCanceled;

export interface MediaProviderAdapter {
  readonly type: string;
  readonly version: number;
  readonly capability: GenerationCapability;
  validate(input: FrozenGenerationInput): void;
  submit(
    input: FrozenGenerationInput,
    context: ProviderContext,
  ): Promise<ProviderSubmitResult>;
  poll?(
    providerTaskId: string,
    context: ProviderContext,
  ): Promise<ProviderState>;
  cancel?(
    providerTaskId: string,
    context: ProviderContext,
  ): Promise<"canceled" | "not_supported" | "unknown">;
}

export class AdapterRegistry {
  readonly #adapters = new Map<string, MediaProviderAdapter>();

  register(adapter: MediaProviderAdapter): void {
    const key = `${adapter.type}:v${adapter.version}:${adapter.capability}`;
    if (this.#adapters.has(key))
      throw new Error(`Adapter already registered: ${key}`);
    this.#adapters.set(key, adapter);
  }

  get(
    type: string,
    version: number,
    capability: GenerationCapability,
  ): MediaProviderAdapter {
    const key = `${type}:v${version}:${capability}`;
    const adapter = this.#adapters.get(key);
    if (!adapter) throw new Error(`Adapter is not registered: ${key}`);
    return adapter;
  }
}

export * from "./grok.js";
export * from "./openai.js";
