import pino, { type LoggerOptions } from "pino";

export type { Logger } from "pino";

const redactionPaths = [
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "apiKey",
  "token",
  "secret",
  "password",
  "signedUrl",
  "*.apiKey",
  "*.token",
  "*.secret",
  "*.password",
  "*.signedUrl",
];

export function createLogger(service: string, level = process.env.LOG_LEVEL ?? "info") {
  const options: LoggerOptions = {
    name: service,
    level,
    redact: { paths: redactionPaths, censor: "[REDACTED]" },
    base: { service },
  };
  return pino(options);
}
