import { z } from "zod";

export const generationCapabilitySchema = z.enum(["image", "video"]);
export const batchStatusSchema = z.enum(["queued", "running", "succeeded", "partial_succeeded", "failed", "canceled"]);
export const jobStatusSchema = z.enum([
  "queued",
  "dispatching",
  "running",
  "waiting_provider",
  "materializing",
  "succeeded",
  "failed",
  "cancel_requested",
  "canceled",
  "outcome_unknown",
]);
export const attemptStatusSchema = z.enum([
  "created",
  "claimed",
  "submitting",
  "accepted",
  "materializing",
  "succeeded",
  "failed",
  "canceled",
  "outcome_unknown",
]);
export const assetStatusSchema = z.enum(["uploading", "verifying", "ready", "rejected", "deleted"]);
export const reservationStatusSchema = z.enum(["reserved", "settled", "released"]);
export const outboxStatusSchema = z.enum(["pending", "sending", "sent", "dead"]);

export type GenerationCapability = z.infer<typeof generationCapabilitySchema>;
export type BatchStatus = z.infer<typeof batchStatusSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
export type AttemptStatus = z.infer<typeof attemptStatusSchema>;
export type AssetStatus = z.infer<typeof assetStatusSchema>;
export type ReservationStatus = z.infer<typeof reservationStatusSchema>;
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

export const activeJobStatuses: ReadonlySet<JobStatus> = new Set([
  "queued",
  "dispatching",
  "running",
  "waiting_provider",
  "materializing",
  "cancel_requested",
]);

export const terminalJobStatuses: ReadonlySet<JobStatus> = new Set(["succeeded", "failed", "canceled"]);
