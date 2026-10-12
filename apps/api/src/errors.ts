import type { ApiError, ErrorCode } from '@aquarium/shared';

export function apiError(
  code: ErrorCode,
  message: string,
  issues?: ApiError['error']['issues'],
): ApiError {
  return { error: { code, message, ...(issues ? { issues } : {}) } };
}
