export type GrokMediaVideoResponse = {
    request_id?: string;
    id?: string;
    status?: string;
    progress?: number;
    video?: { url?: string } | null;
    code?: number | string;
    msg?: string;
    message?: string;
    error?: { message?: string } | string | null;
    data?: GrokMediaVideoResponse | null;
};

export function grokMediaAspectRatio(value: string) {
    const allowed = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
    if (allowed.includes(value)) return value;
    const match = (/^\d+x\d+$/.test(value) ? value : "1280x720").match(/^(\d+)x(\d+)$/);
    if (!match) return "16:9";
    const target = Number(match[1]) / Number(match[2]);
    return allowed.reduce((best, candidate) => {
        const [width, height] = candidate.split(":").map(Number);
        const [bestWidth, bestHeight] = best.split(":").map(Number);
        return Math.abs(width / height - target) < Math.abs(bestWidth / bestHeight - target) ? candidate : best;
    }, "1:1");
}

export function grokMediaResolution(value: string) {
    const normalized = value === "low" ? "480p" : value === "auto" || value === "high" || value === "medium" ? "720p" : `${value.replace(/p$/i, "") || "720"}p`;
    return ["480p", "720p", "1080p"].includes(normalized) ? normalized : "720p";
}

export function unwrapGrokMediaVideoResponse(payload: GrokMediaVideoResponse) {
    assertSuccessfulEnvelope(payload);
    const result = payload.data && typeof payload.data === "object" ? payload.data : payload;
    assertSuccessfulEnvelope(result);
    if (!result.request_id && !result.id && !result.status) {
        const message = responseMessage(result);
        if (message) throw new Error(message);
    }
    return result;
}

function assertSuccessfulEnvelope(payload: GrokMediaVideoResponse) {
    if (payload.code !== undefined && payload.code !== 0 && payload.code !== "0") throw new Error(responseMessage(payload) || `Media API error ${payload.code}`);
}

function responseMessage(payload: GrokMediaVideoResponse) {
    if (typeof payload.error === "string") return payload.error;
    return payload.error?.message || payload.msg || payload.message || "";
}
