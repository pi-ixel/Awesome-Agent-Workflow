export interface AcpDiagnosticPrivacy {
  readonly isSensitiveRequest?: (method: string) => boolean;
  /** 返回诊断专用副本。协议分发始终收到原始通知。 */
  readonly redactNotification?: (
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) => Readonly<Record<string, unknown>>;
}
