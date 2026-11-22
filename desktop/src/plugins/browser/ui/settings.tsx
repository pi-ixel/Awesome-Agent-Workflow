import type { HostService } from "../../host/service.ts";
import {
  SettingCard,
  SettingRow,
} from "../../../shared/ui/SettingsPageParts.tsx";
import { ToggleSwitch } from "../../../shared/ui/controls.tsx";
import { useBrowserAgentControl } from "./agentControl.ts";

export function BrowserAgentControlSettings({
  host,
}: {
  readonly host: HostService["browser"];
}) {
  const control = useBrowserAgentControl(host);
  return (
    <SettingCard label="内嵌浏览器">
      <SettingRow
        label="Agent 浏览器控制"
        desc="开关对所有 Agent 生效，重启后保留选择。关闭会立即撤销已有授权，开启后在新建或重连会话时注册。"
        footer={
          <p className="text-ui-caption text-ink-mute">
            AI 操作页面时会显示“我来接管”；接管立即生效，AI 正常结束后自动交还。
          </p>
        }
        footerAlign="start"
      >
        <ToggleSwitch
          label="Agent 浏览器控制"
          checked={control.enabled === true}
          pending={control.pending}
          disabled={control.enabled === null || !control.available}
          onChange={control.change}
        />
      </SettingRow>
      {control.error && (
        <p role="alert" className="text-xs text-danger-ink">
          {control.error}
        </p>
      )}
    </SettingCard>
  );
}
