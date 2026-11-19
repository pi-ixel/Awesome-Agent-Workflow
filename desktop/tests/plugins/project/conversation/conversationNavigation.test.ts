import type { SessionItem } from "../../../../src/plugins/project/types.ts";
import { describe, expect, it } from "vitest";
import {
  activeQueryAt,
  buildQueryNavigation,
  createQueryNavigationBuilder,
} from "../../../../src/plugins/project/conversation/ui/conversationNavigation.ts";

const user = (id: string, text: string): SessionItem => ({
  kind: "user",
  id,
  text,
  createdAt: "",
});
const answer = (id: string, text: string): SessionItem => ({
  kind: "assistant",
  id,
  text,
  isStreaming: false,
  createdAt: "",
});
describe("提问目录", () => {
  it("每条用户提问单独建项，摘要不串轮；只强调最后正在处理的提问", () => {
    const result = buildQueryNavigation(
      [
        user("u1", "第一个问题"),
        answer("a1", "第一段\n\n第二段\n\n第三段"),
        user("u2", "追加问题"),
        user("u3", "最新问题"),
      ],
      true,
    );
    expect(result.map((item) => item.id)).toEqual(["u1", "u2", "u3"]);
    expect(result[0]).toMatchObject({
      answer: "第一段\n第二段",
      itemIndex: 0,
      running: false,
    });
    expect(result[1]).toMatchObject({ answer: "暂无文字回复", running: false });
    expect(result[2]).toMatchObject({
      answer: "正在处理这条提问…",
      running: true,
    });
  });
  it("超长预览截断；没有用户提问不凭空生成目录", () => {
    expect(buildQueryNavigation([answer("a", "上下文")], false)).toEqual([]);
    expect(
      buildQueryNavigation([user("u", "长".repeat(500))], false)[0]?.question
        .length,
    ).toBe(220);
  });
  it("窗口从旧回复中间开始时，高亮未挂载的上一条提问；越过下个锚点再切换", () => {
    const items = buildQueryNavigation(
      [
        user("u1", "一"),
        answer("a1", "回复"),
        user("u2", "二"),
        answer("a2", "回复"),
      ],
      false,
    );
    const positions = [{ id: "u2", top: 600 }];
    expect(activeQueryAt(items, positions, 50, 1)).toBe("u1");
    expect(activeQueryAt(items, positions, 600, 1)).toBe("u2");
  });
  it("增量构建与完整构建一致，仅重算改变的提问，支持前插、删减和运行态切换", () => {
    const builder = createQueryNavigationBuilder();
    const first = user("u1", "首个问题");
    const firstAnswer = answer("a1", "第一段\n\n第二段");
    const second = user("u2", "第二问题");
    const secondAnswer = answer("a2", "实时回复");
    const items = [first, firstAnswer, second, secondAnswer];
    const initial = builder.build(items, false);
    expect(initial).toEqual(buildQueryNavigation(items, false));
    expect(builder.build([...items], false)).toBe(initial);

    const nextItems = [
      first,
      firstAnswer,
      second,
      answer("a2", "实时回复已更新"),
    ];
    const updated = builder.build(nextItems, false);
    expect(updated).toEqual(buildQueryNavigation(nextItems, false));
    expect(updated[0]).toBe(initial[0]);
    expect(updated[1]).not.toBe(initial[1]);
    const running = builder.build(nextItems, true);
    expect(running).toEqual(buildQueryNavigation(nextItems, true));
    expect(running[0]).toBe(updated[0]);
    expect(running[1]).not.toBe(updated[1]);

    const prefixed = [user("new", "前插"), ...nextItems];
    expect(builder.build(prefixed, true)).toEqual(
      buildQueryNavigation(prefixed, true),
    );
    const shortened = [second, answer("a2", "新的上下文")];
    expect(builder.build(shortened, false)).toEqual(
      buildQueryNavigation(shortened, false),
    );
    const changedUser = [user("u2", "相同 ID 但内容不同"), shortened[1]!];
    expect(builder.build(changedUser, false)).toEqual(
      buildQueryNavigation(changedUser, false),
    );
    expect(builder.build(changedUser, false)[0]?.question).toBe(
      "相同 ID 但内容不同",
    );

    // SessionView 每个会话单独创建 builder，即使数据对象重用也不复用旧会话结果。
    const otherSession = createQueryNavigationBuilder().build(
      changedUser,
      false,
    );
    expect(otherSession).toEqual(buildQueryNavigation(changedUser, false));
    expect(otherSession[0]).not.toBe(builder.build(changedUser, false)[0]);
  });
  it("多段、空白、超长文本及相邻助手消息的增量摘要与原算法一致", () => {
    const builder = createQueryNavigationBuilder();
    const texts = [
      "",
      "  \n\n  ",
      "第一段\n\n第二段\n\n第三段",
      "A".repeat(219),
      "B".repeat(221),
      "  foo \t bar\r\n\n\n baz ",
      "尾部",
    ];
    let items: SessionItem[] = [user("q", "  问题\n\n补充  ")];
    for (const [index, text] of texts.entries()) {
      items = [...items, answer(`a${index}`, text)];
      expect(builder.build(items, index % 2 === 0)).toEqual(
        buildQueryNavigation(items, index % 2 === 0),
      );
      const reversed = [items[0]!, ...items.slice(1).reverse()];
      expect(builder.build(reversed, false)).toEqual(
        buildQueryNavigation(reversed, false),
      );
    }
  });
});
