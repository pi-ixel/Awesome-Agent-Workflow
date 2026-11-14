"""Deterministic ACP peer for the migration probe; no model or workspace writes."""
import json
import sys
import uuid

sys.stdin.reconfigure(encoding="utf-8")
sys.stdout.reconfigure(encoding="utf-8")
session_id = str(uuid.uuid4())
pending = None
review_count = 0

def send(message):
    print(json.dumps(message, ensure_ascii=False), flush=True)

def finish(request_id, text):
    send({"jsonrpc": "2.0", "method": "session/update", "params": {"sessionId": session_id,
        "update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}})
    send({"jsonrpc": "2.0", "id": request_id, "result": {"stopReason": "end_turn"}})

for raw in sys.stdin:
    msg = json.loads(raw)
    method, request_id = msg.get("method"), msg.get("id")
    if method == "initialize":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"protocolVersion": 1, "agentInfo": {"name": "controlled-acp"}, "agentCapabilities": {}}})
    elif method == "session/new":
        send({"jsonrpc": "2.0", "id": request_id, "result": {"sessionId": session_id}})
    elif method == "session/load":
        session_id = msg["params"]["sessionId"]
        send({"jsonrpc": "2.0", "id": request_id, "result": {}})
    elif method == "_session/switch_agent":
        if msg["params"].get("sessionId") != session_id:
            send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": "sessionId required"}})
        else:
            send({"jsonrpc": "2.0", "id": request_id, "result": {"toProfile": msg["params"]["agentProfile"]}})
    elif method == "session/prompt":
        text = msg["params"]["prompt"][0]["text"]
        if "PROBE_DESIGN" in text:
            pending = request_id
            send({"jsonrpc": "2.0", "id": "question-1", "method": "_chrys/request_input", "params": {
                "sessionId": session_id, "requestId": "q-1", "questions": [{"question": "测试选项？", "header": "测试", "options": [{"label": "继续", "description": "测试答案"}], "multiSelect": False}]}})
        elif "PROBE_REVIEW" in text:
            review_count += 1
            finish(request_id, json.dumps({"decision": "revise" if review_count == 1 else "pass", "round": review_count}))
        elif "PROBE_REPAIR" in text:
            finish(request_id, "修订设计：补充边界条件")
        elif "PROBE_TYPED_OK" in text:
            finish(request_id, '{"value":42}')
        elif "PROBE_TYPED_BAD" in text:
            finish(request_id, '{"value":"incorrect"}')
        else:
            finish(request_id, "未识别的测试指令")
    elif request_id == "question-1":
        response = msg.get("result", {})
        finish(pending, "设计候选：" + ("已收到测试答案" if not response.get("cancelled") else "提问已取消"))
    elif method == "session/close":
        send({"jsonrpc": "2.0", "id": request_id, "result": {}})
        break
