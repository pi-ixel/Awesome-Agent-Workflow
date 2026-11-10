/**
 * ACP 协议层错误类型。
 *
 * 分类对齐 skill-eval 的 Python 参考实现（session.py 的
 * InfrastructureError 码：ACP_CLOSED / ACP_WRITE_FAILED /
 * ACP_REQUEST_TIMEOUT / ACP_INIT_FAILED / ACP_SESSION_FAILED），
 * 便于跨语言排查同一类故障。
 */

/** ACP 层错误基类：machineCode 供程序分支，message 供日志与人读。 */
export class AcpError extends Error {
  constructor(
    readonly machineCode: string,
    message: string,
    cause?: unknown,
  ) {
    // ES2022 Error 构造器原生支持 cause（不再声明同名字段覆盖）
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AcpError";
  }
}
