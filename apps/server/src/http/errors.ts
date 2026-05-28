import type { Diagnostic } from '@openclaude-studio/shared';

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
  }
}

export function invalidRequest(message: string): ApiError {
  return new ApiError(400, 'INVALID_REQUEST', message, [{ level: 'error', message }]);
}
