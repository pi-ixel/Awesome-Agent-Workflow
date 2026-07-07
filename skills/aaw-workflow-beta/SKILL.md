---
name: aaw-workflow-beta
description: 研发工作流管理入口技能（CLI 版）。使用 aaw CLI 管理状态，引导标准化开发步骤，协调调用各阶段子技能。
---

# AAW 工作流（CLI Beta）

## 上下文恢复

执行 skill 时可能因上下文压缩丢失流程记忆。**任何时候忘记该做什么，执行以下命令即可恢复：**

```bash
# 1. 查看所有 SR 及进度
python <skill-dir>/scripts/aaw.py status --json

# 2. 找到你的 SR，查看下一步
python <skill-dir>/scripts/aaw.py next --sr SR-XXX --json
```

`aaw next` 返回的 JSON 包含恢复所需的一切：

```json
{
  "ready": [{
    "id": 3,
    "type": "ar-split",
    "name": "ar-split",
    "skill": [],
    "prompt": "询问用户：此 SR 是否需要拆分 AR？...",
    "input":  ["..."],
    "output": ["..."],
    "data": {
      "description": "询问用户是否拆分 AR，两种方式二选一",
      "fields": {
        "ars": {"description": "拆分 AR 时使用。列出所有 AR 及其标题。", "example": [{"id": "AR-001", "title": "用户管理"}]},
        "mode": {"description": "不拆分时使用，固定填 no_split。", "example": "no_split"}
      }
    },
    "deliverables_exist": false
  }],
  "done": false
}
```

**关键判断逻辑：**

- `deliverables_exist: true` → skill 之前已执行完，只是忘了 `done`。**不要重新执行 skill**，直接 `aaw done`
- `deliverables_exist: false` → 继续执行
- `done: true` → 🎉 结束
- `skill` 非空 → `load_skill` 对应技能
- `skill` 为空 → 按 `prompt` 字段执行
- `data` 不为 null → `aaw done` 时需要带 `--data`，格式参看 `data.fields` 的描述和示例

---

## 核心模式

每一步的标准流程：

```
python <skill-dir>/scripts/aaw.py next --sr SR-XXX --json  →  获取 { ready: [...], done }
  │
  ├─ done=true → 🎉 结束
  ├─ ready 多个 → 引导用户选择
  └─ ready 单个 → 向用户确认后进入
       │
       ▼
  判断执行方式:
    - skill 非空 → load_skill 执行子技能
    - skill 为空 → 按 prompt 字段执行
       │
       ▼
  检查交付件（对照 output 列表）
       │
       ▼
  判断是否带 --data:
    - data 为 null → python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --json
    - data 不为 null → 根据 data.fields 的描述和示例，与用户交互收集数据后:
      python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --data '<构造的JSON>' --json
       │
       ▼ (后继立即生成)
aaw next --json → 展示 ready → 循环
```

---

## 进入流程

### 1. 检查环境

```bash
python <skill-dir>/scripts/aaw.py status --json
```

- `.sdd/` 不存在 → 提示用户先执行 `repo-init` skill 初始化项目
- `.sdd/` 存在 → 列出已有 SR 目录

### 2. 选择或创建 SR

已有 SR → 列出让用户选择，进入「推进流程」。
无 SR 或新建 → 用户提供 SR 号（需来自 iDesigner）：

```bash
python <skill-dir>/scripts/aaw.py init --sr SR-XXX
```

然后进入「首次执行」。

---

## 首次执行

新创建的 SR 只有 step 1（sr-design），必须完整执行：

```
python <skill-dir>/scripts/aaw.py next --sr SR-XXX --json
→ ready: [{id: 1, type: "sr-design", skill: ["sr-design"], ...}]
```

1. 向用户说明：`现在进入 Step 1：SR 设计 —— 将 iDesigner SR 转化为结构化设计文档`
2. `load_skill sr-design`，完整执行。**不得跳过 sr-design 的澄清流程**
3. 检查交付件 `.sdd/SR-XXX/SR-design.md` 是否生成
4. 标记完成：

```bash
python <skill-dir>/scripts/aaw.py done --sr SR-XXX 1 --json
```

5. 向用户报告，**询问是否继续**。是 → 进入「推进流程」；否 → 提醒 `/new`。

---

## 推进流程（核心循环）

```
LOOP:
  1. python <skill-dir>/scripts/aaw.py next --sr SR-XXX --json
  2. 解析响应:
     - done=true → 工作流完成，退出
     - ready 多个 → 列出每个 step 的 id / name / type / input / output，让用户选择
     - ready 单个 → 向用户确认后进入
     - deliverables_exist=true → 跳过 skill 执行，直接跳到步骤 7（aaw done）
  3. 判断执行方式:
     - skill 非空 → load_skill 执行子技能
     - skill 为空 → 按 prompt 字段执行
  4. 检查交付件（对照 step 的 output 列表），缺失则中断，不执行 done
  5. 判断是否需要 --data:
     - data 为 null → 跳过
     - data 不为 null → 读取 data.fields 中每个字段的 description 和 example，
       与用户交互收集所需数据，构造 JSON
  6. 执行 done:

     python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --json          # data 为 null 时
     python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --data '<JSON>' --json  # data 不为 null 时

  7. 向用户报告，询问是否继续。是 → 回到步骤 1；否 → 提醒 /new。
```

**--data 构造原则：** 严格参照 `aaw next --json` 返回的 `data.fields` 中每个 key 的 `description` 和 `example`。例如字段 `ars` 的 example 为 `[{"id": "AR-001", "title": "用户管理"}]`，则构造 `{"ars": [{"id": "AR-001", "title": "用户管理"}]}` 作为 --data 的值。

---

## 多就绪 step 时的用户提示

当 `aaw next` 返回多个就绪 step 时，需要向用户清晰展示上下文：

```
当前就绪的步骤：
  [3] AR-001-ar-clarify
      input:  .sdd/SR-001/SR-design.md, AR-001:用户管理
      output: .sdd/SR-001/AR-001/AR-clarify.md
  [4] AR-002-ar-clarify
      input:  .sdd/SR-001/SR-design.md, AR-002:权限控制
      output: .sdd/SR-001/AR-002/AR-clarify.md

请选择要继续的 step：
```

---

## 交付件检查

每步完成后对照 step 的 `output` 列表检查文件是否存在。如果缺失，提示用户 skill 执行可能不完整，不执行 `aaw done`。

---

## 建议新开会话

每完成一个 step 后提醒用户：

> ✅ step N 已完成。建议 `/new` 新开会话，输入 `/aaw-workflow-beta` 从中断处继续，避免上下文膨胀影响效果。

---

## CLI 命令速查

```bash
# 初始化
python <skill-dir>/scripts/aaw.py init
python <skill-dir>/scripts/aaw.py init --sr SR-XXX

# 查看
python <skill-dir>/scripts/aaw.py status --json
python <skill-dir>/scripts/aaw.py status --sr SR-XXX --json

# 推进
python <skill-dir>/scripts/aaw.py next --sr SR-XXX --json

# 完成
python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --json
python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --data '<JSON>' --json

# 回退
python <skill-dir>/scripts/aaw.py rollback --sr SR-XXX <id> --json
```
