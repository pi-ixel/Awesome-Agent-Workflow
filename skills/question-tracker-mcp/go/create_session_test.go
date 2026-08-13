package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ============================================================
// create_session 独立建池 + 选池指引（select_session guidance）
//
// 设计变更（2026-08 用户决策）：
//   - 新建问题池是独立动作 create_session，add_questions 不再隐式建池
//     （池名打错一个字就静默建孤儿池的隐患随之消除）；
//   - 未传池名 / 池名不存在 → 不报错，返回 action_required=select_session
//     指引：列出可用池，提示 AI 无法确定时向用户确认选择或新建。
// ============================================================

// writeEmptyPool 直接在文件系统放一个空池（不经过被测行为，红绿两态通用）。
func writeEmptyPool(t *testing.T, session string) string {
	t.Helper()
	stateFile, err := resolveStateFilePath(session, "")
	if err != nil {
		t.Fatalf("resolve state file: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(stateFile), 0755); err != nil {
		t.Fatalf("mkdir pool: %v", err)
	}
	if err := os.WriteFile(stateFile, []byte(`{"questions":[],"next_id":1}`), 0644); err != nil {
		t.Fatalf("write pool: %v", err)
	}
	return stateFile
}

// assertSelectGuidance 断言 select_session 指引的统一形态。
func assertSelectGuidance(t *testing.T, r map[string]interface{}, reason, requested string) {
	t.Helper()
	if e, ok := r["error"]; ok && e != nil && e != "" {
		t.Errorf("选池指引不得携带 error 字段（否则宿主渲染为失败），got: %v", e)
	}
	if r["action_required"] != "select_session" {
		t.Errorf("expected action_required=select_session, got: %v", r["action_required"])
	}
	if r["reason"] != reason {
		t.Errorf("expected reason=%q, got: %v", reason, r["reason"])
	}
	if requested != "" && r["requested_session"] != requested {
		t.Errorf("expected requested_session=%q, got: %v", requested, r["requested_session"])
	}
	if _, ok := r["available_sessions"]; !ok {
		t.Error("available_sessions 必须存在（哪怕是空列表）")
	}
	g, _ := r["guidance"].(string)
	if !strings.Contains(g, "用户") || !strings.Contains(g, "create_session") {
		t.Errorf("guidance 必须提示“向用户确认”与 create_session，got: %q", g)
	}
}

func guidanceListsPool(r map[string]interface{}, name string) bool {
	avail, _ := r["available_sessions"].([]interface{})
	for _, s := range avail {
		if s == name {
			return true
		}
	}
	return false
}

// ---------- create_session 五分支 ----------

func TestCreateSession_CreatesEmptyPool(t *testing.T) {
	origCwd := isolateDispatchEnv(t)
	defer os.Chdir(origCwd)

	r := createSessionTool("s1", "")
	if r["error"] != nil {
		t.Fatalf("create failed: %v", r["error"])
	}
	if r["created"] != true {
		t.Errorf("expected created=true, got %v", r["created"])
	}
	loc, _ := r["pool_location"].(string)
	data, err := os.ReadFile(loc)
	if err != nil {
		t.Fatalf("state.json should exist at pool_location: %v", err)
	}
	var state map[string]interface{}
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatalf("state.json should be valid JSON: %v", err)
	}
	if qs, _ := state["questions"].([]interface{}); len(qs) != 0 {
		t.Errorf("new pool should be empty, got %v", state["questions"])
	}
}

func TestCreateSession_IdempotentWhenExists(t *testing.T) {
	origCwd := isolateDispatchEnv(t)
	defer os.Chdir(origCwd)

	r1 := createSessionTool("s1", "")
	if r1["created"] != true {
		t.Fatalf("first create should succeed: %v", r1)
	}

	// 已有内容时再调 create_session：幂等、不报错、内容不丢
	if r := addQuestionsTool([]string{"问题？"}, "s1", ""); r["error"] != nil {
		t.Fatalf("seed add: %v", r["error"])
	}
	r2 := createSessionTool("s1", "")
	if r2["error"] != nil {
		t.Errorf("existing pool must not error, got %v", r2["error"])
	}
	if r2["created"] != false {
		t.Errorf("expected created=false, got %v", r2["created"])
	}
	if r2["note"] == nil || r2["note"] == "" {
		t.Error("existing pool should come with a note（如：池已存在，直接续用）")
	}
	st := getStatusTool("summary", "s1", "")
	if v, ok := getIntFromResult(st, "total"); !ok || v != 1 {
		t.Errorf("existing content must be preserved, got total=%v", st["total"])
	}
}

func TestCreateSession_EmptySessionReturnsGuidance(t *testing.T) {
	origCwd := isolateDispatchEnv(t)
	defer os.Chdir(origCwd)

	r := createSessionTool("", "")
	assertSelectGuidance(t, r, "missing_session", "")
}

func TestCreateSession_InvalidNameStillErrors(t *testing.T) {
	origCwd := isolateDispatchEnv(t)
	defer os.Chdir(origCwd)

	// 非法名是参数错误，不是选池场景——维持报错
	r := createSessionTool("bad:name", "")
	if r["error"] == nil || r["error"] == "" {
		t.Errorf("invalid name should error, got %v", r)
	}
	if r["action_required"] != nil {
		t.Errorf("invalid name should NOT produce select guidance, got %v", r["action_required"])
	}
}

