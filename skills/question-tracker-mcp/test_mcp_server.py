"""
Question Tracker 测试文件

测试设计文档中定义的公开方法入口。
"""

import pytest
import os
import sys
import json
import tempfile
import shutil

sys.path.insert(0, os.path.dirname(__file__))

from mcp_server import (
    Question,
    MatchError,
    ValidationError,
    SessionNotFoundError,
    match_question,
    validate_questions_input,
    add_questions,
    answer_question,
    get_status,
    finalize_questions,
    update_answer,
    reset_questions,
    _get_state_file_path,
    STATE_FILE,
    SESSION_MARKER,
)


@pytest.fixture
def clean_state():
    """确保测试前状态文件干净，并创建会话标记"""
    # 创建 .sdd/ 目录和 .current_session 标记
    os.makedirs(".sdd", exist_ok=True)
    session_dir = "./.sdd/test/"
    os.makedirs(session_dir, exist_ok=True)
    with open(SESSION_MARKER, "w", encoding="utf-8") as f:
        f.write(session_dir)

    state_file = _get_state_file_path()
    if os.path.exists(state_file):
        os.remove(state_file)
    yield
    state_file = _get_state_file_path()
    if os.path.exists(state_file):
        os.remove(state_file)
    # 清理标记（保留 .sdd/ 目录，可能被其他测试共享）
    if os.path.exists(SESSION_MARKER):
        os.remove(SESSION_MARKER)


# ============ 7.1 单元测试 ============

class TestMatchQuestion:
    """UT01-UT04: match_question 函数测试"""

    def test_ut01_exact_match(self, clean_state):
        """UT01: 精确匹配 - question 与池中某条原文完全一致"""
        q1 = Question(id=1, question="什么是访问令牌")
        q2 = Question(id=2, question="令牌的过期时间是多少")
        questions = [q1, q2]

        result = match_question("什么是访问令牌", questions)

        assert result.id == 1
        assert result.question == "什么是访问令牌"

    def test_ut02_contains_match_unique(self, clean_state):
        """UT02: 包含匹配唯一 - question 是池中某条原文的唯一子串"""
        q1 = Question(id=1, question="用户认证接口的token字段名是什么")
        questions = [q1]

        result = match_question("token字段名", questions)

        assert result.id == 1
        assert result.question == "用户认证接口的token字段名是什么"

    def test_ut03_contains_match_ambiguous(self, clean_state):
        """UT03: 包含匹配不唯一 - question 是池中多条原文的公共子串"""
        q1 = Question(id=1, question="token过期时间是多少")
        q2 = Question(id=2, question="token刷新策略是什么")
        questions = [q1, q2]

        with pytest.raises(MatchError):
            match_question("token", questions)

    def test_ut04_no_match(self, clean_state):
        """UT04: 无匹配 - question 与池中所有原文均不匹配"""
        q1 = Question(id=1, question="什么是访问令牌")
        questions = [q1]

        with pytest.raises(MatchError):
            match_question("完全不存在的内容", questions)


class TestValidateQuestionsInput:
    """UT05-UT07: validate_questions_input 函数测试"""

    def test_ut05_valid_input(self, clean_state):
        """UT05: 正常输入"""
        result = validate_questions_input(["问题A", "问题B"])

        assert result == ["问题A", "问题B"]

    def test_ut06_empty_list(self, clean_state):
        """UT06: 空列表"""
        result = validate_questions_input([])

        assert result == []

    def test_ut07_empty_string(self, clean_state):
        """UT07: 空字符串"""
        with pytest.raises(ValidationError):
            validate_questions_input([""])


# ============ 7.2 集成测试 ============

class TestIT01_CompleteFlow:
    """IT01: 完整澄清流程"""

    def test_it01_finalize_returns_ready_and_summary(self, clean_state):
        """add(3) → answer(A) → answer(B) → answer(C) → finalize
        finalize 返回 status=ready，summary 含 3 条，.json 中 3 条均为 answered"""
        add_questions(["问题A", "问题B", "问题C"])
        answer_question("问题A", "答案A")
        answer_question("问题B", "答案B")
        answer_question("问题C", "答案C")

        result = finalize_questions()

        assert result["status"] == "ready"
        assert len(result["summary"]) == 3

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            state = json.load(f)
        for q in state["questions"]:
            assert q["status"] == "answered"


