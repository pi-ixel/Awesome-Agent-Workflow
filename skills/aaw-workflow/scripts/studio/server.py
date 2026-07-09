"""Local Workflow Studio server for editing AAW workflow definitions.

The server intentionally keeps YAML files as the source of truth. It exposes a
small JSON API and serves a static HTML application from this directory.
"""

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
        "inputs": len(config.get("input") or []),
        "outputs": len(config.get("output") or []),
    }


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
        if kind not in {"direct", "foreach", "choice", "terminal"}:
            warnings.append(f"{source} 使用了未知 edge kind: {kind}")

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

    edge_id = str(payload.get("edge_id") or "").strip()
    edge, source_edge = _edge_by_id(flow, edge_id)
    old_target = edge["target"]

    config = _build_node_config(payload, node_type)
    _write_yaml(base / f"{node_type}.yaml", config)

    if edge["kind"] == "choice":
        choices = source_edge.get("choices") or []
        branch_index = edge.get("branch_index")
        if branch_index is None or branch_index >= len(choices):
            raise StudioError(f"choice 分支不存在: {edge_id}")
        choices[branch_index]["to"] = node_type
    else:
        source_edge["to"] = node_type

    flow.setdefault("edges", {})[node_type] = {"kind": "direct", "to": old_target}
    _write_yaml(flow_path, flow)

    return {
        "ok": True,
        "message": f"已在 {edge['source']} -> {old_target} 之间插入 {node_type}",
        "created": [f"{node_type}.yaml", "flow.yaml"],
        "config": load_config(),
    }


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
