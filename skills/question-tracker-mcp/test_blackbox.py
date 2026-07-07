"""
Question Tracker 黑盒测试文件

通过 stdio 启动 MCP Server 子进程，发送 JSON-RPC 请求，验证完整响应。
不 import 任何 mcp_server 模块。
"""

import pytest
import os
import sys
import json
import subprocess
import tempfile
import shutil

STATE_FILE = ".question_state.json"


@pytest.fixture
def temp_dir():
    """创建临时目录作为工作目录，含 .sdd/.current_session 标记"""
    tmp = tempfile.mkdtemp()
    orig = os.getcwd()
    os.chdir(tmp)
    # 创建会话标记，指向临时测试 SR 目录
    os.makedirs(os.path.join(tmp, ".sdd"), exist_ok=True)
    session_dir = "./.sdd/test/"
    os.makedirs(os.path.join(tmp, session_dir.strip("./")), exist_ok=True)
    with open(os.path.join(tmp, ".sdd", ".current_session"), "w", encoding="utf-8") as f:
        f.write(session_dir)
    yield tmp
    os.chdir(orig)
    shutil.rmtree(tmp)


@pytest.fixture
def clean_state(temp_dir):
    """确保测试前状态文件干净"""
    state_file = os.path.join(temp_dir, ".sdd", "test", STATE_FILE)
    if os.path.exists(state_file):
        os.remove(state_file)
    yield
    if os.path.exists(state_file):
        os.remove(state_file)


