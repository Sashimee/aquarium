import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';

export const REMINDER_COOLDOWN_HOURS = 24;
export const REMINDER_AFTER_UNFED_HOURS = 20;
export const MAX_PUSH_SUBSCRIPTIONS = 10;

export const reminderSettingsSchema = z.strictObject({
  mail: z.boolean(),
  push: z.boolean(),
  pushAvailable: z.boolean(),
  vapidPublicKey: z.string().min(1).nullable(),
  subscriptions: z.number().int().min(0),
});
export type ReminderSettings = z.infer<typeof reminderSettingsSchema>;

export const updateReminderSettingsRequestSchema = z
  .strictObject({
    mail: z.boolean().optional(),
    push: z.boolean().optional(),
  })
  .refine((v) => v.mail !== undefined || v.push !== undefined, {
    message: 'Provide mail, push or both.',
  });

const base64url = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const pushSubscriptionRequestSchema = z.strictObject({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
  keys: z.strictObject({
    p256dh: base64url.min(80).max(100),
    auth: base64url.min(16).max(32),
  }),
});
export type PushSubscriptionRequest = z.infer<typeof pushSubscriptionRequestSchema>;

export const removePushSubscriptionRequestSchema = z.strictObject({
  endpoint: z.url({ protocol: /^https$/ }).max(2048),
});

export const pushDeviceSchema = z.strictObject({
  id: idSchema,
  label: z.string().min(1),
  createdAt: timestampSchema,
  lastUsedAt: timestampSchema.nullable(),
  current: z.boolean(),
});
export type PushDevice = z.infer<typeof pushDeviceSchema>;

export const pushDeviceListSchema = z.strictObject({ devices: z.array(pushDeviceSchema) });
export type PushDeviceList = z.infer<typeof pushDeviceListSchema>;

export const pushDeviceQuerySchema = z.strictObject({
  endpoint: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .optional(),
});

export const removePushResultSchema = z.strictObject({ removed: z.boolean() });
export type RemovePushResult = z.infer<typeof removePushResultSchema>;

export const exportedReminderSchema = z.strictObject({
  mail: z.boolean(),
  push: z.boolean(),
  lastSentAt: timestampSchema.nullable(),
  pushSubscriptions: z.array(
    z.strictObject({
      id: idSchema,
      endpoint: z.string(),
      createdAt: timestampSchema,
      lastUsedAt: timestampSchema.nullable(),
    }),
  ),
});
