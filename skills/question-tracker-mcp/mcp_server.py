"""
Question Tracker MCP Server

提供问题状态管理能力，用于"设计文档撰写助手"Skill的澄清流程。
"""

import os
import json
from datetime import datetime
from typing import Optional, List

from fastmcp import FastMCP

mcp = FastMCP("question-tracker")

STATE_FILE = ".question_state.json"
SESSION_MARKER = ".sdd/.current_session"
STATE_FILE_NAME = ".question_state.json"


class MatchError(Exception):
    """匹配失败时抛出"""
    pass


class ValidationError(Exception):
    """校验失败时抛出"""
    pass


class SessionNotFoundError(Exception):
    """会话标记文件缺失时抛出"""
    pass


def _get_state_file_path() -> str:
    """获取当前会话的问题状态文件路径。

    读取 .sdd/.current_session 获取当前 SR 隔离目录，
    拼接 .question_state.json 文件名返回。

    Raises:
        SessionNotFoundError: 未找到会话标记文件，说明未通过 aaw-workflow 启动
    """
    if not os.path.exists(SESSION_MARKER):
        raise SessionNotFoundError(
            "未找到 .sdd/.current_session 会话标记文件。\n"
            "请通过 aaw-workflow 启动工作流（输入 /aaw-workflow 或 \"进入工作流\"），"
            "不要直接调用 sr-design 子技能。\n"
            "aaw-workflow 会在调用子技能前自动写入该标记文件。"
        )
    with open(SESSION_MARKER, "r", encoding="utf-8") as f:
        session_dir = f.read().strip()
    if not session_dir:
        raise SessionNotFoundError(
            ".sdd/.current_session 文件内容为空。\n"
            "请通过 aaw-workflow 启动工作流（输入 /aaw-workflow 或 \"进入工作流\"），"
            "不要直接调用 sr-design 子技能。"
        )
    return os.path.join(session_dir, STATE_FILE_NAME)


class Question:
    """问题对象"""
    def __init__(
        self,
        id: int,
        question: str,
        status: str = "pending",
        answer: Optional[str] = None,
        source: Optional[str] = None,
        derivation_note: Optional[str] = None,
        created_at: str = "",
        answered_at: Optional[str] = None,
        updated_at: Optional[str] = None,
        history: Optional[List[dict]] = None
    ):
        self.id = id
        self.question = question
        self.status = status
        self.answer = answer
        self.source = source
        self.derivation_note = derivation_note
        self.created_at = created_at or datetime.now().isoformat()
        self.answered_at = answered_at
        self.updated_at = updated_at
        self.history = history or []

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "question": self.question,
            "status": self.status,
            "answer": self.answer,
            "source": self.source,
            "derivation_note": self.derivation_note,
            "created_at": self.created_at,
            "answered_at": self.answered_at,
            "updated_at": self.updated_at,
            "history": self.history
        }

    @classmethod
    def from_dict(cls, data: dict) -> "Question":
        return cls(
            id=data["id"],
            question=data["question"],
            status=data.get("status", "pending"),
            answer=data.get("answer"),
            source=data.get("source"),
            derivation_note=data.get("derivation_note"),
            created_at=data.get("created_at", ""),
            answered_at=data.get("answered_at"),
            updated_at=data.get("updated_at"),
            history=data.get("history", [])
        )


