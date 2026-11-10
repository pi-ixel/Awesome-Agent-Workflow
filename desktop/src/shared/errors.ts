/** 把 unknown 错误描述成一句话（日志与 UI 提示用）。 */
export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
