"""Codex CLI runner backend.

Drives `codex exec` JSONL runs inside an isolated environment, including
multi-turn followup resumes keyed on the emitted thread id.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from ....config import Settings
from ....errors import InfrastructureError
from ....schemas import CaseSpec, EvalProfile
from ...observability.logs import LogCallback
from ..base import CancelCallback, ProgressCallback, Runner, RunOutcome, command_prefix
from ..protocols.jsonl import (
    execute_streaming,
    find_thread_id,
    parse_jsonl,
    skill_invocation,
    token_usage,
)


def _config_args(profile: EvalProfile, *, judge: bool) -> list[str]:
    effort = profile.judge_reasoning_effort if judge else profile.runner_reasoning_effort
    sandbox = "read-only" if judge else "workspace-write"
    network = "true" if profile.network and not judge else "false"
    args = [
        "-c",
        'approval_policy="never"',
        "-c",
        f'sandbox_mode="{sandbox}"',
        "-c",
        f"sandbox_workspace_write.network_access={network}",
        "-c",
        f'model_reasoning_effort="{effort}"',
        "-c",
        'web_search="disabled"',
        "-c",
        "features.apps=false",
        "-c",
        "features.remote_plugin=false",
        "-c",
        "features.skill_mcp_dependency_install=false",
        "-c",
        "features.multi_agent=false",
        "-c",
        'shell_environment_policy.inherit="core"',
        "-c",
        'shell_environment_policy.exclude=["*KEY*","*SECRET*","*TOKEN*","*PASSWORD*"]',
    ]
    if not profile.allowed_mcp_servers:
        args.extend(["-c", "mcp_servers={}"])
    return args


def _isolated_environment(state_dir: Path) -> dict[str, str]:
    env = os.environ.copy()
    actual_home = Path.home()
    isolated_home = state_dir / "home"
    isolated_home.mkdir(parents=True, exist_ok=True)
    env["HOME"] = str(isolated_home)
    env["USERPROFILE"] = str(isolated_home)
    env.setdefault("CODEX_HOME", str(actual_home / ".codex"))
    env["NO_COLOR"] = "1"
    env["TERM"] = "dumb"
    return env


class CodexRunner(Runner):
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def _execute(
        self,
        arguments: list[str],
        *,
        prompt: str,
        cwd: Path,
        state_dir: Path,
        timeout_seconds: int,
        stdout_path: Path,
        stderr_path: Path,
        on_progress: ProgressCallback | None = None,
        on_log: LogCallback | None = None,
        log_source: str = "runner",
        is_cancelled: CancelCallback | None = None,
    ) -> tuple[int | None, str, str, int, bool, bool, dict[str, Any]]:
        command = [*command_prefix(self.settings.codex_command), *arguments, "-"]
        try:
            return execute_streaming(
                command,
                prompt=prompt,
                cwd=cwd,
                env=_isolated_environment(state_dir),
                timeout_seconds=timeout_seconds,
                stdout_path=stdout_path,
                stderr_path=stderr_path,
                on_progress=on_progress,
                on_log=on_log,
                log_source=log_source,
                is_cancelled=is_cancelled,
            )
        except FileNotFoundError as exc:
            raise InfrastructureError(
                "CODEX_NOT_FOUND", f"Codex executable not found: {self.settings.codex_command}"
            ) from exc

    def run(
        self,
        *,
        workspace: Path,
        artifact_dir: Path,
        case: CaseSpec,
        profile: EvalProfile,
        skill_name: str | None,
        on_progress: ProgressCallback | None = None,
        on_log: LogCallback | None = None,
        is_cancelled: CancelCallback | None = None,
        chrys_home_root: Path | None = None,
    ) -> RunOutcome:
        if chrys_home_root is not None:
            # Codex runs are isolated through their own state dir and never
            # touch a chrys config home; the parameter exists so the runner
            # interface stays uniform across providers.
            _ = chrys_home_root
        artifact_dir.mkdir(parents=True, exist_ok=True)
        last_message = artifact_dir / "last-message.txt"
        prompt_parts = []
        if skill_name:
            prompt_parts.append(f"${skill_name}")
        prompt_parts.append(case.input)
        if case.agent_context:
            prompt_parts.append("Agent 可见补充上下文：\n" + case.agent_context)
        prompt = "\n\n".join(prompt_parts)

        arguments = [
            "exec",
            "--cd",
            str(workspace),
            "--json",
            "--ignore-user-config",
            "--ignore-rules",
            "--strict-config",
            "--sandbox",
            "workspace-write",
            "--model",
            profile.runner_model,
            "--output-last-message",
            str(last_message),
            *_config_args(profile, judge=False),
        ]
        if not case.followups:
            arguments.append("--ephemeral")

        stdout_path = artifact_dir / "codex.jsonl"
        stderr_path = artifact_dir / "codex.stderr.txt"
        exit_code, stdout, stderr, duration_ms, timed_out, cancelled, workspace_stats = (
            self._execute(
                arguments,
                prompt=prompt,
                cwd=workspace,
                state_dir=artifact_dir / "codex-state",
                timeout_seconds=profile.timeout_seconds,
                stdout_path=stdout_path,
                stderr_path=stderr_path,
                on_progress=on_progress,
                on_log=on_log,
                is_cancelled=is_cancelled,
            )
        )
        events = parse_jsonl(stdout)
        thread_id = find_thread_id(events)
        final_response = last_message.read_text(encoding="utf-8") if last_message.exists() else ""
        turns = 1

        if not timed_out and not cancelled and exit_code == 0 and case.followups:
            used: set[int] = set()
            while turns < case.max_turns:
                match_index = next(
                    (
                        index
                        for index, item in enumerate(case.followups)
                        if index not in used
                        and item.when_output_contains.casefold() in final_response.casefold()
                    ),
                    None,
                )
                if match_index is None:
                    break
                if not thread_id:
                    return RunOutcome(
                        exit_code=exit_code,
                        final_response=final_response,
                        events=events,
                        duration_ms=duration_ms,
                        thread_id=None,
                        error_kind="infra_error",
                        error_message="Codex did not emit a resumable thread id",
                        turns=turns,
                    )
                used.add(match_index)
                followup = case.followups[match_index]
                resume_message = artifact_dir / f"last-message-turn-{turns + 1}.txt"
                resume_args = [
                    "exec",
                    "resume",
                    "--json",
                    "--ignore-user-config",
                    "--ignore-rules",
                    "--strict-config",
                    "--model",
                    profile.runner_model,
                    "--output-last-message",
                    str(resume_message),
                    *_config_args(profile, judge=False),
                    thread_id,
                ]
                code, out, err, elapsed, followup_timeout, followup_cancelled = self._execute(
                    resume_args,
                    prompt=followup.reply,
                    cwd=workspace,
                    state_dir=artifact_dir / "codex-state",
                    timeout_seconds=profile.timeout_seconds,
                    stdout_path=stdout_path,
                    stderr_path=stderr_path,
                    on_progress=on_progress,
                    on_log=on_log,
                    is_cancelled=is_cancelled,
                )
                duration_ms += elapsed
                stdout += "\n" + out
                stderr += "\n" + err
                events.extend(parse_jsonl(out))
                final_response = (
                    resume_message.read_text(encoding="utf-8")
                    if resume_message.exists()
                    else final_response
                )
                exit_code = code
                timed_out = followup_timeout
                cancelled = followup_cancelled
                turns += 1
                if timed_out or cancelled or code != 0:
                    break

        input_tokens, output_tokens = token_usage(events)
        return RunOutcome(
            exit_code=exit_code,
            final_response=final_response,
            events=events,
            duration_ms=duration_ms,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            thread_id=thread_id,
            error_kind=(
                "cancelled"
                if cancelled
                else ("timeout" if timed_out else ("agent_error" if exit_code else None))
            ),
            error_message=(
                "Run cancelled by user"
                if cancelled
                else (
                    "Codex execution timed out"
                    if timed_out
                    else (stderr.strip()[-3000:] if exit_code else None)
                )
            ),
            turns=turns,
            skill_invoked=skill_invocation(events, skill_name),
        )
