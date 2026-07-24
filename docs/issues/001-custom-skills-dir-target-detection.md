# 自定义 skills 目录下无法识别 Agent 类型

**状态**：待修复  
**优先级**：高  
**版本**：2.3.2  

## 问题描述

当前 `detect_target(skills_root)` 通过路径后缀匹配推断 Agent 类型：

```
~/.chrys/skills/           → chrys
~/.claude/skills/          → claude
~/.config/opencode/skills/ → opencode
~/.codex/                  → codex
其他                        → None（跳过 MCP 注入）
```

Chrys 支持用户自定义 skills 目录（通过 `skills.paths` 配置），AAW skills 可能被安装到非标准路径。此时 `detect_target` 返回 `None`，`_ensure_mcp_config` 静默跳过，**MCP 配置不会被注入到 Agent 配置文件中**。

## 影响范围

- 使用 Chrys 自定义 skills 目录的用户
- 所有 Agent 平台（不仅是 Chrys），只要用户不按标准路径安装

## 修复方案

`install.sh` 首次安装时，在 `skills_root` 下写入 `.aaw-target` 标记文件，内容为 Agent 类型。`detect_target` 在路径匹配失败时，读此文件作为兜底。

### install.sh 变更

在 `resolve_paths()` 后、skills 复制完成后：

```bash
echo "$TARGET" > "$SKILLS_DST/.aaw-target"
```

卸载时删除：

```bash
rm -f "$SKILLS_DST/.aaw-target"
```

### mcp_config.py 变更

`detect_target()` 增加兜底逻辑：

```python
def detect_target(skills_root: Path) -> str | None:
    # 1. 路径后缀匹配（已有逻辑）
    ...
    # 2. 兜底：读取 .aaw-target 标记文件
    marker = skills_root / ".aaw-target"
    if marker.is_file():
        target = marker.read_text("utf-8").strip()
        if target in ("claude", "codex", "opencode", "chrys"):
            return target
    return None
```

## 验收标准

1. `install.sh --target=chrys --user --copy` → `~/.chrys/skills/.aaw-target` 文件存在，内容 `chrys`
2. 将 skills 整体移动到 `/tmp/custom/skills/`，`detect_target` 返回 `"chrys"`
3. 卸载后 `.aaw-target` 被删除
4. 未安装的目录不受影响（无 `.aaw-target` → 行为不变）
