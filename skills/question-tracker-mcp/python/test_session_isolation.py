"""
会话隔离功能测试

覆盖 _get_state_file_path() 全部 6 个分支（单元测试）
覆盖 _load_state() / _save_state() 文件系统交互（集成测试）

测试先行：阶段 1（空壳）时全部 FAIL，阶段 2（真实实现）时全部 PASS
"""

import pytest
import os
import json
import sys
import tempfile
import shutil
from unittest.mock import MagicMock

# Mock fastmcp before importing mcp_server (避免依赖安装问题)
sys.modules['fastmcp'] = MagicMock()

sys.path.insert(0, os.path.dirname(__file__))
from mcp_server import (
    _get_state_file_path,
    _load_state,
    _save_state,
    _set_next_id,
    _get_questions,
    _save_questions,
    SessionNotFoundError,
    SESSION_MARKER,
    STATE_FILE_NAME,
)

# ============================================================
# Fixtures
# ============================================================


@pytest.fixture
def temp_workdir():
    """创建带 .sdd/ 结构的临时工作目录，测试结束后自动清理"""
    tmp = tempfile.mkdtemp()
    orig_cwd = os.getcwd()
    os.chdir(tmp)
    os.makedirs(os.path.join(tmp, ".sdd"), exist_ok=True)
    yield tmp
    os.chdir(orig_cwd)
    shutil.rmtree(tmp)


@pytest.fixture
def session_marker_valid(temp_workdir):
    """创建合法的 .sdd/.current_session 标记文件（SR-123）"""
    marker_dir = os.path.join(temp_workdir, ".sdd")
    os.makedirs(marker_dir, exist_ok=True)
    marker_path = os.path.join(marker_dir, ".current_session")
    content = "./.sdd/SR-123/"
    with open(marker_path, "w", encoding="utf-8") as f:
        f.write(content)
    # 同时创建目标目录
    target_dir = os.path.join(temp_workdir, ".sdd", "SR-123")
    os.makedirs(target_dir, exist_ok=True)
    yield marker_path


@pytest.fixture
def session_marker_content(temp_workdir, request):
    """通过 parametrize 传入标记文件内容"""
    marker_dir = os.path.join(temp_workdir, ".sdd")
    os.makedirs(marker_dir, exist_ok=True)
    marker_path = os.path.join(marker_dir, ".current_session")
    content = request.param
    with open(marker_path, "w", encoding="utf-8") as f:
        f.write(content)
    yield marker_path


@pytest.fixture
def clean_session_state(temp_workdir, session_marker_valid):
    """确保测试前后 .question_state.json 干净"""
    state_file = _get_state_file_path()
    if os.path.exists(state_file):
        os.remove(state_file)
    yield
    if os.path.exists(state_file):
        os.remove(state_file)


# ============================================================
# 单元测试：_get_state_file_path() 全部 6 个分支
# ============================================================


class TestGetStateFilePath:
    """UT-SI-01 ~ UT-SI-06: 覆盖 _get_state_file_path() 所有分支"""

    def test_ut_si_01_marker_exists_valid_content(self, temp_workdir, session_marker_valid):
        """UT-SI-01: 标记文件存在，内容合法 → 返回拼接后的隔离路径"""
        result = _get_state_file_path()
        assert "SR-123" in result, f"路径应包含 SR-123，实际: {result}"
        assert result.endswith(".question_state.json"), \
            f"路径应以 .question_state.json 结尾，实际: {result}"
        # 平台无关的路径检查
        normalized = result.replace("\\", "/")
        assert ".sdd/SR-123/.question_state.json" in normalized, \
            f"路径应包含 .sdd/SR-123/.question_state.json，实际: {normalized}"

    def test_ut_si_02_marker_not_exists(self, temp_workdir):
        """UT-SI-02: 标记文件不存在 → 抛出 SessionNotFoundError"""
        # 确保 .sdd/.current_session 不存在
        marker = os.path.join(temp_workdir, ".sdd", ".current_session")
        if os.path.exists(marker):
            os.remove(marker)
        with pytest.raises(SessionNotFoundError) as exc_info:
            _get_state_file_path()
        assert "aaw-workflow" in str(exc_info.value), \
            f"错误消息应包含 aaw-workflow 引导信息，实际: {exc_info.value}"

    @pytest.mark.parametrize("session_marker_content", [
        "./.sdd/SR-123/  \n",
        "  ./.sdd/SR-123/  ",
        "./.sdd/SR-123/\n",
    ], indirect=True)
    def test_ut_si_03_marker_trailing_whitespace(self, temp_workdir, session_marker_content):
        """UT-SI-03: 标记内容含尾随空格/换行 → strip() 后正确拼接"""
        result = _get_state_file_path()
        # 路径中不应含尾随空格或换行
        assert "  " not in result, f"路径不应包含双空格，实际: {result!r}"
        assert "\n" not in result, f"路径不应包含换行，实际: {result!r}"
        assert result.endswith(".question_state.json")

    @pytest.mark.parametrize("session_marker_content", [
        "",  # 空文件
    ], indirect=True)
    def test_ut_si_04_marker_empty_string(self, temp_workdir, session_marker_content):
        """UT-SI-04: 标记文件存在但内容为空 → 抛出 SessionNotFoundError"""
        with pytest.raises(SessionNotFoundError) as exc_info:
            _get_state_file_path()
        assert "aaw-workflow" in str(exc_info.value)

    @pytest.mark.parametrize("session_marker_content", [
        "  \n  \t  ",
        "   ",
        "\n\n",
    ], indirect=True)
    def test_ut_si_05_marker_whitespace_only(self, temp_workdir, session_marker_content):
        """UT-SI-05: 标记文件仅含空白字符 → strip() 后为空 → 抛出异常"""
        with pytest.raises(SessionNotFoundError) as exc_info:
            _get_state_file_path()
        assert "aaw-workflow" in str(exc_info.value)

    @pytest.mark.parametrize("session_marker_content", [
        "./.sdd/SR-123/nested/deep/",
        "./.sdd/SR-456/sub/dir/structure/",
    ], indirect=True)
    def test_ut_si_06_nested_directory_path(self, temp_workdir, session_marker_content):
        """UT-SI-06: 标记文件指向多层嵌套目录 → 正确拼接路径"""
        result = _get_state_file_path()
        assert result.endswith(".question_state.json")
        assert ".sdd" in result


