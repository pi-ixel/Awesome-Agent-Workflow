import { useRef, useState, type ReactNode } from "react";
import type {
  ManagedMcpDefinition,
  ManagedMcpEntry,
  McpCredentialReference,
  NativeMcpDraft,
  NativeMcpEntry,
} from "../../../contracts/mcp/management.ts";
import { ActionButton, Listbox } from "../../../shared/ui/controls.tsx";
import { ModalShell } from "../../../shared/ui/ModalShell.tsx";
import { SegmentedControl } from "../../../shared/ui/SettingsPageParts.tsx";
import { mcpTemplates } from "../runtime/importConfig.ts";
import { McpImportDialog, type McpImporter } from "./McpImportDialog.tsx";
import {
  settingsInputClass,
  settingsTextareaClass,
} from "../../../shared/ui/inputStyles.ts";

type TestResult = { ok: boolean; message: string; durationMs: number };
type Editor =
  | {
      source: "native";
      entry?: NativeMcpEntry;
      scoped?: boolean;
      testStdio?: boolean;
      transports: readonly NativeMcpDraft["transport"][];
      submit: (draft: NativeMcpDraft) => Promise<void>;
      test?: (draft: NativeMcpDraft) => Promise<TestResult>;
    }
  | {
      source: "managed";
      entry?: ManagedMcpEntry;
      submit: (draft: ManagedMcpDefinition) => Promise<void>;
      test?: (draft: ManagedMcpDefinition) => Promise<TestResult>;
    };

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-ui-sm font-medium text-ink">
      {label}
      {children}
    </label>
  );
}

function parseChanges(text: string): Record<string, string | null> {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const equals = line.indexOf("=");
        return equals === -1
          ? [line.trim(), null]
          : [line.slice(0, equals).trim(), line.slice(equals + 1)];
      }),
  );
}

const newHeader: McpCredentialReference = {
  name: "",
  source: "environment",
  reference: "",
  prefix: "",
};

function HeadersEditor({
  headers,
  onChange,
  disabled,
}: {
  headers: readonly McpCredentialReference[];
  onChange: (headers: readonly McpCredentialReference[]) => void;
  disabled: boolean;
}) {
  function update(index: number, patch: Partial<McpCredentialReference>) {
    onChange(
      headers.map((header, item) =>
        item === index ? { ...header, ...patch } : header,
      ),
    );
  }
  return (
    <fieldset className="grid gap-2" disabled={disabled}>
      <legend className="mb-2 text-ui-sm font-medium text-ink">
        请求头凭据
      </legend>
      {headers.map((header, index) => (
        <div
          key={index}
          className="grid gap-2 rounded-lg border border-line p-3"
        >
          <div className="grid grid-cols-2 gap-2">
            <Field label="请求头名称">
              <input
                className={settingsInputClass}
                value={header.name}
                required
                placeholder="Authorization"
                onChange={(event) =>
                  update(index, { name: event.target.value })
                }
              />
            </Field>
            <Field label="凭据来源">
              <Listbox
                label="凭据来源"
                value={header.source}
                fullWidth
                options={[
                  { value: "environment", label: "环境变量" },
                  ...(navigator.userAgent.includes("Windows")
                    ? [{ value: "system", label: "Windows 通用凭据" }]
                    : []),
                ]}
                onChange={(value) =>
                  update(index, {
                    source: value === "system" ? "system" : "environment",
                  })
                }
              />
            </Field>
          </div>
          <Field
            label={header.source === "system" ? "通用凭据名称" : "环境变量名"}
          >
            <input
              className={settingsInputClass}
              value={header.reference}
              required
              onChange={(event) =>
                update(index, { reference: event.target.value })
              }
            />
          </Field>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Listbox
              label="请求头前缀"
              value={header.prefix}
              options={[
                { value: "", label: "无前缀" },
                { value: "Bearer ", label: "Bearer" },
                { value: "Basic ", label: "Basic" },
              ]}
              onChange={(prefix) => update(index, { prefix })}
            />
            <ActionButton
              tone="secondary"
              size="compact"
              onClick={() =>
                onChange(headers.filter((_, item) => item !== index))
              }
            >
              移除请求头
            </ActionButton>
          </div>
        </div>
      ))}
      <ActionButton
        tone="secondary"
        size="compact"
        className="justify-self-start"
        onClick={() => onChange([...headers, newHeader])}
      >
        添加请求头
      </ActionButton>
    </fieldset>
  );
}

