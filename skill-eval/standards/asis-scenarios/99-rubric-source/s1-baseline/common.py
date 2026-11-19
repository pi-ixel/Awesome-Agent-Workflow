#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""场景矩阵断言的共享实现。

每个场景脚本 `import common` 后自行登记子项，输出平台固定 check id：
- required-behavior：本场景要求交付的内容
- edge-cases：本场景特有的失败模式

除逐项断言外，本模块还提供一组可量化的产物指标（骨架完整率、结论-证据配对率、
锚点可定位率、路径真实性率、信息密度、重复率等），让每个场景的判据不是
「有没有出现某个词」，而是「这项指标是否达到阈值」。指标同时写进 evidence
与 NOTES，便于人工复核与纵向对比。

只读 AAW_WORKSPACE 与 AAW_FINAL_RESPONSE，不 import 被测评 skill 的任何代码。
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

WORKSPACE = Path(os.environ.get("AAW_WORKSPACE") or ".").resolve()
_FINAL = os.environ.get("AAW_FINAL_RESPONSE") or ""

SKELETON = [
    ("C1", "ASIS 状态"),
    ("C2", "模块边界"),
    ("C3", "关键 ASIS 事实"),
    ("C4", "调用链"),
    ("C5", "配置、数据、测试"),
    ("C6", "规格漂移"),
    ("C7", "证据索引"),
    ("C8", "追溯矩阵"),
]

# 表达决策点 / 待确认 / 目标状态的表述，不能当作“声称现状如此”。
NOT_CLAIM = re.compile(
    r"决策输入|决策点|TOBE|可选|待确认|待定|待实现|尚未|未实现|未发现|不存在|缺失|"
    r"是否|需要.{0,6}吗|OQ\d|D\d+\s*\||建议|推荐|可以考虑|需前置确认|方案选择|候选方案|"
    r"应(新增|增加|引入|同步)|需(新增|引入)|目标状态|期望状态|需求要求"
)
NEGATION = re.compile(r"无|未|不|没有|非|尚未|不存在|不适用|不得|不能|并非|缺")
# 「如返回副本」「改为返回副本」是在描述可选方案或契约变更影响，不是现状断言。
HYPOTHETICAL = re.compile(
    r"[（(]?如(?:返回|改为|改成|需|要)|例如|比如|若(?:改|返回|要)|改成|改为"
    # 描述改造影响（「任何写入语义改造都要考虑…」「原子写都会连带影响…」）不是现状断言。
    r"|都会[^。；\n]{0,12}(影响|连带|涉及)|改造[^。；\n]{0,12}(都要|需|会)"
    r"|任何[^。；\n]{0,12}改造"
)
# 行内自带反证：说明它正在描述「没有做 X」，不能当作「做了 X」；
# 或描述的是仓库里其它位置的原子写实现（不是本模块 Save），也不能算说反。
CONTRAST = re.compile(
    r"直接覆盖|不写[^。；\n]{0,6}(临时文件|tmp)|不 ?rename|无 ?tmp|无(临时文件|写前备份)|"
    r"未使用[^。；\n]{0,8}(临时文件|rename)|非原子|既有原子写实现|writeAtomic"
)
STALE = re.compile(r"不存在|已删除|已移除|缺失|no longer|stale|过时|未实现|未提供|已废弃|待删除")
# 临时/自建对象豁免必须贴着路径出现，避免「临时文件 + rename」这类现状描述
# 把整行里出现的所有路径都当成豁免。
TEMP_NEAR = re.compile(r"(?:临时|副本|探针|probe|自建|示例|伪代码|未落盘|工作区外)[^。；\n]{0,16}$")
TEMP_AFTER = re.compile(r"^[^。；\n]{0,16}(?:临时|副本|探针|probe|自建|示例|伪代码|未落盘|工作区外)")
# 引用/转述外部文档中的路径，不是对当前仓库现状的断言。
DOC_REF = re.compile(r"(?:docs?/[A-Za-z0-9_./\-]+\.md|review-[A-Za-z0-9_.\-]+\.md|README\.md)")
QUOTE_VERB = re.compile(r"描述|声称|写到|写作|引用|列出|提到|中的|不存在|已删除|检索缺失")
GIT_HISTORY = re.compile(r"git (?:show|log|diff)|历史提交|提交 [0-9a-f]{7}|--stat")


