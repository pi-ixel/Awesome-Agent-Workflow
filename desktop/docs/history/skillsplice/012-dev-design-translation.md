# 012 dev 轻量链：需求至设计门禁的翻译

> 本文记录既有链路与当时验证。`dev-design` 的新组合结构和后续维护原则以 [015 可维护定义与 Unit 边界](015-authoring-and-unit-boundaries.md) 为准；本文原子 Unit 描述不代表新版已接入。

> 范围：dev 入口至设计门禁，供审阅和验证；不包含任务拆分、开发或交付。v2 定义和 iCode 接入位于 [aaw-dev](../../skillsplice/aaw-dev/)。

## 流程及数据

```text
需求文件
  → dev-init         记录需求，输出 requirement_ref
  → dev-design       读取需求，输出 design_ref
  → dev-test-design  读取设计，输出 test_design_ref
  → 设计门禁         读取设计、测试设计和可选需求原文
       ├─ pass     完成这一段
       ├─ fail     根据问题整改，再进入下一轮评审，最多评审 3 轮
       └─ blocked  停止，等待所需事实或用户决策
```

根组合 [dev-design-chain.json](../../skillsplice/aaw-dev/definitions/dev-design-chain.json) 使用 `bind` 引用前序输出；每个 Unit 只声明自己需要的参数。绑定传递的是产物路径引用，具体内容仍在工作区；适配器目前校验这些引用与 AAW 的 `.sdd/{SR}/` 路径约定一致，并由执行者读取文件。路径规则不是 SkillSplice 通用模型。

| 原 AAW 环节 | v2 翻译 | 进入条件和输出 |
|---|---|---|
| `dev-init` | `dev-init` 原子 Unit | 本集成要求调用方提供已确定的需求文件和 SR；需求原样写入 `requirement.md`。已有不同内容时停止，不覆盖。架构基线存在则复用，缺失不补建。 |
| `dev-design` | `dev-design` 原子 Unit，iCode 执行 | 接收上一步的需求引用；产出 `dev-design.md`，记录方案、契约、影响面和验收标准。 |
| `dev-test-design` | `dev-test-design` 原子 Unit，iCode 执行 | 接收设计引用；以轻量模式生成 `test-design.md`，不要求严格链的详细设计三件套。 |
| `dev-design-gate` | `dev-gate-round` 组合 Unit，有界重复调用 | 每轮包含 `prepare`、条件执行的 `fix`、`review`；检查决策收敛、代码论断可回溯、契约及验收可执行。 |

原始工作流来源：[`flow.yaml`](../../../skills/aaw-workflow/scripts/cli/definitions/flow.yaml)、[`dev-init.yaml`](../../../skills/aaw-workflow/scripts/cli/definitions/dev-init.yaml)、[`dev-design.yaml`](../../../skills/aaw-workflow/scripts/cli/definitions/dev-design.yaml)、[`dev-test-design.yaml`](../../../skills/aaw-workflow/scripts/cli/definitions/dev-test-design.yaml)、[`dev-design-gate.yaml`](../../../skills/aaw-workflow/scripts/cli/definitions/dev-design-gate.yaml)。

## 门禁如何运转

第一轮 `prepare` 判断没有待整改问题，跳过 `fix`，进入 `review`。评审返回 `fail` 时，本轮调用结果中的问题列表成为下一轮 `prepare` 的输入；下一轮 `fix` 使用该列表修改设计文档，然后 `review` 再次检查。每轮都有独立的 Runtime 路径，门禁报告另存逐轮证据。`pass` 结束循环；三轮仍为 `fail` 则因到达上限结束为 `failed`。`blocked`、缺少必要字段、模型无法执行等以 `unknown` 停止，不进入整改或下游；不自动回滚。

原 AAW 流程要求 fail 时整改后重新执行门禁，并未在原定义中规定自动整改或固定轮次。此处自动整改及“最多三次评审、两次整改”沿用旧 PoC 的试验策略，属于待审阅的翻译选择；若用户决策或外部事实缺失，不应交给自动整改猜测。整改节点的目标是仅变更两份设计文档，评审节点的目标是只读审查、由适配器写门禁报告。宿主检查 `.sdd` 文件变化及工作区中 `.sdd` 以外 Git 可见的变化，发现越界后停止；这不是文件系统沙箱，无法保证拦截所有忽略文件、工作区外变更或撤销已发生的修改。

当前 `fail` 校验要求问题描述非空，但不能证明问题定位与整改方向充分；两份设计文档均在整改允许范围内，也不能机械证明修改只针对本轮问题。自动整改的适用范围和更严格的问题契约仍需决定。

## 运行时与执行者分工