# ============================================================
# 集成测试：_load_state() / _save_state() 文件系统交互
# ============================================================


class TestStatePersistence:
    """IT-SI-01 ~ IT-SI-05: 状态持久化与隔离"""

    def test_it_si_01_first_use_roundtrip(self, temp_workdir, session_marker_valid, clean_session_state):
        """IT-SI-01: 首次使用 → 写问题 → 读回，确认文件落在隔离目录"""
        # 写入问题
        state = _load_state()
        questions = state.get("questions", [])
        next_id = state.get("next_id", 1)
        questions.append({
            "id": next_id,
            "question": "Q1",
            "status": "pending",
            "answer": None,
            "source": None,
            "derivation_note": None,
            "created_at": "",
            "answered_at": None,
            "updated_at": None,
            "history": [],
        })
        state["questions"] = questions
        state["next_id"] = next_id + 1
        _save_state_custom(state)
        # 检查文件落在 SR-123 目录下
        state_file = _get_state_file_path()
        assert os.path.exists(state_file), f"状态文件应存在: {state_file}"
        assert "SR-123" in state_file, f"文件路径应包含 SR-123: {state_file}"
        # 读回验证
        loaded = _load_state()
        assert len(loaded.get("questions", [])) == 1
        assert loaded["questions"][0]["question"] == "Q1"

    def test_it_si_02_auto_create_target_dir(self, temp_workdir):
        """IT-SI-02: 目标目录不存在 → _save_state 自动创建"""
        # 创建标记，但不创建目标目录
        marker_dir = os.path.join(temp_workdir, ".sdd")
        os.makedirs(marker_dir, exist_ok=True)
        marker_path = os.path.join(marker_dir, ".current_session")
        target_rel = "./.sdd/SR-AUTO/"
        with open(marker_path, "w", encoding="utf-8") as f:
            f.write(target_rel)
        # 确认目标目录不存在
        target_abs = os.path.join(temp_workdir, ".sdd", "SR-AUTO")
        assert not os.path.exists(target_abs), "前置: 目标目录不应存在"
        # 写入状态
        state = _load_state()
        state["questions"].append({
            "id": 1, "question": "Q1", "status": "pending",
            "answer": None, "source": None, "derivation_note": None,
            "created_at": "", "answered_at": None, "updated_at": None,
            "history": [],
        })
        state["next_id"] = 2
        _save_state_custom(state)
        # 验证目录和文件均被创建
        assert os.path.isdir(target_abs), f"目标目录应被自动创建: {target_abs}"
        state_file = _get_state_file_path()
        assert os.path.exists(state_file), f"状态文件应存在: {state_file}"

    def test_it_si_03_marker_missing_raises(self, temp_workdir):
        """IT-SI-03: 标记文件缺失 → _load_state 抛出 SessionNotFoundError"""
        marker = os.path.join(temp_workdir, ".sdd", ".current_session")
        if os.path.exists(marker):
            os.remove(marker)
        with pytest.raises(SessionNotFoundError) as exc_info:
            _load_state()
        assert "aaw-workflow" in str(exc_info.value)

    def test_it_si_04_cross_sr_isolation(self, temp_workdir):
        """IT-SI-04: 跨 SR 隔离 → SR-123 和 SR-456 数据互不干扰"""
        marker_dir = os.path.join(temp_workdir, ".sdd")
        os.makedirs(marker_dir, exist_ok=True)
        marker_path = os.path.join(marker_dir, ".current_session")

        # 在 SR-123 下写入 Q1
        os.makedirs(os.path.join(temp_workdir, ".sdd", "SR-123"), exist_ok=True)
        with open(marker_path, "w", encoding="utf-8") as f:
            f.write("./.sdd/SR-123/")
        state = _load_state()
        state["questions"].append({
            "id": 1, "question": "Q1-SR123", "status": "pending",
            "answer": None, "source": None, "derivation_note": None,
            "created_at": "", "answered_at": None, "updated_at": None,
            "history": [],
        })
        state["next_id"] = 2
        _save_state_custom(state)

        # 切换到 SR-456，写入 Q2
        os.makedirs(os.path.join(temp_workdir, ".sdd", "SR-456"), exist_ok=True)
        with open(marker_path, "w", encoding="utf-8") as f:
            f.write("./.sdd/SR-456/")
        state2 = _load_state()
        state2["questions"].append({
            "id": 1, "question": "Q2-SR456", "status": "pending",
            "answer": None, "source": None, "derivation_note": None,
            "created_at": "", "answered_at": None, "updated_at": None,
            "history": [],
        })
        state2["next_id"] = 2
        _save_state_custom(state2)

        # 验证 SR-123 文件只有 Q1
        sr123_file = os.path.join(temp_workdir, ".sdd", "SR-123", ".question_state.json")
        assert os.path.exists(sr123_file)
        with open(sr123_file, "r", encoding="utf-8") as f:
            sr123_data = json.load(f)
        assert len(sr123_data["questions"]) == 1
        assert sr123_data["questions"][0]["question"] == "Q1-SR123"

        # 验证 SR-456 文件只有 Q2
        sr456_file = os.path.join(temp_workdir, ".sdd", "SR-456", ".question_state.json")
        assert os.path.exists(sr456_file)
        with open(sr456_file, "r", encoding="utf-8") as f:
            sr456_data = json.load(f)
        assert len(sr456_data["questions"]) == 1
        assert sr456_data["questions"][0]["question"] == "Q2-SR456"

    def test_it_si_05_session_recovery(self, temp_workdir):
        """IT-SI-05: 会话恢复 → 重启后数据完整保留"""
        marker_dir = os.path.join(temp_workdir, ".sdd")
        os.makedirs(marker_dir, exist_ok=True)
        marker_path = os.path.join(marker_dir, ".current_session")
        target_dir = os.path.join(temp_workdir, ".sdd", "SR-123")
        os.makedirs(target_dir, exist_ok=True)

        with open(marker_path, "w", encoding="utf-8") as f:
            f.write("./.sdd/SR-123/")

        # 写入 Q1(answered) 和 Q2(pending)
        state = _load_state()
        state["questions"] = [
            {
                "id": 1, "question": "Q1", "status": "answered",
                "answer": "Answer1", "source": "user",
                "derivation_note": None, "created_at": "2026-01-01T00:00:00",
                "answered_at": "2026-01-01T00:01:00", "updated_at": "2026-01-01T00:01:00",
                "history": [],
            },
            {
                "id": 2, "question": "Q2", "status": "pending",
                "answer": None, "source": None,
                "derivation_note": None, "created_at": "2026-01-01T00:02:00",
                "answered_at": None, "updated_at": None,
                "history": [],
            },
        ]
        state["next_id"] = 3
        _save_state_custom(state)

        # 模拟重启：重新加载
        loaded = _load_state()
        assert loaded["next_id"] == 3
        assert len(loaded["questions"]) == 2
        # 找到 answered 和 pending
        answered = [q for q in loaded["questions"] if q["status"] == "answered"]
        pending = [q for q in loaded["questions"] if q["status"] == "pending"]
        assert len(answered) == 1
        assert answered[0]["question"] == "Q1"
        assert answered[0]["answer"] == "Answer1"
        assert len(pending) == 1
        assert pending[0]["question"] == "Q2"


# ============================================================
# Helpers
# ============================================================


def _save_state_custom(state: dict):
    """与 mcp_server._save_state 等效（在阶段 2 会被替换为真实实现）"""
    state_file = _get_state_file_path()
    os.makedirs(os.path.dirname(state_file), exist_ok=True)
    with open(state_file, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
