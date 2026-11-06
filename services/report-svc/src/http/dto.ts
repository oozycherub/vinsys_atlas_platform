import { z } from 'zod';

const uuid = z.string().uuid();

export const tenantQuery = z.object({ tenant_id: uuid.optional() }).passthrough();

export const reportBody = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('candidate_assessment_pdf'),
      params: z
        .object({ session_id: uuid, sections: z.array(z.string().max(50)).max(20).optional() })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('assessment_results_xlsx'),
      params: z.object({ assessment_id: uuid }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal('gallery_xlsx'),
      params: z
        .object({
          report: z.string().max(100),
          values: z
            .record(z.unknown())
            .refine((v) => Object.keys(v).length <= 10)
            .default({}),
        })
        .strict(),
    })
    .strict(),
]);

export const settingsBody = z
  .object({
    sections: z
      .array(z.object({ key: z.string().max(50), enabled: z.boolean() }).strict())
      .min(1)
      .max(20),
  })
  .strict();

export const downloadQuery = z
  .object({
    tenant_id: uuid,
    exp: z.coerce.number().int().positive(),
    sig: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  })
  .strict();
