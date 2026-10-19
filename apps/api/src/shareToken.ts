import { createHash, randomBytes } from 'node:crypto';

export const hashShareToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export function issueShareToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashShareToken(token) };
}
