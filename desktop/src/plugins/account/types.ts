/** 登录来源：SSO 企业认证 | 手动输入（自验）。 */
export type AuthSource = "sso" | "dev";

/** 当前登录用户（统一形状，登录来源只影响 source 标记）。 */
export interface UserIdentity {
  /**
   * 唯一 ID：SSO 为认证方返回的唯一锚点；手动登录为本机按工号内部分配的
   * 固定 UUID（不展示）。
   */
  readonly id: string;
  /** 用户名（界面展示用）。 */
  readonly name: string;
  /** 工号（唯一区分身份）。 */
  readonly employeeId: string;
  readonly email: string | null;
  readonly department: string | null;
  readonly source: AuthSource;
  /** 登录时间（ISO 8601）。 */
  readonly loggedInAt: string;
}

/** 手动登录入参（表单只收这两项；store 再守一道）。 */
export interface DevIdentityInput {
  /** 用户名（界面展示用）。 */
  readonly name: string;
  /** 工号（唯一区分身份）。 */
  readonly employeeId: string;
}

export interface AccountSnapshot {
  readonly currentUser: UserIdentity | null;
  /** SSO 认证进行中（登录窗可能需要人工介入，等待可到分钟级）。 */
  readonly ssoPending: boolean;
  /** 最近一次 SSO 尝试的代次（随每次发起递增；UI 据此区分等待轮次）。 */
  readonly ssoAttemptId: number;
  /** 最近一次 SSO 登录失败原因（登录界面展示；成功/取消即清空）。 */
  readonly ssoError: string | null;
}