def _load_state() -> dict:
    """从文件加载状态，无则返回空结构。文件格式异常时自动修复。"""
    state_file = _get_state_file_path()
    if not os.path.exists(state_file):
        return {"questions": [], "next_id": 1}
    try:
        with open(state_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            if not isinstance(data, dict) or "questions" not in data:
                return {"questions": [], "next_id": 1}
            return data
    except (json.JSONDecodeError, IOError):
        return {"questions": [], "next_id": 1}


def _save_state(state: dict):
    """保存状态到文件"""
    state_file = _get_state_file_path()
    os.makedirs(os.path.dirname(state_file), exist_ok=True)
    with open(state_file, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


def _get_questions() -> List[Question]:
    """获取所有问题对象列表"""
    state = _load_state()
    return [Question.from_dict(q) for q in state.get("questions", [])]


def _save_questions(questions: List[Question]):
    """保存问题列表到文件"""
    state = _load_state()
    state["questions"] = [q.to_dict() for q in questions]
    _save_state(state)


def _get_next_id() -> int:
    """获取下一个ID"""
    state = _load_state()
    return state.get("next_id", 1)


def _set_next_id(next_id: int):
    """设置下一个ID"""
    state = _load_state()
    state["next_id"] = next_id
    _save_state(state)


def match_question(question_text: str, questions: List[Question]) -> Question:
    """
    匹配问题

    策略：
    1. 精确匹配：question_text 与某条 question 完全一致
    2. 包含匹配：question_text 是某条 question 的唯一子串

    抛出 MatchError：如果匹配失败或匹配到多条
    """
    matched = []

    for q in questions:
        if q.question == question_text:
            return q
        if question_text in q.question:
            matched.append(q)

    if len(matched) == 1:
        return matched[0]

    raise MatchError()


def validate_questions_input(questions: List[str]) -> List[str]:
    """
    校验问题输入

    抛出 ValidationError：如果包含空字符串
    """
    for q in questions:
        if q == "":
            raise ValidationError()
    return questions


@mcp.tool()
def add_questions(questions: List[str]) -> dict:
    """
    批量添加待确认问题到问题池

    入参：
        questions: 问题文本列表

    出参：
        added_count: 本次添加数量
        total_pending: 当前待处理总数
    """
    try:
        validate_questions_input(questions)
    except ValidationError:
        return {"error": "问题列表不能包含空字符串，请修正后再次尝试！"}

    try:
        all_questions = _get_questions()
        next_id = _get_next_id()

        for q_text in questions:
            q = Question(id=next_id, question=q_text)
            all_questions.append(q)
            next_id += 1

        _save_questions(all_questions)
        _set_next_id(next_id)

        total_pending = sum(1 for q in all_questions if q.status == "pending")

        return {
            "added_count": len(questions),
            "total_pending": total_pending
        }
    except SessionNotFoundError as e:
        return {"error": str(e)}


@mcp.tool()
def answer_question(
    question: str,
    answer: str,
    source: str = "user",
    derivation_note: Optional[str] = None
) -> dict:
    """
    记录用户对某个问题的答案

    入参：
        question: 问题原文
        answer: 答案内容
        source: "user" 或 "derived"
        derivation_note: 推导依据

    出参：
        matched_question: 匹配到的问题原文
        total_pending: 当前待处理数
        action_required: {"type": "analyze_and_add_new_questions"}
    """
    try:
        all_questions = _get_questions()
        try:
            matched_q = match_question(question, all_questions)
        except MatchError:
            return {
                "error": "未匹配到问题。请使用 get_status 查看准确的问题原文后重试。"
            }

        if matched_q.status == "answered":
            return {
                "error": "该问题已回答。如需修改，请使用 update_answer。",
                "matched_question": matched_q.question,
                "current_answer": matched_q.answer
            }

        now = datetime.now().isoformat()
        matched_q.status = "answered"
        matched_q.answer = answer
        matched_q.source = source
        matched_q.derivation_note = derivation_note
        matched_q.answered_at = now
        matched_q.updated_at = now

        _save_questions(all_questions)

        total_pending = sum(1 for q in all_questions if q.status == "pending")

        return {
            "matched_question": matched_q.question,
            "total_pending": total_pending,
            "action_required": {"type": "analyze_and_add_new_questions"}
        }
    except SessionNotFoundError as e:
        return {"error": str(e)}


@mcp.tool()
def get_status(detail: str = "full") -> dict:
    """
    获取问题池状态

    入参：
        detail: "summary" 或 "full"

    出参：
        total: 问题总数
        pending: 待处理数
        answered: 已回答数
        questions: 详细列表（仅full模式）
    """
    try:
        all_questions = _get_questions()

        total = len(all_questions)
        pending = sum(1 for q in all_questions if q.status == "pending")
        answered = total - pending

        if detail == "summary":
            return {
                "total": total,
                "pending": pending,
                "answered": answered
            }

        questions_data = []
        for q in all_questions:
            questions_data.append({
                "question": q.question,
                "status": q.status,
                "answer": q.answer,
                "source": q.source,
                "derivation_note": q.derivation_note,
                "updated_at": q.updated_at,
                "history": q.history
            })

        return {
            "total": total,
            "pending": pending,
            "answered": answered,
            "questions": questions_data
        }
    except SessionNotFoundError as e:
        return {"error": str(e)}


@mcp.tool()
def finalize_questions() -> dict:
    """
    最终确认所有问题已澄清

    入参：无

    出参：
        status: "ready" 或 "blocked"
        summary/pending_questions: 根据status不同而不同
    """
    try:
        all_questions = _get_questions()

        pending_questions = [q for q in all_questions if q.status == "pending"]

        if pending_questions:
            return {
                "status": "blocked",
                "pending_count": len(pending_questions),
                "pending_questions": [{"question": q.question} for q in pending_questions]
            }

        summary = []
        for q in all_questions:
            summary.append({
                "question": q.question,
                "answer": q.answer,
                "source": q.source,
                "derivation_note": q.derivation_note
            })

        return {
            "status": "ready",
            "summary": summary
        }
    except SessionNotFoundError as e:
        return {"error": str(e)}


@mcp.tool()
def update_answer(
    question: str,
    answer: str,
    reason: Optional[str] = None
) -> dict:
    """
    修改某个已记录问题的答案

    入参：
        question: 问题原文
        answer: 新答案
        reason: 修改原因

    出参：
        matched_question: 匹配到的问题原文
        previous_answer: 旧答案
        total_pending: 当前待处理数
        action_required: {"type": "reanalyze_all"}
    """
    try:
        all_questions = _get_questions()
        try:
            matched_q = match_question(question, all_questions)
        except MatchError:
            return {
                "error": "未匹配到问题。请使用 get_status 查看准确的问题原文后重试。"
            }

        if matched_q.status == "pending":
            return {
                "error": "该问题尚未回答，请使用 answer_question 而不是 update_answer。"
            }

        previous_answer = matched_q.answer

        now = datetime.now().isoformat()
        matched_q.history.append({
            "answer": previous_answer,
            "reason": reason,
            "updated_at": now
        })
        matched_q.answer = answer
        matched_q.updated_at = now

        _save_questions(all_questions)

        total_pending = sum(1 for q in all_questions if q.status == "pending")

        return {
            "matched_question": matched_q.question,
            "previous_answer": previous_answer,
            "total_pending": total_pending,
            "action_required": {"type": "reanalyze_all"}
        }
    except SessionNotFoundError as e:
        return {"error": str(e)}


@mcp.tool()
def reset_questions(only_pending: bool = False) -> dict:
    """
    重置问题池（用户确认放弃前序问题后调用）

    入参：
        only_pending:
            False — 清空全部问题（开始全新设计会话）
            True  — 仅清除 pending 状态的遗留问题，已确认答案保留为约束

    出参：
        cleared_count: 被清除的问题数量
        remaining_count: 保留的问题数量
        total_pending: 0
    """
    try:
        all_questions = _get_questions()

        if only_pending:
            remaining = [q for q in all_questions if q.status != "pending"]
        else:
            remaining = []

        cleared = len(all_questions) - len(remaining)
        _save_questions(remaining)

        return {
            "cleared_count": cleared,
            "remaining_count": len(remaining),
            "total_pending": 0
        }
    except SessionNotFoundError as e:
        return {"error": str(e)}


if __name__ == "__main__":
    mcp.run()
