# AAW Skills v2

这是 AAW 技能的新一版，配合 Desktop 的工作流引擎使用，也可以单独使用。

和 `skills/` 下的首版相比：

- **不再驱动流程**。首版 `aaw-workflow` 是 CLI 工作流的入口（读工作单、执行 `aaw next / done`、处理放行与回退）。流程现在由工作流引擎推进，这一版里没有任何依赖 CLI 或流程控制的内容；首版 `aaw-workflow` 由 `aaw-practices` 取代，只保留工作方法与技能地图。
- **各技能与流程解耦**。去掉了开头的「是否回到 aaw-workflow 工作流」确认、结尾的「完成后回调」、以及正文里对工作单字段（`input` / `output` / `data_file` / `commands.done`）的依赖：
  - 输入与输出的位置以调用方（工作流节点或用户）给出的为准，没有给出时用各技能写的默认布局；
  - 结论在工作流节点里按节点声明的结果字段提交，单独使用时直接报告给用户；
  - 轻量 / 严格模式按调用方的说明判断，不再靠工作单里的标记。
- **删掉了首版的兼容路径**：`ar-clarify` 的「旧 SR 派生模式」、`task-dev` 的 CLI 阶段状态机与旧状态迁移。
- **代码检查不依赖特定工具**：`task-dev` 的代码检查有可用的检查技能或项目自带工具就用，没有就自行审读变更。

## 内容

| 技能 | 类型 | 说明 |
|---|---|---|
| `aaw-practices` | 工作方法 | 取代首版 `aaw-workflow` |
| `aaw-workflow-authoring` | 工作流编写 | 新建和修改 AAW 工作流；`references/workflow-format.md` 与引擎的格式说明相同，改格式时一起更新 |
| `repo-init`、`sr-design`、`sr-design-gate`、`ar-clarify`、`module-boundary-design`、`module-asis-analysis`、`module-tobe-design`、`module-test-design`、`module-design-gate`、`dev-design`、`dev-design-gate`、`task-split`、`task-dev` | 研发步骤 | 已去掉流程耦合 |
| `code-check`、`module-deep-research`、`effective-document-writing`、`mermaid-diagram` | 工具 | 原样复制；`module-deep-research` 里的 CLI 是它自己的研究工具 |

## 没有复制的

- `question-tracker-mcp`：问题池服务。工作流引擎在构建时直接从 `skills/question-tracker-mcp/bin/` 取它的可执行文件，留在原处。
- `open-code-review`：自带约 110 MB 的检查器二进制，复制会让仓库体积翻倍。需要时继续使用 `skills/open-code-review/`。
- `skill-a`、`skill-b`、`skill-c`：占位内容。
