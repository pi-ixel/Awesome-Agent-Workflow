# Splice 语言规范 · v0.1 骨架

> Splice 是 AAW 2.0 的流程编程语言：取代 Skill，承载流程与知识，编译为可被引擎执行、可被 GUI 渲染的冻结执行计划。
> 一句话论点：**一切跨越步骤边界的必须是类型化数据；一切在步骤内部的才是 Agent 的判断。**

## 0. 设计原则

1. **边界类型化，内部归 Agent。** 控制流、状态、上下文装配、验收校验归引擎与编译器；判断、即兴、偏离留在 directive 内部。
2. **声明式定义，确定性编排。** 语言只描述图与契约；调度、恢复、重试是引擎资产，不是语言构造。
3. **Agent 是函数体，不是解释器。** Agent 不能隐式决定控制流——它只产出类型化数据，数据驱动路由；偏离必须出现在类型化的 deviation 输出里，由门禁裁决。
4. **编译器拥有最终解释权。** 存得进仓库、过得了编译的定义才可运行；运行期不做任何解析与裁决。
5. **刻意收窄。** 无算术、无逻辑组合、无函数调用、无自由循环。表达力不够时先怀疑设计，再考虑加构造。

## 1. 模块

模块是唯一单元：一个目录 = 一个可版本化、可组合的能力。四件套同居一个程序文件，笨重知识放目录里、按内容寻址。

```
task-dev/
├── module.splice        # manifest + process + directives（全部程序文本）
└── knowledge/           # resources，内容寻址，只读
    ├── coding-rules.md
    └── semantic-review.md
```

解剖图（最小完整模块）：

```
module demo/sanity @ 0.1.0            ← ① manifest：身份 + 类型化端口

in  change : GitChange                ← 输入端口
out verdict : ReviewVerdict           ← 输出端口

type ReviewVerdict = pass | fail | blocked    ← 枚举内联；结构体引用 schema 类型库

knowledge                             ← ② 知识资源
  rules: file knowledge/rules.md  scope explicit

directive check                       ← ③ directive：Agent 指令体（函数体）
  executor : agent
  knowledge: rules
  in  change : GitChange
  out verdict : ReviewVerdict
  goal:
    只读审查 change，给出结论。

step check                            ← ④ process：步骤图（函数调用）
  directive check
  with change=$in.change

export verdict = $check.verdict       ← 模块输出的生产者绑定
```

标识符允许 Unicode（中文绑定名合法）。`agent` 执行器经 ACP 会话服务（2.0 GUI 是这门语言的驾驶舱）。

## 2. 语法

行导向、缩进成块（LL(1)，Python 式 INDENT/DEDENT）。

```
module     := "module" qname ["@" version] body
body       := (use | typedef | port | knowledge | directive | step | export)*

use        := "use" qname ["@" version]          # 钉主版本；编译期解析为精确版本+内容哈希
typedef    := "type" ident "=" enum | "schema" path
enum       := ident ("|" ident)+
port       := ("in" | "out") ident ":" type ["?"]          # "?" = 可选
knowledge  := "knowledge" INDENT kentry+ DEDENT
kentry     := ident ":" "file" path "scope" ("always" | "on-demand" | "explicit")

directive  := "directive" ident INDENT dfield+ DEDENT
dfield     := "executor" ":" ("agent" | "human" | "script")
           | "knowledge" ":" ident+
           | "in"  ident ":" type ["?"]
           | "out" ident (":" type | "<-" ident)          # "<-" = 直通输出
           | ident ":" TEXT                                # 开放文本字段（goal/accept/…），保序

step       := "step" ident INDENT sfield+ DEDENT
sfield     := ("uses" qname | "directive" ident)          # 二选一：向下委托 / 地方执行
           | "with" bindings
           | "route" ref INDENT route+ DEDENT
           | "resume" ident ["with" bindings] "max" int
           | "each" ref "in" ref ["mode" ("serial" | "parallel")]
           | "after" ident+
route      := (ident | "else") "->" target ["with" bindings]
target     := ident | "halt"
export     := "export" ident "=" ref
```

## 3. 受限表达式

```
expr     := ref | literal | interpolated-string
ref      := "$" ident ("." ident)*            # $in.task  $review.verdict  $codecheck.report
literal  := string | number | enum-ident
binding  := ident "=" expr
bindings := binding ("," binding)*
```

三条禁令：**无算术、无逻辑组合、无函数。** 相等比较仅存在于 route 行（枚举值分派）；字符串插值（`"…$ref…"`）是唯一的"计算"。路由守卫不是布尔表达式，是模式分派——这使穷尽性检查可行（见 P5）。

## 4. 知识作用域

