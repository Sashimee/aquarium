import { and, eq } from 'drizzle-orm';
import type { Auth } from './auth.ts';
import { schema, type Database } from './db/index.ts';

export const FRESH_SESSION_MS = 5 * 60_000;

export type Reauthentication = 'ok' | 'wrong_password' | 'stale_session';

export interface ReauthSubject {
  user: { id: string };
  session: { createdAt: Date };
}

// An account with a password proves it by sending it. A passkey-only account has no password, so
// the proof is a sign-in within the last few minutes.
export function createReauthenticator({ db }: Database, auth: Auth) {
  return async (
    subject: ReauthSubject,
    password: string | undefined,
  ): Promise<Reauthentication> => {
    const [credential] = await db
      .select({ password: schema.account.password })
      .from(schema.account)
      .where(
        and(
          eq(schema.account.userId, subject.user.id),
          eq(schema.account.providerId, 'credential'),
        ),
      );
    if (credential?.password) {
      const ctx = await auth.$context;
      const valid =
        password !== undefined &&
        (await ctx.password.verify({ hash: credential.password, password }));
      return valid ? 'ok' : 'wrong_password';
    }
    return Date.now() - subject.session.createdAt.getTime() > FRESH_SESSION_MS
      ? 'stale_session'
      : 'ok';
  };
}