def _is_quoting(line: str) -> bool:
    """该行在转述别的来源，而不是断言当前仓库现状。

    两类：① 引用仓库里真实存在的文档并带转述动词；② 引用 git 历史（历史提交里
    出现过的路径现在可能已被删除，这是有价值的证据而不是虚构）。
    """
    if GIT_HISTORY.search(line):
        return True
    if not QUOTE_VERB.search(line):
        return False
    for match in DOC_REF.finditer(line):
        if resolve_path(_clean_token(match.group(0))) is not None:
            return True
    return False
PLACEHOLDER = re.compile(r"待补充|待填写|未完成|TODO|TBD")
BLOCKED = re.compile(r"ASIS\s*阻塞|状态\s*[:：]\s*(?:阻塞|blocked)|\bblocked\b", re.I)
BLOCK_DENIED = re.compile(
    r"无[^。；\n]{0,12}阻塞|未(?:触发|出现|声明)阻塞|不阻塞|非阻塞|没有[^。；\n]{0,12}阻塞|不适用|无此"
)

# 引用第三方依赖包内的路径（Wails / golang.org/x / github.com 等）时，
# 该路径本就不在仓库里，既不算真实路径也不算虚构。
EXTERNAL_NEAR = re.compile(
    r"(?:Wails|wails|golang\.org/x|github\.com/|gopkg\.in/|gorm\.io/|模块缓存|module cache)"
    r"[^。；\n]{0,30}$"
)


PATH_PATTERN = re.compile(r"[A-Za-z0-9_./\-]*(?:pkg|frontend|docs)/[A-Za-z0-9_./\-]+")
PATH_SUFFIX = (".go", ".ts", ".tsx", ".js", ".jsx", ".md", ".json", ".yaml", ".yml")


# ---------------------------------------------------------------- 读取
def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8-sig", errors="replace") if path.is_file() else ""
    except OSError:
        return ""


def final_response() -> str:
    return read(Path(_FINAL)) if _FINAL else ""


def artifact_of(sr: str) -> tuple[Path | None, str]:
    found = sorted(WORKSPACE.glob(f".sdd/{sr}/*/*/.context/详细设计上下文.md"))
    if not found:
        return None, ""
    return found[0], read(found[0])


def combined(sr: str) -> tuple[Path | None, str]:
    """产物 + 最终回复：允许“阻塞时只在回复中报结论”的降级路径。"""
    path, text = artifact_of(sr)
    return path, (text + "\n\n" + final_response()).strip()


def flat(text: str) -> str:
    return re.sub(r"[ \t]+", " ", text)


def sentences(text: str) -> list[str]:
    return [part.strip() for part in re.split(r"[。；\n]+", text) if part.strip()]


def any_of(text: str, *patterns: str) -> bool:
    return any(re.search(pattern, text) for pattern in patterns)


def section(text: str, tag: str) -> str:
    match = re.search(rf"^##\s*{tag}[^\n]*\n(.*?)(?=^##\s|\Z)", text, re.S | re.M)
    return match.group(1) if match else ""


def skeleton_missing(text: str) -> list[str]:
    return [f"{tag}.{kw}" for tag, kw in SKELETON if not (tag in text and kw in text)]


def boundary_source(text: str) -> str:
    """C2 声明的边界来源类型。

    合法产物可能同时写「归属 declared」与「某条结论因冲突而 blocked」——这比
    一刀切标 blocked 更准确。因此只有「没有 declared 只有 blocked」才算 blocked。
    """
    body = section(text, "C2") or text[:4000]
    if re.search(r"declared", body, re.I) and "software_architecture.md" in body:
        return "declared"
    if BLOCKED.search(body):
        return "blocked"
    return "unknown"


