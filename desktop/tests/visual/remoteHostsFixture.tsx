import { createRoot } from "react-dom/client";
import { createStore } from "zustand";
import { RemoteHostsSettings } from "../../src/plugins/remoteProject/ui/RemoteHostsSettings.tsx";
import type {
  RemoteConnectionDTO,
  RemoteProjectService,
} from "../../src/plugins/remoteProject/service.ts";
import { SettingRow } from "../../src/shared/ui/SettingsPageParts.tsx";
import { settingsInputClass } from "../../src/shared/ui/inputStyles.ts";
import { ContextMenu } from "../../src/shared/ui/ContextMenu.tsx";
import { useMenuController } from "../../src/shared/ui/useMenuController.ts";
import { ActionButton } from "../../src/shared/ui/controls.tsx";
import "../../src/shared/styles/index.css";

const connection: RemoteConnectionDTO = {
  id: "dev",
  name: "开发服务器",
  host: "192.168.1.12",
  port: 22,
  user: "root",
  hasPassword: true,
  revision: 0,
};
const service = {
  projects: createStore(() => ({ records: [], recentDirsByConnection: {} })),
  listConnections: () => Promise.resolve([connection]),
  listProjectsForConnection: () => [],
  testConnection: () =>
    Promise.resolve({ ok: false, message: "连接超时，请检查地址" }),
  createConnection: () => Promise.resolve(connection),
  updateConnection: () => Promise.resolve(connection),
} as unknown as RemoteProjectService;

export function Fixture() {
  const controller = useMenuController();
  return (
    <main className="@container/settings mx-auto max-w-4xl bg-surface p-6 text-ui-base text-ink">
      <section aria-label="标准设置">
        <SettingRow label="标准设置标签" desc="标准设置说明" htmlFor="standard">
          <input
            id="standard"
            className={settingsInputClass}
            defaultValue="标准输入"
          />
        </SettingRow>
      </section>
      <section aria-label="远程主机设置">
        <RemoteHostsSettings service={service} />
      </section>
      <ActionButton
        tone="secondary"
        size="compact"
        style={{ position: "fixed", right: 12, bottom: 12 }}
        onClick={(event) =>
          controller.open(
            "project",
            "项目菜单",
            [
              { id: "edit", label: "编辑项目", onSelect: () => {} },
              {
                id: "open",
                label: "在资源管理器中打开",
                children: [
                  {
                    id: "main",
                    label: "main",
                    description: "D:/项目/main",
                    onSelect: () => {
                      document.documentElement.dataset.opened = "main";
                    },
                  },
                  {
                    id: "related",
                    label: "关联目录",
                    description: "D:/项目/" + "很长的目录名称".repeat(12),
                    onSelect: () => {
                      document.documentElement.dataset.opened = "related";
                    },
                  },
                ],
              },
            ],
            { trigger: event.currentTarget },
          )
        }
      >
        项目操作
      </ActionButton>
      {controller.menu && (
        <ContextMenu
          key={controller.menu.instance}
          {...controller.menu}
          onDismiss={controller.dismiss}
        />
      )}
    </main>
  );
}
createRoot(document.querySelector("#root")!).render(<Fixture />);
