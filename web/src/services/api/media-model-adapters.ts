export type ModelAdapterProfile = "auto" | "protocol" | "grok2api-image" | "sub2api-image" | "grok2api-video" | "sub2api-video" | "custom-script";
export type LegacyAdapterHint = "grok2api-image" | "sub2api-image" | "grok-video" | "custom-script" | undefined;

type ModelCapability = "image" | "video" | "text" | "audio";
type MediaChannelAdapter = "grok2api" | "sub2api";

const COMMON_PROFILES: ModelAdapterProfile[] = ["auto", "protocol"];

export function modelAdapterProfilesForCapability(capability: ModelCapability): ModelAdapterProfile[] {
    if (capability === "image") return [...COMMON_PROFILES, "grok2api-image", "sub2api-image", "custom-script"];
    if (capability === "video") return [...COMMON_PROFILES, "grok2api-video", "sub2api-video", "custom-script"];
    return [...COMMON_PROFILES, "custom-script"];
}

export function normalizeModelAdapterProfile(value: unknown, capability: ModelCapability): ModelAdapterProfile | undefined {
    return typeof value === "string" && modelAdapterProfilesForCapability(capability).includes(value as ModelAdapterProfile) ? (value as ModelAdapterProfile) : undefined;
}

export function resolveMediaModelAdapter({
    selected = "auto",
    channelAdapter,
    capability,
    legacyHint,
}: {
    selected?: ModelAdapterProfile;
    channelAdapter?: MediaChannelAdapter;
    capability: ModelCapability;
    legacyHint?: LegacyAdapterHint;
}): Exclude<ModelAdapterProfile, "auto"> {
    if (selected !== "auto") return selected;
    if (legacyHint === "custom-script") return legacyHint;
    if (capability === "image" && (legacyHint === "grok2api-image" || legacyHint === "sub2api-image")) return legacyHint;
    if (capability === "video" && legacyHint === "grok-video") return channelAdapter === "sub2api" ? "sub2api-video" : "grok2api-video";
    if (channelAdapter === "grok2api" && capability === "image") return "grok2api-image";
    if (channelAdapter === "sub2api" && capability === "image") return "sub2api-image";
    if (channelAdapter === "grok2api" && capability === "video") return "grok2api-video";
    if (channelAdapter === "sub2api" && capability === "video") return "sub2api-video";
    return "protocol";
}

export function legacyAdapterHintForModel(legacyHint: LegacyAdapterHint, capability: ModelCapability, recognizedMediaCapability: ModelCapability | undefined): LegacyAdapterHint {
    if (legacyHint === "custom-script") return legacyHint;
    return recognizedMediaCapability === capability ? legacyHint : undefined;
}

export function mediaChannelAdapterForVideoProfile(profile: ModelAdapterProfile): MediaChannelAdapter | undefined {
    if (profile === "grok2api-video") return "grok2api";
    if (profile === "sub2api-video") return "sub2api";
    return undefined;
}