def claims_blocked(text: str) -> bool:
    """是否真的声明了 ASIS 阻塞。

    `### C6.2 ASIS 阻塞项` 这类固定目录标题本身就是模板一部分，标题下面写
    「不适用，原因：…」才是结论。因此标题行不参与判定，改为看标题后的第一句。
    """
    lines = text.splitlines()
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#"):
            if BLOCKED.search(stripped):
                body = next(
                    (item.strip() for item in lines[index + 1 :] if item.strip()),
                    "",
                )
                if body and not BLOCK_DENIED.search(body):
                    return True
            continue
        if stripped and BLOCKED.search(stripped) and not BLOCK_DENIED.search(stripped):
            return True
    return False


def blocked_on_missing(text: str, subject: str) -> bool:
    """是否把「对象不存在」本身当作阻塞理由。

    纯新增场景允许写 `部分完成` + 阻塞项，那些阻塞通常来自需求口径缺口（导出是否带
    凭据、去重键是什么），是合法降级；只有「因为找不到对象所以阻塞」才是失效模式。
    因此要求同一行里同时出现：阻塞措辞 + 该对象 + 不存在类措辞。
    """
    missing = re.compile(r"不存在|未找到|未实现|未提供|缺失|找不到|没有实现")
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or not BLOCKED.search(stripped):
            continue
        if BLOCK_DENIED.search(stripped):
            continue
        if not re.search(subject, stripped) or not missing.search(stripped):
            continue
        return True
    return False


# ---------------------------------------------------------------- 编号与路径
def ids(text: str, prefix: str) -> set[str]:
    return set(re.findall(rf"\b{prefix}\d{{1,3}}\b", text))


def traceable_ratio(text: str, prefix: str) -> float:
    found = ids(text, prefix)
    if not found:
        return 0.0
    return len([i for i in found if len(re.findall(rf"\b{i}\b", text)) >= 2]) / len(found)


def _clean_token(raw: str) -> str:
    token = raw.strip("`;:，。；：）()[] ").replace("\\", "/")
    while token.startswith("./"):
        token = token[2:]
    # 产物常以仓库根为锚写成 `/pkg/...`，这与 `pkg/...` 是同一路径。
    if token.startswith("/") and not token.startswith("//"):
        token = token[1:]
    return token.rstrip(".,")


def path_tokens(text: str) -> dict[str, bool]:
    tokens: dict[str, bool] = {}
    for line in text.splitlines():
        if STALE.search(line):
            continue
        # 转述外部文档里的路径（「文档以 `pkg/x/y.go` 描述…」）不是对当前仓库的断言：
        # 那份文档可能本身就在引用已删除的文件，转述它是漂移发现的一部分。
        quoting = _is_quoting(line)
        for match in PATH_PATTERN.finditer(line):
            token = _clean_token(match.group(0))
            if not (token.endswith(PATH_SUFFIX) or token.endswith("/")):
                continue
            before = line[: match.start()]
            after = line[match.end() :]
            exempt = (
                quoting
                or bool(TEMP_NEAR.search(before))
                or bool(TEMP_AFTER.match(after))
                or bool(EXTERNAL_NEAR.search(before))
            )
            tokens[token] = tokens.get(token, False) or exempt
    return tokens


def phantom_paths(text: str) -> list[str]:
    """虚构路径：既不是真实文件，也不是唯一的省略号/裸名缩写。"""
    return sorted(
        token
        for token, exempt in path_tokens(text).items()
        if not exempt and resolve_path(token) is None and not (WORKSPACE / token).is_dir()
    )


def real_paths(text: str) -> list[str]:
    phantom = set(phantom_paths(text))
    return sorted(token for token in path_tokens(text) if token not in phantom)


