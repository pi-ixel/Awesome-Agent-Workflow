"""Machine-protocol error codes and payload helpers for the AAW CLI.

The protocol blueprint lives in ``docs/cli-machine-protocol.md``.  This module
owns the stable, machine-distinguishable ``error.code`` vocabulary so that a
caller can branch on a code instead of parsing Chinese human-readable text.

Every code below must stay in the table in the blueprint document.  Do not
invent ad-hoc codes.
"""

from __future__ import annotations

from typing import Any

# Protocol version stamped on every --json envelope.  Bump only on a
# backward-incompatible change to the envelope shape.
PROTOCOL_VERSION = 1


class ErrorCode:
    """Stable machine-distinguishable error codes (see docs/cli-machine-protocol.md §2.1)."""

    INVALID_ARGS = "INVALID_ARGS"
    DATA_VALIDATION = "DATA_VALIDATION"
    WORKFLOW_NOT_FOUND = "WORKFLOW_NOT_FOUND"
    DUPLICATE_SR = "DUPLICATE_SR"
    ENTRY_UNKNOWN = "ENTRY_UNKNOWN"
    MISSING_REQUIRED_INPUT = "MISSING_REQUIRED_INPUT"
    MISSING_REQUIRED_OUTPUT = "MISSING_REQUIRED_OUTPUT"
    STEP_NOT_FOUND = "STEP_NOT_FOUND"
    STEP_ALREADY_COMPLETE = "STEP_ALREADY_COMPLETE"
    STEP_NOT_STARTED = "STEP_NOT_STARTED"
    AWAITING_USER_CONFIRM = "AWAITING_USER_CONFIRM"
    DEFINITION_CONFLICT = "DEFINITION_CONFLICT"
    TASK_DEV_STATE = "TASK_DEV_STATE"
    MIGRATION_NEEDED = "MIGRATION_NEEDED"
    UPDATE_FAILED = "UPDATE_FAILED"
    UPDATE_RECOVERY = "UPDATE_RECOVERY"
    UNKNOWN = "UNKNOWN"


def error_payload(code: str, message: str) -> dict[str, Any]:
    """Build the ``error`` block of the machine envelope.

    ``code`` must be one of :class:`ErrorCode`; ``message`` is human-readable
    text that machines must not rely on.
    """
    return {"code": code, "message": message}


# ---------------------------------------------------------------------------
# Heuristic classification of the CLI's exception types.
#
# The CLI raises only three exception types (WorkflowError / DataError /
# TaskDevError) with free-form Chinese messages across dozens of call sites.
# Rather than touch every raise site during the minimal protocol stage, we
# classify an exception to a stable code here by type first, then by message
# markers for the common cases.  This keeps the minimal stage additive: no
# raise site changes, every error still lands on a stable code.
#
# Note: messages are matched by *runtime* substring, never by the f-string
# template (which still contains "{sr}" braces and never appears verbatim).
# ---------------------------------------------------------------------------

def _from_message(message: str, exc_name: str) -> str:
    """Map a known error message to a stable code (ordered, substring match)."""

    # --- task-dev always maps to TASK_DEV_STATE --------------------------
    if exc_name == "TaskDevError":
        return ErrorCode.TASK_DEV_STATE

    # --- data validation (DataError) ------------------------------------
    # Every DataError originates from --data / foreach / choice validation.
    if exc_name == "DataError":
        return ErrorCode.DATA_VALIDATION

    # --- entry / argument problems ---------------------------------------
    if "入口不存在" in message or "指向未知节点" in message:
        return ErrorCode.ENTRY_UNKNOWN
    if "缺少变量" in message or "缺少 SR 变量" in message or "必须提供非空的原始需求" in message:
        return ErrorCode.INVALID_ARGS
    if "--var 格式错误" in message or "--var 缺少 key" in message:
        return ErrorCode.INVALID_ARGS
    if "--map 格式错误" in message or "--data 和 --data-file 不能同时使用" in message:
        return ErrorCode.INVALID_ARGS
    if "--artifacts 必须是 preserve 或 discard" in message:
        return ErrorCode.INVALID_ARGS

    # --- definition layer --------------------------------------------------
    if "flow.yaml 不存在" in message:
        return ErrorCode.DEFINITION_CONFLICT
    if "未知 edge kind" in message or "未知后继节点" in message:
        return ErrorCode.DEFINITION_CONFLICT
    if "同名" in message or "冲突" in message:
        return ErrorCode.DEFINITION_CONFLICT

    # --- workflow existence / lifecycle -------------------------------------
    if "workflow 已存在" in message or (message.startswith("SR ") and "已存在" in message):
        return ErrorCode.DUPLICATE_SR
    if message.startswith("SR ") and "不存在" in message:
        return ErrorCode.WORKFLOW_NOT_FOUND

    # --- step lifecycle -------------------------------------------------------
    if "已完成，不能重复 done" in message or "is already complete" in message:
        return ErrorCode.STEP_ALREADY_COMPLETE
    if "has not been started" in message or "requires an attempt" in message:
        return ErrorCode.STEP_NOT_STARTED
    if "does not exist" in message or ("step " in message and "不存在" in message):
        return ErrorCode.STEP_NOT_FOUND

    # --- input/output guards ---------------------------------------------------
    if "缺少 required input" in message:
        return ErrorCode.MISSING_REQUIRED_INPUT
    if "缺少 required output" in message:
        return ErrorCode.MISSING_REQUIRED_OUTPUT

    # --- awaiting user confirm ---------------------------------------------------
    if "待用户确认" in message or "等待用户确认" in message:
        return ErrorCode.AWAITING_USER_CONFIRM

    # --- update ------------------------------------------------------------------
    if "更新失败" in message:
        return ErrorCode.UPDATE_FAILED

    return ErrorCode.UNKNOWN


def classify_error(exc: BaseException) -> str:
    """Classify an exception into a stable :class:`ErrorCode`.

    ``exc`` is one of the CLI's exception types (WorkflowError, DataError,
    TaskDevError) or anything else.  The classification is best-effort: a
    message we cannot recognize falls back to ``ErrorCode.UNKNOWN``.
    """
    name = type(exc).__name__
    message = str(exc)
    return _from_message(message, name)
