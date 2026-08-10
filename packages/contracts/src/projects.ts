import { z } from "zod";

import { projectIdSchema, workspaceIdSchema } from "./ids.js";

export const canvasDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  localProjectId: z.string().min(1).max(128),
  document: z.record(z.string(), z.unknown()),
});

const projectWriteSchema = z.object({
  title: z.string().trim().min(1).max(200),
  documentJson: canvasDocumentSchema,
});

export const createProjectRequestSchema = projectWriteSchema
  .extend({
    workspaceId: workspaceIdSchema,
    clientProjectId: z.string().min(1).max(128),
  })
  .superRefine((value, context) => {
    if (value.clientProjectId !== value.documentJson.localProjectId) {
      context.addIssue({
        code: "custom",
        path: ["clientProjectId"],
        message: "clientProjectId must match documentJson.localProjectId",
      });
    }
  });

export const updateProjectRequestSchema = projectWriteSchema.extend({
  version: z.number().int().positive(),
});

export const projectProjectionSchema = z.object({
  id: projectIdSchema,
  workspaceId: workspaceIdSchema,
  title: z.string(),
  documentJson: canvasDocumentSchema,
  version: z.number().int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

export type CanvasDocument = z.infer<typeof canvasDocumentSchema>;
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;
export type ProjectProjection = z.infer<typeof projectProjectionSchema>;