ANCHOR_ANY = re.compile(
    r"[A-Za-z0-9_./\-]+\.(?:tsx|ts|jsx|js|go|md|json|yaml|yml)"
    r"(?::\d+(?:-\d+)?|#[A-Za-z_][A-Za-z0-9_]*)?"
)
# 证据表常见写法：`path:1-325（Session 21-27、Load 50-64、Save 66-73）`
# 括号里的行号区间是同一文件的细分锚点，必须一起计入，否则会低估证据密度。
SPAN_TAIL = re.compile(r"[（(]([^）)]*)[）)]")
BARE_SPAN = re.compile(r"(?<![\d:])(\d+)\s*[-–]\s*(\d+)(?![\d:])")


_BASENAME_CACHE: dict[str, list[str]] = {}
_FILE_LIST: list[str] = []


def _all_files() -> list[str]:
    global _FILE_LIST, _BASENAME_CACHE
    if not _FILE_LIST:
        for base, dirs, names in os.walk(WORKSPACE):
            dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "build", "vendor"}]
            for name in names:
                _FILE_LIST.append((Path(base) / name).relative_to(WORKSPACE).as_posix())
        for relative in _FILE_LIST:
            _BASENAME_CACHE.setdefault(relative.rsplit("/", 1)[-1], []).append(relative)
    return _FILE_LIST


def module_hint() -> str | None:
    """从产物路径推断被分析模块目录（`pkg-foo-bar` → `pkg/foo/bar`）。

    产物里 `manager.go:75-79` 这类裸文件名指向的通常是本模块的文件；
    工作区里有多个同名 manager.go 时，需要这个线索才能无歧义解析。
    """
    for path in WORKSPACE.glob(".sdd/*/*/*/.context/详细设计上下文.md"):
        parts = path.relative_to(WORKSPACE).parts
        if len(parts) < 5:
            continue
        group = parts[3]
        if "-" not in group:
            return None
        head, _, tail = group.partition("-")
        return f"{head}/{tail.replace('-', '/')}"
    return None


def resolve_path(path: str) -> str | None:
    """把产物里的路径映射到工作区真实文件。

    裸文件名（`manager.go:114-120`）在已声明模块的文档里很常见：先按模块目录
    解析，再退化为「全工作区唯一同名文件」；仍有歧义则返回 None。
    省略号缩写（`frontend/.../SessionManager.tsx`）按通配匹配唯一文件。
    """
    if "..." in path:
        pattern = re.compile(
            "^" + re.escape(path).replace(r"\.\.\.", ".*") + "$"
        )
        matches = [item for item in _all_files() if pattern.match(item)]
        return matches[0] if len(matches) == 1 else None
    if "/" in path:
        return path if (WORKSPACE / path).is_file() else None
    _all_files()
    matches = _BASENAME_CACHE.get(path, [])
    if len(matches) == 1:
        return matches[0]
    hint = module_hint()
    if hint:
        scoped = [item for item in matches if item.startswith(hint + "/")]
        if len(scoped) == 1:
            return scoped[0]
    return None


def _resolve_anchor(token: str) -> bool:
    token = _clean_token(token)
    match = re.fullmatch(
        r"((?:[A-Za-z0-9_.\-]+/)*[A-Za-z0-9_.\-]+\.(?:tsx|ts|jsx|js|go|md|json|yaml|yml))"
        r"(?::(\d+)(?:-(\d+))?|#([A-Za-z_][A-Za-z0-9_]*))",
        token,
    )
    if not match:
        return False
    resolved = resolve_path(match.group(1))
    if resolved is None:
        return False
    body = read(WORKSPACE / resolved)
    if not body:
        return False
    if match.group(4):
        return match.group(4) in body
    total = len(body.splitlines())
    numbers = [int(match.group(2))] + ([int(match.group(3))] if match.group(3) else [])
    return all(1 <= number <= total for number in numbers)


