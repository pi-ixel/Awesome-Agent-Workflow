import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expandCaseReferences } from "../../../scripts/browserCoverage.ts";
import {
  classifyBrowserContractChange,
  validateBrowserCrossSurfaceCoverage,
  validateBrowserDependencies,
  validateBrowserDocumentPairing,
  validateBrowserTraceability,
  verifyBrowserDesignBaseline,
} from "../../../scripts/browserArchitecture.ts";

describe("TD-00-U01/U02 浏览器依赖规则", () => {
  it("无环依赖通过，有环依赖返回完整路径", () => {
    expect(
      validateBrowserDependencies([
        { from: "host", to: "contracts" },
        { from: "runtime", to: "contracts" },
      ]).cycles,
    ).toEqual([]);
    expect(
      validateBrowserDependencies([
        { from: "contracts", to: "runtime" },
        { from: "runtime", to: "contracts" },
      ]).cycles,
    ).toEqual([["contracts", "runtime", "contracts"]]);
  });

  it("识别跨层禁止依赖", () => {
    expect(
      validateBrowserDependencies([
        { from: "mcp", to: "acp" },
        { from: "ui", to: "mcp" },
      ]).forbiddenEdges,
    ).toEqual([
      { from: "mcp", to: "acp" },
      { from: "ui", to: "mcp" },
    ]);
  });
});

describe("TD-00-U03 契约兼容", () => {
  it("只有不改变既有必填字段、枚举和工具的变更兼容", () => {
    expect(
      classifyBrowserContractChange({
        requiredFieldAdded: false,
        requiredFieldRemoved: false,
        enumChanged: false,
        toolRemoved: false,
      }).compatibility,
    ).toBe("compatible");
    expect(
      classifyBrowserContractChange({
        requiredFieldAdded: true,
        requiredFieldRemoved: false,
        enumChanged: false,
        toolRemoved: false,
      }).compatibility,
    ).toBe("breaking");
  });
});

describe("TD-00-U04/U05/U06 文档追踪", () => {
  it("识别缺失详设、测试和验收，保留明确延期项", () => {
    expect(
      validateBrowserTraceability({
        designs: ["UC_READ"],
        tests: ["UC_READ"],
        acceptance: [],
        deferred: ["P2_RECORDING"],
      }),
    ).toEqual({
      missingDesign: [],
      missingTests: [],
      missingAcceptance: ["UC_READ"],
      unknownTestCases: [],
      deferred: ["P2_RECORDING"],
    });
  });

  it("详设和测试按数字前缀唯一配对", () => {
    expect(
      validateBrowserDocumentPairing(["00总览", "01核心"], ["00测试"]),
    ).toEqual({
      missingTestDocuments: ["01"],
      missingDesignDocuments: [],
      duplicatePairs: [],
    });
  });
});

describe("TD-00-U07 交叉组合覆盖", () => {
  it("缺项和未评审豁免均阻断", () => {
    expect(
      validateBrowserCrossSurfaceCoverage({
        required: ["multi-window", "update-active-operation"],
        covered: ["multi-window"],
        exemptions: ["unreviewed"],
      }),
    ).toEqual({
      uncoveredCombinations: ["update-active-operation"],
      unreviewedExemptions: ["unreviewed"],
    });
  });
});

describe("TD-00-I03 基线文档数据层校验", () => {
  it("真实基线目录中的十份详设与测试设计完整配对", () => {
    expect(verifyBrowserDesignBaseline("docs/内嵌浏览器/详细设计")).toEqual({
      missingDesignLinks: [],
      missingTestLinks: [],
      designDocumentCount: 10,
      testDesignDocumentCount: 10,
    });
  });
});

describe("TD-00-U06 用例编号追踪", () => {
  it("组合编号展开为独立基线用例且不重复", () => {
    expect(
      expandCaseReferences("TD-02-U01/U09 与 td_04_i08，重复 TD-02-U01"),
    ).toEqual(["TD-02-U01", "TD-02-U09", "TD-04-I08"]);
  });
});

describe("TD-009 原生页面首次可见时序", () => {
  it("原生页面在布局和可见性生效前必须保持隐藏", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src-tauri/src/browser/host.rs"),
      "utf8",
    );
    const hidden = source.indexOf("created.hide()");
    const bridge = source.indexOf("register_user_message_bridge");
    expect(hidden).toBeGreaterThanOrEqual(0);
    expect(hidden).toBeLessThan(bridge);
  });
});

describe("TD-024-U03 原生接管桥安全边界", () => {
  it("只有玻璃真实用户事件能请求接管，MCP 不新增隐式授权", () => {
    const host = readFileSync(
      resolve(process.cwd(), "src-tauri/src/browser/host.rs"),
      "utf8",
    );
    const mcp = readFileSync(
      resolve(process.cwd(), "src-tauri/src/browser/mcp.rs"),
      "utf8",
    );
    expect(host).not.toContain("runtime.user_input");
    expect(host).toContain("user-takeover");
    expect(host).toContain("event.isTrusted");
    expect(host).toContain("controlGeneration");
    const requestControl = mcp.slice(
      mcp.indexOf('"browser_request_control"'),
      mcp.indexOf('"browser_handoff"'),
    );
    expect(requestControl).not.toContain("require_approval");
    expect(requestControl).not.toContain("grant_control");
    const handoff = mcp.slice(
      mcp.indexOf('"browser_handoff"'),
      mcp.indexOf('"browser_list_tabs"'),
    );
    expect(handoff).toContain("CONTROL_SWITCH_REQUIRED");
    expect(handoff).not.toContain("release_control");
  });
});
