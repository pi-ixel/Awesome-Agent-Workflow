# 工作流定义扩展指南

`definitions/` 目录定义了 AAW 工作流的所有步骤及其拓扑关系。扩展时只需修改此目录，无需改动 Python 代码。

---

## 目录结构

```
definitions/
├── flow.yaml                      # DAG 拓扑（edge 定义）
├── sr-design.yaml                 # 步骤定义（每步骤一个文件）
├── ar-split.yaml
├── ar-clarify.yaml
├── module-boundary-design.yaml
├── module-detail-design-split.yaml
├── module-asis-analysis.yaml
├── module-tobe-design.yaml
├── module-test-design.yaml
├── module-design-gate.yaml
├── task-split.yaml
└── task-dev.yaml
```

---

## 添加新步骤

### 1. 创建步骤 YAML

新建 `definitions/<step-type>.yaml`，字段如下：

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | ✅ | 步骤显示名，可用 `{VAR}` 占位符（如 `{AR}-ar-clarify`） |
| `skill` | ❌ | 对应的子技能名列表（如 `[sr-design]`）。为空表示 LLM 按 `prompt` 自行执行 |
| `prompt` | ❌ | `skill` 为空时，LLM 的执行指令 |
| `input` | ❌ | 输入文件列表，支持 `{VAR}` 占位符，相对于 `.sdd/` |
| `output` | ❌ | 交付件文件列表，支持 `{VAR}` 占位符，用于交付件检查 |

**示例——1:1 后继步骤（ar-clarify.yaml）：**

```yaml
name: "{AR}-ar-clarify"
skill: [ar-clarify]
input: [".sdd/{SR}/SR-design.md", "{AR}:{描述}"]
output: [".sdd/{SR}/{AR}/AR-clarify.md"]
```

**示例——分叉 / 需要 --data 的步骤（ar-split.yaml）：**

```yaml
name: ar-split
prompt: |
  询问用户：此 SR 是否需要拆分 AR？
  ...
input: [".sdd/{SR}/SR-design.md"]
```

### 2. 在 flow.yaml 添加 edge

`flow.yaml` 只描述步骤间关系，四种 `kind`：

---

#### kind: 1to1 — 完成 → 生成 1 个固定后继

```yaml
sr-design: { kind: 1to1, to: ar-split }
```

`to` 指向目标步骤 YAML 的文件名（不含 `.yaml`）。

---

#### kind: 1toN — 完成 → 根据 --data 生成 N 个后继

```yaml
task-split:
  kind: 1toN
  to: task-dev
  data_schema:
    description: "从 task-split 生成的 tasks 目录中提取任务列表"
    fields:
      tasks:
        description: "任务名称列表，每个任务对应一个独立开发单元。"
        example: ["T1-用户CRUD", "T2-权限校验"]
```

- `to`：目标步骤模板名。
- `data_schema`：**必填**。LLM 看到 `aaw next --json` 的 `data` 字段后，根据 `description` 理解含义、根据 `example` 构造 `--data` JSON。
- 生成数量由 `--data` 中数组长度决定（如 `tasks` 有 3 项 → 生成 3 个 `task-dev`）。

---

#### kind: choice — 完成 → 用户从多选项中选一个

```yaml
ar-split:
  kind: choice
  ars: ar-clarify
  no_split: module-boundary-design
  data_schema:
    description: "询问用户是否拆分 AR，两种方式二选一"
    fields:
      ars:
        description: "拆分 AR 时使用。列出所有 AR 及其标题。"
        example: [{id: AR-001, title: 用户管理}]
      mode:
        description: "不拆分时使用，固定填 no_split。"
        example: no_split
```

- 除了 `data_schema` 外的每个 key 都是一个选项（`ars`、`no_split`），值为目标步骤模板名。
- LLM 根据 `data_schema.fields` 与用户交互后，选择构造对应的 `--data`（如 `{"ars": [...]}` 或 `{"mode": "no_split"}`）。
- 如果每个选项对应不同的后继步骤，只需添加更多 key。

> ⚠️ `choice` 目前只有 `ar-split` 一个实例。如果新步骤不需这种二选一行为，应使用 `1to1` 或 `1toN`。

---

#### kind: terminal — 终点

```yaml
task-dev: { kind: terminal }
```

完成后不生成后继，工作流在此终止。

---

### 3. data_schema 规范

`data_schema` 用于 `1toN` 和 `choice` 类型，定义 LLM 需要收集的结构化数据。LLM 通过 `aaw next --json` 的 `data` 字段获取。

格式：

```yaml
data_schema:
  description: "一句话说明这个步骤需要用户提供什么数据"
  fields:
    <key-name>:
      description: "这个字段的含义、选项说明"
      example: <示例值>
```

- `description`：向 LLM 解释数据用途。
- `example`：用真实值演示格式。LLM 会参照此格式构造 JSON。

---

## 变量传递

步骤之间通过占位符 `{VAR}` 传递上下文。可用变量：

| 变量 | 来源 | 说明 |
|------|------|------|
| `{SR}` | 初始化时传入 | SR 编号，如 `SR-001` |
| `{AR}` | ar-split 的 --data 或 _extract_variables | AR 编号，如 `AR-001` |
| `{描述}` | ar-split 的 --data | AR 标题描述 |
| `{需求短名}` | module-detail-design-split 的 --data | 需求短名 |
| `{模块组名}` | module-detail-design-split 的 --data | 模块组缩写，如 `模块A,B` |
| `{序号}` | task-split 的 --data | 任务序号，如 `1`、`2` |
| `{任务标题}` | task-split 的 --data | 任务标题，如 `T1-用户CRUD` |

---

## 添加 skill

如果新步骤需要调用子技能（`skill` 字段非空），需确保：

1. `skills/` 目录下存在对应的 skill（如 `skills/sr-design/`）
2. skill 的 `SKILL.md` 中 `name` 字段与步骤 YAML 的 `skill` 值一致
3. 在 `flow.yaml` 中添加对应的 edge

无需修改 `main.py`、`models.py` 或 `workflow.py`。
