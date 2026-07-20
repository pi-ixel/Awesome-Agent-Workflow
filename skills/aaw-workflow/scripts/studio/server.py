"""Local Workflow Studio server for editing AAW workflow definitions.

The server intentionally keeps YAML files as the source of truth. It exposes a
small JSON API and serves a static HTML application from this directory.
"""
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pyyaml>=6.0",
# ]
# ///

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import yaml


SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_DEFINITIONS_DIR = SCRIPT_DIR.parent / "cli" / "definitions"
NODE_TYPE_RE = re.compile(r"^[a-z][a-z0-9-]*$")
TOKEN_ENV = "AAW_STUDIO_TOKEN"
USER_CONFIRM_VALUES = {"skip", "ask", "must"}


class StudioError(Exception):
    """User-facing API error."""

    def __init__(self, message: str, status: HTTPStatus = HTTPStatus.BAD_REQUEST):
        super().__init__(message)
        self.status = status


def definitions_dir() -> Path:
    override = os.environ.get("AAW_STUDIO_DEFINITIONS_DIR")
    if override:
        return Path(override).resolve()
    return DEFAULT_DEFINITIONS_DIR.resolve()


def _read_yaml(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text("utf-8")) or {}
    if not isinstance(data, dict):
        raise StudioError(f"YAML 必须是 object: {path.name}")
    return data


def _write_yaml(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        yaml.safe_dump(
            data,
            allow_unicode=True,
            sort_keys=False,
            default_flow_style=False,
        ),
        "utf-8",
    )


def _node_files(base: Path) -> list[Path]:
    return sorted(p for p in base.glob("*.yaml") if p.stem != "flow")


def load_config() -> dict[str, Any]:
    base = definitions_dir()
    flow = _read_yaml(base / "flow.yaml")
    nodes = {path.stem: _read_yaml(path) for path in _node_files(base)}
    edges = build_edges(flow)
    validation = validate_config(flow, nodes, edges)
    return {
        "definitions_dir": str(base).replace("\\", "/"),
        "flow": flow,
        "nodes": [
            {
                "type": node_type,
                "path": str((base / f"{node_type}.yaml")).replace("\\", "/"),
                "config": config,
                "summary": summarize_node(node_type, config),
            }
            for node_type, config in nodes.items()
        ],
        "edges": edges,
        "validation": validation,
    }


def summarize_node(node_type: str, config: dict[str, Any]) -> dict[str, Any]:
    skill = config.get("skill") or []
    if isinstance(skill, str):
        skill = [skill]
    return {
        "name": config.get("name") or node_type,
        "execution": config.get("execution") or ("skill" if skill else "prompt" if config.get("prompt") else "noop"),
        "skill": skill,
        "prompt": summarize_prompt(config.get("prompt")),
        "has_data_prompt": bool(config.get("data_prompt")),
        "inputs": len(config.get("input") or []),
        "outputs": len(config.get("output") or []),
    }


def summarize_prompt(prompt: Any) -> str:
    if not prompt:
        return ""
    if isinstance(prompt, str):
        return prompt
    if not isinstance(prompt, dict):
        return "复杂 prompt"
    if prompt.get("template"):
        return str(prompt["template"])
    if prompt.get("inline"):
        return "内联说明"
    steps = prompt.get("steps")
    if isinstance(steps, list):
        return f"步骤清单 {len(steps)} 项"
    return "复杂 prompt"