def expand_anchors(line: str) -> list[tuple[str, list[tuple[int, int]], str]]:
    """把一行的证据锚点展开为 (文件, 行号区间列表, 符号)。

    `path:10-20` 之后紧跟的括号里若列了 `Symbol 21-27` 这类细分区间，
    这些区间归属同一文件；单独出现的行号区间不计（无法判断属于哪个文件）。
    `path#Symbol` 的行号列表为空，符号非空。
    """
    found: list[tuple[str, list[tuple[int, int]], str]] = []
    for match in ANCHOR_ANY.finditer(line):
        token = _clean_token(match.group(0))
        path = re.match(r"[A-Za-z0-9_./\-]+\.(?:tsx|ts|jsx|js|go|md|json|yaml|yml)", token)
        # 裸文件名（正文里讨论 `manager.go`）不是锚点；带行号/符号或带目录才算。
        if not path:
            continue
        has_anchor = bool(re.search(r"(?::\d+(?:-\d+)?|#[A-Za-z_][A-Za-z0-9_]*)$", token))
        if "/" not in path.group(0) and not has_anchor:
            continue
        spans: list[tuple[int, int]] = []
        symbol = ""
        tail = token[len(path.group(0)) :]
        if tail.startswith("#"):
            symbol = tail[1:]
        elif tail.startswith(":"):
            first, _, last = tail[1:].partition("-")
            spans.append((int(first), int(last or first)))
            rest = line[match.end() :]
            # 允许反引号收尾后再跟括号：`path:1-325`（`Save` 66-73、…）
            paren = re.match(r"[`\s]*[（(]([^）)]*)[）)]", rest)
            if paren:
                for start, end in BARE_SPAN.findall(paren.group(1)):
                    spans.append((int(start), int(end)))
        found.append((path.group(0), spans, symbol))
    return found


def anchors_resolvable(text: str, prefixes: list[str] | None = None) -> tuple[int, list[str]]:
    """可定位锚点数（按展开后的区间/符号计数，去重）与无效锚点列表。"""
    valid: set[str] = set()
    invalid: set[str] = set()
    for line in text.splitlines():
        for path, spans, symbol in expand_anchors(line):
            if prefixes and not any(path.startswith(prefix) for prefix in prefixes):
                continue
            resolved = resolve_path(path)
            if resolved is None:
                continue
            body = read(WORKSPACE / resolved)
            if not body:
                invalid.add(f"{path}(missing)")
                continue
            if symbol:
                key = f"{path}#{symbol}"
                if symbol in body:
                    valid.add(key)
                else:
                    invalid.add(key)
                continue
            if not spans:
                continue
            total = len(body.splitlines())
            for start, end in spans:
                # `requirement.md:2025-11` 之类是文档日期，不是行号锚点：不计有效也不计无效。
                if start >= 1900:
                    continue
                key = f"{path}:{start}-{end}" if start != end else f"{path}:{start}"
                if 1 <= start <= end <= total:
                    valid.add(key)
                else:
                    invalid.add(key)
    return len(valid), sorted(invalid - valid)


COMMAND_EVIDENCE = re.compile(
    r"(?:^|[\s`|])(?:go test|go build|go vet|git (?:log|show|diff|status)|rg |grep |"
    r"python |powershell |TestProbe_[A-Za-z0-9_]+)"
)


def row_locatable(row: list[str], prefixes: list[str] | None = None) -> str | None:
    """判定证据行可定位的类型：`file` / `command` / None。

    ASIS 证据不只来自读文件：跑测试、跑探针、看 git 历史同样构成可复核证据。
    两类都要认，否则一份把行为实测写进 C7 的产物会被误判成“没有证据”。
    """
    joined = " | ".join(row)
    for path, spans, symbol in expand_anchors(joined):
        if prefixes and not any(path.startswith(prefix) for prefix in prefixes):
            continue
        resolved = resolve_path(path)
        if resolved is None:
            continue
        body = read(WORKSPACE / resolved)
        total = len(body.splitlines())
        if not body:
            continue
        if symbol:
            if symbol in body:
                return "file"
            continue
        if not spans or all(1 <= start <= end <= total for start, end in spans):
            return "file"
    if COMMAND_EVIDENCE.search(joined) and re.search(r"→|->|ok |PASS|err=|输出", joined):
        return "command"
    return None


