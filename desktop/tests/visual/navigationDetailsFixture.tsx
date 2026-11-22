import type { PlanEntry } from "../../src/contracts/acp/protocol.ts";
import { taskProgressSummary } from "../../src/plugins/project/conversation/sessionStatusModel.ts";
import { StatusTaskProgress } from "../../src/plugins/project/conversation/ui/StatusTaskProgress.tsx";
import { TurnStatusRow } from "../../src/plugins/project/conversation/ui/InputStatusBar.tsx";
import { EditDiffView } from "../../src/plugins/project/conversation/ui/EditDiffView.tsx";
import { SubagentToolRow } from "../../src/plugins/project/conversation/ui/SubagentToolRow.tsx";
import { QuotaContent } from "../../src/plugins/agents/enhancements/codeagent/credit/QuotaContent.tsx";
import { StorageView } from "../../src/plugins/diagnostics/ui/StorageView.tsx";
import ProjectOverview from "../../src/plugins/project/ui/ProjectOverview.tsx";
import { MarkdownTable } from "../../src/shared/ui/markdown/MarkdownTable.tsx";

const steps: PlanEntry[] = Array.from({ length: 9 }, (_, index) => ({
  content: "核对发布事项 " + (index + 1),
  priority: "medium",
  status: index < 3 ? "completed" : index === 3 ? "in_progress" : "pending",
}));
const plan = taskProgressSummary(steps)!;
const makeLines = (prefix: string) =>
  Array.from(
    { length: 20 },
    (_, index) => prefix + "第 " + (index + 1) + " 行",
  ).join("\n");
const readStorage = () =>
  Promise.resolve([
    {
      id: "diagnostics.logs",
      label: "诊断日志",
      bytes: 825000000,
      count: 12,
      protected: 1,
      protectedBytes: 10000,
      cleanable: true,
      exact: true,
    },
  ]);

export function NavigationDetails() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl min-w-0 flex-col gap-4 bg-base p-2 text-ink">
      <ul aria-label="会话运行状态">
        <TurnStatusRow />
      </ul>
      <ProjectOverview path="D:/status-overlay" />
      <section aria-label="任务步骤">
        <StatusTaskProgress model={plan} />
      </section>
      <EditDiffView
        payload={{
          kind: "edit",
          path: "docs/releases/交接检查说明.md",
          oldString: makeLines("原始说明"),
          newString: makeLines("更新说明"),
        }}
      />
      <SubagentToolRow
        item={{
          kind: "tool",
          id: "batch-check",
          toolCallId: "batch-check",
          title: "核对部署步骤",
          toolKind: "other",
          status: "completed",
          rawInput: null,
          rawOutput: null,
          inputSummary: "",
          resultSummary: "",
          startedAt: 1,
          endedAt: 2,
        }}
        agent={{
          name: "Review",
          task: "核对部署步骤",
          stats: null,
          messages: [
            { id: "review", kind: "message", text: "已核对回滚记录。" },
          ],
        }}
      />
      <section aria-label="示例额度">
        <QuotaContent
          isLoading={false}
          result={{
            status: "ready",
            snapshot: {
              fetchedAt: 0,
              rows: [
                {
                  kind: "CPM",
                  used: 25432,
                  total: 400000,
                  resetAt: null,
                  message: null,
                },
              ],
            },
          }}
        />
      </section>
      <StorageView request={readStorage} />
      <section aria-label="对照表格">
        <MarkdownTable>
          <thead>
            <tr>
              {Array.from({ length: 6 }, (_, index) => (
                <th key={index}>发布阶段与负责人 {index + 1}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              {Array.from({ length: 6 }, (_, index) => (
                <td key={index}>交接记录与验收结果 {index + 1}</td>
              ))}
            </tr>
          </tbody>
        </MarkdownTable>
      </section>
    </main>
  );
}
