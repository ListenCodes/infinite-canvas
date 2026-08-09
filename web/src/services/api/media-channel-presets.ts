import {
    createModelChannel,
    findExactModelChannel,
    guessCapability,
    modelAdapterProfileOf,
    modelCapabilityOf,
    modelOptionName,
    resolveModelScript,
    type AiConfig,
    type ChannelModel,
    type MediaChannelAdapter,
    type ModelCapability,
    type ModelChannel,
} from "@/stores/use-config-store";

import { GROK2API_IMAGE_ADAPTER_SCRIPT, GROK_MEDIA_VIDEO_ADAPTER_SCRIPT, SUB2API_IMAGE_ADAPTER_SCRIPT, grokMediaCapability } from "./media-channel-adapter-scripts";
import { resolveMediaModelAdapter, type LegacyAdapterHint, type ModelAdapterProfile } from "./media-model-adapters";

const PRESETS: Record<MediaChannelAdapter, { baseUrl: string; models: string[] }> = {
    grok2api: {
        baseUrl: "https://grok.jluma.com",
        models: ["grok-imagine-image", "grok-imagine-image-quality", "grok-imagine-image-edit", "grok-imagine-video"],
    },
    sub2api: {
        baseUrl: "https://sub.jluma.com",
        models: ["grok-4.5", "grok-imagine", "grok-imagine-image", "grok-imagine-image-quality", "grok-imagine-edit", "grok-imagine-video", "grok-imagine-video-1.5"],
    },
};

export function createMediaChannelPreset(adapter: MediaChannelAdapter, name: string): ModelChannel {
    const preset = PRESETS[adapter];
    return createModelChannel({
        adapter,
        name,
        baseUrl: preset.baseUrl,
        apiFormat: "openai",
        models: preset.models.map((model) => createMediaChannelModel(adapter, model)),
    });
}

export function createMediaChannelModel(adapter: MediaChannelAdapter | undefined, name: string): ChannelModel {
    const capability = adapter ? grokMediaCapability(name) || guessCapability(name) : guessCapability(name);
    return { name, capability, adapterProfile: "auto" };
}

export function resolveModelRuntimeAdapter(config: AiConfig, value: string): Exclude<ModelAdapterProfile, "auto"> {
    const channel = findExactModelChannel(config, value);
    const capability = modelCapabilityOf(config, value) || guessCapability(value);
    const mediaCapability = grokMediaCapability(modelOptionName(value));
    const script = resolveModelScript(config, value);
    return resolveMediaModelAdapter({
        selected: modelAdapterProfileOf(config, value),
        channelAdapter: mediaCapability === capability ? channel?.adapter : undefined,
        capability,
        legacyHint: legacyAdapterHint(script),
    });
}

export function resolveModelRuntimeScript(config: AiConfig, value: string, profile = resolveModelRuntimeAdapter(config, value)) {
    if (profile === "grok2api-image") return GROK2API_IMAGE_ADAPTER_SCRIPT;
    if (profile === "sub2api-image") return SUB2API_IMAGE_ADAPTER_SCRIPT;
    if (profile === "custom-script") return resolveModelScript(config, value);
    return "";
}

export function builtInMediaAdapterScriptCapability(script: string): ModelCapability | undefined {
    if (script === GROK2API_IMAGE_ADAPTER_SCRIPT || script === SUB2API_IMAGE_ADAPTER_SCRIPT) return "image";
    if (script === GROK_MEDIA_VIDEO_ADAPTER_SCRIPT) return "video";
    return undefined;
}

function legacyAdapterHint(script: string): LegacyAdapterHint {
    if (!script) return undefined;
    if (script === GROK2API_IMAGE_ADAPTER_SCRIPT) return "grok2api-image";
    if (script === SUB2API_IMAGE_ADAPTER_SCRIPT) return "sub2api-image";
    if (script === GROK_MEDIA_VIDEO_ADAPTER_SCRIPT) return "grok-video";
    return "custom-script";
}
