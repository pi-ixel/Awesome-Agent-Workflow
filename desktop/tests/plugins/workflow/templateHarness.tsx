/** 左侧「工作流」功能区的测试装配：侧栏与中间共用一份导航状态（ADR 038）。 */
import { render } from "@testing-library/react";
import { WorkflowSidebar } from "../../../src/plugins/workflow/ui/WorkflowSidebar.tsx";
import { WorkflowWorkspace } from "../../../src/plugins/workflow/ui/WorkflowWorkspace.tsx";
import { createTemplateNavigation } from "../../../src/plugins/workflow/ui/templateNavigation.ts";
import type { WorkflowDraftEditor, WorkflowFileTransfer, WorkflowService } from "../../../src/plugins/workflow/types.ts";

export function renderTemplates(service: WorkflowService, options: { readonly editor?: WorkflowDraftEditor; readonly transfer?: WorkflowFileTransfer } = {}) {
  const navigation = createTemplateNavigation();
  const view = render(<>
    <WorkflowSidebar service={service} navigation={navigation} canCompose={options.editor !== undefined} />
    <WorkflowWorkspace service={service} navigation={navigation} editor={options.editor} transfer={options.transfer} />
  </>);
  return { ...view, navigation };
}
