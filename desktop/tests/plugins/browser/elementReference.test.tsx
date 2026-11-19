import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserElementSummary } from "../../../src/plugins/project/conversation/ui/BrowserElementSummary.tsx";
import {
  decodeAnnotationMessage,
  encodeAnnotationMessage,
} from "../../../src/plugins/project/composer/annotationMessage.ts";
import { createAnnotationDraftStore } from "../../../src/plugins/project/composer/annotationDraftStore.ts";
import { webviewStorage } from "../../../src/plugins/host/storage/storage.ts";
import { draftScopeKey } from "../../../src/plugins/project/composer/draftStore.ts";
import { browserElement } from "../../helpers/browserElement.ts";
import type { DocumentAnnotation } from "../../../src/plugins/documents/types.ts";

const annotation: DocumentAnnotation = {
  id: "annotation-1",
  project: "D:/project",
  path: "D:/project/design.md",
  source: false,
  quote: "目标文本",
  prefix: "",
  suffix: "",
  offset: 0,
  revision: "revision-1",
  comment: "请解释这段",
};

const scope = draftScopeKey("D:/project", "A");
const otherScope = draftScopeKey("D:/project", "B");

beforeEach(() => localStorage.clear());

describe("TD-026-B01 公开元素引用消息", () => {
  it("浏览器引用与文档批注共用版本化消息并保留用户正文", () => {
    const prompt = encodeAnnotationMessage(
      "说明我引用的元素",
      [annotation],
      [browserElement],
    );
    expect(decodeAnnotationMessage(prompt)).toMatchObject({
      text: "说明我引用的元素",
      annotations: [annotation],
      browserElements: [browserElement],
    });
    expect(prompt).toContain("AAW 页面元素引用");
  });

  it("仅浏览器引用也可往返，旧 version 1 文档消息仍兼容", () => {
    const browserOnly = encodeAnnotationMessage("", [], [browserElement]);
    expect(decodeAnnotationMessage(browserOnly)).toMatchObject({
      text: "",
      annotations: [],
      browserElements: [browserElement],
    });
    const legacy = encodeAnnotationMessage("旧批注", [annotation]);
    expect(decodeAnnotationMessage(legacy)).toMatchObject({
      text: "旧批注",
      annotations: [annotation],
      browserElements: [],
    });
  });

  it("ACP 序列化使用公开 URL 脱敏规则，不携带凭据、查询或片段", () => {
    const prompt = encodeAnnotationMessage(
      "检查来源",
      [],
      [
        {
          ...browserElement,
          url: "https://user:password@local.test/fixture?token=secret#private",
        },
      ],
    );
    expect(prompt).not.toContain("password");
    expect(prompt).not.toContain("token=secret");
    expect(prompt).not.toContain("private");
    expect(decodeAnnotationMessage(prompt)?.browserElements[0]?.url).toBe(
      "https://local.test/fixture",
    );
  });
});

describe("TD-026-B03 元素引用草稿持久化、恢复与隔离", () => {
  it("公开 putBrowserElements 写入当前会话，重启后恢复且不串 A/B", () => {
    const owner = createAnnotationDraftStore(webviewStorage);
    expect(owner.service.putBrowserElements(scope, [browserElement])).toBe(
      true,
    );
    owner.service.ensure(otherScope);
    expect(
      owner.service.getState().drafts[otherScope]?.browserElements,
    ).toEqual([]);

    const persisted = JSON.parse(
      localStorage.getItem(`${scope}/document-annotations-v1`) ?? "null",
    ) as { browserElements?: unknown };
    expect(persisted.browserElements).toEqual([browserElement]);

    const restarted = createAnnotationDraftStore(webviewStorage);
    restarted.service.ensure(scope);
    expect(restarted.service.getState().drafts[scope]?.browserElements).toEqual(
      [browserElement],
    );
    owner.dispose();
    restarted.dispose();
  });

  it("提交后重启标记未确认，恢复同时取回正文和引用，迁移不复制到其他会话", () => {
    const owner = createAnnotationDraftStore(webviewStorage);
    expect(owner.service.putBrowserElements(scope, [browserElement])).toBe(
      true,
    );
    const prompt = encodeAnnotationMessage(
      "保留这段正文",
      [],
      [browserElement],
    );
    const message = decodeAnnotationMessage(prompt);
    expect(message).toMatchObject({
      text: "保留这段正文",
      browserElements: [browserElement],
    });
    if (!message) throw new Error("ELEMENT_MESSAGE_NOT_DECODABLE");
    expect(owner.service.submit(scope, prompt)).toBe(true);
    expect(owner.service.getState().drafts[scope]?.browserElements).toEqual([]);

    const restarted = createAnnotationDraftStore(webviewStorage);
    restarted.service.ensure(scope);
    expect(
      restarted.service.getState().drafts[scope]?.submissions[message.id]
        ?.state,
    ).toBe("uncertain");
    expect(restarted.service.recover(scope, message.id)).toBe("保留这段正文");
    expect(restarted.service.getState().drafts[scope]?.browserElements).toEqual(
      [browserElement],
    );

    const fresh = draftScopeKey("D:/project", null);
    restarted.service.putBrowserElements(fresh, [browserElement]);
    restarted.service.migrate(fresh, otherScope);
    expect(
      restarted.service.getState().drafts[otherScope]?.browserElements,
    ).toEqual([browserElement]);
    expect(restarted.service.getState().drafts[fresh]?.browserElements).toEqual(
      [],
    );
    owner.dispose();
    restarted.dispose();
  });
});

describe("TD-026-B01 输入区元素芯片", () => {
  it("芯片显示定位摘要，删除回调直接携带 referenceId", () => {
    const onRemove = vi.fn(() => true);
    render(
      <BrowserElementSummary elements={[browserElement]} onRemove={onRemove} />,
    );
    expect(screen.getByText("点击验证")).toBeInTheDocument();
    expect(screen.getByText("#target")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "删除元素引用 点击验证" }),
    );
    expect(onRemove).toHaveBeenCalledExactlyOnceWith("element-1");
  });
});
