# AAW 工作流宿主工具

每个工作流 Agent 会话都挂载了同一组宿主工具（`aaw-workflow-result` MCP），用于读取上游成果、固定产物、使用问题池和交付结果。工作方法由节点自己的知识决定；本文件只说明工具本身。

## 读取上游成果

- `list_workflow_results`：列出本次运行已完成节点的目录（siteId、ordinal、actor、字段名）。先列目录再取内容，避免盲目猜测。
- `get_workflow_result`：按 `siteId` + `ordinal` 读取某个已完成节点的原始结果对象。不要把别的节点摘要当作原始证据，需要引用时读原始结果。

## 固定与读取产物

- `capture_workflow_artifact`：把本地文件或 HTTP(S) 内容固定为不可变引用（返回 `workflow-artifact://` URI 与 SHA-256）。产物内容可能随后被修改时，先固定再引用。
- `read_workflow_artifact`：按 URI 读取产物内容片段（UTF-8 文本及 base64）。

## 问题池

- `aaw_pool_get_status`：查询本次运行的问题池状态（待答/已答）。提问前先查，避免重复。
- `aaw_pool_add_questions`：登记新的问题。
- `aaw_pool_answer_question` / `aaw_pool_update_answer`：登记用户回答及其修订。

需要用户决策时，在本会话向用户提问并等待答复；得到答复后把问题和回答记入问题池，再继续工作。不得把未经用户确认的推荐答案当作决定。

## 交付结果

- `submit_workflow_result`：完成本次工作后调用，把本次动作的实际结果对象放在 `result` 参数中交付。结果必须符合当前节点定义的交付 schema；本轮对话正常结束后引擎核验并推进流程。

不要编造缺失的事实；无法完成时如实说明。
