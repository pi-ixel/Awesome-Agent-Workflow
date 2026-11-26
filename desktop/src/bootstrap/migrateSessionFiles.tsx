import { clearRecoveryImages } from "./clearRecoveryImages.ts";
import { createRoot } from "react-dom/client";
import {
  desktopManagedStorage,
  prepareSessionRecovery,
  type MigrationReport,
} from "../plugins/host/service.ts";
import { ActionButton } from "../shared/ui/controls.tsx";
import { ModalShell } from "../shared/ui/ModalShell.tsx";
import "../shared/styles/index.css";

/** Finish the native upgrade before appMain starts services that can write history. */
export async function migrateSessionFiles(): Promise<void> {
  if (!desktopManagedStorage.available()) return;
  const container = document.getElementById("root");
  if (!container) throw new Error("找不到工作台容器");
  const root = createRoot(container);
  const metadataKeys = [
    "aaw-desktop/session-project-owners.v1",
    "aaw-desktop/session-working-directories.v1",
    "aaw-desktop/session-unread-replies.v1",
    "aaw-desktop/archived-sessions.v1",
    "aaw-desktop/archived-session-metadata.v1",
    ...Object.keys(localStorage).filter((key) =>
      key.startsWith("aaw-desktop/session-title/") ||
      key.startsWith("aaw-desktop/session-title.v2/")),
  ];
  const show = (message: string, label?: string, action?: () => void) => {
    root.render(
      <ModalShell
        label="迁移会话数据"
        dismissOnBackdrop={false}
        onDismiss={() => {}}
      >
        <section className="flex flex-col gap-4 p-5">
          <h2 className="text-ui-lg font-semibold text-ink">迁移会话数据</h2>
          <p
            role="status"
            className="max-h-[55vh] overflow-y-auto whitespace-pre-line break-words text-sm text-ink-soft"
          >
            {message}
          </p>
          {label && (
            <ActionButton tone="primary" onClick={action}>
              {label}
            </ActionButton>
          )}
        </section>
      </ModalShell>,
    );
  };
  try {
    for (;;) {
      // A clean install or a completed upgrade usually finishes before the dialog paints.
      const pending = window.setTimeout(
        () => show("正在校验并迁移会话文件…"),
        150,
      );
      let report: MigrationReport;
      try {
        report = await desktopManagedStorage.request<MigrationReport>(
          "migrate_session_files",
          {
            webviewIndex: Object.fromEntries(
              ["aaw-desktop/workspace/v1", ...metadataKeys].map((key) =>
                [key, window.localStorage.getItem(key)]),
            ),
          },
        );
        await prepareSessionRecovery(report, clearRecoveryImages);
        for (const key of metadataKeys) localStorage.removeItem(key);
      } catch (error) {
        window.clearTimeout(pending);
        await new Promise<void>((retry) => show(String(error), "重试", retry));
        continue;
      }
      window.clearTimeout(pending);
      const cleaned = report.recovery.filter(
        (item) => item.phase === "webview",
      );
      if (
        report.completed.length ||
        report.moved > 0 ||
        cleaned.length ||
        report.deleted_orphans?.length ||
        report.retained_orphans?.length
      ) {
        await new Promise<void>((done) =>
          show(
            [
              `已完成 ${report.completed.length} 个会话的迁移校验。`,
              ...report.completed.map(
                ({ agentId, project, sessionId }) =>
                  `${agentId} · ${project} · ${sessionId}：迁移完成`,
              ),
              ...(report.deleted_orphans ?? []).map(
                (scope) => `已删除无会话归属的旧历史 · ${scope}`,
              ),
              ...(report.retained_orphans ?? []).map(
                (scope) => `归属待核对，已保留旧历史 · ${scope}`,
              ),
              ...cleaned.map(
                ({ owner }) =>
                  `${owner.agentId} · ${owner.project} · ${owner.sessionId} 的本地历史已清理。打开会话时将从 Agent 恢复。`,
              ),
            ].join("\n"),
            "进入工作台",
            done,
          ),
        );
      }
      return;
    }
  } finally {
    root.unmount();
  }
}