export function McpEditor({
  editor,
  close,
  reload,
  importer,
  initialTab = "form",
}: {
  editor: Editor;
  close: () => void;
  reload: () => Promise<void>;
  importer?: McpImporter;
  initialTab?: "form" | "json";
}) {
  const entry = editor.entry;
  const native = editor.source === "native" ? editor.entry : undefined;
  const form = useRef<HTMLFormElement>(null);
  const [nameEdit, setName] = useState<string>();
  const [descriptionEdit, setDescription] = useState<string>();
  const [tab, setTab] = useState<"form" | "json" | "templates">(initialTab);
  const [transportEdit, setTransport] = useState<"stdio" | "http">();
  const [urlEdit, setUrl] = useState<string>();
  const [commandEdit, setCommand] = useState<string>();
  const [cwdEdit, setCwd] = useState<string>();
  const [replaceArgs, setReplaceArgs] = useState(false);
  const [args, setArgs] = useState("");
  const [secrets, setSecrets] = useState({ http: "", stdio: "" });
  const [headersEdit, setHeaders] =
    useState<readonly McpCredentialReference[]>();
  const [pending, setPending] = useState<
    "save" | "test" | "reload" | "import" | null
  >(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [testResult, setTestResult] = useState<TestResult>();
  const [stale, setStale] = useState(false);
  const name = nameEdit ?? entry?.name ?? "";
  const description = descriptionEdit ?? entry?.description ?? "";
  const transport =
    transportEdit ?? (native?.transport === "stdio" ? "stdio" : "http");
  const url = urlEdit ?? entry?.url ?? "";
  const command = commandEdit ?? native?.command ?? "";
  const cwd = cwdEdit ?? native?.cwd ?? "";
  const headers =
    headersEdit ??
    (editor.source === "managed" ? (editor.entry?.headers ?? []) : []);
  const isOriginalTransport = native?.transport === transport;
  const isHiddenUrl =
    transport === "http" && isOriginalTransport && native?.url === null;
  const canTest =
    !!editor.test &&
    (transport === "http" || (editor.source === "native" && editor.testStdio));
  const busy = pending !== null;
  const title = entry ? "编辑 MCP" : "新增 MCP";

  async function run(mode: "save" | "test") {
    if (busy || stale || !form.current?.reportValidity()) return;
    setError(undefined);
    setNotice(undefined);
    setTestResult(undefined);
    setPending(mode);
    try {
      if (editor.source === "native") {
        const draft: NativeMcpDraft = {
          name: name.trim(),
          transport,
          ...(transport === "http"
            ? { url: url.trim() || undefined }
            : {
                command: command.trim(),
                cwd: cwdEdit?.trim(),
                args: replaceArgs
                  ? args.length
                    ? args.replaceAll("\r\n", "\n").split("\n")
                    : []
                  : undefined,
              }),
          secretChanges: parseChanges(secrets[transport]),
        };
        if (mode === "test") {
          if (editor.test) setTestResult(await editor.test(draft));
        } else {
          await editor.submit(draft);
        }
      } else {
        const draft: ManagedMcpDefinition = {
          name: name.trim(),
          transport: "http",
          url: url.trim(),
          headers,
          ...(description.trim() ? { description: description.trim() } : {}),
        };
        if (mode === "test") {
          if (editor.test) setTestResult(await editor.test(draft));
        } else {
          await editor.submit(draft);
        }
      }
      if (mode === "save") close();
    } catch (failure) {
      const message =
        failure instanceof Error ? failure.message : String(failure);
      setError(message);
      if (message.startsWith("配置已变化")) setStale(true);
    } finally {
      setPending(null);
    }
  }

  async function reloadConfiguration() {
    setPending("reload");
    try {
      await reload();
      setStale(false);
      setError(undefined);
      setNotice("配置已重新加载，已保留你的输入，请核对后保存。");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(null);
    }
  }

  return (
    <ModalShell
      label={title}
      size="form"
      onDismiss={() => {
        if (!busy) close();
      }}
    >
      <form
        ref={form}
        className="flex min-h-0 flex-col"
        onChange={() => setTestResult(undefined)}
        onSubmit={(event) => {
          event.preventDefault();
          if (tab === "form") void run("save");
        }}
      >
        <header className="shrink-0 border-b border-line px-5 py-4">
          <h2 className="text-ui-lg font-semibold">{title}</h2>
        </header>
        {importer && (
          <div className="border-b border-line px-5 py-2">
            <SegmentedControl
              tabs
              groupLabel="新增 MCP 方式"
              value={tab}
              options={[
                { value: "form", label: "表单配置" },
                { value: "json", label: "JSON 导入" },
                { value: "templates", label: "推荐模板" },
              ]}
              onChange={(value) => {
                if (!busy) setTab(value);
              }}
            />
          </div>
        )}
        {importer && (
          <McpImportDialog
            close={close}
            importer={importer}
            isActive={tab === "json"}
            isBusy={pending === "import"}
            onBusy={(isBusy) => setPending(isBusy ? "import" : null)}
          />
        )}
        {tab === "templates" && (
          <section
            role="tabpanel"
            aria-label="推荐模板"
            className="min-h-0 space-y-2 overflow-auto px-5 py-4"
          >
            {mcpTemplates.map((template) => (
              <div
                key={template.name}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2"
              >
                <div>
                  <p className="text-ui-sm font-semibold">{template.name}</p>
                  <p className="text-ui-caption text-ink-mute">
                    {template.description} · Streamable HTTP
                  </p>
                </div>
                <ActionButton
                  tone="secondary"
                  size="compact"
                  onClick={() => {
                    setName(template.name);
                    setDescription(template.description);
                    setUrl(template.url);
                    setHeaders(template.headers);
                    setTestResult(undefined);
                    setTab("form");
                  }}
                >
                  使用模板
                </ActionButton>
              </div>
            ))}
          </section>
        )}
        {tab === "form" && (
          <fieldset
            disabled={busy}
            className="grid min-h-0 min-w-0 gap-4 overflow-y-auto px-5 py-4"
          >
            {editor.source === "native" && editor.scoped && (
              <p className="text-ui-sm text-ink-mute">
                请求头和环境变量会以明文保存到 CodeAgent 用户配置文件
                ~/.cac.json。
              </p>
            )}
            <Field label="服务名称">
              <input
                className={settingsInputClass}
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </Field>
            {editor.source === "managed" && (
              <>
                <Field label="服务说明">
                  <input
                    className={settingsInputClass}
                    value={description}
                    maxLength={1024}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </Field>
                <p className="text-ui-sm text-ink-mute">
                  传输方式 · Streamable HTTP
                </p>
              </>
            )}
            {editor.source === "native" && (
              <Field label="传输方式">
                <Listbox
                  label="传输方式"
                  value={transport}
                  fullWidth
                  options={[
                    { value: "http", label: "Streamable HTTP" },
                    { value: "stdio", label: "stdio · 本地命令" },
                  ].filter(({ value }) =>
                    editor.transports.some((transport) => transport === value),
                  )}
                  onChange={(value) => {
                    setTransport(value === "stdio" ? "stdio" : "http");
                    setTestResult(undefined);
                  }}
                />
              </Field>
            )}
            {transport === "http" ? (
              <Field label="服务地址">
                <input
                  className={settingsInputClass}
                  type="url"
                  value={url}
                  required={!isHiddenUrl}
                  placeholder={
                    isHiddenUrl
                      ? "原地址已隐藏，留空保留"
                      : "https://example.com/mcp"
                  }
                  onChange={(event) => setUrl(event.target.value)}
                />
              </Field>
            ) : (
              <>
                <Field label="启动命令">
                  <input
                    className={settingsInputClass}
                    value={command}
                    required
                    onChange={(event) => setCommand(event.target.value)}
                  />
                </Field>
                {!(editor.source === "native" && editor.scoped) && (
                  <Field label="工作目录">
                    <input
                      className={settingsInputClass}
                      value={cwd}
                      placeholder="默认使用会话工作目录"
                      onChange={(event) => setCwd(event.target.value)}
                    />
                  </Field>
                )}
                {replaceArgs || !native?.argsCount || !isOriginalTransport ? (
                  <Field label="启动参数">
                    <textarea
                      className={settingsTextareaClass}
                      rows={3}
                      placeholder="每行一个参数"
                      value={args}
                      onChange={(event) => {
                        setReplaceArgs(true);
                        setArgs(event.target.value);
                      }}
                    />
                  </Field>
                ) : (
                  <div className="flex items-center justify-between gap-2 text-ui-sm text-ink-mute">
                    <span>已配置 {native?.argsCount} 个启动参数</span>
                    <ActionButton
                      tone="secondary"
                      size="compact"
                      onClick={() => setReplaceArgs(true)}
                    >
                      替换启动参数
                    </ActionButton>
                  </div>
                )}
              </>
            )}
            {editor.source === "managed" ? (
              <HeadersEditor
                headers={headers}
                onChange={(value) => {
                  setHeaders(value);
                  setTestResult(undefined);
                }}
                disabled={busy}
              />
            ) : (
              <Field
                label={
                  transport === "http" ? "修改 HTTP 请求头" : "修改环境变量"
                }
              >
                {isOriginalTransport && native?.secretKeys.length ? (
                  <span className="break-all font-normal text-ink-mute">
                    已配置 {native.secretKeys.join("、")}
                  </span>
                ) : null}
                <textarea
                  className={settingsTextareaClass}
                  value={secrets[transport]}
                  autoComplete="off"
                  spellCheck={false}
                  rows={2}
                  onChange={(event) =>
                    setSecrets({
                      ...secrets,
                      [transport]: event.target.value,
                    })
                  }
                  placeholder={"每行“名称=新值”，只填名称则移除该项。"}
                />
              </Field>
            )}
            {native && !isOriginalTransport && (
              <p className="text-ui-sm text-ink-mute">
                保存后会清理原传输方式的专用配置。
              </p>
            )}
            {notice && (
              <p role="status" className="text-ui-sm text-ink-mute">
                {notice}
              </p>
            )}
            {testResult && (
              <p
                role="status"
                className={
                  testResult.ok
                    ? "text-ui-sm text-ok-ink"
                    : "text-ui-sm text-danger-ink"
                }
              >
                {testResult.message} · {testResult.durationMs} ms
              </p>
            )}
            {error && (
              <p role="alert" className="text-ui-sm text-danger-ink">
                {error}
              </p>
            )}
            {stale && (
              <ActionButton
                tone="secondary"
                size="compact"
                className="justify-self-start"
                onClick={() => void reloadConfiguration()}
              >
                {pending === "reload" ? "正在重新读取…" : "重新加载配置"}
              </ActionButton>
            )}
          </fieldset>
        )}
        {tab === "form" && (
          <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-line px-5 py-3">
            {canTest && (
              <ActionButton
                tone="secondary"
                size="compact"
                className="mr-auto"
                disabled={busy || stale}
                onClick={() => void run("test")}
              >
                {pending === "test" ? "正在测试…" : "测试连接"}
              </ActionButton>
            )}
            <ActionButton
              tone="secondary"
              size="compact"
              onClick={close}
              disabled={busy}
            >
              取消
            </ActionButton>
            <ActionButton
              tone="primary"
              size="compact"
              type="submit"
              disabled={busy || stale || !name.trim()}
            >
              {pending === "save" ? "正在保存…" : "保存"}
            </ActionButton>
          </footer>
        )}
      </form>
    </ModalShell>
  );
}