def build_edges(flow: dict[str, Any]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for source, edge in (flow.get("edges") or {}).items():
        if not isinstance(edge, dict):
            continue
        kind = normalize_kind(str(edge.get("kind") or "terminal"))
        if kind in {"direct", "foreach"}:
            target = edge.get("to")
            if target:
                result.append(
                    {
                        "id": f"{source}::{kind}::to::{target}",
                        "source": source,
                        "target": target,
                        "kind": kind,
                        "label": edge.get("foreach") if kind == "foreach" else "direct",
                        "branch_index": None,
                        "user_confirm": edge.get("user_confirm") or "skip",
                    }
                )
        elif kind == "choice":
            for index, choice in enumerate(edge.get("choices") or []):
                if not isinstance(choice, dict):
                    continue
                target = choice.get("to")
                if not target:
                    continue
                label = choice.get("when") or f"choice {index + 1}"
                if choice.get("foreach"):
                    label = f"{label} / {choice['foreach']}"
                result.append(
                    {
                        "id": f"{source}::choice::{index}::{target}",
                        "source": source,
                        "target": target,
                        "kind": "choice",
                        "label": label,
                        "branch_index": index,
                        "user_confirm": choice.get("user_confirm") or edge.get("user_confirm") or "skip",
                    }
                )
    return result


def normalize_kind(kind: str) -> str:
    if kind == "1to1":
        return "direct"
    if kind == "1toN":
        return "foreach"
    return kind


def validate_config(
    flow: dict[str, Any],
    nodes: dict[str, dict[str, Any]],
    edges: list[dict[str, Any]],
) -> dict[str, list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    node_names = set(nodes)
    edge_sources = set((flow.get("edges") or {}).keys())
    edge_targets = {edge["target"] for edge in edges}
    entry_starts = {
        data.get("start")
        for data in (flow.get("entrypoints") or {}).values()
        if isinstance(data, dict) and data.get("start")
    }

    for entry, data in (flow.get("entrypoints") or {}).items():
        start = data.get("start") if isinstance(data, dict) else None
        if start and start not in node_names:
            errors.append(f"入口 {entry} 指向不存在的节点: {start}")

    for source, edge in (flow.get("edges") or {}).items():
        if source not in node_names:
            errors.append(f"flow.yaml 中存在没有节点文件的来源节点: {source}")
        if not isinstance(edge, dict):
            errors.append(f"{source} 的 edge 必须是 object")
            continue
        kind = normalize_kind(str(edge.get("kind") or "terminal"))
        if kind in {"direct", "foreach"} and edge.get("to") not in node_names:
            errors.append(f"{source} 指向不存在的节点: {edge.get('to')}")
        if edge.get("user_confirm") and edge.get("user_confirm") not in USER_CONFIRM_VALUES:
            errors.append(f"{source}.user_confirm 必须是 skip、ask 或 must")
        if kind == "choice":
            choices = edge.get("choices") or []
            if not choices:
                errors.append(f"{source} 是 choice，但没有 choices")
            for index, choice in enumerate(choices):
                if not isinstance(choice, dict):
                    errors.append(f"{source}.choices[{index}] 必须是 object")
                    continue
                if choice.get("to") not in node_names:
                    errors.append(f"{source}.choices[{index}] 指向不存在的节点: {choice.get('to')}")
                if choice.get("user_confirm") and choice.get("user_confirm") not in USER_CONFIRM_VALUES:
                    errors.append(f"{source}.choices[{index}].user_confirm 必须是 skip、ask 或 must")
        if kind not in {"direct", "foreach", "choice", "terminal"}:
            warnings.append(f"{source} 使用了未知 edge kind: {kind}")

    for node_type, config in sorted(nodes.items()):
        execution = str(config.get("execution") or "").strip()
        if execution == "skill" and not config.get("skill"):
            warnings.append(f"{node_type} 使用 skill 执行方式，但没有配置 skill")
        if execution == "prompt" and not config.get("prompt"):
            warnings.append(f"{node_type} 使用 prompt 执行方式，但没有配置 prompt")
        if execution and execution not in {"skill", "prompt", "manual", "noop"}:
            warnings.append(f"{node_type} 使用了未知 execution: {execution}")

    referenced = edge_sources | edge_targets | entry_starts
    for node_type in sorted(node_names - referenced):
        warnings.append(f"{node_type}.yaml 已定义，但未被当前流程引用")

    for node_type in sorted((edge_targets | entry_starts) - edge_sources):
        config = nodes.get(node_type) or {}
        if normalize_kind(str((flow.get("edges") or {}).get(node_type, {}).get("kind") or "")) != "terminal":
            if node_type in node_names and node_type not in edge_sources:
                warnings.append(f"{node_type} 被流程引用，但没有后继边；如为结束节点，请在 flow.yaml 中标为 terminal")

    return {"errors": errors, "warnings": warnings}


def _parse_io_text(text: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("value:"):
            value = line.split(":", 1)[1].strip()
            if value:
                items.append({"value": value})
            continue

        parts = [part.strip() for part in line.split("|") if part.strip()]
        item: dict[str, Any] = {"path": parts[0], "required": True}
        for part in parts[1:]:
            if part == "required=false":
                item["required"] = False
            elif part == "required=true":
                item["required"] = True
        items.append(item)
    return items


def _normalize_skill_text(skill: str) -> list[str]:
    return [item.strip() for item in skill.replace("\n", ",").split(",") if item.strip()]


def _build_prompt_config(payload: dict[str, Any]) -> dict[str, Any] | None:
    legacy_template = str(payload.get("prompt_template") or "").strip()
    mode = str(payload.get("prompt_mode") or ("template" if legacy_template else "")).strip()
    text = str(payload.get("prompt_text") if "prompt_text" in payload else legacy_template).strip()
    if not text:
        return None
    if mode == "template":
        return {"template": text}
    if mode == "inline":
        return {"inline": text}
    if mode == "steps":
        return {"steps": _parse_prompt_steps(text)}
    raise StudioError("prompt_mode 必须是 template、inline 或 steps")


def _parse_prompt_steps(text: str) -> list[dict[str, str]]:
    steps: list[dict[str, str]] = []
    for index, raw_line in enumerate(text.splitlines(), start=1):
        line = raw_line.strip()
        if not line:
            continue
        if line.startswith("- "):
            line = line[2:].strip()
        key = f"step_{index}"
        description = line
        if ":" in line:
            left, right = line.split(":", 1)
            if left.strip() and right.strip():
                key = left.strip()
                description = right.strip()
        steps.append({key: description})
    return steps


def _edge_by_id(flow: dict[str, Any], edge_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    for edge in build_edges(flow):
        if edge["id"] == edge_id:
            return edge, (flow.get("edges") or {}).get(edge["source"], {})
    raise StudioError(f"找不到要插入的边: {edge_id}", HTTPStatus.NOT_FOUND)


def insert_node(payload: dict[str, Any]) -> dict[str, Any]:
    base = definitions_dir()
    flow_path = base / "flow.yaml"
    flow = _read_yaml(flow_path)
    nodes = {path.stem: _read_yaml(path) for path in _node_files(base)}

    node_type = str(payload.get("node_type") or "").strip()
    if not NODE_TYPE_RE.match(node_type):
        raise StudioError("node_type 只能使用小写字母、数字和中划线，并以字母开头")
    if node_type in nodes:
        raise StudioError(f"节点已存在: {node_type}")

    config = _build_node_config(payload, node_type)

    edge_id = str(payload.get("edge_id") or "").strip()
    if edge_id:
        message = _insert_between_edge(flow, edge_id, node_type)
    else:
        anchor_node = str(payload.get("anchor_node") or "").strip()
        position = str(payload.get("position") or "").strip()
        if anchor_node not in nodes:
            raise StudioError(f"锚点节点不存在: {anchor_node}", HTTPStatus.NOT_FOUND)
        if position == "before":
            message = _insert_before_node(flow, anchor_node, node_type)
        elif position == "after":
            message = _insert_after_node(flow, anchor_node, node_type)
        else:
            raise StudioError("请选择插入位置：edge_id，或 anchor_node + position(before/after)")

    _write_yaml(base / f"{node_type}.yaml", config)
    _write_yaml(flow_path, flow)

    return {
        "ok": True,
        "message": message,
        "created": [f"{node_type}.yaml", "flow.yaml"],
        "config": load_config(),
    }


def _insert_between_edge(flow: dict[str, Any], edge_id: str, node_type: str) -> str:
    edge, source_edge = _edge_by_id(flow, edge_id)
    old_target = edge["target"]
    if edge["kind"] == "choice":
        choices = source_edge.get("choices") or []
        branch_index = edge.get("branch_index")
        if branch_index is None or branch_index >= len(choices):
            raise StudioError(f"choice 分支不存在: {edge_id}")
        choices[branch_index]["to"] = node_type
    else:
        source_edge["to"] = node_type

    flow.setdefault("edges", {})[node_type] = {"kind": "direct", "to": old_target}
    return f"已在 {edge['source']} -> {old_target} 之间插入 {node_type}"


def _insert_before_node(flow: dict[str, Any], anchor_node: str, node_type: str) -> str:
    incoming = _incoming_refs(flow, anchor_node)
    entry_refs = [
        name
        for name, data in (flow.get("entrypoints") or {}).items()
        if isinstance(data, dict) and data.get("start") == anchor_node
    ]
    if len(incoming) + len(entry_refs) != 1:
        raise StudioError("只能在恰好有一个上游或一个入口的节点左侧新增；多上游请点击具体连线插入")

    if incoming:
        _set_ref_target(flow, incoming[0], node_type)
    else:
        flow["entrypoints"][entry_refs[0]]["start"] = node_type
    flow.setdefault("edges", {})[node_type] = {"kind": "direct", "to": anchor_node}
    return f"已在 {anchor_node} 左侧新增 {node_type}"


def _insert_after_node(flow: dict[str, Any], anchor_node: str, node_type: str) -> str:
    outgoing = [edge for edge in build_edges(flow) if edge["source"] == anchor_node]
    raw_edge = (flow.get("edges") or {}).get(anchor_node)
    raw_kind = normalize_kind(str(raw_edge.get("kind") or "")) if isinstance(raw_edge, dict) else ""

    if len(outgoing) == 1:
        _insert_between_edge(flow, outgoing[0]["id"], node_type)
    elif len(outgoing) == 0 and (not isinstance(raw_edge, dict) or raw_kind == "terminal"):
        flow.setdefault("edges", {})[anchor_node] = {"kind": "direct", "to": node_type}
        flow.setdefault("edges", {})[node_type] = {"kind": "terminal"}
    else:
        raise StudioError("只能在恰好有一个下游或结束节点右侧新增；多下游请点击具体连线插入")
    return f"已在 {anchor_node} 右侧新增 {node_type}"


def _build_node_config(payload: dict[str, Any], node_type: str) -> dict[str, Any]:
    execution = str(payload.get("execution") or "skill").strip()
    if execution not in {"skill", "prompt", "manual", "noop"}:
        raise StudioError("execution 必须是 skill、prompt、manual 或 noop")

    config: dict[str, Any] = {
        "name": str(payload.get("name") or node_type).strip(),
        "execution": execution,
    }
    skills = _normalize_skill_text(str(payload.get("skill") or ""))
    if skills:
        config["skill"] = skills
    prompt_config = _build_prompt_config(payload)
    if execution == "prompt" and not prompt_config:
        raise StudioError("prompt 执行方式需要配置 prompt")
    if prompt_config:
        config["prompt"] = prompt_config
    inputs = _parse_io_text(str(payload.get("input_text") or ""))
    outputs = _parse_io_text(str(payload.get("output_text") or ""))
    if inputs:
        config["input"] = inputs
    if outputs:
        config["output"] = outputs
    data_prompt = str(payload.get("data_prompt") or "").strip()
    if data_prompt:
        config["data_prompt"] = {"description": data_prompt}
    return config


def update_node(payload: dict[str, Any]) -> dict[str, Any]:
    base = definitions_dir()
    node_type = str(payload.get("node_type") or "").strip()
    if not NODE_TYPE_RE.match(node_type):
        raise StudioError("node_type 格式不合法")
    path = base / f"{node_type}.yaml"
    if not path.exists():
        raise StudioError(f"节点不存在: {node_type}", HTTPStatus.NOT_FOUND)

    config = _read_yaml(path)
    if "name" in payload:
        config["name"] = str(payload.get("name") or node_type).strip()
    if "execution" in payload:
        execution = str(payload.get("execution") or "skill").strip()
        if execution not in {"skill", "prompt", "manual", "noop"}:
            raise StudioError("execution 必须是 skill、prompt、manual 或 noop")
        config["execution"] = execution
    if "skill" in payload:
        skills = _normalize_skill_text(str(payload.get("skill") or ""))
        if skills:
            config["skill"] = skills
        else:
            config.pop("skill", None)
    if "prompt_text" in payload or "prompt_template" in payload:
        prompt_config = _build_prompt_config(payload)
        if prompt_config:
            config["prompt"] = prompt_config
        elif config.get("execution") == "prompt" and not config.get("prompt"):
            raise StudioError("prompt 执行方式需要配置 prompt")
    if "input_text" in payload:
        config["input"] = _parse_io_text(str(payload.get("input_text") or ""))
    if "output_text" in payload:
        config["output"] = _parse_io_text(str(payload.get("output_text") or ""))
    if "data_prompt" in payload:
        value = str(payload.get("data_prompt") or "").strip()
        if value:
            config["data_prompt"] = {"description": value}
        else:
            config.pop("data_prompt", None)

    _write_yaml(path, config)
    return {"ok": True, "message": f"已保存 {node_type}.yaml", "config": load_config()}


def delete_node(payload: dict[str, Any]) -> dict[str, Any]:
    base = definitions_dir()
    node_type = str(payload.get("node_type") or "").strip()
    flow = _read_yaml(base / "flow.yaml")
    nodes = {path.stem: _read_yaml(path) for path in _node_files(base)}
    edges = build_edges(flow)
    entry_starts = {
        data.get("start")
        for data in (flow.get("entrypoints") or {}).values()
        if isinstance(data, dict) and data.get("start")
    }
    referenced = set((flow.get("edges") or {}).keys()) | {edge["target"] for edge in edges} | entry_starts
    if node_type in referenced:
        raise StudioError("该节点仍被流程引用。请先调整 flow.yaml 的连接关系，再删除节点。")
    if node_type not in nodes:
        raise StudioError(f"节点不存在: {node_type}", HTTPStatus.NOT_FOUND)

    (base / f"{node_type}.yaml").unlink()
    return {"ok": True, "message": f"已删除 {node_type}.yaml", "config": load_config()}


def remove_node(payload: dict[str, Any]) -> dict[str, Any]:
    """Remove a simple middle node and reconnect its predecessor to its successor."""
    base = definitions_dir()
    flow_path = base / "flow.yaml"
    flow = _read_yaml(flow_path)
    nodes = {path.stem: _read_yaml(path) for path in _node_files(base)}
    node_type = str(payload.get("node_type") or "").strip()
    if node_type not in nodes:
        raise StudioError(f"节点不存在: {node_type}", HTTPStatus.NOT_FOUND)

    entry_starts = {
        data.get("start")
        for data in (flow.get("entrypoints") or {}).values()
        if isinstance(data, dict) and data.get("start")
    }
    if node_type in entry_starts:
        raise StudioError("入口节点不能通过一键移除删除")

    node_edge = (flow.get("edges") or {}).get(node_type)
    if not isinstance(node_edge, dict) or normalize_kind(str(node_edge.get("kind") or "")) != "direct":
        raise StudioError("只能一键移除 direct 中间节点；复杂分支请手动调整 flow.yaml")
    successor = node_edge.get("to")
    if not successor:
        raise StudioError("该节点没有可接回的下游")

    incoming = _incoming_refs(flow, node_type)
    if len(incoming) != 1:
        raise StudioError("只能一键移除恰好有一个上游的节点")
    incoming_ref = incoming[0]
    _set_ref_target(flow, incoming_ref, successor)

    flow.get("edges", {}).pop(node_type, None)
    _write_yaml(flow_path, flow)
    (base / f"{node_type}.yaml").unlink()
    return {
        "ok": True,
        "message": f"已移除 {node_type}，并接回到 {successor}",
        "config": load_config(),
    }


def _incoming_refs(flow: dict[str, Any], target: str) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    for source, edge in (flow.get("edges") or {}).items():
        if not isinstance(edge, dict):
            continue
        kind = normalize_kind(str(edge.get("kind") or "terminal"))
        if kind in {"direct", "foreach"} and edge.get("to") == target:
            refs.append({"source": source, "kind": kind})
        elif kind == "choice":
            for index, choice in enumerate(edge.get("choices") or []):
                if isinstance(choice, dict) and choice.get("to") == target:
                    refs.append({"source": source, "kind": "choice", "index": index})
    return refs


def _set_ref_target(flow: dict[str, Any], ref: dict[str, Any], target: str) -> None:
    edge = flow.get("edges", {}).get(ref["source"])
    if not isinstance(edge, dict):
        raise StudioError("上游连接不存在，无法接回")
    if ref["kind"] == "choice":
        choices = edge.get("choices") or []
        index = ref.get("index")
        if index is None or index >= len(choices):
            raise StudioError("choice 上游分支不存在，无法接回")
        choices[index]["to"] = target
    else:
        edge["to"] = target


class StudioHandler(BaseHTTPRequestHandler):
    server_version = "AAWWorkflowStudio/0.1"

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/api/config":
            if not self._ensure_authorized():
                return
            self._send_json(load_config())
            return
        if parsed.path == "/api/validate":
            if not self._ensure_authorized():
                return
            config = load_config()
            self._send_json(config["validation"])
            return
        self._serve_static(parsed.path)

    def do_POST(self) -> None:
        try:
            if not self._ensure_authorized():
                return
            payload = self._read_json()
            if self.path == "/api/insert-node":
                self._send_json(insert_node(payload))
            elif self.path == "/api/update-node":
                self._send_json(update_node(payload))
            elif self.path == "/api/delete-node":
                self._send_json(delete_node(payload))
            elif self.path == "/api/remove-node":
                self._send_json(remove_node(payload))
            else:
                self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        except StudioError as exc:
            self._send_json({"error": str(exc)}, exc.status)
        except Exception as exc:  # pragma: no cover - defensive API boundary
            self._send_json({"error": f"服务器错误: {exc}"}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length") or "0")
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        data = json.loads(raw.decode("utf-8"))
        if not isinstance(data, dict):
            raise StudioError("请求 JSON 必须是 object")
        return data

    def _serve_static(self, raw_path: str) -> None:
        path = unquote(raw_path)
        if path in {"", "/"}:
            path = "/index.html"
        file_path = (SCRIPT_DIR / path.lstrip("/")).resolve()
        if SCRIPT_DIR not in file_path.parents and file_path != SCRIPT_DIR:
            self._send_json({"error": "Forbidden"}, HTTPStatus.FORBIDDEN)
            return
        if not file_path.exists() or not file_path.is_file():
            self._send_json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
            return

        body = file_path.read_bytes()
        content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_json(self, data: dict[str, Any], status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _ensure_authorized(self) -> bool:
        expected = os.environ.get(TOKEN_ENV)
        if not expected:
            return True
        supplied = self.headers.get("X-AAW-Studio-Token")
        if supplied == expected:
            return True
        self._send_json(
            {
                "error": "需要访问令牌",
                "requires_token": True,
            },
            HTTPStatus.UNAUTHORIZED,
        )
        return False

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[studio] {self.address_string()} - {fmt % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description="AAW Workflow Studio")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", default=8765, type=int)
    parser.add_argument("--open", action="store_true", help="启动后打开浏览器")
    parser.add_argument("--token", default=None, help="设置访问令牌；适合内网共享时使用")
    args = parser.parse_args()

    if args.token:
        os.environ[TOKEN_ENV] = args.token

    server = ThreadingHTTPServer((args.host, args.port), StudioHandler)
    browser_host = "127.0.0.1" if args.host in {"0.0.0.0", "::"} else args.host
    local_url = f"http://{browser_host}:{args.port}"
    print(f"AAW Workflow Studio: {local_url}")
    print(f"definitions: {definitions_dir()}")
    if os.environ.get(TOKEN_ENV):
        print("token: enabled")
    if args.host in {"0.0.0.0", "::"}:
        print("lan: enabled; use this machine's intranet IP with the same port")
    if args.open:
        webbrowser.open(local_url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping studio server")


if __name__ == "__main__":
    main()
