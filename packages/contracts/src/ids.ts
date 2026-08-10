import { z } from "zod";

export const uuidSchema = z.uuid();
export const workspaceIdSchema = uuidSchema.brand<"WorkspaceId">();
export const projectIdSchema = uuidSchema.brand<"ProjectId">();
export const batchIdSchema = uuidSchema.brand<"BatchId">();
export const jobIdSchema = uuidSchema.brand<"JobId">();
export const attemptIdSchema = uuidSchema.brand<"AttemptId">();
export const assetIdSchema = uuidSchema.brand<"AssetId">();
export const channelIdSchema = uuidSchema.brand<"ChannelId">();
export const modelConfigIdSchema = uuidSchema.brand<"ModelConfigId">();
export const slotIdSchema = z.string().trim().min(1).max(128).brand<"SlotId">();
export const nodeIdSchema = z.string().trim().min(1).max(128).brand<"NodeId">();
export const decimalUnsignedSchema = z.string().regex(/^(0|[1-9]\d*)$/);
export const decimalSignedSchema = z.string().regex(/^-?(0|[1-9]\d*)$/);
export const eventSequenceSchema = decimalUnsignedSchema.brand<"EventSequence">();

export type WorkspaceId = z.infer<typeof workspaceIdSchema>;
export type ProjectId = z.infer<typeof projectIdSchema>;
export type BatchId = z.infer<typeof batchIdSchema>;
export type JobId = z.infer<typeof jobIdSchema>;
export type AttemptId = z.infer<typeof attemptIdSchema>;
export type AssetId = z.infer<typeof assetIdSchema>;
export type ChannelId = z.infer<typeof channelIdSchema>;
export type ModelConfigId = z.infer<typeof modelConfigIdSchema>;
export type SlotId = z.infer<typeof slotIdSchema>;
export type NodeId = z.infer<typeof nodeIdSchema>;
export type EventSequence = z.infer<typeof eventSequenceSchema>;
