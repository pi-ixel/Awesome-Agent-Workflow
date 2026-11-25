import { createRoot } from "react-dom/client";
import { useLayoutEffect, useMemo, useState } from "react";
import { createStore } from "zustand/vanilla";
import { ConversationTurnView } from "../../src/plugins/project/conversation/ui/ConversationTurnView.tsx";
import { createProjectForeground } from "../../src/plugins/project/conversation/foreground.ts";
import {
  ProjectViewContext,
  type ProjectViewBinding,
} from "../../src/plugins/project/ui/bindings/projectView.tsx";
import { emptyWorkspace } from "../../src/plugins/project/workspace/types.ts";
import type {
  ChangesView,
  TurnChangesSession,
} from "../../src/plugins/project/conversation/changes/service.ts";
import type { TurnChangesRecord } from "../../src/contracts/turnChanges/types.ts";
import { HintTooltip } from "../../src/shared/ui/controls/HintTooltip.tsx";
import "../../src/shared/styles/index.css";

const base: TurnChangesRecord = {
  id: "preview-turn",
  userId: "preview-user",
  startedAt: 1,
  endedAt: 2,
  status: "completed",
  snapshotState: "saved",
  concurrent: false,
  hasOperations: true,
  incomplete: [],
  restored: [],
  canUndo: false,
  results: [],
  files: [
    {
      path: "src/browser/systemFallback.ts",
      kind: "modified",
      oldPath: undefined,
      before:
        'export async function openTargetUrl(url: string) {\n  if (!embeddedBrowser.isReady()) {\n    logger.warn("AAW embedded browser unavailable, falling back to OS default");\n    return await launchSystemDefaultBrowser(url);\n  }\n  return await embeddedBrowser.navigate(url);\n}\n',
      after:
        'export async function openTargetUrl(url: string) {\n  if (!embeddedBrowser.isReady()) {\n    throw new BrowserError("AAW_BROWSER_UNAVAILABLE");\n  }\n  return await embeddedBrowser.navigate(url);\n}\n',
      added: 1,
      removed: 2,
      notice: null,
      canRestore: true,
    },
    {
      path: "config/tools.legacy.json",
      kind: "deleted",
      before: '{\n  "systemBrowserFallback": true\n}\n',
      after: null,
      added: 0,
      removed: 3,
      notice: null,
      canRestore: true,
    },
    {
      path: "tests/browser/browserGuard.test.ts",
      kind: "added",
      before: null,
      after:
        'it("不会调用系统浏览器", async () => {\n  await expect(openTargetUrl(url)).rejects.toThrow("AAW_BROWSER_UNAVAILABLE");\n  expect(execFileAsync).not.toHaveBeenCalled();\n});\n',
      added: 4,
      removed: 0,
      notice: null,
      canRestore: true,
    },
  ],
};
const demo = new URLSearchParams(location.search);
const useLargeDiff = demo.has("large-diff");
const useDeferredDetails = demo.has("deferred-details");
const largeDiff: TurnChangesRecord = {
  ...base,
  files: [
    {
      ...base.files[0]!,
      before:
        Array.from(
          { length: 1100 },
          (_, index) => `before-${index + 1} ${"x".repeat(index % 2 ? 92 : 8)}`,
        ).join("\n") + "\n",
      after: Array.from(
        { length: 1100 },
        (_, index) => `after-${index + 1} ${"y".repeat(index % 2 ? 11 : 145)}`,
      ).join("\n"),
      added: 1100,
      removed: 1100,
    },
    ...base.files.slice(1),
  ],
};
const foreground = createProjectForeground();
const binding = {
  project: {
    projects: {
      workspace: createStore(() => ({
        ...emptyWorkspace,
        activePath: "D:/preview",
      })),
    },
    sessions: { activity: createStore(() => ({ entries: {} })) },
    conversation: { foreground: foreground.snapshot },
  },
  isActive: () => true,
} as unknown as ProjectViewBinding;
function Preview() {
  const [mode, setMode] = useState("complete");
  const [warm, setWarm] = useState(false);
  const [state] = useState(() =>
    createStore<ChangesView>(() => ({
      openRevision: useDeferredDetails ? 0 : 1,
      records: [
        useDeferredDetails
          ? {
              ...base,
              detailsDeferred: true,
              files: base.files.map((file) => ({
                ...file,
                before: null,
                after: null,
              })),
            }
          : useLargeDiff
            ? largeDiff
            : demo.has("journal-fragments")
              ? {
                  ...base,
                  files: [
                    {
                      ...base.files[0]!,
                      before: null,
                      after: null,
                      added: null,
                      removed: null,
                      canRestore: false,
                      fragments: [
                        ["first-old", "first-new"],
                        ["second-old", "second-new"],
                      ],
                    },
                  ],
                }
              : base,
      ],
      selected: base.id,
      phase: "idle",
      error: null,
      message: null,
    })),
  );
  const changes = useMemo<TurnChangesSession>(
    () => ({
      state,
      journal: false,
      recordSubmission: () => {},
      submitted: () => {},
      finish: () => Promise.resolve(),
      select: (id) =>
        state.setState({
          selected: id,
          openRevision: state.getState().openRevision + 1,
        }),
      dispose: () => Promise.resolve(),
      dismiss: () => state.setState({ message: null }),
      refresh: () => {
        if (useDeferredDetails) {
          state.setState({ records: [base] });
          return Promise.resolve();
        }
        state.setState({ error: "文件仍有后续修改，未执行撤销。" });
        return Promise.resolve();
      },
      restore: (paths) => {
        const record = state.getState().records[0]!;
        if (mode === "conflict") {
          state.setState({
            error: "文件已有后续修改，整批操作未执行。",
            records: [
              {
                ...record,
                results: paths.map((path) => ({
                  path,
                  status: "conflict",
                  message: "文件在本轮结束后又被修改",
                })),
              },
            ],
          });
        } else if (mode === "failure") {
          state.setState({
            error: "已撤销 1 个文件，1 个失败，其余未执行。",
            records: [
              {
                ...record,
                restored: [paths[0]!],
                canUndo: true,
                results: paths.map((path, index) => ({
                  path,
                  status:
                    index === 0
                      ? "restored"
                      : index === 1
                        ? "failed"
                        : "skipped",
                  message:
                    index === 0
                      ? "已撤销"
                      : index === 1
                        ? "文件被其他程序占用"
                        : "未执行",
                })),
              },
            ],
          });
        } else
          state.setState({
            records: [
              {
                ...record,
                restored: [...new Set([...record.restored, ...paths])],
                canUndo: true,
              },
            ],
            message: `已撤销 ${paths.length} 个文件`,
          });
        return Promise.resolve();
      },
      undo: () => {
        const record = state.getState().records[0]!;
        state.setState({
          records: [{ ...record, restored: [], canUndo: false, results: [] }],
          message: "已恢复改动",
          error: null,
        });
        return Promise.resolve();
      },
    }),
    [state, mode],
  );
  useLayoutEffect(() => {
    foreground.view.session.setState({ turnChanges: changes });
  }, [changes]);
  const reset = (next: string) => {
    setMode(next);
    const record: TurnChangesRecord = {
      ...base,
      status: ["unknown", "connection", "timeout", "runtime"].includes(next)
        ? ("unknown" as const)
        : next === "running"
          ? ("running" as const)
          : next === "cancelled"
            ? ("cancelled" as const)
            : ("completed" as const),
      endedAt: ["running", "settling"].includes(next) ? null : 2,
      concurrent: next === "concurrent",
      unknownReason:
        next === "connection" || next === "timeout" || next === "runtime"
          ? next
          : undefined,
      snapshotState:
        next === "snapshot-failed"
          ? "failed"
          : ["running", "settling"].includes(next)
            ? "pending"
            : "saved",
      files:
        next === "zero" || next === "missing-baseline"
          ? []
          : next === "legacy-large" || next === "partial-large"
            ? [
                {
                  ...base.files[2]!,
                  path: "hello.ts",
                  after: "console.log('Hello, World!');\n",
                  added: 1,
                },
                ...(next === "legacy-large"
                  ? Array.from({ length: 853 }, (_, index) => ({
                      ...base.files[0]!,
                      path: `.agents/skills/untouched-${index}/README.md`,
                      kind: "unknown" as const,
                      before: null,
                      added: null,
                      removed: null,
                      canRestore: false,
                      notice: "前后内容采集不完整",
                    }))
                  : []),
              ]
            : next === "newline"
              ? [
                  {
                    ...base.files[0]!,
                    before: "same\n",
                    after: "same",
                    added: 1,
                    removed: 1,
                  },
                ]
              : base.files,
      unverified:
        next === "missing-baseline"
          ? [
              {
                ...base.files[0]!,
                kind: "unknown",
                before: null,
                added: null,
                removed: null,
                canRestore: false,
                notice: "有写入证据，但开始时内容未采集",
              },
            ]
          : [],
      incomplete: ["incomplete", "partial-large", "legacy-large"].includes(next)
        ? ["部分目录未完成采集"]
        : [],
    };
    state.setState({
      records:
        next === "legacy-empty" || next === "preparing"
          ? []
          : ["chat-running", "chat-zero", "next-diff"].includes(next)
            ? [
                { ...base, locked: true },
                {
                  ...base,
                  id: "next-turn",
                  userId: "next-user",
                  startedAt: 3,
                  endedAt: next === "chat-running" ? null : 4,
                  snapshotState: next === "chat-running" ? "pending" : "saved",
                  files:
                    next === "next-diff"
                      ? [{ ...base.files[2]!, path: "new-file.ts" }]
                      : next === "chat-running"
                        ? base.files
                        : [],
                },
              ]
            : [record],
      selected: record.id,
      phase:
        next === "settling"
          ? "settling"
          : next === "preparing"
            ? "preparing"
            : "idle",
      error: null,
      message: null,
    });
  };
  return (
    <ProjectViewContext.Provider value={binding}>
      <div className="flex h-full flex-col bg-base p-5 text-ui-base text-ink">
        <div className="mb-4 flex flex-wrap items-center gap-3 border-b border-line pb-3">
          <span>轮次变更 · 开发预览</span>
          <label>
            场景{" "}
            <select
              className="rounded border border-line bg-surface px-2 py-1"
              value={mode}
              onChange={(event) => reset(event.target.value)}
            >
              {[
                ["complete", "已完成"],
                ["conflict", "后续修改冲突"],
                ["failure", "批量部分失败"],
                ["unknown", "执行结果未知"],
                ["connection", "连接中断未收到结束确认"],
                ["timeout", "结束响应超时"],
                ["runtime", "运行实例变化"],
                ["snapshot-failed", "执行结束但变更未保存"],
                ["settling", "正在保存最终变更"],
                ["running", "执行中"],
                ["cancelled", "已取消并停止"],
                ["concurrent", "并发归因不确定"],
                ["incomplete", "统计不完整"],
                ["zero", "无净变更"],
                ["newline", "文件末尾换行变化"],
                ["missing-baseline", "缺少开始内容"],
                ["chat-running", "新消息执行中，旧卡只读"],
                ["chat-zero", "新轮纯聊天，保留旧卡"],
                ["next-diff", "新轮有变更，替换旧卡"],
                ["legacy-empty", "旧会话无快照"],
                ["preparing", "准备基线，不显示卡片"],
                ["partial-large", "大仓库只新增 hello.ts"],
                ["legacy-large", "旧记录含 853 个采集缺口"],
              ].map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button
            className="rounded border border-line px-2 py-1"
            onClick={() => {
              document.documentElement.classList.toggle("theme-warm");
              setWarm(!warm);
            }}
          >
            {warm ? "切换暗夜" : "切换暖白"}
          </button>
        </div>
        <div
          className="min-h-0 flex-1 overflow-auto px-4 py-5"
          data-message-list
        >
          <div className="mx-auto max-w-4xl space-y-8" data-chat-content>
            {[
              "preview-user",
              ...(["chat-running", "chat-zero", "next-diff"].includes(mode)
                ? ["next-user"]
                : []),
            ].map((id) => (
              <div key={id} data-preview-turn={id}>
                <ConversationTurnView
                  turn={{
                    id,
                    user: {
                      kind: "user",
                      id,
                      text:
                        id === "preview-user"
                          ? "修复浏览器问题，补充测试。"
                          : "下一条消息",
                      createdAt: "",
                    },
                    history: [],
                    answer: {
                      kind: "assistant",
                      isStreaming: false,
                      id: `${id}-answer`,
                      text: "已完成本轮请求。",
                      createdAt: "",
                    },
                    running: false,
                  }}
                  renderItem={(item) => (
                    <p className="py-2">{"text" in item ? item.text : ""}</p>
                  )}
                />
              </div>
            ))}
          </div>
        </div>
        <div
          data-composer-dock
          className="shrink-0 rounded-lg border border-line bg-surface p-3 text-ui-sm text-ink-mute"
        >
          输入消息，Enter 发送，Shift+Enter 换行
          <div className="mt-6">CodeAgent</div>
        </div>
        <HintTooltip />
      </div>
    </ProjectViewContext.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
