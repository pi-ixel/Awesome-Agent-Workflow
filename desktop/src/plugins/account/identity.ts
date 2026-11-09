import type { SsoFetchWire } from "../../contracts/sso.ts";

/**
 * 用户身份契约（src/core）：SSO 登录返回的身份解析 + 统一身份类型。
 *
 * SSO 对接形态（Issue #247）：登录窗口完成 W3 登录后，宿主读 WebView
 * cookie 转发调网关，网关返回用户身份 JSON（实测为扁平 `{uid, givenName}`）。
 * 解析按宽松契约实现——常见字段别名（camelCase / snake_case /
 * PascalCase 大小写不敏感）+ 常见包裹层（data / result / user / …）各
 * 认一遍；网关契约如有变化在此收敛，调用方（authStore / UI）不动。
 *
 * 传输与契约分层：宿主命令（src-tauri sso_login.rs）只把 status + body
 * 原文带回，本模块是全仓库唯一的身份解析点——Tauri 与 dev-web bridge
 * 两条通路共用，vitest 直接可测。
 */

/** 解析后的用户身份（SSO 与降级登录共用的形状）。 */
export interface SsoIdentity {
  /** 唯一标识：显式 id 字段优先，依次回落工号 / 邮箱 / 账号 / 姓名。 */
  readonly userId: string;
  /** 姓名（响应缺姓名字段时回落 userId）。 */
  readonly name: string;
  /** 工号（响应未提供时为 null）。 */
  readonly employeeId: string | null;
  readonly email: string | null;
  readonly department: string | null;
}

/** 非 2xx 响应的统一错误文案（带 body 片段，方便现场排查契约差异）。 */
export function describeSsoHttpFailure(wire: SsoFetchWire): string {
  const snippet = wire.body.trim().slice(0, 300);
  return snippet === ""
    ? `SSO 认证接口返回 HTTP ${wire.status}（空响应体）`
    : `SSO 认证接口返回 HTTP ${wire.status}：${snippet}`;
}

/**
 * 身份字段在各候选对象里的别名表（索引键统一「小写 + 去下划线」比对：
 * camelCase / snake_case / PascalCase 一视同仁）。
 *
 * 唯一锚点分强弱两轮：强锚点（显式 id / 工号字段）优先于弱锚点（账号 /
 * 邮箱 / 姓名）——包裹层里有显式 userId 时，不被顶层 name 抢走唯一标识；
 * 两轮都落空才判定契约不合法。
 */
const ID_STRONG_ALIASES: readonly string[] = [
  "userid",
  "uid",
  "id",
  "uuid",
  "uniqueid",
  "openid",
  "ssoid",
  // 工号类字段也是合法的唯一锚点（比 email / 账号更权威）
  "employeeid",
  "empid",
  "jobnumber",
  "workno",
  "workcode",
  "staffid",
  "staffnumber",
  "employeenumber",
];
const ID_WEAK_ALIASES: readonly string[] = [
  "account",
  "username",
  "email",
  // 兜底：响应只给了姓名时以姓名为锚（自验工具，宽容优先）
  "name",
  "displayname",
];
/** id 别名中「实际是工号」的键：命中时 employeeId 一并落值。 */
const ID_AS_EMPLOYEE_ALIASES: ReadonlySet<string> = new Set([
  "employeeid",
  "empid",
  "jobnumber",
  "workno",
  "workcode",
  "staffid",
  "staffnumber",
  "employeenumber",
]);
const NAME_ALIASES: readonly string[] = [
  "name",
  "username",
  "displayname",
  // W3 网关的姓名字段（Issue #247：`{uid, givenName}`）
  "givenname",
  "realname",
  "fullname",
  "nickname",
  "chinesename",
  "cn",
];
const EMPLOYEE_ALIASES: readonly string[] = [
  "employeeid",
  "jobnumber",
  "workno",
  "workcode",
  "staffid",
  "staffnumber",
  "employeenumber",
  "employeeno",
  "empid",
  "jobno",
];
const EMAIL_ALIASES: readonly string[] = [
  "email",
  "mail",
  "useremail",
  "emailaddress",
];
const DEPARTMENT_ALIASES: readonly string[] = [
  "department",
  "dept",
  "deptname",
  "departmentname",
  "org",
  "orgname",
  "organization",
  "organizationname",
];

