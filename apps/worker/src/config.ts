import { z } from "zod";

const workerConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  BUSINESS_DATABASE_URL: z.url(),
  SUPABASE_URL: z.url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  HATCHET_MODE: z.enum(["cloud", "lite", "oss"]),
  HATCHET_CLIENT_TOKEN: z.string().min(1),
  HATCHET_CLIENT_HOST_PORT: z.string().min(1).optional(),
  HATCHET_CLIENT_API_URL: z.url().optional(),
  HATCHET_CLIENT_TLS_STRATEGY: z.enum(["tls", "mtls", "none"]).optional(),
  HATCHET_CLIENT_TLS_CERT_FILE: z.string().min(1).optional(),
  HATCHET_CLIENT_TLS_ROOT_CA_FILE: z.string().min(1).optional(),
  HATCHET_CLIENT_TLS_KEY_FILE: z.string().min(1).optional(),
  HATCHET_CLIENT_TLS_SERVER_NAME: z.string().min(1).optional(),
  HATCHET_NAMESPACE: z.string().min(1).default("infinite-canvas"),
  HATCHET_WORKER_SLOTS: z.coerce.number().int().min(1).max(1000).default(20),
  HATCHET_DURABLE_SLOTS: z.coerce.number().int().min(1).max(5000).default(100),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(8733),
  WORKER_METRICS_PORT: z.coerce.number().int().min(1).max(65535).default(9464),
  OUTBOX_POLL_MS: z.coerce.number().int().min(100).max(30_000).default(1000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(50),
  OUTBOX_DISPATCHER_ENABLED: z.enum(["true", "false"]).default("true"),
  UNKNOWN_RECONCILER_ENABLED: z.enum(["true", "false"]).default("true"),
  CREDENTIAL_MASTER_KEY: z.string().min(40),
  S3_REGION: z.string().min(1),
  S3_ENDPOINT: z.url(),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  MAX_MEDIA_BYTES: z.coerce.number().int().positive().default(500 * 1024 * 1024),
  MAX_IMAGE_PIXELS: z.coerce.number().int().positive().default(40_000_000),
  MAX_MEDIA_DURATION_SECONDS: z.coerce.number().int().positive().default(1800),
  FFPROBE_PATH: z.string().min(1).default("ffprobe"),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
});

export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export function loadWorkerConfig(environment: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const config = workerConfigSchema.parse(environment);
  const masterKey = Buffer.from(config.CREDENTIAL_MASTER_KEY, "base64");
  if (masterKey.length !== 32) throw new Error("CREDENTIAL_MASTER_KEY must be a base64-encoded 32-byte key");
  if (config.NODE_ENV === "production" && config.HATCHET_MODE === "lite") {
    throw new Error("HATCHET_MODE=lite is not allowed in production");
  }
  const hasHost = Boolean(config.HATCHET_CLIENT_HOST_PORT);
  const hasApi = Boolean(config.HATCHET_CLIENT_API_URL);
  if (hasHost !== hasApi) {
    throw new Error("HATCHET_CLIENT_HOST_PORT and HATCHET_CLIENT_API_URL must be configured together");
  }
  if (config.HATCHET_MODE !== "cloud" && (!hasHost || !hasApi)) {
    throw new Error("Hatchet Lite/OSS requires explicit HATCHET_CLIENT_HOST_PORT and HATCHET_CLIENT_API_URL");
  }
  if (config.HATCHET_MODE === "lite" && config.HATCHET_CLIENT_TLS_STRATEGY && config.HATCHET_CLIENT_TLS_STRATEGY !== "none") {
    throw new Error("Hatchet Lite must use HATCHET_CLIENT_TLS_STRATEGY=none");
  }
  if (config.HATCHET_CLIENT_TLS_STRATEGY === "mtls" &&
      (!config.HATCHET_CLIENT_TLS_CERT_FILE || !config.HATCHET_CLIENT_TLS_KEY_FILE || !config.HATCHET_CLIENT_TLS_ROOT_CA_FILE)) {
    throw new Error("Hatchet mTLS requires certificate, key, and root CA files");
  }
  return config;
}

export function hatchetClientOptions(config: WorkerConfig) {
  const tlsStrategy = config.HATCHET_CLIENT_TLS_STRATEGY ?? (config.HATCHET_MODE === "lite" ? "none" : "tls");
  return {
    token: config.HATCHET_CLIENT_TOKEN,
    namespace: config.HATCHET_NAMESPACE,
    healthcheck: { enabled: true, port: config.WORKER_HEALTH_PORT },
    ...(config.HATCHET_CLIENT_HOST_PORT ? { host_port: config.HATCHET_CLIENT_HOST_PORT } : {}),
    ...(config.HATCHET_CLIENT_API_URL ? { api_url: config.HATCHET_CLIENT_API_URL } : {}),
    tls_config: {
      tls_strategy: tlsStrategy,
      ...(config.HATCHET_CLIENT_TLS_CERT_FILE ? { cert_file: config.HATCHET_CLIENT_TLS_CERT_FILE } : {}),
      ...(config.HATCHET_CLIENT_TLS_ROOT_CA_FILE ? { ca_file: config.HATCHET_CLIENT_TLS_ROOT_CA_FILE } : {}),
      ...(config.HATCHET_CLIENT_TLS_KEY_FILE ? { key_file: config.HATCHET_CLIENT_TLS_KEY_FILE } : {}),
      ...(config.HATCHET_CLIENT_TLS_SERVER_NAME ? { server_name: config.HATCHET_CLIENT_TLS_SERVER_NAME } : {}),
    },
  } as const;
}
