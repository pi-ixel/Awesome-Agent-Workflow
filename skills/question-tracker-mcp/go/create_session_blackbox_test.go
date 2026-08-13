package main_test

import (
	"os"
	"strings"
	"testing"
)

// ============================================================
// create_session + 选池指引 黑盒测试（真实 exe 子进程 + stdio）
// ============================================================

// TestBB_ToolsListHasCreateSession：tools/list 必须暴露 create_session。
func TestBB_ToolsListHasCreateSession(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	resp := client.callRaw(map[string]interface{}{
		"method": "tools/list",
		"params": map[string]interface{}{},
	})
	result, _ := resp["result"].(map[string]interface{})
	tools, _ := result["tools"].([]interface{})
	found := false
	for _, tool := range tools {
		if m, ok := tool.(map[string]interface{}); ok && m["name"] == "create_session" {
			found = true
		}
	}
	if !found {
		t.Errorf("tools/list should expose create_session, got %d tools", len(tools))
	}
}

// TestBB_SelectCreateAddFlow 完整链路：
// 无 session 调用 → 选池指引（非错误）→ create_session 建池 → add 成功 →
// 错名 get_status → 指引列出刚建的池。
func TestBB_SelectCreateAddFlow(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	// 1. 未传 session → 指引，且不得是 isError
	r1, isErr1 := client.callTool("add_questions", map[string]interface{}{
		"questions": []interface{}{"q？"},
	})
	if isErr1 {
		t.Fatalf("missing-session guidance must not be isError, got %v", r1)
	}
	if r1["action_required"] != "select_session" || r1["reason"] != "missing_session" {
		t.Fatalf("expected missing_session guidance, got %v", r1)
	}

	// 2. 显式建池
	r2, isErr2 := client.callTool("create_session", map[string]interface{}{
		"session": "bb-pool",
	})
	if isErr2 || r2["created"] != true {
		t.Fatalf("create_session failed: %v (isErr=%v)", r2, isErr2)
	}

	// 3. 建池后 add 成功
	r3, isErr3 := client.callTool("add_questions", map[string]interface{}{
		"session":   "bb-pool",
		"questions": []interface{}{"q？"},
	})
	if isErr3 || r3["error"] != nil {
		t.Fatalf("add after create failed: %v", r3)
	}

	// 4. 错名 get_status → 指引列出 bb-pool
	r4, isErr4 := client.callTool("get_status", map[string]interface{}{
		"session": "ghost-pool",
	})
	if isErr4 {
		t.Fatalf("not-found guidance must not be isError, got %v", r4)
	}
	if r4["action_required"] != "select_session" || r4["reason"] != "session_not_found" {
		t.Fatalf("expected session_not_found guidance, got %v", r4)
	}
	avail, _ := r4["available_sessions"].([]interface{})
	found := false
	for _, s := range avail {
		if s == "bb-pool" {
			found = true
		}
	}
	if !found {
		t.Errorf("guidance should list bb-pool, got %v", r4["available_sessions"])
	}
}

// TestBB_AddOnMissingPoolNoSilentCreate：整机层面确认 add 不再隐式建池。
func TestBB_AddOnMissingPoolNoSilentCreate(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	r, isErr := client.callTool("add_questions", map[string]interface{}{
		"session":   "typo-pool",
		"questions": []interface{}{"q？"},
	})
	if isErr {
		t.Fatalf("guidance must not be isError, got %v", r)
	}
	if r["action_required"] != "select_session" {
		t.Fatalf("expected select_session guidance, got %v", r)
	}
	if stateFile := poolStateFile(t, poolRoot, "typo-pool"); stateFile != "" {
		t.Errorf("typo-pool must NOT be silently created, found %s", stateFile)
	}

	// 指引里应包含 create_session 提示
	g, _ := r["guidance"].(string)
	if !strings.Contains(g, "create_session") {
		t.Errorf("guidance should mention create_session, got %q", g)
	}
}