class TestIT02_ContradictionCorrection:
    """IT02: 矛盾纠正"""

    def test_it02_update_creates_history(self, clean_state):
        """add(1) → answer(A) → update(A,新答案) → get_status(full)
        get_status 中 history 含旧答案，.json 中 history 数组长度=1，answer=新答案"""
        add_questions(["问题A"])
        answer_question("问题A", "原答案")

        update_result = update_answer("问题A", "新答案", reason="用户纠正")
        assert update_result["matched_question"] == "问题A"
        assert update_result["previous_answer"] == "原答案"
        assert "total_pending" in update_result
        assert update_result["action_required"]["type"] == "reanalyze_all"

        result = get_status(detail="full")
        question = result["questions"][0]

        assert len(question["history"]) == 1
        assert question["history"][0]["answer"] == "原答案"
        assert question["answer"] == "新答案"

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            state = json.load(f)
        assert len(state["questions"][0]["history"]) == 1
        assert state["questions"][0]["answer"] == "新答案"


class TestIT03_DerivationResolution:
    """IT03: 推导消解"""

    def test_it03_derived_has_derivation_note(self, clean_state):
        """add(3) → answer(2) → answer(1,source=derived,note=基于问题2) → get_status(full)
        问题1 derivation_note=基于问题2，.json 中问题1 source=derived"""
        add_questions(["问题1", "问题2", "问题3"])
        answer_question("问题2", "答案2")

        answer_question("问题1", "推导答案1", source="derived", derivation_note="基于问题2")

        result = get_status(detail="full")
        question1 = next(q for q in result["questions"] if q["question"] == "问题1")

        assert question1["source"] == "derived"
        assert question1["derivation_note"] == "基于问题2"

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            state = json.load(f)
        q1_from_file = next(q for q in state["questions"] if q["question"] == "问题1")
        assert q1_from_file["source"] == "derived"


class TestIT04_AnswerNotFound:
    """IT04: 回答不存在的问题"""

    def test_it04_error_and_status_unchanged(self, clean_state):
        """add(1) → answer("不存在的问题原文") 返回 error，.json 中问题 status 仍为 pending"""
        add_questions(["问题A"])

        result = answer_question("不存在的原文", "答案")

        assert "error" in result
        assert "未匹配到问题" in result["error"]

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            state = json.load(f)
        assert state["questions"][0]["status"] == "pending"


class TestIT05_DuplicateAnswer:
    """IT05: 重复回答同一问题"""

    def test_it05_second_answer_error(self, clean_state):
        """add(1) → answer(A) → answer(A) 第二次返回 error，.json 中 answer 仍为第一次的值"""
        add_questions(["问题A"])
        answer_question("问题A", "第一次答案")

        result = answer_question("问题A", "第二次答案")

        assert "error" in result
        assert "已回答" in result["error"]
        assert "current_answer" in result

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            state = json.load(f)
        assert state["questions"][0]["answer"] == "第一次答案"


class TestIT06_UpdatePending:
    """IT06: 对 pending 用 update"""

    def test_it06_update_pending_error(self, clean_state):
        """add(1) → update(A,新答案) 返回 error，.json 中 status 仍为 pending"""
        add_questions(["问题A"])

        result = update_answer("问题A", "新答案")

        assert "error" in result
        assert "尚未回答" in result["error"]

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            state = json.load(f)
        assert state["questions"][0]["status"] == "pending"


class TestIT07_FinalizeBlocked:
    """IT07: finalize 时有 pending"""

    def test_it07_finalize_blocked(self, clean_state):
        """add(2) → answer(1) → finalize 返回 blocked，.json 中问题1=answered，问题2=pending"""
        add_questions(["问题A", "问题B"])
        answer_question("问题A", "答案A")

        result = finalize_questions()

        assert result["status"] == "blocked"
        assert result["pending_count"] == 1

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            state = json.load(f)
        q1 = next(q for q in state["questions"] if q["question"] == "问题A")
        q2 = next(q for q in state["questions"] if q["question"] == "问题B")
        assert q1["status"] == "answered"
        assert q2["status"] == "pending"