| scope | 语义 |
|---|---|
| `always` | 注入本模块所有 directive 的上下文 |
| `explicit` | 仅注入声明了它的 directive |
| `on-demand` | 注入目录卡片，Agent 经引擎工具按 id 取用 |

directive 的 `knowledge:` 字段列出所需资源，编译器校验 ⊆ 模块声明集。**上下文装配归引擎**：装了什么、何时装，可审计、可复现。知识资源不可变、按内容寻址。

## 5. 步骤语义

- **两种形态**：`uses`（委托给另一个模块，递归组合；本步骤的输出即对方 exports）或 `directive`（本地执行一个指令体）。步骤即调用点，directive/模块端口即函数签名——`with` 是实参，编译器做形实参匹配。
- **数据即依赖**：`with` 里的 `$ref` 产生数据边；`after` 只声明纯顺序，不给数据时用。
- **route**：门禁不是特殊构造。产出枚举 verdict 的步骤声明 route，按枚举值分派到目标步骤或显式 `halt`；route 行可携带 `with` 绑定。
- **resume**：唯一合法的反向边，表达"修复后重验"。`resume <step> with …, max N` 显式改绑目标步骤输入、显式限次；超限即 run 失败。这是业务循环的全部表达——图仍然无环，循环被有限的、可见的、被计数的。
- **直通输出 `out x <- in.y`**：门禁认证并转发它所审批的产物。`$review.reviewed` 恒等于"通过了 review 的那份 change"——认证链即数据流。
- **可选输入 `?`**：生产者被跳过（如无 finding 故未修复）时，引擎以类型化空值填充。条件执行下的数据流因此诚实，无需 `latest/or` 之类的运算符。

## 6. 编译器必须保证的性质

| # | 性质 | 检查 |
|---|---|---|
| P1 | **引用闭包** | 每个 `$ref`/`uses`/`knowledge` 可解析；版本钉死为精确版本+哈希 |
| P2 | **端口匹配** | 每条 binding 的表达式类型 ≤ 目标端口类型（schema 子类型）；直通输出两侧类型一致 |
| P3 | **无环有界** | 数据/顺序/route 边无环；`resume` 是唯一反向边且必带 `max`；模块引用图无环，嵌套 ≤ 8 |
| P4 | **导出有源** | 每个 `export` 引用的步骤在所有正常终止路径上都会执行，类型匹配 |
| P5 | **路由穷尽** | 每个 route 对其枚举类型穷尽（或含 `else`）；每个分支指向已声明步骤或显式 `halt`——不存在无去向的 verdict |
| P6 | **冻结确定** | 编译输出是全解析执行计划（引用→步骤 id、版本→哈希、知识→内容地址），同输入必出同计划 |

编译产物即三样东西的共同对象：**引擎的调度表、GUI 的泳道图、ACP 会话的分配单**。

## 7. 引擎语义（语言之外，一并约定）

- **定义与运行分离**：语言写定义；run 是引擎资产，含每步状态 `PENDING → READY → RUNNING → COMPLETED | FAILED | SKIPPED`，另有 `STALE`。
- **COMPLETED ≠ PASSED**：完成是执行事实；通过与否是 verdict 数据，由门禁表达与传递。
- **重执行传染**：`resume` 重跑某步后，其全部下游传递性置 `STALE` 并重跑（产物带版本）。增量正确性由此免费获得——这正是构建系统的语义。
- **校验前不算完成**：executor（agent/human/script）的产出必须通过端口 schema 校验，方可置 `COMPLETED`。agent 经 ACP prompt 轮次执行，`permission/request` 映射为 GUI 审批。
- **作用域外零注入**：directive 看不到未声明的知识与数据；父子模块只经端口传递。

## 8. 样例一：`aaw/task-dev`

task-dev 拆为 5 步：实现 → 语义审查 →（有条件）修复→回验 → CodeCheck → 交付。**验收判据：directives 的开放文本字段之外，零自由文本。**