- **Runtime**：按定义调度、传递上游引用与问题列表、判定分支、限制轮次、记录每个节点与结果。
- **宿主和 iCode 适配器**：接收已确定的需求文件、调用 Agent、加载固定知识、检查实际产物及执行边界、保存评审证据。入口要求干净的隔离 Git 工作区和工作区外的新证据目录。
- **Agent**：阅读需求及代码、撰写设计和测试设计、评审或根据问题整改。结构校验不能证明设计内容正确，也不能证明评审覆盖充分。

固定知识采用旧 PoC 已有的摘录快照，并非各原始 Skill 的完整内容；摘要锁定保证运行前快照未被更改，不等于完整继承原 Skill 的方法与全部引用。特别是 `dev-design` 的问用户环节，目前没有接到可交互的宿主问答：入口视传入的需求已由调用方确认；运行过程中如果出现必须由用户决定的问题，现有一次性 iCode 调用没有完整的提问、回答和继续机制。这项能力不能因定义里写了提示词就算已实现。

## 验证与运行

受控检查使用真实 v2 定义和 Runtime，覆盖首次通过、fail 后整改重审、blocked、轮次耗尽、越界修改及拒绝覆盖不同需求。其中一项连接真实 iCode 适配器和命令行替身，检查结构化结果、角色配置及整改后的重审。9 项测试通过；它们验证流程契约，不证明真实模型的设计质量。

```powershell
python -B desktop/skillsplice/aaw-dev/test_bridge.py
python -B desktop/skillsplice/aaw-dev/bridge.py --workspace <隔离且干净的Git工作区> --requirement <需求文件> --sr SR-001 --evidence <工作区外的新目录>
```

独立命令当前只支持新建 run，不提供用户交互和恢复入口；Runtime 自身的保守恢复机制不等于该命令已实现端到端恢复。真实运行应独立保存输入、工作区基线、Journal、每轮报告和 Agent 调用记录，并区分模型运行结果与受控替身结果。

### 真实 iCode 运行（2026-11-03）

以 OpsCopilot 提交 `3f5f4e696721ed768a5ad67224cba28f00ce1c9a` 的独立克隆和 R1 自然需求运行，run ID 为 `359d77d3-605e-47d2-9255-83217aaddeab`。需求进入、设计和测试设计完成；第一轮门禁为 `fail`，发现并发计数测试先在被测实例取基准、却没有把基准调用计入预期的自相矛盾。整改改为在独立实例取基准；第二轮门禁为 `pass`，本段 run 状态为 `passed`。运行止于设计门禁，没有执行任务拆分、代码实现和项目验收。

结果与过程已归档：[需求与设计产物](../../poc/skillsplice/evidence/v2-dev-design-20261103/artifacts/)、[第一轮报告](../../poc/skillsplice/evidence/v2-dev-design-20261103/evidence/gate-round-1.md)、[第二轮报告](../../poc/skillsplice/evidence/v2-dev-design-20261103/evidence/gate-round-2.md)、[Journal 与调用记录](../../poc/skillsplice/evidence/v2-dev-design-20261103/evidence/)及 [摘要清单](../../poc/skillsplice/evidence/v2-dev-design-20261103/sha256-manifest.json)。记录内部分绝对路径指向原始临时工作区；归档中的 `artifacts/` 和 `evidence/` 是对应副本。原始副本位于 `D:/dev/tmp/skillsplice-v2-dev-6bwr9p21/`，可能被临时文件清理影响。

本次 Reviewer 将缺少 race 环境视为不阻断设计门禁，并接受了用确定性计数断言替代的措辞。设计可以先完成，但计数断言不能证明无数据竞争；后续若最终验收要求 `go test -race`，必须在具备条件的环境实际运行，未运行时保留未验证状态。该次 run 启动后，宿主增加了评审结束时额外检查 Git 可见越界变化及 `.sdd` 根目录符号链接的检查，真实运行没有覆盖这两项新增检查；它们属于后续版本的受控验证范围。

## 需要共同决定的问题

1. 需求是否应以对话、已有文件或二者皆可进入；需要用户澄清时，怎样暂停并继续？目前的必填需求文件是接入限制，不是原 `dev-init` 的必需品。
2. `dev-design` 与 `dev-test-design` 的知识应保留为完整可复用 Unit，还是采用经审阅的精简知识包？目前只复制了旧 PoC 的摘录。
3. 门禁 fail 后是否默认自动整改？整改多少轮、哪些问题允许自动修改，哪些必须交给用户？
4. AAW 是否继续以 `.sdd/{SR}` 文件路径作为环节间唯一交付方式，还是引入更明确的产物契约？