def anchor_density(text: str, prefixes: list[str] | None = None) -> float:
    """C7 证据行可定位率：文件锚点或带结论输出的命令证据。

    prefixes 为空时对任意仓库文件锚点计数——C7 天然会引用多个文件
    （需求、架构基线、组合根、消费方），只认被分析模块会把合法证据误判为无锚点。
    """
    rows = table_rows(text, "C7")
    if not rows:
        return 0.0
    return len([row for row in rows if row_locatable(row, prefixes)]) / len(rows)


def file_anchor_density(text: str, prefixes: list[str] | None = None) -> float:
    """严格口径：只算带可定位文件锚点的行。"""
    rows = table_rows(text, "C7")
    if not rows:
        return 0.0
    return len([row for row in rows if row_locatable(row, prefixes) == "file"]) / len(rows)


def command_evidence_density(text: str) -> float:
    rows = table_rows(text, "C7")
    if not rows:
        return 0.0
    return len([row for row in rows if row_locatable(row) == "command"]) / len(rows)


def wrong_claim(text: str, subject: str, claim: str, negations: str | None = None) -> str | None:
    negation = re.compile(negations) if negations else NEGATION
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or not re.search(subject, stripped) or not re.search(claim, stripped):
            continue
        if (
            negation.search(stripped)
            or NOT_CLAIM.search(stripped)
            or HYPOTHETICAL.search(stripped)
            or CONTRAST.search(stripped)
        ):
            continue
        return stripped[:160]
    return None


