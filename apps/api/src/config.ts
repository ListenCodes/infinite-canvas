import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  METRICS_BEARER_TOKEN: z.string().min(32).optional(),
  BUSINESS_DATABASE_URL: z.url(),
  BUSINESS_DATABASE_LISTENER_URL: z.url(),
  SUPABASE_URL: z.url(),
  SUPABASE_JWT_AUDIENCE: z.string().min(1).default("authenticated"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  CREDENTIAL_MASTER_KEY: z.string().min(40),
  STORAGE_BUCKET: z.string().min(1).default("infinite-canvas-assets"),
  CORS_ALLOWED_ORIGINS: z.string().min(1),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  MAX_IMPORT_BYTES: z.coerce.number().int().positive().max(50 * 1024 * 1024).default(25 * 1024 * 1024),
  MAX_CONCURRENT_IMPORTS: z.coerce.number().int().min(1).max(8).default(2),
  MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(40_000_000),
  MAX_MEDIA_DURATION_SECONDS: z.coerce.number().int().positive().default(1800),
  FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().min(3600).max(7 * 86400).default(86400),
  ADMIN_LARGE_DEBIT_THRESHOLD: z.coerce.bigint().positive().default(1000n),
  SSE_CURSOR_SCAN_MS: z.coerce.number().int().min(1000).max(30_000).default(5000),
});

export type ApiConfig = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const config = configSchema.parse(environment);
  if (Buffer.from(config.CREDENTIAL_MASTER_KEY, "base64").length !== 32) {
    throw new Error("CREDENTIAL_MASTER_KEY must be a base64-encoded 32-byte key");
  }
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!config.METRICS_BEARER_TOKEN && !loopbackHosts.has(config.HOST.toLowerCase())) {
    throw new Error(
      "METRICS_BEARER_TOKEN is required when API metrics bind to a non-loopback host",
    );
  }
  return config;
}

export function allowedOrigins(config: ApiConfig): string[] {
  return config.CORS_ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
}
