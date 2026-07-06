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
    "id": 3,                          // step id
    "type": "ar-clarify",             // 步骤类型
    "name": "AR-001-ar-clarify",      // 步骤名称
    "skill": ["ar-clarify"],          // 非空 → load_skill；空 → 按 prompt 执行
    "input":  ["...", "..."],         // 输入文件
    "output": ["..."],                // 交付件（完成后检查）
    "deliverables_exist": true,       // true → 交付件已存在，可直接 done
    "hint": "交付件已存在，请执行 aaw done --sr SR-XXX 3"
  },
  // confirm 类型示例:
  {
    "id": 5,
    "type": "confirm",                // ⏸ 确认步骤
    "name": "确认继续 - sr-design",
    "skill": [],
    "prompt": "上一步 [1] sr-design 已完成。\n\n请向用户确认是否继续。\n\n- 继续: aaw done --sr SR-001 5 --data '{\"confirm\":true}' --json\n- 取消: aaw done --sr SR-001 5 --data '{\"confirm\":false}' --json"
  }],
  "done": false
}
```

**关键判断逻辑：**

- `type: "confirm"` → ⏸ 确认步骤，展示 `prompt` 给用户，执行 prompt 中的确认/取消命令
- `deliverables_exist: true` → skill 之前已执行完，只是忘了 `done`。**不要重新执行 skill**，直接 `aaw done`
- `deliverables_exist: false` → 正常执行 `load_skill`
- `done: true` → 🎉 结束
- `skill: []` + 非 confirm → 按 `prompt` 字段执行，不加载 skill

---

## 核心模式

每一步的标准流程（CLI 自动在每步完成后插入确认步骤）：

```
python <skill-dir>/scripts/aaw.py next --sr SR-XXX --json  →  获取 { ready: [...], done }
  │
  ├─ done=true → 🎉 结束
  ├─ type=confirm → ⏸ 确认步骤：展示 prompt 给用户，执行 prompt 中的命令
  ├─ ready 多个 → 引导用户选择
  └─ ready 单个 → 向用户确认后进入
       │
       ▼
load_skill / 执行 prompt  →  产出交付件
       │
       ▼
python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> [--data '...'] --json
       │
       ▼ (CLI 生成确认步骤，不是真正后继)
aaw next --json → 看到 confirm 步骤，prompt 内置续/否命令
  ├─ 继续 → aaw done <confirm_id> --data '{"confirm":true}' → 真正后继出现 → 循环
  └─ 取消 → aaw done <confirm_id> --data '{"confirm":false}' → 分支终止
```

**重点**：`aaw done` 后生成的不是真正的下一步，而是一个 `confirm` 步骤。必须确认后才生成实际后继。terminal 步骤（task-dev）无此确认。

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

### 通用循环

```
LOOP:
  1. python <skill-dir>/scripts/aaw.py next --sr SR-XXX --json
  2. 解析响应:
     - done=true → 工作流完成，退出
     - type=confirm → ⏸ 确认步骤：向用户展示 prompt，
       用户选继续 → aaw done <id> --data '{"confirm":true}'
       用户选取消 → aaw done <id> --data '{"confirm":false}'
       done 后回到步骤 1（真正后继已生成）
     - deliverables_exist=true → **跳过 skill 执行**，直接跳到步骤 6（aaw done）
     - ready 单个 → 向用户确认后进入
     - ready 多个 → 列出让用户选择:
       展示每个 step 的 id / name / type / input / output
       用户选择 step id 后进入
  3. 判断 step 类型:
     - skill 非空 → load_skill 执行子技能
     - skill 为空 → 按 prompt 执行
  4. 检查交付件（对照 step 的 output 列表）
  5. 判断是否需要 --data:
     - type=ar-split → **先询问用户是否拆分 AR**，再决定 --data
     - type=module-detail-design-split → 读取 boundary-design.md，分析模块组
     - type=task-split → 读取设计文档，分析任务列表
     - 其他 → 不需要
  6. python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> [--data '...'] --json
  7. 回到步骤 1（CLI 已自动生成确认步骤或真正后继）
```

### ar-split：询问是否拆分

执行完 ar-split prompt 后，**必须询问用户**：此 SR 是否需要拆分 AR？

**拆分（split）**：从 `SR-design.md` 中分析出所有 AR 编号和标题，构造 --data：

```bash
python <skill-dir>/scripts/aaw.py done --sr SR-XXX 2 --json \
  --data '{"ars":[{"id":"AR-001","title":"用户管理"},{"id":"AR-002","title":"权限控制"}]}'
```

然后按 AR 编号创建目录：`.sdd/SR-XXX/AR-001/`、`.sdd/SR-XXX/AR-002/`

**免拆分（no_split）**：直接标记完成，CLI 生成 module-boundary-design 步骤：

```bash
python <skill-dir>/scripts/aaw.py done --sr SR-XXX 2 --json \
  --data '{"mode":"no_split"}'
```

### module-detail-design-split

```bash
python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --json \
  --data '{"module_groups":[{"name":"A,B","modules":["模块A","模块B"],"requirement":"用户管理"},{"name":"C","modules":["模块C"],"requirement":"用户管理"}]}'
```

**task-split**：从设计文档中提取任务列表（T1-xxx, T2-xxx）：

```bash
python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --json \
  --data '{"tasks":["T1-用户CRUD","T2-权限校验"]}'
```

### 具体 step 对应关系

| step type | 做什么 | 是否需要 --data |
|-----------|--------|----------------|
| `sr-design` | load_skill sr-design | 否 |
| `ar-split` | 按 prompt 执行，**询问用户是否拆分** | **是**（ars 或 mode:no_split） |
| `ar-clarify` | load_skill ar-clarify | 否 |
| `module-boundary-design` | load_skill module-boundary-design | 否 |
| `module-detail-design-split` | 按 prompt 执行，**询问用户如何分组** | **是**（module_groups） |
| `module-asis-analysis` | load_skill module-asis-analysis | 否 |
| `module-tobe-design` | load_skill module-tobe-design | 否 |
| `module-test-design` | load_skill module-test-design | 否 |
| `module-design-gate` | load_skill module-design-gate | 否 |
| `task-split` | load_skill task-split | **是**（tasks） |
| `task-dev` | load_skill task-dev | 否 |
| `confirm` | ⏸ CLi 自动生成：向用户确认是否继续 | **是**（confirm: true/false） |

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
python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --json --data '{"mode":"no_split"}'
python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --json --data '{"ars":[...]}'
python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --json --data '{"module_groups":[...]}'
python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --json --data '{"tasks":[...]}'

# 确认步骤
python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --json --data '{"confirm":true}'
python <skill-dir>/scripts/aaw.py done --sr SR-XXX <id> --json --data '{"confirm":false}'

# 回退
python <skill-dir>/scripts/aaw.py rollback --sr SR-XXX <id> --json
```
