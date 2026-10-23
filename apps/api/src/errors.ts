import type { ApiError, ConflictReason, ErrorCode } from '@aquarium/shared';

export function apiError(
  code: ErrorCode,
  message: string,
  issues?: ApiError['error']['issues'],
  reason?: ConflictReason,
): ApiError {
  return { error: { code, message, ...(issues ? { issues } : {}), ...(reason ? { reason } : {}) } };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ReturnType<typeof apiError>,
    readonly headers: Record<string, string> = {},
  ) {
    super(body.error.message);
  }
}