class TestIT08_EmptyListAdd:
    """IT08: 空列表 add"""

    def test_it08_empty_list_returns_zero(self, clean_state):
        """add([]) 返回 added_count=0，.json 中 questions 数组长度不变"""
        add_questions(["问题A", "问题B"])

        result = add_questions([])

        assert result["added_count"] == 0

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            state = json.load(f)
        assert len(state["questions"]) == 2


class TestIT09_IncludeMatchUnique:
    """IT09: 包含匹配唯一"""

    def test_it09_include_match_unique(self, clean_state):
        """add(["用户认证接口的token字段名是什么"]) → answer("token字段名")
        matched_question 为完整原文，.json 中 status=answered"""
        add_questions(["用户认证接口的token字段名是什么"])

        result = answer_question("token字段名", "字段名是token")

        assert "matched_question" in result
        assert result["matched_question"] == "用户认证接口的token字段名是什么"
        assert "error" not in result

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            state = json.load(f)
        assert state["questions"][0]["status"] == "answered"


class TestIT10_IncludeMatchNotUnique:
    """IT10: 包含匹配不唯一"""

    def test_it10_include_match_not_unique_error(self, clean_state):
        """add(["token过期时间是多少", "token刷新策略是什么"]) → answer("token")
        返回 error，.json 中两条均仍为 pending"""
        add_questions(["token过期时间是多少", "token刷新策略是什么"])

        result = answer_question("token", "答案")

        assert "error" in result
        assert "未匹配到问题" in result["error"]

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            state = json.load(f)
        for q in state["questions"]:
            assert q["status"] == "pending"


class TestIT11_AllDerivedFinalize:
    """IT11: 全部推导消解"""

    def test_it11_all_derived_finalize_ready(self, clean_state):
        """add(3) → answer(2) → answer(1,source=derived) → answer(3,source=derived) → finalize
        finalize 返回 ready，3 条 source 均为 derived，.json 中 3 条 source 均为 "derived" """
        add_questions(["问题1", "问题2", "问题3"])
        answer_question("问题2", "推导答案2", source="derived", derivation_note="基于外部推理")

        answer_question("问题1", "推导答案1", source="derived", derivation_note="基于问题2")
        answer_question("问题3", "推导答案3", source="derived", derivation_note="基于问题2")

        result = finalize_questions()

        assert result["status"] == "ready"
        for item in result["summary"]:
            assert item["source"] == "derived"

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            state = json.load(f)
        for q in state["questions"]:
            assert q["source"] == "derived"


class TestIT12_MultipleHistory:
    """IT12: 多次修改"""

    def test_it12_multiple_history_length_and_answer(self, clean_state):
        """add(1) → answer(A) → update(A,答案B) → update(A,答案C) → get_status(full)
        history 数组长度=2，answer=答案C，.json 中 history 数组长度=2，answer=答案C"""
        add_questions(["问题A"])
        answer_question("问题A", "答案A")

        r1 = update_answer("问题A", "答案B", reason="第一次修改")
        assert r1["matched_question"] == "问题A"
        assert r1["previous_answer"] == "答案A"
        assert r1["action_required"]["type"] == "reanalyze_all"

        r2 = update_answer("问题A", "答案C", reason="第二次修改")
        assert r2["matched_question"] == "问题A"
        assert r2["previous_answer"] == "答案B"
        assert r2["action_required"]["type"] == "reanalyze_all"

        result = get_status(detail="full")
        question = result["questions"][0]

        assert len(question["history"]) == 2
        assert question["answer"] == "答案C"

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            state = json.load(f)
        assert len(state["questions"][0]["history"]) == 2
        assert state["questions"][0]["answer"] == "答案C"


