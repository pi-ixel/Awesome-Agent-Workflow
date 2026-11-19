import { useEffect, useState } from "react";
import type { HostService } from "../../host/service.ts";
import {
  SettingCard,
  SettingRow,
} from "../../../shared/ui/SettingsPageParts.tsx";
import { ToggleSwitch } from "../../../shared/ui/controls.tsx";

export function BrowserAgentControlSettings({
  host,
}: {
  readonly host: HostService["browser"];
}) {
  const [enabled, setEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let unsubscribe = () => {};
    void host
      .agentControlEnabled()
      .then((value) => {
        if (active) setEnabled(value);
      })
      .catch((cause) => setError(String(cause)));
    void host
      .onAgentControl(({ enabled: actual }) => {
        if (active) setEnabled(actual);
      })
      .then((release) => {
        unsubscribe = release;
        if (!active) release();
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      active = false;
      unsubscribe();
    };
  }, [host]);
  return (
    <SettingCard label="内嵌浏览器">
      <SettingRow
        label="Agent 浏览器控制"
        desc="默认允许。新建或重连的 Agent 会话可发现浏览器工具；关闭会立即撤销全部现有授权，已有会话开启后需确认重连。"
        footer={
          <p className="text-ui-caption text-ink-mute">
            AI 操作页面时会显示“我来接管”；接管立即生效，AI 正常结束后自动交还。
          </p>
        }
        footerAlign="start"
      >
        <ToggleSwitch
          appearance="neutral"
          label="Agent 浏览器控制"
          checked={enabled}
          onChange={(value) => {
            void host
              .setAgentControl(value)
              .then((actual) => {
                setEnabled(actual);
                setError(null);
              })
              .catch((cause) => setError(String(cause)));
          }}
        />
      </SettingRow>
      {error && (
        <p role="alert" className="text-xs text-danger-ink">
          {error}
        </p>
      )}
    </SettingCard>
  );
}
