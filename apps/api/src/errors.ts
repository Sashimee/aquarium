import type { ApiError, ErrorCode } from '@aquarium/shared';

export function apiError(
  code: ErrorCode,
  message: string,
  issues?: ApiError['error']['issues'],
): ApiError {
  return { error: { code, message, ...(issues ? { issues } : {}) } };
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: ReturnType<typeof apiError>,
  ) {
    super(body.error.message);
  }
}