class TestIT13_TotalPendingCount:
    """IT13: total_pending 计数"""

    def test_it13_pending_count_sequence(self, clean_state):
        """add(2) → add(3) → answer(1) → answer(2,source=derived) → answer(3)
        total_pending 依次为 2、5、4、3、2，.json 中 pending 计数与返回值一致"""
        r1 = add_questions(["问题A", "问题B"])
        assert r1["total_pending"] == 2

        r2 = add_questions(["问题C", "问题D", "问题E"])
        assert r2["total_pending"] == 5

        answer_question("问题A", "答案A")
        r3 = get_status(detail="summary")
        assert r3["pending"] == 4

        answer_question("问题B", "答案B", source="derived", derivation_note="基于问题A")
        r4 = get_status(detail="summary")
        assert r4["pending"] == 3

        answer_question("问题C", "答案C")
        r5 = get_status(detail="summary")
        assert r5["pending"] == 2

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            state = json.load(f)
        pending_count = sum(1 for q in state["questions"] if q["status"] == "pending")
        assert pending_count == 2


class TestIT14_GetStatusSummary:
    """IT14: get_status summary 模式"""

    def test_it14_summary_returns_correct_counts(self, clean_state):
        """add(2) → get_status(detail="summary") 返回 {"total":2,"pending":2,"answered":0}"""
        add_questions(["问题A", "问题B"])

        result = get_status(detail="summary")

        assert result["total"] == 2
        assert result["pending"] == 2
        assert result["answered"] == 0

    def test_it14_summary_does_not_change_file(self, clean_state):
        """get_status(summary) 不改变 .json 内容"""
        add_questions(["问题A", "问题B"])

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            before = f.read()

        get_status(detail="summary")

        with open(_get_state_file_path(), "r", encoding="utf-8") as f:
            after = f.read()

        assert before == after


class TestIT15_ExternalClearRecovery:
    """IT15: 外部清空后恢复"""

    def test_it15_rebuild_after_external_delete(self, clean_state):
        """add(3) → answer(1) → 删除 .json → 重启进程(重新加载状态) → get_status(full)
        total=0，.json 被重建，questions=[], next_id=1"""
        add_questions(["问题A", "问题B", "问题C"])
        answer_question("问题A", "答案A")

        os.remove(_get_state_file_path())

        from mcp_server import _load_state
        state = _load_state()

        assert state["questions"] == []
        assert state["next_id"] == 1


class TestIT16_ResetQuestions:
    """IT16: reset_questions 重置问题池"""

    def test_it16_full_reset_clears_all(self, clean_state):
        """add(3) → answer(1) → reset_questions() → cleared=3, remaining=0,
        get_status(summary) total=0，finalize_questions 立即可 ready"""
        add_questions(["问题A", "问题B", "问题C"])
        answer_question("问题A", "答案A")

        result = reset_questions()

        assert result["cleared_count"] == 3
        assert result["remaining_count"] == 0
        assert result["total_pending"] == 0
        status = get_status(detail="summary")
        assert status["total"] == 0
        assert finalize_questions()["status"] == "ready"

    def test_it16_only_pending_keeps_answered(self, clean_state):
        """add(3) → answer(1) → answer(2,source=derived) → reset_questions(only_pending=True)
        cleared=1（仅问题C），answered/derived 的 2 条保留且答案不变"""
        add_questions(["问题A", "问题B", "问题C"])
        answer_question("问题A", "答案A")
        answer_question("问题B", "答案B", source="derived", derivation_note="基于问题A")

        result = reset_questions(only_pending=True)

        assert result["cleared_count"] == 1
        assert result["remaining_count"] == 2
        assert result["total_pending"] == 0
        status = get_status(detail="full")
        texts = [q["question"] for q in status["questions"]]
        assert texts == ["问题A", "问题B"]
        assert status["questions"][0]["answer"] == "答案A"
        assert status["questions"][1]["source"] == "derived"

    def test_it16_reset_without_session_marker(self):
        """无 .current_session 标记时 reset_questions 返回 error，不抛异常"""
        if os.path.exists(SESSION_MARKER):
            os.remove(SESSION_MARKER)

        result = reset_questions()

        assert "error" in result


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
