# module-asis-analysis 精简演进基线（A/B 消融协议）

## 1. 为什么选 module-asis-analysis 作为典型

这个 skill 同时具备三种「过度复杂」症状，且都能被量化：

| 症状 | 证据 |
|---|---|
| 体量失控 | `SKILL.md` 13,401 字符 / 376 行；加 `references/` 两个文件后总计约 31.8 KB。 |
| 规则密度过高 | 每千字符出现 4.7 次「必须/不得/严禁」类强规则（63 处），其中相当部分重复同一约束。 |
| 跨 skill 冗余 | 「前置操作：工作流编排检查」整段在 12 个子 skill 中逐字复制（65/86/118 字符三块）；「完成后回调」的 `aaw next/done` 三段在 6 个 skill 中重复。全库跨 skill 重复块合计约 12.5 KB。 |
| 与模型潜意识的职责重叠 | 「保留标题不要删」「区分事实与推断」「不要臆造证据」等，是强模型的默认行为；写进强制流程后变成额外的 token 与流程负担，且难以判断是否被真正执行。 |

因此优化的目标不是「写得更少」，而是**在同样的交付契约下，把不可验证的规训换成可断言的判据**。
这三套测试就是这场优化的度量基线。

## 2. 三套测试的分工

三套共用同一个场景（OpsCopilot `pkg/sessionmanager` 会话树 ASIS 分析）、同一个固定 commit、
同一份需求与架构基线，只是判据不同。这样可以分别观察「换 skill 版本」对三个维度的影响，
而不是被场景差异污染。

| 套件 | 维度 | 判据 | 回答的问题 |
|---|---|---|---|
| `ASIS-契约基线` | 内容完整性（代码 + LLM） | `validate_contract.py`：C1–C8 骨架、declared 边界标记、A/E 编号、结论可追溯、真实路径、不越界写正式说明书、现状/方案分离 | 精简版本是否仍守交付契约？ |
| `ASIS-事实可信` | 功能正确性（代码）+ 事实与证据质量（LLM） | `validate_facts.py`：10 条现状事实逐条核对；`validate_edge.py`：5 条反直觉边界行为与「不得说反」 | 精简是否以牺牲事实准确性为代价？ |
| `ASIS-产出经济性` | 内容完整性（代码）+ 表达清晰度（LLM） | `validate_economy.py`：规模上下限、证据定位密度、正文 30-gram 重复率、Skill 元指令重述次数、单句重复率 | 同样的信息量是否用了更少的冗余表达？ |

每套都是单候选（`current_only`），因此对比要靠**基线钉死**：先用当前 skill 跑一轮并设为 baseline，
再换精简版 skill 路径跑，页面上的 delta 才是这次优化的净效果。

## 3. 判据为什么可复核

- 断言脚本全部放在 workspace 之外（grader 文件独立 materialize），Agent 看不到判据条款。
- 事实类断言锚定**符号级**引用：`pkg/sessionmanager/manager.go#RenameSession` 必须能在真实文件里找到该符号。
- 「说反」类断言只匹配明确断言，不匹配否定表达（例如「没有临时文件与 rename」不算违规）。
- 经济性断言有上下限：低于 1200 字符视为空壳直接判负，避免「什么都不写」拿满分。

## 4. 消融流程

1. 当前 skill 跑三套（quick），把三套的 `current` 结果分别设为 baseline。
2. 修改 skill（移动公共块到 `aaw-workflow`、删除模型默认行为规训、合并重复约束），得到新版本。
3. 新版本跑同样三套，比较 delta：
   - 契约基线下降 → 精简越界，交付契约丢了东西。
   - 事实可信下降 → 精简把「必须查证」的约束删过头。
   - 产出经济性上升 → 精简确实降低了冗余成本。
4. 只有「经济性上升且前两者不降」的版本才可接受。

一键脚本：

```powershell
cd skill-eval
.venv/Scripts/python.exe evolution/asis-slim/build_suites.py      # 创建/复用三套并锁定
.venv/Scripts/python.exe evolution/asis-slim/run_baseline.py      # 跑一轮并把结果钉为基线
.venv/Scripts/python.exe evolution/asis-slim/run_baseline.py --skill <精简版路径> --no-pin  # 跑新版本
.venv/Scripts/python.exe evolution/asis-slim/export_standards.py  # 归档到 standards/
```

`run_baseline.py --skill` 可以指向任意 skill 目录，因此 A/B 对比只是换一个路径。
`export_standards.py` 把用例输入、预期、判据脚本、套件定义和固定 commit 一并归档，
保证分数可复核、可重放。

## 5. 基线参考值（2026-10-27，deepseek-v4.1-flash，quick 模式）

| 套件 | 当前 skill 得分 | 说明 |
|---|---|---|
| 契约基线 | 100.0 | 骨架、边界来源、编号体系、路径真实性、职责边界全部满足 |
| 事实可信 | 100.0 | 12 项现状事实 + 7 项反直觉边界行为全部命中，LLM 事实/证据维度满分 |
| 产出经济性 | 87.4 | 内容完整性与表达清晰度加权 87.4；代码侧 89.5，唯一失分是产物 36.4 KB 超过 32 KB 上限 |

这三个数字是「精简前」的对照点，不是质量结论。精简版必须做到：经济性上升，
同时契约基线与事实可信不下降。经济性 87.4 中的 32 KB 上限就是这次精简最直接的目标——
当前 skill 会让产物写到 36 KB，其中相当部分是重复的流程规训。

基线已钉死在平台里（`05-meta.json` 的 `baseline_experiment_id`），换 skill 版本重跑后
页面上的 delta 即为净效果。

## 6. 已知局限

- `no_skill` 对照组对当前模型已失效（训练语料含 AAW 术语），因此这里不做 skill vs no_skill 的增量判断，
  只做 skill 版本之间的比较。
- 经济性断言里的重复率阈值来自对既有 ASIS 产物的实测（正文 30-gram 重复 4.5%–10.5%），
  是对「当前基线」的贴合，不是绝对质量标准；换场景后需重新校准。
- 三套共用同一场景，反应的是该场景下的表现，不能外推到所有模块类型。