/** 常见响应包裹层：身份字段可能不在顶层而在其中之一（只下探一层）。 */
const ENVELOPE_KEYS: readonly string[] = [
  "data",
  "result",
  "user",
  "userinfo",
  "profile",
  "content",
  "detail",
];

/** 候选对象：键「小写 + 去下划线」索引（大小写 / snake_case 一视同仁）。 */
function fieldIndex(value: unknown): Map<string, string> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const index = new Map<string, string>();
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    // 字段值只认非空字符串（数字工号等由服务端序列化，不做隐式转型）
    if (typeof raw === "string" && raw.trim() !== "") {
      index.set(key.toLowerCase().replaceAll("_", ""), raw.trim());
    }
  }
  return index;
}

function pick(
  index: Map<string, string>,
  aliases: readonly string[],
): string | null {
  for (const alias of aliases) {
    const hit = index.get(alias);
    if (hit !== undefined) {
      return hit;
    }
  }
  return null;
}

/**
 * 解析 SSO 认证接口返回的用户身份。
 *
 * 容错规则：
 * - 响应必须是 JSON 对象（数组 / 标量 / 断流文本直接报错并附原文片段）；
 * - 顶层没有身份字段时依次下探包裹层（data / result / user / …）；
 * - userId 按强锚点 → 弱锚点两轮取第一个命中（强锚点全局优先于弱锚点，
 *   同轮内顶层优先）；命中工号类键时 employeeId 一并落值；响应缺姓名时
 *   回落 userId；
 * - 一个身份锚点都找不到时报错并列出顶层键名——契约差异第一时间可见，
 *   而不是落一个空身份进持久化。
 */
export function parseSsoIdentity(bodyText: string): SsoIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText) as unknown;
  } catch {
    throw new Error(
      `SSO 响应不是合法 JSON：${bodyText.trim().slice(0, 200) || "(空响应体)"}`,
    );
  }

  const root = fieldIndex(parsed);
  if (root === null) {
    throw new Error(
      `SSO 响应不是 JSON 对象：${bodyText.trim().slice(0, 200) || "(空响应体)"}`,
    );
  }

  // 候选顺序：顶层优先（显式契约），随后是各包裹层
  const candidates: Map<string, string>[] = [root];
  const source = parsed as Record<string, unknown>;
  for (const key of ENVELOPE_KEYS) {
    const nested = fieldIndex(source[key]);
    if (nested !== null) {
      candidates.push(nested);
    }
  }

  let idHit: {
    index: Map<string, string>;
    value: string;
    isEmployee: boolean;
  } | null = null;
  // 强锚点优先（显式 id / 工号），全落空才用弱锚点（账号 / 邮箱 / 姓名）
  for (const aliases of [ID_STRONG_ALIASES, ID_WEAK_ALIASES]) {
    if (idHit !== null) {
      break;
    }
    for (const index of candidates) {
      for (const alias of aliases) {
        const value = index.get(alias);
        if (value !== undefined) {
          idHit = {
            index,
            value,
            isEmployee: ID_AS_EMPLOYEE_ALIASES.has(alias),
          };
          break;
        }
      }
      if (idHit !== null) {
        break;
      }
    }
  }
  if (idHit === null) {
    const topKeys = [...Object.keys(source)].join(", ") || "(无字段)";
    throw new Error(
      `无法从 SSO 响应中解析用户身份（顶层字段：${topKeys}）——请核对认证接口返回的契约`,
    );
  }

  // 其余字段优先取锚点所在层，缺了再回落顶层（包裹层常只带部分字段）
  const byAliases = (aliases: readonly string[]): string | null =>
    pick(idHit.index, aliases) ?? pick(root, aliases);

  const employeeId = idHit.isEmployee
    ? idHit.value
    : byAliases(EMPLOYEE_ALIASES);
  const name = byAliases(NAME_ALIASES) ?? idHit.value;
  return {
    userId: idHit.value,
    name,
    employeeId,
    email: byAliases(EMAIL_ALIASES),
    department: byAliases(DEPARTMENT_ALIASES),
  };
}
