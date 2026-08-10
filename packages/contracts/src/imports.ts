import { z } from "zod";

export const localDataImportResponseSchema = z.object({
  importId: z.uuid(),
  status: z.enum(["uploaded", "validating", "importing", "published", "failed", "deleted"]),
  counts: z.record(z.string(), z.unknown()),
  error: z.object({ code: z.string(), message: z.string().nullable() }).optional(),
  publishedAt: z.iso.datetime({ offset: true }).optional(),
});
export type LocalDataImportResponse = z.infer<typeof localDataImportResponseSchema>;
