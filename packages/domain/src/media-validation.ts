import { spawn } from "node:child_process";

import sharp from "sharp";

export class MediaProbeUnavailableError extends Error {}

export interface MediaValidationOptions {
  path: string;
  mime: string;
  kind: "image" | "video" | "audio";
  maxImagePixels: number;
  maxDurationSeconds: number;
  ffprobePath?: string;
  ffmpegPath?: string;
}

export interface ValidatedMedia {
  width?: number;
  height?: number;
  durationSeconds?: number;
}

interface ProbeOutput {
  format?: { duration?: string };
  streams?: Array<{ codec_type?: string; width?: number; height?: number; duration?: string }>;
}

async function runProcess(command: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) child.kill("SIGKILL");
      else target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === "ENOENT" ? new MediaProbeUnavailableError(`${command} is not installed`) : error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && outputBytes <= 1024 * 1024) resolve(Buffer.concat(stdout).toString("utf8"));
      else reject(new Error(`${command} rejected media (${signal ?? `exit ${code}`}): ${Buffer.concat(stderr).toString("utf8").slice(0, 500)}`));
    });
  });
}

async function validateImage(options: MediaValidationOptions): Promise<ValidatedMedia> {
  const image = sharp(options.path, { failOn: "warning", limitInputPixels: options.maxImagePixels, limitInputChannels: 5 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height || !metadata.mediaType?.startsWith("image/")) throw new Error("Image decoder did not identify valid dimensions and MIME");
  if (metadata.mediaType.toLowerCase() !== options.mime.toLowerCase()) throw new Error("Decoded image MIME does not match the declared MIME");
  const pages = metadata.pages ?? 1;
  if (metadata.width * metadata.height * pages > options.maxImagePixels) throw new Error("Decoded image exceeds the pixel limit");
  await sharp(options.path, { failOn: "warning", limitInputPixels: options.maxImagePixels, limitInputChannels: 5, animated: pages > 1 }).stats();
  return { width: metadata.width, height: metadata.height };
}

async function validateAudioVideo(options: MediaValidationOptions): Promise<ValidatedMedia> {
  const probeText = await runProcess(options.ffprobePath ?? "ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=codec_type,width,height,duration", "-of", "json", options.path,
  ]);
  const probe = JSON.parse(probeText) as ProbeOutput;
  const expectedType = options.kind === "video" ? "video" : "audio";
  const stream = probe.streams?.find((candidate) => candidate.codec_type === expectedType);
  if (!stream) throw new Error(`Media does not contain a decodable ${expectedType} stream`);
  const duration = Number(stream.duration ?? probe.format?.duration ?? "0");
  if (!Number.isFinite(duration) || duration <= 0 || duration > options.maxDurationSeconds) throw new Error("Media duration is missing or exceeds the limit");
  const decodeArgs = options.kind === "video"
    ? ["-v", "error", "-xerror", "-i", options.path, "-map", "0:v:0", "-frames:v", "1", "-f", "null", "-"]
    : ["-v", "error", "-xerror", "-i", options.path, "-map", "0:a:0", "-t", "1", "-f", "null", "-"];
  await runProcess(options.ffmpegPath ?? "ffmpeg", decodeArgs);
  return {
    ...(stream.width ? { width: stream.width } : {}),
    ...(stream.height ? { height: stream.height } : {}),
    durationSeconds: duration,
  };
}

export async function validateMediaFile(options: MediaValidationOptions): Promise<ValidatedMedia> {
  return options.kind === "image" ? validateImage(options) : validateAudioVideo(options);
}
