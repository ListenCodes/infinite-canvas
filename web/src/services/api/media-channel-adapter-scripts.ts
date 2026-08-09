export function grokMediaCapability(model: string): "image" | "video" | undefined {
    const name = model.trim().toLowerCase();
    if (/^grok-imagine-video(?:$|-)/.test(name)) return "video";
    if (/^grok-imagine(?:$|-image(?:$|-)|-edit(?:$|-))/.test(name)) return "image";
    return undefined;
}

function imageAdapterScript(editModel: string) {
    return `const editing = images.length > 0;
const generationModel = model.includes("edit") ? "grok-imagine-image-quality" : model;
const sizeMatch = String(params.size || "").match(/^(\\d+)x(\\d+)$/);
const allowedRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
let aspectRatio;
if (sizeMatch) {
  const target = Number(sizeMatch[1]) / Number(sizeMatch[2]);
  aspectRatio = allowedRatios.reduce((best, candidate) => {
    const [width, height] = candidate.split(":").map(Number);
    const [bestWidth, bestHeight] = best.split(":").map(Number);
    return Math.abs(width / height - target) < Math.abs(bestWidth / bestHeight - target) ? candidate : best;
  }, "1:1");
} else if (allowedRatios.includes(params.size)) {
  aspectRatio = params.size;
}
const requestedPixels = sizeMatch ? Number(sizeMatch[1]) * Number(sizeMatch[2]) : 0;
if (requestedPixels > 4194304) throw new Error("Grok media providers support image output up to 2K.");
const resolution = editing ? "1k" : params.quality === "medium" || params.quality === "high" || requestedPixels > 1600000 ? "2k" : "1k";
const body = {
  model: editing ? ${JSON.stringify(editModel)} : generationModel,
  prompt,
  n: editing ? 1 : Math.max(1, Math.min(10, Number(params.count) || 1)),
  response_format: "b64_json",
  stream: false,
  resolution,
};
const allowedSizes = ["1024x1024", "1024x1536", "1536x1024"];
if (allowedSizes.includes(params.size)) body.size = params.size;
if (aspectRatio) body.aspect_ratio = aspectRatio;
if (editing) body.images = images.slice(0, 8).map((url) => ({ url }));

const response = await http.post(editing ? "/images/edits" : "/images/generations", body, { timeoutMs: 300000 });
const root = response?.data && !Array.isArray(response.data) && (response.data.data || response.data.images || response.data.results) ? response.data : response;
const items = root?.data || root?.images || root?.results || [];
const urls = items.map((item) => {
  if (item?.b64_json) return \`data:image/png;base64,\${item.b64_json}\`;
  const value = item?.url;
  return typeof value === "string" && value.startsWith("/") ? new URL(value, baseUrl).href : value;
}).filter(Boolean);
if (!urls.length) throw new Error("The media API returned no image.");
return urls;`;
}

export const GROK2API_IMAGE_ADAPTER_SCRIPT = imageAdapterScript("grok-imagine-image-edit");
export const SUB2API_IMAGE_ADAPTER_SCRIPT = imageAdapterScript("grok-imagine-edit");

export const GROK_MEDIA_VIDEO_ADAPTER_SCRIPT = `const duration = Math.max(1, Math.min(15, Math.round(Number(params.seconds) || 8)));
const ratioMap = { "1280x720": "16:9", "1792x1024": "16:9", "720x1280": "9:16", "1024x1792": "9:16", "1024x1024": "1:1", "1024x1536": "2:3", "1536x1024": "3:2" };
const allowedRatios = ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"];
const aspectRatio = allowedRatios.includes(params.ratio) ? params.ratio : ratioMap[params.size] || ratioMap[params.ratio] || "16:9";
const allowedResolutions = ["480p", "720p", "1080p"];
const resolution = allowedResolutions.includes(params.resolution) ? params.resolution : "720p";
const body = { model, prompt, duration, aspect_ratio: aspectRatio, resolution };
if (images[0]) body.image = { url: images[0] };

const created = await http.post("/videos/generations", body);
const createdTask = created?.data && !Array.isArray(created.data) ? created.data : created;
const requestId = createdTask?.request_id || createdTask?.id;
if (!requestId) throw new Error("The media API returned no video task ID.");

await poll(
  () => http.get(\`/videos/\${encodeURIComponent(requestId)}\`),
  (payload) => {
    const state = payload?.data && !Array.isArray(payload.data) ? payload.data : payload;
    const status = String(state?.status || "").toLowerCase();
    if (["failed", "cancelled", "expired"].includes(status)) {
      throw new Error(state?.error?.message || state?.message || "Video generation failed.");
    }
    return ["done", "completed", "succeeded"].includes(status) ? true : null;
  },
  { intervalMs: 2500, timeoutMs: 300000 },
);

return await http.get(\`/videos/\${encodeURIComponent(requestId)}/content\`, { responseType: "blob" });`;
