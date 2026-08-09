import { createModelChannel, guessCapability, type ChannelModel, type MediaChannelAdapter, type ModelChannel } from "@/stores/use-config-store";

import { GROK2API_IMAGE_ADAPTER_SCRIPT, SUB2API_IMAGE_ADAPTER_SCRIPT, grokMediaCapability } from "./media-channel-adapter-scripts";

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
    if (!adapter || capability !== "image") return { name, capability };
    const script = adapter === "grok2api" ? GROK2API_IMAGE_ADAPTER_SCRIPT : SUB2API_IMAGE_ADAPTER_SCRIPT;
    return { name, capability, script };
}
