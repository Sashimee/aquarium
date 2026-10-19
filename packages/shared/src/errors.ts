import { z } from 'zod';

export const errorCodeSchema = z.enum([
  'validation_failed',
  'unauthenticated',
  'forbidden',
  'own_tank',
  'not_found',
  'conflict',
  'push_device_owned',
  'push_device_limit',
  'rate_limited',
  'email_not_verified',
  'insufficient_pearls',
  'feeding_rejected',
  'payload_too_large',
  'unsupported_media_type',
  'internal',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: errorCodeSchema,
    message: z.string().min(1),
    issues: z
      .array(
        z.strictObject({
          path: z.array(z.union([z.string(), z.number()])),
          message: z.string(),
        }),
      )
      .optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
