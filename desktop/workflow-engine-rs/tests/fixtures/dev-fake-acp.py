"""Controlled ACP peer for workflow wiring; never modifies a workspace."""
import json
import sys
import uuid
import subprocess
import os
import urllib.request
import time

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
session = str(uuid.uuid4())
mode = sys.argv[1] if len(sys.argv) > 1 else "pass"
mcp = None
mcp_http = None

def mcp_request(method, params=None):
    if mcp_http is not None:
        data = json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params or {}}).encode("utf-8")
        headers = {"Content-Type":"application/json", "Accept":"application/json, text/event-stream"}
        headers.update({h["name"]:h["value"] for h in mcp_http["headers"]})
        # 直连：本假 Agent 只用于验证引擎侧 HTTP 通道，不模拟某个 Agent 的代理行为。
        direct = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with direct.open(urllib.request.Request(mcp_http["url"], data=data, headers=headers), timeout=5) as response:
            return json.load(response)
    mcp.stdin.write(json.dumps({"jsonrpc":"2.0","id":1,"method":method,"params":params or {}}) + "\n")
    mcp.stdin.flush()
    return json.loads(mcp.stdout.readline())

def connect_mcp(request):
    global mcp, mcp_http
    servers = request.get("params", {}).get("mcpServers", [])
    server = next((s for s in servers if s.get("name") == "aaw-workflow-result"), None)
    # AAW_FAKE_IGNORE_MCP=1：模拟「MCP 挂载静默失败」的 Agent——从不连结果
    # 通道，手里没有 submit_workflow_result，结果只能当文本输出。
    if server is None or os.environ.get("AAW_FAKE_IGNORE_MCP") == "1":
        return
    if server.get("type") == "http":
        mcp_http = server
    else:
        # 标准 ACP McpServerStdio：env（name/value 列表）必须带进子进程——
        # 结果通道的桥接令牌就在这里（AAW_RESULT_TOKEN，不走命令行）。
        env = {**os.environ, **{item["name"]: item["value"] for item in server.get("env", [])}}
        mcp = subprocess.Popen([server["command"], *server.get("args", [])], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, encoding="utf-8", env=env)
    assert "result" in mcp_request("initialize", {"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"fake-acp","version":"1"}})
    # 按名字找 submit 工具：它排在列表末尾（schema 因节点而异，静态工具在前）。
    tools = mcp_request("tools/list")["result"]["tools"]
    assert any(tool["name"] == "submit_workflow_result" for tool in tools)

def submit_result(result):
    if mcp is None and mcp_http is None:
        return False
    response = mcp_request("tools/call", {"name":"submit_workflow_result","arguments":{"result":result}})
    assert not response["result"].get("isError", False), response
    return True

def send(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

for line in sys.stdin:
    request = json.loads(line)
    method, request_id = request.get("method"), request.get("id")
    if method == "initialize":
        send({"jsonrpc":"2.0", "id":request_id, "result":{"protocolVersion":1, "agentInfo":{"name":"workflow-test"}, "agentCapabilities":{"mcpCapabilities":{"http":os.environ.get("AAW_FAKE_HTTP_MCP") == "1"}}}})
    elif method == "session/new":
        connect_mcp(request)
        send({"jsonrpc":"2.0", "id":request_id, "result":{"sessionId":session}})
    elif method == "session/load":
        connect_mcp(request)
        session = request["params"]["sessionId"]
        send({"jsonrpc":"2.0", "id":request_id, "result":{}})
    elif method == "session/prompt":
        text = request["params"]["prompt"][0]["text"]
        if mode == "enterprise":
            if "结合 SR 设计和用户意见决定拆分" in text:
                result = {"status":"ready", "confirmed":True, "mode":"split", "ars":[{"id":"AR1", "title":"fixture"}], "evidence":"test confirmation"}
            elif "确认用户提供的 AR 内容" in text:
                result = {"status":"ready", "confirmed":True, "mode":"split", "ars":[{"id":"AR1", "title":"fixture"}], "evidence":"test confirmation"}
            elif "设计当前 AR 的模块边界" in text:
                result = {"status":"ready", "reference":"boundary", "confirmed":True, "groups":[{"id":"M1", "title":"fixture"}], "evidence":"test confirmation"}
            elif "依据当前 AR 范围澄清" in text:
                result = {"status":"ready", "reference":"ar", "confirmed":True, "evidence":"test confirmation"}
            elif "代码检查" in text:
                result = {"decision":"pass", "safe":False, "method":"fixture lint", "evidence":"fixture scan report", "issues":[]}
            elif "规划有序任务" in text:
                result = {"status":"ready", "confirmed":True, "plan":"plan", "tests":"tests", "tasks":[{"id":"T1", "goal":"goal", "scope":"scope", "tests":"test"}], "evidence":"test confirmation"}
            elif "独立检查整体设计" in text or "独立检查当前模块设计" in text:
                result = {"decision":"pass", "issues":"", "report":"checked", "safe":False}
            elif "只读独立评审当前任务" in text:
                result = {"decision":"pass", "report":"reviewed"}
            elif "核对当前任务实际证据" in text:
                result = {"status":"ready", "plan":"plan", "tests":"tests", "done":True, "nextTaskId":"", "evidence":"done"}
            else:
                result = {"status":"ready", "reference":"fixture", "evidence":"fixture"}
            delivered = submit_result(result)
            send({"jsonrpc":"2.0", "method":"session/update", "params":{"sessionId":session, "update":{"sessionUpdate":"agent_message_chunk", "content":{"type":"text", "text":"已完成本次工作。" if delivered else json.dumps(result, ensure_ascii=False)}}}})
            send({"jsonrpc":"2.0", "id":request_id, "result":{"stopReason":"end_turn"}})
            continue
        if os.environ.get("AAW_FAKE_WAIT_FOR_USER") == "1" and "确认需求及边界" in text:
            send({"jsonrpc":"2.0", "method":"session/update", "params":{"sessionId":session, "update":{"sessionUpdate":"agent_message_chunk", "content":{"type":"text", "text":"请确认选择 A 还是 B？"}}}})
            send({"jsonrpc":"2.0", "id":request_id, "result":{"stopReason":"end_turn"}})
            continue
        if "用户针对上次阻塞给出的答复" in text:
            result = {"status":"ready", "evidence":"user decision received", "needA":False, "needB":False}
        elif "依据两份独立报告处置发现" in text and os.environ.get("AAW_FAKE_BLOCK_RESOLUTION") == "1":
            result = {"status":"blocked", "evidence":"user decision needed", "needA":False, "needB":False}
        elif "代码检查" in text:
            result = {"decision":"pass", "safe":False, "method":"fixture lint", "evidence":"fixture scan report", "issues":[]}
        elif "规划有序任务" in text:
            result = {"status":"ready", "plan":"plan-v1", "tests":"tests-v1", "tasks":[{"id":"one", "goal":"goal", "scope":"scope", "tests":"test"}], "evidence":"plan evidence"}
        elif "独立只读检查" in text or "只读检查需求" in text or "重新只读检查" in text:
            is_gate = "检查需求" in text or "整改后的设计和测试设计版本" in text
            result = {"decision":"revise" if mode == "gate-revise" and is_gate else "pass", "issues":"evidence", "report":"report", "safe":True}
        elif "只读独立评审" in text:
            result = {"decision":"findings" if os.environ.get("AAW_FAKE_BLOCK_RESOLUTION") == "1" else "pass", "report":"review evidence"}
        elif "核对当前任务实际证据" in text:
            result = {"status":"ready", "plan":"plan-v2", "tests":"tests-v2", "done":True, "nextTaskId":"", "evidence":"delivery evidence"}
        elif "仅整改门禁" in text:
            result = {"status":"ready", "design":"design-v2", "tests":"tests-v2", "evidence":"repair evidence"}
        else:
            result = {"status":"ready", "reference":"test-ref", "evidence":"test evidence"}
        delivered = submit_result(result)
        send({"jsonrpc":"2.0", "method":"session/update", "params":{"sessionId":session, "update":{"sessionUpdate":"agent_message_chunk", "content":{"type":"text", "text":"已完成本次工作。" if delivered else json.dumps(result, ensure_ascii=False)}}}})
        if os.environ.get("AAW_FAKE_BLOCK_AFTER_SUBMIT") == "1":
            time.sleep(60)
        send({"jsonrpc":"2.0", "id":request_id, "result":{"stopReason":"cancelled" if mode == "cancel-after-submit" else "end_turn"}})
    elif method == "session/close":
        send({"jsonrpc":"2.0", "id":request_id, "result":{}})
        break
