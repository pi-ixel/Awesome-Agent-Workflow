"""Chrys runner backend.

Drives evaluation cases through the ACP session (agent client protocol over
stdio). The Settings-dependent wiring lifted out of the former session class
lives here: resolving the isolated chrys config home, building the
`chrys acp` argv and its environment, and mapping spawn failures back to the
original CHRYS_* infrastructure errors.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ....config import Settings
from ....errors import EvalError, InfrastructureError
from ....schemas import CaseSpec, EvalProfile
from ...observability.logs import LogCallback
from ..base import CancelCallback, ProgressCallback, Runner, RunOutcome, command_prefix
from ..protocols.acp import AcpSession
from ..protocols.jsonl import skill_invocation
from .runtime import RUNNER_PROFILE_NAME, prepare_isolated_home


def chrys_error_text(stderr: str) -> str:
    text = stderr.strip()[-3000:]
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        return text
    if isinstance(payload, dict):
        return str(payload.get("error") or payload.get("message") or text)[-3000:]
    return text


def _acp_error_text(error: dict[str, Any]) -> str:
    message = str(error.get("message") or "Chrys agent error")
    data = error.get("data")
    if isinstance(data, dict):
        detail = data.get("message") or data.get("details")
        if detail:
            message = f"{message}: {detail}"
    return message[-3000:]


def _isolation_root(settings: Settings, chrys_home_root: Path | None) -> Path:
    """Resolve the config home the ACP session runs against (ex-session.start()).

    Runs chrys against an isolated config home so the operator's global skills
    (~APPDATA/chrys/skills) cannot leak into evaluation runs and pollute the
    no_skill baseline (R4P1). Fails closed: without the isolation the baseline
    would be silently contaminated. With pair-parallel execution the
    orchestrator materializes one config home per run from the experiment
    template (``chrys_home_root``); the shared chrys-isolated fallback is only
    for standalone callers.
    """
    if chrys_home_root is not None:
        return chrys_home_root
    try:
        return prepare_isolated_home(settings)
    except (EvalError, InfrastructureError, OSError) as exc:
        raise InfrastructureError(
            "CHRYS_ISOLATION_FAILED", f"Failed to prepare isolated chrys home: {exc}"
        ) from exc


def _acp_command(settings: Settings, agent_profile: str, cwd: Path) -> list[str]:
    """Build the `chrys acp` argv for one session (ex-ChrysAcpSession.command)."""
    return [
        *command_prefix(settings.chrys_command),
        "acp",
        "-a",
        agent_profile,
        "--approval",
        "bypass",
        "-C",
        str(cwd),
    ]


def _acp_environment(isolated_root: Path) -> dict[str, str]:
    """Env pointing the agent at the isolated config home (ex-session.start())."""
    env = {**os.environ, "NO_COLOR": "1", "TERM": "dumb"}
    if os.name == "nt":
        env["APPDATA"] = str(isolated_root)
    else:
        env["HOME"] = str(isolated_root)
    return env


def _build_session(
    settings: Settings,
    *,
    agent_profile: str,
    cwd: Path,
    artifact_dir: Path,
    on_log: LogCallback | None,
    log_source: str,
    chrys_home_root: Path | None,
) -> AcpSession:
    """Construct the platform-neutral ACP session with chrys wiring injected.

    ``isolated_root`` keeps receiving the caller's original value so the
    session preserves its per-run isolation semantics; the materialized root
    (shared fallback included) travels through ``env``.
    """
    isolated_root = _isolation_root(settings, chrys_home_root)
    return AcpSession(
        command=_acp_command(settings, agent_profile, cwd),
        env=_acp_environment(isolated_root),
        agent_profile=agent_profile,
        cwd=cwd,
        artifact_dir=artifact_dir,
        on_log=on_log,
        log_source=log_source,
        isolated_root=chrys_home_root,
    )


def _start_session(acp: AcpSession, settings: Settings) -> None:
    """Start the session, mapping spawn failures to the original CHRYS_* errors."""
    try:
        acp.start()
    except FileNotFoundError as exc:
        raise InfrastructureError(
            "CHRYS_NOT_FOUND", f"Chrys executable not found: {settings.chrys_command}"
        ) from exc
    except OSError as exc:
        raise InfrastructureError(
            "CHRYS_SPAWN_FAILED", f"Failed to start chrys acp: {exc}"
        ) from exc


class ChrysRunner(Runner):
    """Runs cases through `chrys acp` (Agent Client Protocol over stdio).

    The ACP notification stream (agent message chunks, tool calls, plan and
    token updates) is forwarded to the platform progress/log pipeline, and the
    per-turn timeout only fires when the agent shows no activity at all.
    """

    def __init__(self, settings: Settings) -> None:
        self.settings = settings

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
        prompt_parts = []
        if skill_name:
            prompt_parts.append(f"${skill_name}")
        prompt_parts.append(case.input)
        if case.agent_context:
            prompt_parts.append("Agent 可见补充上下文：\n" + case.agent_context)
        prompt = "\n\n".join(prompt_parts)
        acp = _build_session(
            self.settings,
            agent_profile=RUNNER_PROFILE_NAME,
            cwd=workspace,
            artifact_dir=artifact_dir,
            on_log=on_log,
            log_source="runner",
            chrys_home_root=chrys_home_root,
        )
        events: list[dict[str, Any]] = []
        duration_ms = 0
        final = ""
        turns = 1
        used: set[int] = set()
        session_id: str | None = None
        timed_out = False
        cancelled = False
        idle_timeout = False
        turn_error: dict[str, Any] | None = None
        try:
            _start_session(acp, self.settings)
            acp.initialize()
            session_id = acp.new_session(workspace)
            acp.ensure_model(profile.runner_model)
            result = acp.prompt(
                prompt,
                timeout_seconds=profile.timeout_seconds,
                on_progress=on_progress,
                is_cancelled=is_cancelled,
                turn=1,
            )
            events.extend(result.events)
            duration_ms += result.duration_ms
            final = result.text
            timed_out, cancelled = result.timed_out, result.cancelled
            idle_timeout = result.idle_timeout
            turn_error = result.error
            while (
                not timed_out
                and not cancelled
                and turn_error is None
                and result.stop_reason == "end_turn"
                and turns < case.max_turns
                and case.followups
            ):
                match_index = next(
                    (
                        index
                        for index, item in enumerate(case.followups)
                        if index not in used
                        and item.when_output_contains.casefold() in final.casefold()
                    ),
                    None,
                )
                if match_index is None:
                    break
                used.add(match_index)
                followup = case.followups[match_index]
                turns += 1
                result = acp.prompt(
                    followup.reply,
                    timeout_seconds=profile.timeout_seconds,
                    on_progress=on_progress,
                    is_cancelled=is_cancelled,
                    turn=turns,
                )
                events.extend(result.events)
                duration_ms += result.duration_ms
                timed_out, cancelled = result.timed_out, result.cancelled
                idle_timeout = idle_timeout or result.idle_timeout
                turn_error = result.error
                final = result.text or final
                if timed_out or cancelled or turn_error is not None:
                    break
        finally:
            acp.close()
        error_kind = None
        error_message = None
        if cancelled:
            error_kind = "cancelled"
            error_message = "Run cancelled by user"
        elif timed_out:
            error_kind = "timeout"
            if idle_timeout:
                idle_limit = max(profile.timeout_seconds, 60)
                error_message = (
                    f"Chrys execution timed out after {idle_limit}s without any activity "
                    "(no ACP events, no workspace file changes); consider raising the "
                    "per-turn inactivity timeout"
                )
            else:
                error_message = (
                    f"Chrys turn exceeded the absolute limit of "
                    f"{max(3 * profile.timeout_seconds, 3600)}s while still active"
                )
        elif turn_error is not None:
            error_kind = "agent_error"
            error_message = _acp_error_text(turn_error)
        last = events[-1] if events else {}
        input_tokens = last.get("input_tokens") if isinstance(last, dict) else None
        output_tokens = last.get("output_tokens") if isinstance(last, dict) else None
        return RunOutcome(
            exit_code=0 if error_kind is None else 1,
            final_response=final,
            events=events,
            duration_ms=duration_ms,
            input_tokens=input_tokens if isinstance(input_tokens, int) else None,
            output_tokens=output_tokens if isinstance(output_tokens, int) else None,
            thread_id=session_id,
            error_kind=error_kind,
            error_message=error_message,
            turns=turns,
            skill_invoked=skill_invocation(events, skill_name),
            skills_loaded=list(acp.skills_loaded),
        )