// ---------- add_questions 不再隐式建池 ----------

func TestAddQuestions_NoAutoCreateOnMissingPool(t *testing.T) {
	origCwd := isolateDispatchEnv(t)
	defer os.Chdir(origCwd)

	r := addQuestionsTool([]string{"手滑的问题？"}, "ghost-pool", "")
	assertSelectGuidance(t, r, "session_not_found", "ghost-pool")

	// 核心防回归：池目录不得被静默创建
	stateFile, err := resolveStateFilePath("ghost-pool", "")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if _, err := os.Stat(stateFile); !os.IsNotExist(err) {
		t.Error("add_questions 不得在池不存在时静默建池")
	}
}

func TestAddQuestions_WorksAfterExplicitCreate(t *testing.T) {
	origCwd := isolateDispatchEnv(t)
	defer os.Chdir(origCwd)

	if r := createSessionTool("s1", ""); r["created"] != true {
		t.Fatalf("create: %v", r)
	}
	r := addQuestionsTool([]string{"问题？"}, "s1", "")
	if r["error"] != nil {
		t.Fatalf("add after create should succeed: %v", r["error"])
	}
	if v, ok := r["added_count"].(int); !ok || v != 1 {
		t.Errorf("expected added_count=1, got %v", r["added_count"])
	}
}

// ---------- 选池指引：所有 session 工具统一形态 ----------

func TestSessionNotFound_GuidanceAllSessionTools(t *testing.T) {
	origCwd := isolateDispatchEnv(t)
	defer os.Chdir(origCwd)

	writeEmptyPool(t, "alpha-pool")

	toolArgs := map[string]map[string]interface{}{
		"add_questions":      {"questions": []interface{}{"q？"}},
		"answer_question":    {"question": "q？", "answer": "a"},
		"get_status":         {},
		"finalize_questions": {},
		"update_answer":      {"question": "q？", "answer": "a2"},
		"reset_questions":    {},
		"reopen_session":     {},
		"delete_session":     {"confirm": true},
		// 注意：create_session 不在此列——对不存在的名字，建池本身就是它的职责；
		// 其空 session 指引由 TestCreateSession_EmptySessionReturnsGuidance 覆盖。
	}
	for tool, args := range toolArgs {
		args["session"] = "ghost-pool"
		r, isErr := dispatchTool(tool, args)
		if isErr {
			t.Errorf("%s: 选池指引不得标记 isError", tool)
		}
		assertSelectGuidance(t, r, "session_not_found", "ghost-pool")
		if !guidanceListsPool(r, "alpha-pool") {
			t.Errorf("%s: guidance should list alpha-pool, got %v", tool, r["available_sessions"])
		}
	}
}

func TestMissingSession_GuidanceShape(t *testing.T) {
	origCwd := isolateDispatchEnv(t)
	defer os.Chdir(origCwd)

	writeEmptyPool(t, "alpha-pool")

	for _, tool := range []string{"get_status", "add_questions", "finalize_questions"} {
		args := map[string]interface{}{}
		if tool == "add_questions" {
			args["questions"] = []interface{}{"q？"}
		}
		r, isErr := dispatchTool(tool, args)
		if isErr {
			t.Errorf("%s: missing-session 指引不得标记 isError", tool)
		}
		assertSelectGuidance(t, r, "missing_session", "")
		if !guidanceListsPool(r, "alpha-pool") {
			t.Errorf("%s: guidance should list alpha-pool, got %v", tool, r["available_sessions"])
		}
	}
}

func TestGuidance_ListsArchivedPools(t *testing.T) {
	origCwd := isolateDispatchEnv(t)
	defer os.Chdir(origCwd)

	// 一个已归档的池（含 1 个已答问题 → finalize 归档）
	writePoolWithOneAnsweredQuestion(t, "beta-pool")
	if r := finalizeQuestionsTool("beta-pool", ""); r["status"] != "ready" {
		t.Fatalf("finalize: %v", r)
	}

	r := getStatusTool("summary", "ghost-pool", "")
	assertSelectGuidance(t, r, "session_not_found", "ghost-pool")
	arch, _ := r["archived_sessions"].([]interface{})
	found := false
	for _, s := range arch {
		if name, _ := s.(string); strings.HasPrefix(name, "beta-pool-") {
			found = true
		}
	}
	if !found {
		t.Errorf("archived_sessions 应列出 beta-pool 的归档（提示可 reopen），got %v", r["archived_sessions"])
	}
	if g, _ := r["guidance"].(string); !strings.Contains(g, "reopen_session") {
		t.Errorf("有归档池时 guidance 应提示 reopen_session，got %q", g)
	}
}

// writePoolWithOneAnsweredQuestion 直接落盘一个含已答问题的池。
func writePoolWithOneAnsweredQuestion(t *testing.T, session string) {
	t.Helper()
	stateFile, err := resolveStateFilePath(session, "")
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if err := os.MkdirAll(filepath.Dir(stateFile), 0755); err != nil {
		t.Fatal(err)
	}
	body := `{"questions":[{"id":1,"question":"q？","status":"answered","answer":"a","source":"user"}],"next_id":2}`
	if err := os.WriteFile(stateFile, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
}
