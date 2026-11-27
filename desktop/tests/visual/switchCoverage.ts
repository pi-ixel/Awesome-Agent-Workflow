/** Each group covers one production declaration. A declaration in a loop can render several cases. */
export const switchCoverage = {
  "plugins/updates/ui/DesktopUpdate.tsx": [
    ["自动检查更新"], ["自动下载更新"], ["使用服务器加速下载", "帮助分发更新（仅上传已验证的官方安装包）"],
  ],
  "plugins/scheduledTasks/index.ts": [["关闭窗口时留在托盘"]],
  "plugins/browser/ui/settings.tsx": [["Agent 浏览器控制"]],
  "plugins/project/ui/settings.tsx": [["在消息流中显示任务步骤"], ["问答自动应答"], ["自动归档闲置会话"]],
  "plugins/agents/ui/AgentsSettings.tsx": [["支持自定义回答"]],
  "plugins/tools/ui/ToolManagement.tsx": [["排序键名"]],
  "plugins/skills/ui/SkillCards.tsx": [["发布准备和回滚预案的完整审查"]],
  "plugins/mcp/ui/McpView.tsx": [["AAW 内置浏览器 启用"], ["发布服务 启用"], ["发布服务 详情开关"]],
  "plugins/mcp/ui/McpServiceDetails.tsx": [["browser_open 启用"]],
} satisfies Record<string, readonly (readonly [string, ...string[]])[]>;