def file_unchanged(relative: str) -> bool | None:
    """只读任务的真实过程指标：工作区文件是否与 HEAD 提交一致。

    `git show` 输出的是索引内容（LF），工作区在 Windows 上可能是 CRLF，
    因此比较前统一换行符与 BOM，否则每个未改动的文件都会被判成改动。
    """
    try:
        head = subprocess.run(
            ["git", "-C", str(WORKSPACE), "show", f"HEAD:{relative}"],
            capture_output=True,
            timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if head.returncode != 0:
        return None

    def normalize(raw: bytes) -> bytes:
        return raw.lstrip(b"\xef\xbb\xbf").replace(b"\r\n", b"\n")

    current = WORKSPACE / relative
    try:
        if not current.is_file():
            return False
        return normalize(current.read_bytes()) == normalize(head.stdout)
    except OSError:
        return None


def extra_sdd_files(sr: str) -> list[str]:
    """产物目录下除上下文本体与需求外的文件。

    `.context/reviews/` 是评测 harness 自带的独立评审工具落盘位置（runner profile
    明确要求把 reviewer_a/b 的报告原样保存），不是模型自作主张多写的文档，因此不计入。
    """
    root = WORKSPACE / ".sdd" / sr
    if not root.is_dir():
        return []
    return sorted(
        p.relative_to(WORKSPACE).as_posix()
        for p in root.rglob("*")
        if p.is_file()
        and p.name not in {"详细设计上下文.md", "requirement.md"}
        and "/.context/reviews/" not in p.relative_to(WORKSPACE).as_posix()
    )


def formal_docs() -> list[str]:
    return sorted(p.as_posix() for p in WORKSPACE.glob(".sdd/**/模块详细设计说明书.md"))


# ---------------------------------------------------------------- 表格与章节
def table_rows(text: str, tag: str) -> list[list[str]]:
    rows = []
    for line in section(text, tag).splitlines():
        stripped = line.strip()
        if not stripped.startswith("|") or re.fullmatch(r"\|[\s\-:|]+\|", stripped):
            continue
        cells = [cell.strip() for cell in stripped.strip("|").split("|")]
        if cells and re.search(r"编号|结论|位置|说明|需求项|依据|类型|状态|文档位置|文档承诺", cells[0]):
            continue
        if cells and re.fullmatch(r"[-: ]+", cells[0]):
            continue
        rows.append(cells)
    return rows


def mapping_ratio(text: str) -> float:
    """C3 事实表里，结论行同时给出证据编号的比例。"""
    rows = table_rows(text, "C3")
    if not rows:
        return 0.0
    good = 0
    for row in rows:
        joined = " | ".join(row)
        if re.search(r"\bA\d{1,3}\b", joined) and re.search(r"\bE\d{1,3}\b", joined):
            good += 1
    return good / len(rows)


def coverage_ratio(text: str) -> float:
    """C8 需求追溯表的覆盖比例。

    C8 章节里通常还有 C8.1「覆盖统计」与 C8.2「未纳入范围」两张附表，它们不含
    覆盖状态列；把附表算进分母会把一份完整追溯矩阵判成覆盖不足。只统计需求行。
    """
    rows = [row for row in table_rows(text, "C8") if row and re.match(r"^R\d{1,3}\b", row[0])]
    if not rows:
        rows = table_rows(text, "C8")
    if not rows:
        return 0.0
    status = re.compile(r"已覆盖|部分覆盖|待确认|不涉及|未覆盖|阻塞|已查证|未查证")
    return len([row for row in rows if any(status.search(cell) for cell in row)]) / len(rows)


def substantive_sections(text: str) -> float:
    """C1–C8 有实质内容（非占位、非空）的章节比例。"""
    good = 0
    for tag, _ in SKELETON:
        body = section(text, tag).strip()
        if body and not (PLACEHOLDER.search(body) and len(body) < 60):
            good += 1
    return good / len(SKELETON)


def drift_count(text: str) -> int:
    body = section(text, "C6")
    rows = [row for row in table_rows(text, "C6") if any(row)]
    markers = len(re.findall(r"漂移|不一致|冲突|过时|与实现不符", body))
    return max(len(rows), markers)


# ---------------------------------------------------------------- 经济性
def text_metrics(text: str) -> dict:
    rows, body, in_fence = [], [], False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if stripped.startswith("|"):
            if not re.fullmatch(r"\|[\s\-:|]+\|", stripped):
                rows.append(stripped)
            continue
        body.append(stripped)
    prose = "\n".join(body)
    compact = re.sub(r"\s+", "", prose)
    repeat = 0.0
    if len(compact) >= 60:
        counts: dict[str, int] = {}
        for index in range(len(compact) - 30 + 1):
            gram = compact[index : index + 30]
            counts[gram] = counts.get(gram, 0) + 1
        repeat = sum(30 for gram, count in counts.items() if count > 1) / len(compact)
    parts = [
        re.sub(r"\s+", "", part)
        for part in re.split(r"[。；\n]+", prose)
        if len(part.strip()) >= 24
    ]
    total = sum(len(item) for item in parts)
    dup = 0.0
    if total:
        counts = {}
        for item in parts:
            counts[item] = counts.get(item, 0) + 1
        dup = sum(len(item) * (count - 1) for item, count in counts.items() if count > 1) / total
    return {
        "chars": len(text),
        "table_rows": len(rows),
        "prose_repeat": round(repeat, 4),
        "sentence_dup": round(dup, 4),
        "meta_mentions": len(
            re.findall(r"本 ?skill|阶段产出|SubAgent|固定目录|工作流程|模板|检查清单|按 skill", text)
        ),
    }


# ---------------------------------------------------------------- 指标汇总
@dataclass
class Metrics:
    artifact: bool
    chars: int
    skeleton_rate: float
    substantive_rate: float
    conclusions: int
    evidences: int
    traceable_rate: float
    mapping_rate: float
    anchors_total: int
    anchors_valid: int
    anchor_rate: float
    c7_density: float
    c7_file_density: float
    c7_command_density: float
    c8_coverage: float
    paths_total: int
    paths_real: int
    path_truth: float
    drift_items: int
    table_rows: int
    prose_repeat: float
    sentence_dup: float
    meta_mentions: int
    formal_docs: int
    extra_files: int


def measure(sr: str, anchor_prefixes: list[str]) -> tuple[Path | None, str, Metrics]:
    path, text = artifact_of(sr)
    if not text:
        zero = Metrics(
            artifact=False, chars=0, skeleton_rate=0.0, substantive_rate=0.0, conclusions=0,
            evidences=0, traceable_rate=0.0, mapping_rate=0.0, anchors_total=0, anchors_valid=0,
            anchor_rate=0.0, c7_density=0.0, c7_file_density=0.0, c7_command_density=0.0,
            c8_coverage=0.0, paths_total=0, paths_real=0,
            path_truth=0.0, drift_items=0, table_rows=0, prose_repeat=0.0, sentence_dup=0.0,
            meta_mentions=0, formal_docs=len(formal_docs()), extra_files=len(extra_sdd_files(sr)),
        )
        return path, text, zero

    tokens = path_tokens(text)
    # 锚点总数按全工作区统计：C7 天然引用需求、架构、组合根、消费方多个文件，
    # 只数被分析模块会把一份证据充分的产物判成“锚点不足”。模块内锚点由场景自行调用。
    valid_anchors, invalid_anchors = anchors_resolvable(text)
    total_anchors = valid_anchors + len(invalid_anchors)
    tm = text_metrics(text)
    metrics = Metrics(
        artifact=True,
        chars=len(text),
        skeleton_rate=(len(SKELETON) - len(skeleton_missing(text))) / len(SKELETON),
        substantive_rate=round(substantive_sections(text), 3),
        conclusions=len(ids(text, "A")),
        evidences=len(ids(text, "E")),
        traceable_rate=round(traceable_ratio(text, "A"), 3),
        mapping_rate=round(mapping_ratio(text), 3),
        anchors_total=total_anchors,
        anchors_valid=valid_anchors,
        anchor_rate=round(valid_anchors / total_anchors, 3) if total_anchors else 0.0,
        c7_density=round(anchor_density(text), 3),
        c7_file_density=round(file_anchor_density(text), 3),
        c7_command_density=round(command_evidence_density(text), 3),
        c8_coverage=round(coverage_ratio(text), 3),
        paths_total=len(tokens),
        paths_real=len(real_paths(text)),
        path_truth=round(len(real_paths(text)) / len(tokens), 3) if tokens else 0.0,
        drift_items=drift_count(text),
        table_rows=tm["table_rows"],
        prose_repeat=tm["prose_repeat"],
        sentence_dup=tm["sentence_dup"],
        meta_mentions=tm["meta_mentions"],
        formal_docs=len(formal_docs()),
        extra_files=len(extra_sdd_files(sr)),
    )
    return path, text, metrics


# ---------------------------------------------------------------- 输出
class Report:
    """按平台固定 check id 累计加权子项，并附带可复核的指标快照。"""

    def __init__(self, check_ids: list[str], reason: str = "") -> None:
        self.rows: dict[str, list[tuple[str, int, bool, str]]] = {cid: [] for cid in check_ids}
        self.metrics: dict | None = None
        if reason:
            for cid in check_ids:
                self.rows[cid].append(("产物缺失", 1, False, reason))

    def attach(self, metrics: Metrics) -> None:
        self.metrics = asdict(metrics)

    def add(self, check: str, label: str, weight: int, ok: bool, detail: str = "") -> None:
        if check not in self.rows:
            raise SystemExit(f"unknown checkpoint {check}")
        self.rows[check].append((label, weight, bool(ok), detail))

    def emit(self, notes: dict | None = None) -> None:
        checks = []
        for check, rows in self.rows.items():
            total = sum(weight for _, weight, _, _ in rows)
            got = sum(weight for _, weight, ok, _ in rows if ok)
            score = round(100.0 * got / total, 1) if total else 0.0
            failed = [
                f"{label}（{detail}）" if detail else label
                for label, _, ok, detail in rows
                if not ok
            ]
            evidence = f"{check}：{got}/{total} 权重通过，得分 {score}。"
            if failed:
                evidence += "未通过：" + "；".join(failed[:8])
            checks.append({"id": check, "score": score, "weight": 1, "evidence": evidence[:2000]})
        print(json.dumps({"checks": checks}, ensure_ascii=False))
        payload = {"metrics": self.metrics, **(notes or {})}
        print("NOTES: " + json.dumps(payload, ensure_ascii=False), file=sys.stderr)