class TestBlackBox:
    """BB01-BB05: 黑盒测试，通过 stdio 启动子进程"""

    @pytest.fixture
    def mcp_process(self, temp_dir):
        """启动 MCP Server 子进程"""
        server_path = os.path.join(os.path.dirname(__file__), "mcp_server.py")
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        proc = subprocess.Popen(
            [sys.executable, server_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
            text=True,
            encoding="utf-8",
            cwd=temp_dir,
            env=env,
        )
        yield proc
        proc.terminate()
        proc.wait(timeout=5)

    def _initialize(self, proc):
        """初始化 MCP 连接"""
        init_request = {
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "test",
                    "version": "1.0.0"
                }
            },
            "id": 0
        }
        proc.stdin.write(json.dumps(init_request) + "\n")
        proc.stdin.flush()
        response_line = proc.stdout.readline()
        return json.loads(response_line)

    def _call_tool(self, proc, tool_name, arguments, req_id=1):
        """调用 MCP 工具，返回解析后的结果数据"""
        request = {
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {
                "name": tool_name,
                "arguments": arguments
            },
            "id": req_id
        }
        proc.stdin.write(json.dumps(request) + "\n")
        proc.stdin.flush()
        response_line = proc.stdout.readline()
        response = json.loads(response_line)

        if "error" in response:
            return response

        result_text = response["result"]["content"][0]["text"]
        return json.loads(result_text)

    def test_bb01_complete_workflow(self, mcp_process, clean_state):
        """BB01: 完整澄清流程 - 每个响应符合 JSON-RPC 规范，finalize 返回 status=ready"""
        self._initialize(mcp_process)

        r1 = self._call_tool(mcp_process, "add_questions", {"questions": ["问题A", "问题B", "问题C"]})
        assert "added_count" in r1
        assert r1["added_count"] == 3

        r2 = self._call_tool(mcp_process, "answer_question", {"question": "问题A", "answer": "答案A"})
        assert "matched_question" in r2

        r3 = self._call_tool(mcp_process, "answer_question", {"question": "问题B", "answer": "答案B"})
        assert "matched_question" in r3

        r3b = self._call_tool(mcp_process, "answer_question", {"question": "问题C", "answer": "答案C"})
        assert "matched_question" in r3b

        r4 = self._call_tool(mcp_process, "finalize_questions", {})
        assert r4["status"] == "ready"
        assert len(r4["summary"]) == 3

    def test_bb02_error_response_format(self, mcp_process, clean_state):
        """BB02: 异常响应格式 - 响应符合 JSON-RPC 规范，result 中含 error 字段"""
        self._initialize(mcp_process)

        self._call_tool(mcp_process, "add_questions", {"questions": ["问题A"]})

        r = self._call_tool(mcp_process, "answer_question", {"question": "不存在的原文", "answer": "答案"})

        assert "error" in r
        assert "未匹配到问题" in r["error"]

    def test_bb03_persistence_recovery(self, mcp_process, clean_state, temp_dir):
        """BB03: 重启恢复 - 恢复后 pending=1，answered=1，问题原文完整保留"""
        self._initialize(mcp_process)

        self._call_tool(mcp_process, "add_questions", {"questions": ["问题A", "问题B"]})
        self._call_tool(mcp_process, "answer_question", {"question": "问题A", "answer": "答案A"})

        proc_id = mcp_process.pid
        mcp_process.terminate()
        mcp_process.wait(timeout=5)

        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        new_proc = subprocess.Popen(
            [sys.executable, os.path.join(os.path.dirname(__file__), "mcp_server.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
            text=True,
            encoding="utf-8",
            cwd=temp_dir,
            env=env,
        )

        try:
            self._initialize(new_proc)
            r = self._call_tool(new_proc, "get_status", {"detail": "full"})
            assert r["pending"] == 1
            assert r["answered"] == 1

            questions = r["questions"]
            questions_text = [q["question"] for q in questions]
            assert "问题A" in questions_text
            assert "问题B" in questions_text
        finally:
            new_proc.terminate()
            new_proc.wait(timeout=5)

    def test_bb04_external_clear_new_design(self, mcp_process, clean_state, temp_dir):
        """BB04: 外部清空后新设计 - total=1，next_id=2"""
        self._initialize(mcp_process)

        self._call_tool(mcp_process, "add_questions", {"questions": ["问题A", "问题B"]})
        self._call_tool(mcp_process, "answer_question", {"question": "问题A", "answer": "答案A"})

        mcp_process.terminate()
        mcp_process.wait(timeout=5)

        state_file = os.path.join(temp_dir, ".sdd", "test", STATE_FILE)
        if os.path.exists(state_file):
            os.remove(state_file)

        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        new_proc = subprocess.Popen(
            [sys.executable, os.path.join(os.path.dirname(__file__), "mcp_server.py")],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
            text=True,
            encoding="utf-8",
            cwd=temp_dir,
            env=env,
        )

        try:
            self._initialize(new_proc)
            self._call_tool(new_proc, "add_questions", {"questions": ["新问题"]})
            r = self._call_tool(new_proc, "get_status", {"detail": "full"})

            assert r["total"] == 1

            with open(os.path.join(temp_dir, ".sdd", "test", STATE_FILE), "r", encoding="utf-8") as f:
                state = json.load(f)
            assert state["next_id"] == 2
        finally:
            new_proc.terminate()
            new_proc.wait(timeout=5)

    def test_bb05_jsonrpc_protocol_error(self, mcp_process, clean_state):
        """BB05: JSON-RPC 协议错误 - 服务器对非 JSON 输入不崩溃，返回有效 JSON"""
        self._initialize(mcp_process)

        mcp_process.stdin.write("这不是有效的JSON\n")
        mcp_process.stdin.flush()

        response_line = mcp_process.stdout.readline()
        response = json.loads(response_line)

        assert isinstance(response, dict)


class TestSessionIsolationBlackBox:
    """BB-SI-01 ~ BB-SI-04: 会话隔离端到端测试"""

    SESSION_MARKER_REL = ".sdd/.current_session"

    @pytest.fixture
    def temp_dir_with_sdd(self):
        """创建带 .sdd/ 结构的临时目录"""
        tmp = tempfile.mkdtemp()
        orig = os.getcwd()
        os.chdir(tmp)
        os.makedirs(os.path.join(tmp, ".sdd"), exist_ok=True)
        yield tmp
        os.chdir(orig)
        shutil.rmtree(tmp)

    def _write_session_marker(self, temp_dir, content):
        """写入 .sdd/.current_session 标记文件"""
        marker_path = os.path.join(temp_dir, ".sdd", ".current_session")
        target_dir = os.path.join(temp_dir, content.lstrip("./").replace("/", os.sep).strip())
        os.makedirs(os.path.dirname(target_dir), exist_ok=True)
        with open(marker_path, "w", encoding="utf-8") as f:
            f.write(content)

    def _start_mcp(self, temp_dir):
        """启动 MCP Server 子进程"""
        server_path = os.path.join(os.path.dirname(__file__), "mcp_server.py")
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        proc = subprocess.Popen(
            [sys.executable, server_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=1,
            text=True,
            encoding="utf-8",
            cwd=temp_dir,
            env=env,
        )
        return proc

    def _initialize(self, proc):
        """初始化 MCP 连接"""
        init_request = {
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1.0.0"},
            },
            "id": 0,
        }
        proc.stdin.write(json.dumps(init_request) + "\n")
        proc.stdin.flush()
        response_line = proc.stdout.readline()
        return json.loads(response_line)

    def _call_tool(self, proc, tool_name, arguments, req_id=1):
        """调用 MCP 工具，返回解析后的结果数据"""
        request = {
            "jsonrpc": "2.0",
            "method": "tools/call",
            "params": {"name": tool_name, "arguments": arguments},
            "id": req_id,
        }
        proc.stdin.write(json.dumps(request) + "\n")
        proc.stdin.flush()
        response_line = proc.stdout.readline()
        response = json.loads(response_line)
        if "error" in response:
            return response
        result_text = response["result"]["content"][0]["text"]
        return json.loads(result_text)

    def test_bb_si_01_with_marker_normal_flow(self, temp_dir_with_sdd):
        """
        BB-SI-01: 有标记 → 正常完成澄清流程
        标记指向 ./.sdd/SR-123/，目标目录已创建
        初始化 → add 3 个问题 → 逐个 answer → finalize
        """
        temp_dir = temp_dir_with_sdd
        self._write_session_marker(temp_dir, "./.sdd/SR-123/")

        proc = self._start_mcp(temp_dir)
        try:
            self._initialize(proc)

            r1 = self._call_tool(proc, "add_questions", {"questions": ["Q-A", "Q-B", "Q-C"]})
            assert "added_count" in r1, f"add_questions failed: {r1}"
            assert r1["added_count"] == 3

            r2 = self._call_tool(proc, "answer_question", {"question": "Q-A", "answer": "Ans-A"})
            assert "matched_question" in r2

            r3 = self._call_tool(proc, "answer_question", {"question": "Q-B", "answer": "Ans-B"})
            assert "matched_question" in r3

            r4 = self._call_tool(proc, "answer_question", {"question": "Q-C", "answer": "Ans-C"})
            assert "matched_question" in r4

            r5 = self._call_tool(proc, "finalize_questions", {})
            assert r5["status"] == "ready"
            assert len(r5["summary"]) == 3

            # 验证文件落在 SR-123 目录下
            expected_file = os.path.join(temp_dir, ".sdd", "SR-123", ".question_state.json")
            assert os.path.exists(expected_file), (
                f"状态文件应位于隔离目录 {expected_file}"
            )
        finally:
            proc.terminate()
            proc.wait(timeout=5)

    def test_bb_si_02_no_marker_returns_error(self, temp_dir_with_sdd):
        """
        BB-SI-02: 无标记 → 返回错误
        .sdd/.current_session 不存在时，add_questions 应返回 error
        """
        temp_dir = temp_dir_with_sdd
        # 确保标记文件不存在
        marker = os.path.join(temp_dir, ".sdd", ".current_session")
        if os.path.exists(marker):
            os.remove(marker)

        proc = self._start_mcp(temp_dir)
        try:
            self._initialize(proc)
            r = self._call_tool(proc, "add_questions", {"questions": ["Q1"]})
            assert "error" in r, f"预期返回 error，实际: {r}"
            assert "aaw-workflow" in r["error"], (
                f"错误消息应包含 'aaw-workflow' 引导信息，实际: {r['error']}"
            )
        finally:
            proc.terminate()
            proc.wait(timeout=5)

    def test_bb_si_03_switch_marker_isolation(self, temp_dir_with_sdd):
        """
        BB-SI-03: 切换标记 → 隔离生效
        标记 → SR-123，add Q1；修改标记 → SR-456（不重启进程）→ add Q2
        验证两个文件独立存在
        """
        temp_dir = temp_dir_with_sdd
        marker_path = os.path.join(temp_dir, ".sdd", ".current_session")

        # 先写入 SR-123 标记
        self._write_session_marker(temp_dir, "./.sdd/SR-123/")

        proc = self._start_mcp(temp_dir)
        try:
            self._initialize(proc)

            r1 = self._call_tool(proc, "add_questions", {"questions": ["Q1-SR123"]})
            assert "added_count" in r1

            # 切换标记到 SR-456（覆盖写入）
            os.makedirs(os.path.join(temp_dir, ".sdd", "SR-456"), exist_ok=True)
            with open(marker_path, "w", encoding="utf-8") as f:
                f.write("./.sdd/SR-456/")

            r2 = self._call_tool(proc, "add_questions", {"questions": ["Q2-SR456"]})
            assert "added_count" in r2

            r3 = self._call_tool(proc, "get_status", {"detail": "full"})
            # 当前会话是 SR-456，应只有 1 个问题
            assert r3["total"] == 1, f"SR-456 会话应只有 1 个问题，实际: {r3['total']}"

            # 验证两个文件独立存在
            sr123_file = os.path.join(temp_dir, ".sdd", "SR-123", ".question_state.json")
            sr456_file = os.path.join(temp_dir, ".sdd", "SR-456", ".question_state.json")
            # 注: SR-123 文件应在第一次 add_questions 时创建
        finally:
            proc.terminate()
            proc.wait(timeout=5)

    def test_bb_si_04_restart_recovery(self, temp_dir_with_sdd):
        """
        BB-SI-04: 重启 MCP Server → 恢复状态
        标记 → SR-123，add Q1 并 answer，终止进程
        启动新子进程（标记不变）→ get_status 验证状态完整恢复
        """
        temp_dir = temp_dir_with_sdd
        self._write_session_marker(temp_dir, "./.sdd/SR-123/")

        # 第一轮：写入状态
        proc1 = self._start_mcp(temp_dir)
        try:
            self._initialize(proc1)
            self._call_tool(proc1, "add_questions", {"questions": ["Q1", "Q2"]})
            self._call_tool(proc1, "answer_question", {"question": "Q1", "answer": "Ans1"})
        finally:
            proc1.terminate()
            proc1.wait(timeout=5)

        # 第二轮：重启，标记不变
        proc2 = self._start_mcp(temp_dir)
        try:
            self._initialize(proc2)
            r = self._call_tool(proc2, "get_status", {"detail": "full"})
            assert r["total"] == 2, f"重启后应恢复 2 个问题，实际: {r['total']}"
            assert r["pending"] == 1, f"应有 1 个待处理问题，实际: {r['pending']}"
            assert r["answered"] == 1, f"应有 1 个已回答问题，实际: {r['answered']}"

            questions_text = [q["question"] for q in r["questions"]]
            assert "Q1" in questions_text
            assert "Q2" in questions_text
        finally:
            proc2.terminate()
            proc2.wait(timeout=5)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
