import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';

export const emailSchema = z.email().max(254);
export const passwordSchema = z.string().min(10).max(128);

export const signUpRequestSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(60),
});
export type SignUpRequest = z.infer<typeof signUpRequestSchema>;

export const signInRequestSchema = z.strictObject({
  email: emailSchema,
  password: z.string().min(1).max(128),
});
export type SignInRequest = z.infer<typeof signInRequestSchema>;

export const userSchema = z.strictObject({
  id: idSchema,
  email: emailSchema,
  name: z.string(),
  emailVerified: z.boolean(),
  createdAt: timestampSchema,
});
export type User = z.infer<typeof userSchema>;

export const sessionInfoSchema = z.strictObject({
  id: idSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  userAgent: z.string().nullable(),
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const sessionListSchema = z.array(sessionInfoSchema);

export const revokeSessionRequestSchema = z.strictObject({ sessionId: idSchema });
export type RevokeSessionRequest = z.infer<typeof revokeSessionRequestSchema>;
