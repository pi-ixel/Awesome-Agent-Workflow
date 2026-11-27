import { useState, type ReactNode } from "react";
import type {
  McpInspection,
  McpTool,
} from "../../../contracts/mcp/management.ts";
import { ActionButton, ToggleSwitch } from "../../../shared/ui/controls.tsx";
import { SegmentedControl } from "../../../shared/ui/SettingsPageParts.tsx";
import { fieldSurfaceClass } from "../../../shared/ui/inputStyles.ts";
import { IconButton } from "../../../shared/ui/IconButton.tsx";
import { PanelRightCloseIcon, PlugIcon } from "../../../shared/ui/icons.tsx";

function signature(schema: McpTool["inputSchema"]) {
  const properties = schema?.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    return "";
  const required: readonly unknown[] = Array.isArray(schema?.required)
    ? schema.required
    : [];
  return Object.entries(properties as Record<string, unknown>)
    .map(([name, value]) => {
      const type =
        value &&
        typeof value === "object" &&
        "type" in value &&
        typeof value.type === "string"
          ? value.type
          : "unknown";
      return `${name}${required.includes(name) ? "" : "?"}: ${type}`;
    })
    .join(", ");
}

export function McpServiceDetails({
  name,
  description,
  transport,
  summary,
  config,
  connection,
  health,
  inspectionNote,
  tools,
  disabledTools,
  actions,
  toggle,
  onToggleTools,
  onClose,
  isToolPending,
}: {
  name: string;
  description: string;
  transport: string;
  summary: string;
  config: unknown;
  connection: readonly (readonly [string, string])[];
  health?: McpInspection;
  inspectionNote?: string;
  tools?: readonly McpTool[];
  disabledTools: readonly string[];
  actions: ReactNode;
  toggle: ReactNode;
  onToggleTools?: (names: readonly string[], enabled: boolean) => void;
  onClose: () => void;
  isToolPending: (name: string) => boolean;
}) {
  const [tab, setTab] = useState<"tools" | "connection" | "json">("tools");
  const [search, setSearch] = useState("");
  const filtered = tools?.filter((tool) =>
    `${tool.name} ${tool.description ?? ""}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const enabled = tools?.filter(
    (tool) => !disabledTools.includes(tool.name),
  ).length;
  return (
    <div className="min-w-0">
      <header className="sticky top-0 z-10 space-y-2 border-b border-line bg-base px-5 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-control bg-skill-reference-lilac/10 text-skill-reference-lilac">
            <PlugIcon className="ui-icon-18" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="break-all text-ui-lg font-semibold">{name}</h2>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <p className="text-ui-caption text-ink-mute">
                {transport} · {summary}
              </p>
              {actions}
            </div>
          </div>
          {toggle}
          <IconButton
            iconSize="compact"
            placement="top"
            aria-label="收起详情"
            data-hint="收起详情"
            onClick={onClose}
          >
            <PanelRightCloseIcon className="ui-icon-16" />
          </IconButton>
        </div>
        {description && (
          <p className="break-words text-ui-sm text-ink">{description}</p>
        )}
        {inspectionNote && (
          <p className="break-words text-ui-caption text-ink-mute">
            {inspectionNote}
          </p>
        )}
        {health?.ok === false && (
          <p className="break-words text-ui-caption text-danger-ink">
            {health.message}
          </p>
        )}
      </header>
      <div className="border-b border-line px-5 py-2">
        <SegmentedControl
          tabs
          groupLabel="服务详情"
          value={tab}
          options={[
            {
              value: "tools",
              label: tools
                ? `工具权限 (${enabled}/${tools.length})`
                : "工具权限",
            },
            { value: "connection", label: "连接配置" },
            { value: "json", label: "原始 JSON" },
          ]}
          onChange={setTab}
        />
      </div>
      {tab === "tools" && (
        <section
          role="tabpanel"
          aria-label="工具权限"
          className="space-y-3 p-5"
        >
          {health?.ok === false && health.tools && (
            <p className="text-ui-caption text-ink-mute">
              显示上次检测到的工具清单。
            </p>
          )}
          {tools === undefined ? (
            <p className="text-ui-sm text-ink-mute">尚未读取工具清单。</p>
          ) : tools.length === 0 ? (
            <p className="text-ui-sm text-ink-mute">此服务未提供工具。</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="search"
                  aria-label="筛选工具"
                  className={`${fieldSurfaceClass} min-w-32 flex-1 px-3 py-1.5 text-ui-sm`}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="搜索工具名称或说明…"
                />
                {onToggleTools && (
                  <ActionButton
                    tone="secondary"
                    size="compact"
                    disabled={
                      tools.some(({ name }) => isToolPending(name)) ||
                      enabled === tools.length
                    }
                    onClick={() =>
                      onToggleTools(
                        tools.map(({ name }) => name),
                        true,
                      )
                    }
                  >
                    全部启用
                  </ActionButton>
                )}
              </div>
              {onToggleTools ? (
                <p className="text-ui-caption text-ink-mute">
                  关闭立即限制调用。Agent 缓存的工具清单在重连时刷新。
                </p>
              ) : (
                <p className="text-ui-caption text-ink-mute">
                  工具清单由当前 Agent 上报。
                </p>
              )}
              <ul className="divide-y divide-line overflow-hidden rounded-popover border border-line bg-surface">
                {filtered?.map((tool) => {
                  const parameters = signature(tool.inputSchema);
                  return (
                    <li
                      key={tool.name}
                      className="flex min-w-0 items-center gap-3 p-3"
                    >
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="flex flex-wrap items-baseline gap-x-2 break-all text-ui-sm">
                          <span className="font-mono font-semibold">
                            {tool.name}
                          </span>
                          {tool.readOnly !== undefined && (
                            <span className="text-ui-xs text-ink-mute">
                              {tool.readOnly ? "只读" : "可执行操作"}
                            </span>
                          )}
                        </p>
                        {tool.description && (
                          <p className="break-words text-ui-caption text-ink-mute">
                            {tool.description}
                          </p>
                        )}
                        {parameters && (
                          <p className="break-all font-mono text-ui-xs text-ink-mute">
                            ({parameters})
                          </p>
                        )}
                      </div>
                      {onToggleTools && (
                        <ToggleSwitch
                          label={tool.name + " 启用"}
                          checked={!disabledTools.includes(tool.name)}
                          pending={isToolPending(tool.name)}
                          onChange={(value) =>
                            onToggleTools([tool.name], value)
                          }
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
              {!filtered?.length && (
                <p className="text-ui-sm text-ink-mute">没有匹配的工具。</p>
              )}
            </>
          )}
        </section>
      )}
      {tab === "connection" && (
        <section
          role="tabpanel"
          aria-label="连接配置"
          className="space-y-2 p-5 text-ui-sm"
        >
          <dl className="space-y-3">
            <div>
              <dt className="text-ink-mute">传输方式</dt>
              <dd>{transport}</dd>
            </div>
            {connection.map(([label, value]) => (
              <div key={label}>
                <dt className="text-ink-mute">{label}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {tab === "json" && (
        <section role="tabpanel" aria-label="原始 JSON" className="p-5">
          <pre className="overflow-auto whitespace-pre-wrap break-all rounded-control border border-line bg-surface p-3 font-mono text-ui-caption">
            {JSON.stringify(config, null, 2)}
          </pre>
        </section>
      )}
    </div>
  );
}
