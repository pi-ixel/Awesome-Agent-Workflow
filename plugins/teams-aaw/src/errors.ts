/** Error codes follow the OpsCopilot bundle conventions (gateway surfaces `{ error, code }`). */
export type AawErrorCode =
  | 'INVALID_ARGUMENT'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'TIMEOUT'
  | 'RUNTIME_UNAVAILABLE'
  | 'OPERATION_FAILED'
  | 'UNSUPPORTED_CAPABILITY'

export class AawError extends Error {
  constructor(
    readonly code: AawErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'AawError'
  }
}

export function isAawError(value: unknown): value is AawError {
  return value instanceof AawError
}
