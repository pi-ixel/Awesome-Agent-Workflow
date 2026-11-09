/**
 * core/auth 测试：SSO 响应宽松契约解析（顶层 / 包裹层 / 别名 / 大小写）、
 * 失败分支（非 JSON / 非对象 / 无身份锚点）与传输结果守卫。
 */
import { describe, expect, it } from "vitest";

import { asSsoFetchWire } from "../../src/contracts/sso.ts";
import {
  describeSsoHttpFailure,
  parseSsoIdentity,
} from "../../src/plugins/account/identity.ts";

describe("parseSsoIdentity", () => {
  it("顶层平铺字段：camelCase 正常解析", () => {
    const identity = parseSsoIdentity(
      JSON.stringify({
        userId: "u-1024",
        name: "张三",
        employeeId: "100001",
        email: "zhangsan@example.com",
        department: "平台研发部",
      }),
    );
    expect(identity).toEqual({
      userId: "u-1024",
      name: "张三",
      employeeId: "100001",
      email: "zhangsan@example.com",
      department: "平台研发部",
    });
  });

  it("W3 网关实测契约：扁平 {uid, givenName}（Issue #247）", () => {
    const identity = parseSsoIdentity(
      JSON.stringify({ uid: "a00012345", givenName: "张三" }),
    );
    expect(identity).toEqual({
      userId: "a00012345",
      name: "张三", // givenName 命中姓名别名，不再回落成工号
      employeeId: null, // uid 不在工号类键里，employeeId 保持 null
      email: null,
      department: null,
    });
  });

  it("包裹层 data：身份字段在信封内也能解析", () => {
    const identity = parseSsoIdentity(
      JSON.stringify({
        code: 0,
        message: "ok",
        data: {
          uid: "sso-abc",
          displayName: "李四",
          jobNumber: "200002",
          mail: "lisi@example.com",
          deptName: "质量部",
        },
      }),
    );
    expect(identity).toEqual({
      userId: "sso-abc",
      name: "李四",
      employeeId: "200002",
      email: "lisi@example.com",
      department: "质量部",
    });
  });

  it("snake_case / PascalCase 别名大小写不敏感", () => {
    const identity = parseSsoIdentity(
      JSON.stringify({
        User_Id: "p-7",
        RealName: "王五",
        employee_id: "300003",
      }),
    );
    expect(identity.userId).toBe("p-7");
    expect(identity.name).toBe("王五");
    expect(identity.employeeId).toBe("300003");
  });

  it("锚点命中工号类键时 employeeId 一并落值", () => {
    const identity = parseSsoIdentity(
      JSON.stringify({ jobNumber: "400004", userName: "赵六" }),
    );
    expect(identity.userId).toBe("400004");
    expect(identity.employeeId).toBe("400004");
    expect(identity.name).toBe("赵六");
  });

  it("缺姓名字段时回落唯一标识；缺可选字段为 null", () => {
    const identity = parseSsoIdentity(JSON.stringify({ id: "only-id" }));
    expect(identity.userId).toBe("only-id");
    expect(identity.name).toBe("only-id");
    expect(identity.employeeId).toBeNull();
    expect(identity.email).toBeNull();
    expect(identity.department).toBeNull();
  });

  it("字段值在锚点层缺失时回落顶层（包裹层只带部分字段）", () => {
    const identity = parseSsoIdentity(
      JSON.stringify({
        name: "孙七",
        department: "架构组",
        data: { userId: "wrap-9" },
      }),
    );
    expect(identity.userId).toBe("wrap-9");
    expect(identity.name).toBe("孙七");
    expect(identity.department).toBe("架构组");
  });

  it("非 JSON 响应报错并附原文片段", () => {
    expect(() => parseSsoIdentity("<html>login page</html>")).toThrow(
      /SSO 响应不是合法 JSON/,
    );
    expect(() => parseSsoIdentity("")).toThrow(/空响应体/);
  });

  it("JSON 数组 / 标量响应报错", () => {
    expect(() => parseSsoIdentity("[1,2,3]")).toThrow(/不是 JSON 对象/);
    expect(() => parseSsoIdentity('"ok"')).toThrow(/不是 JSON 对象/);
  });

  it("无任何身份锚点：报错并列出顶层字段（契约差异可见）", () => {
    expect(() =>
      parseSsoIdentity(JSON.stringify({ code: 1, message: "未登录" })),
    ).toThrow(/顶层字段：code, message/);
  });

  it("空字符串 / 空白字段不作为锚点", () => {
    expect(() =>
      parseSsoIdentity(JSON.stringify({ userId: "  ", name: "" })),
    ).toThrow(/顶层字段/);
  });
});

describe("asSsoFetchWire / describeSsoHttpFailure", () => {
  it("合法 wire 形状通过；形状不对抛错", () => {
    expect(asSsoFetchWire({ status: 200, body: "{}" })).toEqual({
      status: 200,
      body: "{}",
    });
    expect(() => asSsoFetchWire({ status: 200 })).toThrow(/返回形状不合法/);
    expect(() => asSsoFetchWire(null)).toThrow(/返回形状不合法/);
  });

  it("非 2xx 文案带状态码与 body 片段（截断 300 字符）", () => {
    const message = describeSsoHttpFailure({
      status: 502,
      body: "x".repeat(400),
    });
    expect(message).toContain("HTTP 502");
    expect(message).toHaveLength("SSO 认证接口返回 HTTP 502：".length + 300);
    expect(describeSsoHttpFailure({ status: 500, body: "  " })).toContain(
      "空响应体",
    );
  });
});
