"""Durable task-dev phase state and guidance."""

from __future__ import annotations

import hashlib
import json
import re
import subprocess
from pathlib import Path, PurePosixPath
from typing import Any

import yaml

from .models import Step, Workflow, WorkflowError


TASK_STATUSES = (
    "initialized",
    "implemented",
    "reviewed",
    "revalidated",
    "prepared",
    "completed",
)
CHECKPOINT_PHASES = {"implemented", "reviewed", "revalidated", "prepared"}
REVIEW_DIMENSIONS = {"requirements", "security", "performance", "structure", "readability", "evolution"}
REVIEW_SEVERITIES = {"critical", "high", "medium", "low"}
REVIEW_SECTION = "task-dev 语义 Review 扩展规则"
REVIEW_SECTION_LABEL = "task-dev semantic Review extension rules"


class TaskDevError(WorkflowError):
    def __init__(self, message: str, payload: dict[str, Any] | None = None):
        super().__init__(message)
        self.payload = payload


def _atomic_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", "utf-8")
    temporary.replace(path)


def _read_json(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text("utf-8-sig"))
    except OSError as exc:
        raise TaskDevError(f"cannot read the task-dev data file: {path}: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise TaskDevError(f"the task-dev data file is not valid JSON: {path}: {exc}") from exc
    if not isinstance(data, dict):
        raise TaskDevError(f"the task-dev data file must be a JSON object: {path}")
    return data


class TaskDevManager:
    def __init__(self, sdd_dir: Path):
        self.sdd_dir = Path(sdd_dir)
        self.root = self.sdd_dir.parent.resolve()

    @staticmethod
    def is_task_dev(step: Step) -> bool:
        return step.type == "task-dev"

    def _attempt_dir(self, wf: Workflow, step: Step) -> Path:
        return self.sdd_dir / wf.sr / ".aaw" / "task-dev" / str(step.id) / str(step.attempt or 1)

    def _state_path(self, wf: Workflow, step: Step) -> Path:
        return self._attempt_dir(wf, step) / "state.json"

    @staticmethod
    def _script_path() -> str:
        return str((Path(__file__).resolve().parents[1] / "aaw.py")).replace("\\", "/")

    def _command(self, *args: str) -> list[str]:
        return ["python", self._script_path(), *args]

    def _git(self, args: list[str], *, check: bool = True) -> subprocess.CompletedProcess[bytes]:
        try:
            result = subprocess.run(
                ["git", *args],
                cwd=self.root,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                check=False,
                timeout=60,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise TaskDevError(f"cannot execute the Git command: {exc}") from exc
        if check and result.returncode != 0:
            detail = result.stderr.decode("utf-8", "replace").strip()
            raise TaskDevError(f"the Git command failed: {detail or result.returncode}")
        return result

    def _head_tree(self) -> str:
        result = self._git(["rev-parse", "HEAD^{tree}"], check=False)
        return result.stdout.decode("ascii", "replace").strip() if result.returncode == 0 else "UNBORN"

    def _tree_for_revision(self, revision: str) -> str:
        if not revision or revision == "UNBORN":
            return "UNBORN"
        result = self._git(["rev-parse", f"{revision}^{{tree}}"], check=False)
        if result.returncode != 0:
            raise TaskDevError("cannot migrate the task-dev Git baseline; start a new attempt for this task")
        return result.stdout.decode("ascii", "replace").strip()

    @staticmethod
    def _decode_paths(raw: bytes) -> set[str]:
        return {
            part.decode("utf-8", "surrogateescape").replace("\\", "/")
            for part in raw.split(b"\0")
            if part
        }

    @staticmethod
    def _is_runtime_path(name: str) -> bool:
        path = PurePosixPath(name)
        parts = path.parts
        if parts and parts[0] == ".aaw":
            return True
        if len(parts) >= 3 and parts[0] == ".sdd" and ".aaw" in parts[2:]:
            return True
        return len(parts) >= 3 and parts[0] == ".sdd" and parts[-1] == "workflow.yaml"

    def _changed_files(self, baseline_tree: str) -> list[str]:
        diff_base = baseline_tree if baseline_tree != "UNBORN" else "HEAD"
        tracked = self._git(
            ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", diff_base],
            check=False,
        )
        names = self._decode_paths(tracked.stdout) if tracked.returncode == 0 else set()
        if tracked.returncode != 0:
            names.update(self._decode_paths(self._git(["ls-files", "--cached", "-z"]).stdout))
        names.update(self._decode_paths(self._git(["ls-files", "--others", "--exclude-standard", "-z"]).stdout))
        return sorted(name for name in names if not self._is_runtime_path(name))

    def snapshot(self, wf: Workflow, step: Step, baseline_tree: str) -> dict[str, Any]:
        del wf, step
        changed_files = self._changed_files(baseline_tree)
        validated_files = [name for name in changed_files if not name.startswith(".sdd/")]
        digest = hashlib.sha256()
        for name in validated_files:
            digest.update(name.encode("utf-8", "surrogateescape"))
            digest.update(b"\0")
            path = self.root / PurePosixPath(name)
            if not path.exists():
                digest.update(b"<deleted>")
            elif path.is_file():
                digest.update(path.read_bytes())
            else:
                digest.update(b"<non-file>")
            digest.update(b"\0")
        return {
            "validated_code_digest": "sha256:" + digest.hexdigest(),
            "changed_files": changed_files,
            "validated_files": validated_files,
        }

    def ensure_initialized(self, wf: Workflow, step: Step) -> dict[str, Any]:
        if not self.is_task_dev(step):
            raise TaskDevError(f"step {step.id} is not a task-dev step")
        path = self._state_path(wf, step)
        if path.exists():
            return self.load(wf, step)
        baseline_tree = self._head_tree()
        snapshot = self.snapshot(wf, step, baseline_tree)
        state = {
            "schema_version": 3,
            "task_id": self.task_id(step),
            "step_id": step.id,
            "attempt": step.attempt,
            "status": "initialized",
            "baseline_tree": baseline_tree,
            "initial_changed_files": snapshot["changed_files"],
            "validated_code_digest": snapshot["validated_code_digest"],
            "changed_files": snapshot["changed_files"],
            "validated_files": snapshot["validated_files"],
            "reports": {},
            "open_findings": [],
            "review_policy_digest": None,
            "proposed_commit_message": None,
        }
        _atomic_json(path, state)
        return state

    def load(self, wf: Workflow, step: Step) -> dict[str, Any]:
        path = self._state_path(wf, step)
        if not path.exists():
            return self.ensure_initialized(wf, step)
        state = _read_json(path)
        if state.get("schema_version") == 2:
            state["schema_version"] = 3
            state["baseline_tree"] = self._tree_for_revision(str(state.pop("head_commit", "")))
            state.pop("index_baseline_tree", None)
            state.pop("integrity_error", None)
            self.save(wf, step, state)
        if state.get("schema_version") != 3:
            raise TaskDevError("the task-dev state version has changed; start a new attempt for this task")
        if state.get("task_id") != self.task_id(step) or state.get("attempt") != step.attempt:
            raise TaskDevError(f"the task-dev state does not match step {step.id} attempt {step.attempt}")
        # Older attempts used a dedicated CodeCheck state. Re-enter the
        # revalidated phase so the standalone skill can run before delivery.
        if state.get("status") == "codecheck_passed":
            state["status"] = "revalidated"
            state.setdefault("reports", {}).pop("codecheck", None)
            state.pop("last_codecheck", None)
            state.pop("codecheck_digest", None)
        if state.get("status") not in TASK_STATUSES:
            raise TaskDevError(f"invalid task-dev status: {state.get('status')}")
        return state

    def save(self, wf: Workflow, step: Step, state: dict[str, Any]) -> None:
        _atomic_json(self._state_path(wf, step), state)

    @staticmethod
    def task_id(step: Step) -> str:
        value = step.vars.get("序号")
        if value is not None:
            return f"T{value}"
        match = re.search(r"T\d+", step.name)
        return match.group(0) if match else f"T{step.id}"

    def _discard_phase_artifacts(
        self,
        wf: Workflow,
        step: Step,
        phases: tuple[str, ...],
    ) -> None:
        for phase in phases:
            self._phase_file(wf, step, phase).unlink(missing_ok=True)

    def refresh(self, wf: Workflow, step: Step, state: dict[str, Any]) -> dict[str, Any]:
        snapshot = self.snapshot(wf, step, str(state.get("baseline_tree", "UNBORN")))
        status = str(state.get("status"))
        if status in {"reviewed", "revalidated", "prepared"}:
            extension = self.review_extensions()
            policy_digest = self._review_policy_digest(extension)
            if extension["status"] == "invalid" or policy_digest != state.get("review_policy_digest"):
                self._discard_phase_artifacts(
                    wf,
                    step,
                    ("reviewed", "revalidated", "prepared"),
                )
                state["status"] = "implemented"
                for name in ("review", "revalidation", "delivery"):
                    state["reports"].pop(name, None)
                state["open_findings"] = []
                state["proposed_commit_message"] = None
        previous = state.get("validated_code_digest")
        current = snapshot["validated_code_digest"]
        if previous and previous != current:
            status = str(state.get("status"))
            if status in {"revalidated", "prepared"}:
                self._discard_phase_artifacts(wf, step, ("revalidated", "prepared"))
                state["status"] = "reviewed"
                state["reports"].pop("revalidation", None)
                state["reports"].pop("delivery", None)
                state["proposed_commit_message"] = None
        state["validated_code_digest"] = current
        state["changed_files"] = snapshot["changed_files"]
        state["validated_files"] = snapshot["validated_files"]
        self.save(wf, step, state)
        return state

    @staticmethod
    def _review_policy_digest(extension: dict[str, Any]) -> str | None:
        if extension.get("status") == "invalid":
            return None
        payload = json.dumps(extension.get("rules", []), ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def review_extensions(self) -> dict[str, Any]:
        path = self.sdd_dir / "AICodingGuidelines.md"
        result: dict[str, Any] = {
            "path": str(path.resolve()).replace("\\", "/"),
            "section": REVIEW_SECTION_LABEL,
            "rules": [],
            "status": "missing",
        }
        if not path.exists():
            return result
        try:
            text = path.read_text("utf-8")
        except OSError as exc:
            return result | {"status": "invalid", "error": str(exc)}
        heading = re.compile(rf"^##[ \t]+{re.escape(REVIEW_SECTION)}[ \t]*$", re.MULTILINE)
        matches = list(heading.finditer(text))
        if not matches:
            return result
        if len(matches) != 1:
            return result | {"status": "invalid", "error": "the semantic Review extension section must appear exactly once"}
        match = matches[0]
        tail = text[match.end():]
        next_heading = re.search(r"^##[ \t]+", tail, re.MULTILINE)
        section = tail[: next_heading.start()] if next_heading else tail
        blocks = re.findall(r"```ya?ml[ \t]*\r?\n(.*?)\r?\n```", section, re.DOTALL | re.IGNORECASE)
        if len(blocks) != 1:
            return result | {"status": "invalid", "error": "the extension section must contain exactly one YAML code block"}
        try:
            data = yaml.safe_load(blocks[0]) or {}
        except yaml.YAMLError as exc:
            return result | {"status": "invalid", "error": f"cannot parse the YAML block: {exc}"}
        if not isinstance(data, dict) or set(data) - {"version", "rules"}:
            return result | {"status": "invalid", "error": "only the version and rules fields are allowed"}
        if data.get("version") != 1 or not isinstance(data.get("rules", []), list):
            return result | {"status": "invalid", "error": "version must be 1 and rules must be an array"}
        rules = []
        rule_ids: set[str] = set()
        for index, rule in enumerate(data.get("rules", []), start=1):
            if not isinstance(rule, dict) or set(rule) != {"id", "dimension", "description"}:
                return result | {"status": "invalid", "error": f"extension rule {index} has invalid fields"}
            if rule["dimension"] not in REVIEW_DIMENSIONS:
                return result | {"status": "invalid", "error": f"extension rule {index} has an invalid dimension"}
            if not all(isinstance(rule[key], str) and rule[key].strip() for key in rule):
                return result | {"status": "invalid", "error": f"extension rule {index} contains an empty field"}
            if rule["id"].strip() in rule_ids:
                return result | {"status": "invalid", "error": f"extension rule {index} has a duplicate id"}
            rule_ids.add(rule["id"].strip())
            rules.append({key: rule[key].strip() for key in ("id", "dimension", "description")})
        return result | {"status": "loaded", "rules": rules}

    def _phase_file(self, wf: Workflow, step: Step, phase: str) -> Path:
        names = {
            "implemented": "implementation.json",
            "reviewed": "review-report.json",
            "revalidated": "revalidation.json",
            "prepared": "delivery.json",
        }
        return self._attempt_dir(wf, step) / names[phase]

    def _next_argv(self, wf: Workflow) -> list[str]:
        return self._command("next", "--sr", wf.sr, "--json")

    @staticmethod
    def _reference_path(name: str) -> str:
        path = Path(__file__).resolve().parents[3] / "task-dev" / "references" / name
        return str(path).replace("\\", "/")

    @staticmethod
    def _skill_path(name: str) -> str:
        path = Path(__file__).resolve().parents[3] / name / "SKILL.md"
        return str(path).replace("\\", "/")

    def guidance(self, wf: Workflow, step: Step, done_argv: list[str] | None = None) -> dict[str, Any]:
        state = self.refresh(wf, step, self.load(wf, step))
        status = str(state["status"])
        commands: dict[str, Any] = {"next_argv": self._next_argv(wf)}
        directive = "continue"
        blocking: list[str] = []
        forbidden = ["Do not start another task", "Do not run git add", "Do not run git commit"]
        warnings = []
        if state.get("initial_changed_files"):
            warnings.append(
                "task-dev assumes a clean working tree at startup; these pre-existing changes may be mixed into the current task and must be distinguished when drafting the commit message: "
                + ", ".join(state["initial_changed_files"])
            )
        extension: dict[str, Any] | None = None
        instruction_refs: list[str] = []
        report_schema_ref: str | None = None

        if status == "initialized":
            current_phase, next_phase = "implementation", "review"
            objective = "Implement and test the current task"
            required = ["Implement the current task", "Run the current task tests", "Write implementation.json", "Run next_argv to submit the phase result"]
            forbidden.extend(["Do not start Reviewers yet", "Do not run CodeCheck", "Do not run done yet"])
            commands["data_file"] = str(self._phase_file(wf, step, "implemented").resolve()).replace("\\", "/")
        elif status == "implemented":
            current_phase, next_phase = "review", "revalidation"
            objective = "Run independent semantic Review and save a structured report"
            required = ["Start read-only Reviewers", "Write review-report.json", "Run next_argv to submit the phase result"]
            instruction_refs = [self._reference_path("semantic-review-prompt.md")]
            report_schema_ref = self._reference_path("review-report.schema.json")
            extension = self.review_extensions()
            if extension["status"] == "invalid":
                directive = "wait"
                objective = "Wait for the user to correct the semantic Review extension section"
                required = ["Report the extension section error to the user", "Wait for the correction, then run next_argv again"]
                blocking.append(f"Invalid AICodingGuidelines Review extension: {extension['error']}")
            else:
                required = [
                    "Use instruction_refs to start reviewer-a and reviewer-b in parallel",
                    "Merge their reports and write review-report.json for the current code digest before fixing any code",
                    "Run next_argv to submit the phase result",
                ]
            commands["data_file"] = str(self._phase_file(wf, step, "reviewed").resolve()).replace("\\", "/")
            forbidden.extend(
                [
                    "Neither the main Agent nor the Reviewers may modify code before the Review report is accepted",
                    "Do not run CodeCheck",
                    "Do not run done yet",
                ]
            )
        elif status == "reviewed":
            current_phase, next_phase = "revalidation", "codecheck"
            objective = "Resolve Review findings and revalidate the implementation"
            instruction_refs = [self._reference_path("semantic-review-prompt.md")]
            report_schema_ref = self._reference_path("revalidation-report.schema.json")
            required = [
                "Resolve Review findings and run affected tests",
                "Ask the original Reviewer for targeted Review of high-risk, semantic, or structural changes",
                "Write revalidation.json according to report_schema_ref",
                "Run next_argv to submit the phase result",
            ]
            forbidden.extend(["Do not reuse the old code digest", "Do not run CodeCheck yet", "Do not run done yet"])
            commands["data_file"] = str(self._phase_file(wf, step, "revalidated").resolve()).replace("\\", "/")
        elif status == "revalidated":
            current_phase, next_phase = "codecheck", "delivery"
            objective = "Run the standalone CodeCheck skill, then prepare delivery"
            instruction_refs = [self._skill_path("code-check")]
            required = [
                "Load and use the code-check skill from instruction_refs on the current task changes",
                "If CodeCheck changes code, run affected tests and run next_argv without preparing delivery so task-dev can revalidate the changes",
                "If CodeCheck requires a high-impact decision, stop and ask the user before making that change",
                "Only after CodeCheck passes without further code changes, update the overview handoff and draft the candidate commit message",
                "Write delivery.json and run next_argv to submit the phase result",
            ]
            commands["data_file"] = str(self._phase_file(wf, step, "prepared").resolve()).replace("\\", "/")
            forbidden.extend(
                [
                    "Do not bypass the code-check skill or treat a failed check as passed",
                    "Do not make high-impact CodeCheck fixes without user approval",
                    "Do not run done before CodeCheck passes and delivery.json is accepted",
                ]
            )
        elif status == "prepared":
            current_phase, next_phase = "delivery", "completed"
            objective = "Complete the current task-dev work order"
            required = ["Run done_argv", "Stop after done succeeds"]
            forbidden.extend(["Do not modify files or the Git index", "Do not regenerate code"])
            if done_argv:
                commands["done_argv"] = done_argv
        else:
            directive = "stop"
            current_phase, next_phase = "completed", None
            objective = "The current task is complete"
            required = []
            forbidden.append("Do not modify the code further")
            commands = {}

        phase_guidance: dict[str, Any] = {
            "directive": directive,
            "current_phase": current_phase,
            "objective": objective,
            "required_actions": required,
            "forbidden_actions": forbidden,
        }
        if next_phase is not None:
            phase_guidance["next_phase"] = next_phase
        if blocking:
            phase_guidance["blocking_reasons"] = blocking
        if instruction_refs:
            phase_guidance["instruction_refs"] = instruction_refs
        if report_schema_ref is not None:
            phase_guidance["report_schema_ref"] = report_schema_ref
        payload: dict[str, Any] = {
            "task_id": state["task_id"],
            "status": status,
            "guidance": phase_guidance,
        }
        if commands:
            payload["commands"] = commands
        if status in {"implemented", "reviewed", "revalidated"}:
            payload["validated_code_digest"] = state.get("validated_code_digest")
            payload["changed_files"] = state.get("changed_files", [])
        if status in {"reviewed", "revalidated"} and state.get("reports"):
            payload["reports"] = state["reports"]
        if warnings and status in {"initialized", "revalidated"}:
            payload["warnings"] = warnings
        if extension is not None:
            payload["review_extension"] = extension
        return payload

    def _accept_phase_report(self, wf: Workflow, step: Step, phase: str, data: dict[str, Any]) -> dict[str, Any]:
        if phase not in CHECKPOINT_PHASES:
            raise TaskDevError(f"unsupported task-dev phase report: {phase}")
        state = self.refresh(wf, step, self.load(wf, step))
        expected = {
            "initialized": "implemented",
            "implemented": "reviewed",
            "reviewed": "revalidated",
            "revalidated": "prepared",
        }.get(str(state["status"]))
        if expected != phase:
            raise TaskDevError(
                f"cannot accept a {phase} phase report from status {state['status']}; the only allowed phase is {expected or 'none'}",
                self.guidance(wf, step),
            )
        snapshot = self.snapshot(wf, step, str(state.get("baseline_tree", "UNBORN")))
        digest = snapshot["validated_code_digest"]
        reports = state.setdefault("reports", {})
        if phase == "implemented":
            self._require_value(data, "implementation", "completed")
            self._require_value(data, "tests", "passed")
            self._validate_checks(data.get("checks"), "implementation")
            data["validated_code_digest"] = digest
            reports["implementation"] = self._write_phase_data(wf, step, phase, data)
        elif phase == "reviewed":
            extension = self.review_extensions()
            if extension["status"] == "invalid":
                raise TaskDevError(f"invalid AICodingGuidelines Review extension: {extension['error']}")
            self._validate_review_report(data, digest, state["task_id"], extension["rules"])
            reports["review"] = self._write_phase_data(wf, step, phase, data)
            state["open_findings"] = [
                item["id"] for item in data.get("findings", []) if item.get("status", "open") == "open"
            ]
            state["reviewed_digest"] = digest
            state["review_policy_digest"] = self._review_policy_digest(extension)
        elif phase == "revalidated":
            revalidation_fields = {
                "status",
                "validated_code_digest",
                "open_blocking_findings",
                "finding_resolutions",
                "semantic_impact",
                "targeted_review_required",
                "targeted_review_refs",
                "checks",
            }
            if set(data) - revalidation_fields:
                raise TaskDevError("the revalidation report contains fields not defined by the schema")
            self._require_value(data, "status", "passed")
            if data.get("validated_code_digest") != digest:
                raise TaskDevError("the revalidation validated_code_digest does not match the current code")
            if data.get("open_blocking_findings") != []:
                raise TaskDevError("revalidation cannot complete while blocking findings remain open")
            self._validate_checks(data.get("checks"), "revalidation")
            impact = data.get("semantic_impact")
            if impact not in {"none", "behavior", "structure", "compatibility", "security"}:
                raise TaskDevError("the revalidation semantic_impact is invalid")
            targeted_required = data.get("targeted_review_required")
            targeted_refs = data.get("targeted_review_refs")
            if not isinstance(targeted_required, bool) or not isinstance(targeted_refs, list):
                raise TaskDevError("revalidation must include a targeted Review decision and evidence array")
            if impact != "none" and not targeted_required:
                raise TaskDevError("semantic or structural impact requires targeted Review")
            if targeted_required and (
                not targeted_refs
                or not all(isinstance(item, str) and item.strip() for item in targeted_refs)
            ):
                raise TaskDevError("targeted Review requires non-empty targeted_review_refs")
            if not targeted_required and targeted_refs:
                raise TaskDevError("targeted_review_refs must be empty when targeted Review is not required")
            resolutions = data.get("finding_resolutions")
            if not isinstance(resolutions, list):
                raise TaskDevError("revalidation finding_resolutions must be an array")
            for index, item in enumerate(resolutions, start=1):
                if not isinstance(item, dict) or set(item) != {"id", "status", "rationale"}:
                    raise TaskDevError(f"revalidation finding resolution {index} has invalid fields")
                if item.get("status") not in {"fixed", "rejected"}:
                    raise TaskDevError(f"revalidation finding resolution {index} has an invalid status")
                if not all(isinstance(item.get(name), str) and item[name].strip() for name in ("id", "rationale")):
                    raise TaskDevError(f"revalidation finding resolution {index} is missing id or rationale")
            if state.get("open_findings"):
                resolved_ids = {
                    item.get("id")
                    for item in resolutions
                    if isinstance(item, dict)
                    and item.get("status") in {"fixed", "rejected"}
                    and isinstance(item.get("rationale"), str)
                    and item["rationale"].strip()
                }
                missing = sorted(set(state["open_findings"]) - resolved_ids)
                if missing:
                    raise TaskDevError("revalidation did not resolve Review findings: " + ", ".join(missing))
            reports["revalidation"] = self._write_phase_data(wf, step, phase, data)
            state["open_findings"] = []
            state["revalidated_digest"] = digest
        else:
            if set(data) != {"proposed_commit_message", "message_basis", "diff_confirmed"}:
                raise TaskDevError("delivery data must contain proposed_commit_message, message_basis, and diff_confirmed")
            message = data.get("proposed_commit_message")
            if not isinstance(message, str) or not message.strip():
                raise TaskDevError("delivery data is missing proposed_commit_message")
            basis = data.get("message_basis")
            if not isinstance(basis, str) or not basis.strip():
                raise TaskDevError("delivery data needs a message_basis grounded in requirements, design, and implementation")
            if data.get("diff_confirmed") is not True:
                raise TaskDevError("delivery data must confirm that the commit message was checked against the diff")
            state["proposed_commit_message"] = message.strip()
            reports["delivery"] = self._write_phase_data(wf, step, phase, data)
        state["status"] = phase
        state["validated_code_digest"] = digest
        state["changed_files"] = snapshot["changed_files"]
        state["validated_files"] = snapshot["validated_files"]
        self.save(wf, step, state)
        return state

    def _write_phase_data(self, wf: Workflow, step: Step, phase: str, data: dict[str, Any]) -> str:
        path = self._phase_file(wf, step, phase)
        _atomic_json(path, data)
        return str(path.resolve()).replace("\\", "/")

    @staticmethod
    def _require_value(data: dict[str, Any], name: str, expected: Any) -> None:
        if data.get(name) != expected:
            raise TaskDevError(f"task-dev data field {name} must be {expected}")

    @staticmethod
    def _validate_checks(value: Any, label: str) -> None:
        if not isinstance(value, list) or not value:
            raise TaskDevError(f"{label} data field checks must be a non-empty array")
        for index, item in enumerate(value, start=1):
            if not isinstance(item, dict) or not isinstance(item.get("name"), str) or not item["name"].strip():
                raise TaskDevError(f"{label} check {index} is missing name")
            if item.get("status") not in {"passed", "completed", "skipped"}:
                raise TaskDevError(f"{label} check {index} has an invalid status")

    @staticmethod
    def _validate_review_report(
        data: dict[str, Any],
        digest: str,
        task_id: str,
        extension_rules: list[dict[str, Any]],
    ) -> None:
        allowed_report_fields = {
            "schema_version",
            "task_id",
            "validated_code_digest",
            "verdict",
            "reviewers",
            "covered_dimensions",
            "applied_extension_rule_ids",
            "findings",
        }
        if set(data) - allowed_report_fields:
            raise TaskDevError("the Review report contains fields not defined by the schema")
        if data.get("schema_version") != 1:
            raise TaskDevError("the Review report schema_version must be 1")
        if data.get("task_id") != task_id:
            raise TaskDevError("the Review report task_id does not match the current task")
        if data.get("validated_code_digest") != digest:
            raise TaskDevError("the Review report validated_code_digest does not match the current code")
        if data.get("verdict") not in {"pass", "fail", "blocked"}:
            raise TaskDevError("the Review report verdict must be pass, fail, or blocked")
        if data.get("verdict") == "blocked":
            raise TaskDevError("a blocked Review cannot advance to revalidation")
        covered = data.get("covered_dimensions")
        if not isinstance(covered, list) or len(covered) != len(set(covered)) or set(covered) != REVIEW_DIMENSIONS:
            raise TaskDevError("the Review report must cover every required semantic dimension")
        applied = data.get("applied_extension_rule_ids")
        expected_rules = {item["id"] for item in extension_rules}
        if not isinstance(applied, list) or len(applied) != len(set(applied)) or set(applied) != expected_rules:
            raise TaskDevError("the Review report did not apply every current extension rule")
        reviewers = data.get("reviewers")
        if not isinstance(reviewers, list):
            raise TaskDevError("the Review report reviewers field must be an array")
        for index, reviewer in enumerate(reviewers, start=1):
            if not isinstance(reviewer, dict) or set(reviewer) != {"role", "status", "report_ref"}:
                raise TaskDevError(f"Review reviewer {index} has invalid fields")
            if not isinstance(reviewer.get("report_ref"), str) or not reviewer["report_ref"].strip():
                raise TaskDevError(f"Review reviewer {index} is missing report_ref")
        roles = {
            item.get("role")
            for item in reviewers or []
            if isinstance(item, dict) and item.get("status") == "completed"
        }
        if roles != {"reviewer-a", "reviewer-b"}:
            raise TaskDevError("the Review report must contain completed records for reviewer-a and reviewer-b")
        findings = data.get("findings")
        if not isinstance(findings, list):
            raise TaskDevError("the Review report findings field must be an array")
        finding_ids: set[str] = set()
        finding_fields = {
            "id",
            "severity",
            "dimension",
            "subcategory",
            "file",
            "line",
            "evidence",
            "impact",
            "recommendation",
            "status",
        }
        for index, item in enumerate(findings, start=1):
            if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not item["id"].strip():
                raise TaskDevError(f"Review finding {index} is missing id")
            if set(item) != finding_fields:
                raise TaskDevError(f"Review finding {index} fields do not match the schema")
            if item["id"] in finding_ids:
                raise TaskDevError(f"Review finding {index} has a duplicate id")
            finding_ids.add(item["id"])
            if item.get("dimension") not in REVIEW_DIMENSIONS:
                raise TaskDevError(f"Review finding {index} has an invalid dimension")
            if item.get("severity") not in REVIEW_SEVERITIES:
                raise TaskDevError(f"Review finding {index} has an invalid severity")
            required_strings = ("subcategory", "file", "evidence", "impact", "recommendation")
            if any(not isinstance(item.get(name), str) or not item[name].strip() for name in required_strings):
                raise TaskDevError(f"Review finding {index} is missing structured evidence or a recommendation")
            if not isinstance(item.get("line"), int) or isinstance(item.get("line"), bool) or item["line"] < 1:
                raise TaskDevError(f"Review finding {index} has an invalid line")
            if item.get("status", "open") not in {"open", "fixed", "rejected"}:
                raise TaskDevError(f"Review finding {index} has an invalid status")
        open_findings = [item for item in findings if item.get("status", "open") == "open"]
        if data.get("verdict") == "pass" and open_findings:
            raise TaskDevError("a Review report with verdict=pass cannot contain open findings")

    def _advance_from_report(self, wf: Workflow, step: Step) -> dict[str, Any]:
        """Consume at most one report when `next` revisits a running task-dev step."""
        state = self.refresh(wf, step, self.load(wf, step))
        if state.get("status") in {"prepared", "completed"}:
            return state
        expected_phase = {
            "initialized": "implemented",
            "implemented": "reviewed",
            "reviewed": "revalidated",
            "revalidated": "prepared",
        }.get(str(state.get("status")))
        try:
            if expected_phase:
                report_path = self._phase_file(wf, step, expected_phase)
                if report_path.is_file():
                    return self._accept_phase_report(wf, step, expected_phase, _read_json(report_path))
        except TaskDevError as exc:
            raise TaskDevError(f"the current phase report failed validation: {exc}", self.guidance(wf, step)) from exc
        return state

    def ensure_done_ready(self, wf: Workflow, step: Step) -> dict[str, Any]:
        state = self.refresh(wf, step, self.load(wf, step))
        if state.get("status") != "prepared":
            raise TaskDevError("task-dev has not reached the prepared status", self.guidance(wf, step))
        for name in ("implementation", "review", "revalidation", "delivery"):
            report_path = state.get("reports", {}).get(name)
            if not report_path or not Path(report_path).is_file():
                raise TaskDevError(f"task-dev is missing {name} phase evidence", self.guidance(wf, step))
        if state.get("open_findings"):
            raise TaskDevError("task-dev still has open Review findings", self.guidance(wf, step))
        self._ensure_overview_completed(step, state["task_id"])
        return {
            "task_id": state["task_id"],
            "implementation": "completed",
            "tests": "passed",
            "semantic_review": "passed",
            "revalidation": "passed",
            "codecheck": "passed",
            "delivery": "prepared",
            "validated_code_digest": state["validated_code_digest"],
            "changed_files": state["changed_files"],
            "proposed_commit_message": state["proposed_commit_message"],
        }

    def _ensure_overview_completed(self, step: Step, task_id: str) -> None:
        candidates = [item.get("path") for item in step.input if str(item.get("path", "")).endswith("tasks-overview.md")]
        if not candidates:
            raise TaskDevError("the task-dev work order is missing the tasks-overview.md input")
        path = self.root / str(candidates[0])
        try:
            text = path.read_text("utf-8")
        except OSError as exc:
            raise TaskDevError(f"cannot read tasks-overview.md: {exc}") from exc
        heading = re.search(rf"^###\s+{re.escape(task_id)}(?:[：:].*)?$", text, re.MULTILINE)
        if not heading:
            raise TaskDevError(f"tasks-overview.md is missing the final handoff record for {task_id}")
        tail = text[heading.end():]
        next_heading = re.search(r"^###\s+", tail, re.MULTILINE)
        block = tail[: next_heading.start()] if next_heading else tail
        if not re.search(r"^-\s*状态[：:]\s*Completed\s*$", block, re.MULTILINE):
            raise TaskDevError(f"the {task_id} status in tasks-overview.md is not Completed")

    def mark_completed(self, wf: Workflow, step: Step) -> None:
        state = self.load(wf, step)
        state["status"] = "completed"
        self.save(wf, step, state)
