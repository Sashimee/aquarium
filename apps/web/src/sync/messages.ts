import { ApiRequestError, ClientValidationError } from '../ui/api';

/** One plain sentence for the person looking at the screen, saying what happened and what to do. */
export function describeSyncError(error: unknown): string {
  if (error instanceof ClientValidationError) {
    return Object.values(error.fields)[0] ?? error.message;
  }
  if (!(error instanceof ApiRequestError)) {
    return 'Something went wrong. Reload the page and try again.';
  }
  switch (error.code) {
    case 'network':
      return 'Could not reach the server. Your tank is safe; check your connection and try again.';
    case 'timeout':
      return 'The server did not answer in time. Your tank is safe; try again in a moment.';
    case 'unauthenticated':
      return 'You have been signed out. Sign in again to keep caring for your tank.';
    case 'email_not_verified':
      return 'Verify your email address to use your saved tank.';
    case 'rate_limited':
      return error.retryAfterSeconds === null
        ? 'Too many requests. Wait a moment and try again.'
        : `Too many requests. Try again in ${error.retryAfterSeconds} seconds.`;
    case 'feeding_rejected':
    case 'conflict':
    case 'not_found':
    case 'validation_failed':
      return error.message;
    default:
      return error.status >= 500
        ? 'The server had a problem. Try again in a moment.'
        : error.message;
  }
}
