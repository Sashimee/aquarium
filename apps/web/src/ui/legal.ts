import type { ApiRequestError } from './api';

export function rateLimitMessage(error: ApiRequestError, what: string): string {
  const wait = error.retryAfterSeconds;
  if (wait === null) return `Too many ${what} requests. Wait a little and try again.`;
  const minutes = Math.ceil(wait / 60);
  const span = wait < 60 ? `${wait} seconds` : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  return `Too many ${what} requests. Try again in about ${span}.`;
}

export function deleteErrorMessage(error: ApiRequestError, passwordGiven: boolean): string {
  if (error.code === 'rate_limited') return rateLimitMessage(error, 'deletion');
  if (error.code === 'forbidden') {
    return passwordGiven
      ? 'That password is not correct.'
      : 'This account needs a fresh sign-in. Sign out, sign in again with your passkey, then retry within 5 minutes.';
  }
  return error.message;
}

export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