```
module aaw/task-dev @ 2.0.0

use aaw/codecheck @ 1

type ReviewVerdict = pass | fail | blocked

in  task    : TaskBrief
in  design  : DesignDoc
in  tests   : TestSpec
out change  : GitChange
out evidence: CompletionReport

knowledge
  coding-rules: file knowledge/coding-rules.md      scope explicit
  review-rules: file knowledge/semantic-review.md  scope explicit

directive implement-d
  executor : agent
  knowledge: coding-rules
  in  task  : TaskBrief
  in  design: DesignDoc
  in  tests : TestSpec
  out impl  : Implementation
  out change: GitChange
  goal:
    按 design 在 task 范围内实现并测试。测试以 tests 为下限不是上限，
    补测与设计偏离写入 impl.deviation，不得静默。
  accept:
    tests 圈定的用例全部通过；impl.deviation 完整登记。

directive review-d
  executor : agent
  knowledge: review-rules
  in  change: GitChange
  out report : ReviewReport
  out verdict: ReviewVerdict
  out reviewed <- change
  goal:
    对 change 做只读语义审查：需求一致性、正确性、安全、结构、演进。
    只审不改，不重复 CodeCheck 的确定性规则。
  accept:
    report 符合 ReviewReport schema；verdict 与 findings 严格一致。

directive fix-d
  executor : agent
  knowledge: coding-rules
  in  change  : GitChange
  in  findings: ReviewReport
  out change  : GitChange
  out log     : FixLog
  goal:
    处理成立的 findings；拒绝的逐条记录依据。修改后重跑受影响测试。
    高风险修改在 log 中标注 targeted_review。
  accept:
    每条 finding 在 log 中有归宿（fixed 或 rejected+依据）。

directive deliver-d
  executor : agent
  in  change: GitChange
  in  report: ReviewReport
  in  log   : FixLog?
  in  check : CodecheckReport
  out completion: CompletionReport
  goal:
    汇总四段为一份 completion，起草候选提交信息并对照工作区 diff 核实。
    不执行 git add / git commit。
  accept:
    completion 符合 CompletionReport schema，
    含偏差与残余风险小节；log 为空时按"无修复"如实呈现。

step implement
  directive implement-d
  with task=$in.task, design=$in.design, tests=$in.tests

step review
  directive review-d
  with change=$implement.change
  route $verdict
    pass    -> codecheck
    fail    -> fix
    blocked -> halt

step fix
  directive fix-d
  with change=$review.reviewed, findings=$review.report
  resume review with change=$fix.change, max 2

step codecheck
  uses aaw/codecheck
  with change=$review.reviewed

step deliver
  directive deliver-d
  with change=$review.reviewed, report=$review.report, log=$fix.log, check=$codecheck.report

export change   = $review.reviewed
export evidence = $deliver.completion
```

要点：`fix` 是条件步骤，`deliver` 以 `FixLog?` 诚实消费"可能未发生"的修复；`export change = $review.reviewed`——模块交付的恒是"通过了审查的那份变更"。

## 9. 样例二：插入安全审查（纯编辑）

在 `review` 与 `codecheck` 之间插一个安全门禁。**验收判据：纯编辑、编译通过、下游输入一行不改。**

改动共两处 + 新增一块：

```
# 改动 1：review 的 route 改一行
  route $verdict
    pass    -> sec-review      # 原: codecheck
    fail    -> fix
    blocked -> halt

# 改动 2：knowledge 增一行
  sec-rules: file knowledge/sec-rules.md  scope explicit

# 新增：类型 + 指令体 + 步骤
type SecVerdict = pass | fail | blocked

directive sec-review-d
  executor : agent
  knowledge: sec-rules
  in  change: GitChange
  out report : SecReport
  out verdict: SecVerdict
  out reviewed <- change
  goal:
    对 change 做只读安全审查：注入、越权、敏感信息、依赖风险。只审不改。
  accept:
    report 符合 SecReport schema；verdict 与 findings 严格一致。

step sec-review
  directive sec-review-d
  with change=$review.reviewed
  route $verdict
    pass    -> codecheck
    fail    -> fix
    blocked -> halt
```

`codecheck`、`deliver`、两条 `export` 一行不动——直通输出让"经安全审查的同一份 change"沿原引用继续流动，下游自动接上。

设计上的回报时刻：`fix` 的 `resume review` 同样一行不改。修复后 review 重跑 → `$review.reviewed` 的新版本使 `sec-review`、`codecheck`、`deliver` 传递性置 `STALE` 并自动重跑——**第 7 节的重执行传染让回验链自动覆盖新插入的门禁**，插入者不需要理解它前后步骤的内部。

（更严格的认证链写法是让下游改绑 `$sec-review.reviewed`，一行代价；本例选择零下游改动，两种都被 P1–P6 接受。）

## 10. 验收判据（规范立住的标志）

1. 样例一全文中，除 directives 的开放文本字段（goal/accept）外不存在任何散文指令段落；5 步图的每条边、每个 verdict 的去处、每次循环的次数上限都可被机器指认。
2. 样例二对样例一的改动 = 2 行编辑 + 1 块新增，编译通过（P1–P6 全绿），下游零改动。
3. 两条样例若写不出来或写得难看，是语言设计的失败，不是写样例人的失败——回到第 0 节加构造或减构造。

---

*v0.1 骨架。未决事项：类型库的存放与命名（aaw/types schema 注册表）、`each` 循环变量在嵌套步骤中的遮蔽规则、多文件模块是否允许、directive 文本字段是否需要保留字段（如 `constraints`）的标准集。均不阻塞上述骨架的评审。*
