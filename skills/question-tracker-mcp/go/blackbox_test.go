package main_test

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ============================================================
// Global: path to the built MCP server binary
// ============================================================

var binaryPath string

func TestMain(m *testing.M) {
	exeName := "mcp_server_test.exe"
	buildCmd := exec.Command("go", "build", "-o", exeName, ".")
	buildCmd.Dir = "."
	if out, err := buildCmd.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "failed to build binary: %v\n%s\n", err, string(out))
		os.Exit(1)
	}

	absPath, err := filepath.Abs(exeName)
	if err != nil {
		fmt.Fprintf(os.Stderr, "failed to get absolute path: %v\n", err)
		os.Exit(1)
	}
	binaryPath = absPath

	code := m.Run()

	os.Remove(exeName)
	os.Exit(code)
}

// ============================================================
// Blackbox Test Helpers
// ============================================================

// bbSetup creates an isolated env: QUESTION_TRACKER_HOME in temp dir,
// chdir into a temp project workdir. Returns (origCwd, poolRoot, workDir).
func bbSetup(t *testing.T) (string, string, string) {
	t.Helper()
	origCwd, _ := os.Getwd()
	poolRoot := t.TempDir()
	workDir := t.TempDir()
	os.Chdir(workDir)
	return origCwd, poolRoot, workDir
}

// poolStateFile locates the state.json for a session under poolRoot
// via directory walk (the project slug is CWD-derived in tests).
func poolStateFile(t *testing.T, poolRoot, session string) string {
	t.Helper()
	var found string
	filepath.Walk(poolRoot, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && info.Name() == "state.json" {
			if strings.Contains(filepath.ToSlash(path), "/"+session+"/state.json") {
				found = path
			}
		}
		return nil
	})
	return found
}

// poolArchiveDirs lists .archive subdirectories for a session under poolRoot.
func poolArchiveDirs(t *testing.T, poolRoot, session string) []string {
	t.Helper()
	var found []string
	filepath.Walk(poolRoot, func(path string, info os.FileInfo, err error) error {
		if err == nil && info.IsDir() && info.Name() == ".archive" {
			entries, _ := os.ReadDir(path)
			for _, e := range entries {
				if strings.HasPrefix(e.Name(), session+"-") {
					found = append(found, filepath.Join(path, e.Name()))
				}
			}
		}
		return nil
	})
	return found
}

// mcpClient wraps the MCP subprocess communication.
type mcpClient struct {
	cmd    *exec.Cmd
	stdin  *bufio.Writer
	stdout *bufio.Scanner
	t      *testing.T
	nextID int
}

// newMCPClient starts the MCP server with the given env and returns a client.
func newMCPClient(t *testing.T, workDir, poolRoot string) *mcpClient {
	t.Helper()

	cmd := exec.Command(binaryPath)
	cmd.Dir = workDir
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(), "QUESTION_TRACKER_HOME="+poolRoot)

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("stdin pipe: %v", err)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}

	if err := cmd.Start(); err != nil {
		t.Fatalf("start: %v", err)
	}

	t.Cleanup(func() {
		if cmd.Process != nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
	})

	return &mcpClient{
		cmd:    cmd,
		stdin:  bufio.NewWriter(stdinPipe),
		stdout: bufio.NewScanner(stdoutPipe),
		t:      t,
		nextID: 0,
	}
}

// initialize performs the MCP initialize handshake with a specific version.
// Empty string means the protocolVersion field is omitted.
func (c *mcpClient) initializeWithVersion(version string) map[string]interface{} {
	c.t.Helper()
	c.nextID++
	params := map[string]interface{}{
		"capabilities": map[string]interface{}{},
		"clientInfo": map[string]interface{}{
			"name":    "test",
			"version": "1.0.0",
		},
	}
	if version != "" {
		params["protocolVersion"] = version
	}
	req := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "initialize",
		"params":  params,
		"id":      c.nextID,
	}
	return c.sendRequest(req)
}

// initialize performs the default handshake.
func (c *mcpClient) initialize() {
	c.t.Helper()
	resp := c.initializeWithVersion("2024-11-05")
	if resp["error"] != nil {
		c.t.Fatalf("initialize failed: %v", resp["error"])
	}
}

// callTool sends a tools/call request and returns (tool result JSON, isError).
func (c *mcpClient) callTool(name string, args map[string]interface{}) (map[string]interface{}, bool) {
	c.t.Helper()

	c.nextID++
	req := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "tools/call",
		"params": map[string]interface{}{
			"name":      name,
			"arguments": args,
		},
		"id": c.nextID,
	}

	resp := c.sendRequest(req)

	if errData, ok := resp["error"]; ok {
		return map[string]interface{}{"error": fmt.Sprintf("%v", errData)}, true
	}

	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		return map[string]interface{}{"error": "no result in response"}, true
	}

	isError := false
	if v, ok := result["isError"].(bool); ok && v {
		isError = true
	}

	content, ok := result["content"].([]interface{})
	if !ok || len(content) == 0 {
		return map[string]interface{}{"error": "no content in result"}, isError
	}

	contentItem, ok := content[0].(map[string]interface{})
	if !ok {
		return map[string]interface{}{"error": "invalid content item"}, isError
	}

	text, ok := contentItem["text"].(string)
	if !ok {
		return map[string]interface{}{"error": "invalid text in content"}, isError
	}

	var toolResult map[string]interface{}
	if err := json.Unmarshal([]byte(text), &toolResult); err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("failed to parse tool result: %v", err)}, isError
	}

	return toolResult, isError
}

// callRaw sends a raw request and returns the raw response.
func (c *mcpClient) callRaw(req map[string]interface{}) map[string]interface{} {
	c.t.Helper()
	c.nextID++
	req["id"] = c.nextID
	if _, ok := req["jsonrpc"]; !ok {
		req["jsonrpc"] = "2.0"
	}
	return c.sendRequest(req)
}

// sendRawText writes a raw line and returns the parsed response.
func (c *mcpClient) sendRawText(text string) map[string]interface{} {
	c.t.Helper()
	c.stdin.Write([]byte(text + "\n"))
	c.stdin.Flush()
	if !c.stdout.Scan() {
		c.t.Fatal("no response from server")
	}
	line := c.stdout.Text()
	var resp map[string]interface{}
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		c.t.Fatalf("unmarshal response: %v\nline: %s", err, line)
	}
	return resp
}

// sendRequest writes a JSON-RPC request and reads the response.
func (c *mcpClient) sendRequest(req map[string]interface{}) map[string]interface{} {
	c.t.Helper()

	data, err := json.Marshal(req)
	if err != nil {
		c.t.Fatalf("marshal request: %v", err)
	}

	_, err = c.stdin.Write(append(data, '\n'))
	if err != nil {
		c.t.Fatalf("write request: %v", err)
	}
	c.stdin.Flush()

	if !c.stdout.Scan() {
		c.t.Fatal("no response from server")
	}

	line := c.stdout.Text()
	var resp map[string]interface{}
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		c.t.Fatalf("unmarshal response: %v\nline: %s", err, line)
	}

	return resp
}

// close terminates the MCP server.
func (c *mcpClient) close() {
	c.t.Helper()
	if c.cmd.Process != nil {
		c.cmd.Process.Kill()
		c.cmd.Wait()
	}
}

// todayStr returns yyyyMMdd.
func todayStr() string {
	return time.Now().Format("20060102")
}

// getInt extracts an int from a JSON value.
func getInt(v interface{}) (int, bool) {
	switch val := v.(type) {
	case float64:
		return int(val), true
	case int:
		return val, true
	default:
		return 0, false
	}
}

// ============================================================
// BB-01: stdio complete flow
// ============================================================

func TestBB01_StdioCompleteFlow(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	client.callTool("create_session", map[string]interface{}{"session": "test-session"})
	r1, isErr1 := client.callTool("add_questions", map[string]interface{}{
		"session":   "test-session",
		"questions": []interface{}{"Q1"},
	})
	if isErr1 {
		t.Fatalf("add_questions failed: %v", r1)
	}
	if r1["pool_location"] == nil {
		t.Error("add_questions should return pool_location")
	}

	r2, isErr2 := client.callTool("answer_question", map[string]interface{}{
		"session":  "test-session",
		"question": "Q1",
		"answer":   "A1",
	})
	if isErr2 {
		t.Fatalf("answer_question failed: %v", r2)
	}
	if r2["pool_location"] == nil {
		t.Error("answer_question should return pool_location")
	}

	r3, _ := client.callTool("finalize_questions", map[string]interface{}{
		"session": "test-session",
	})
	if r3["status"] != "ready" {
		t.Errorf("expected ready, got %v", r3["status"])
	}
	if loc, _ := r3["pool_location"].(string); !strings.Contains(filepath.ToSlash(loc), ".archive") {
		t.Errorf("finalize ready pool_location should point into .archive, got: %v", r3["pool_location"])
	}
	archives := poolArchiveDirs(t, poolRoot, "test-session")
	if len(archives) != 1 {
		t.Errorf("expected 1 archived dir after finalize, got %d", len(archives))
	}
}

// ============================================================
// BB-02: error-tolerance self-heal (M05 path)
// ============================================================

func TestBB02_ErrorToleranceSelfHeal(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	client.callTool("create_session", map[string]interface{}{"session": "sr001-用户认证"})
	client.callTool("add_questions", map[string]interface{}{
		"session":   "sr001-用户认证",
		"questions": []interface{}{"Q1"},
	})

	r1, isErr1 := client.callTool("get_status", map[string]interface{}{
		"session": "sr001-支付",
	})
	if isErr1 {
		t.Fatal("pool-selection guidance must NOT be isError")
	}
	if r1["action_required"] != "select_session" || r1["reason"] != "session_not_found" {
		t.Fatalf("expected session_not_found guidance, got %v", r1)
	}
	avail, ok := r1["available_sessions"].([]interface{})
	if !ok {
		t.Fatalf("expected available_sessions in guidance: %v", r1)
	}
	found := false
	for _, s := range avail {
		if s.(string) == "sr001-用户认证" {
			found = true
		}
	}
	if !found {
		t.Fatalf("available_sessions should contain sr001-用户认证: %v", avail)
	}

	r2, isErr2 := client.callTool("get_status", map[string]interface{}{
		"session": "sr001-用户认证",
	})
	if isErr2 {
		t.Fatalf("second get_status should succeed: %v", r2)
	}
	if v, ok := getInt(r2["total"]); !ok || v != 1 {
		t.Errorf("expected total=1, got %v", r2["total"])
	}
}

// ============================================================
// BB-03: no .sdd directory (non-AAW scenario)
// ============================================================

func TestBB03_NoSddDirectory(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	// workDir has no .sdd by construction; full flow must work
	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	client.callTool("create_session", map[string]interface{}{"session": "test-session"})
	r, isErr := client.callTool("add_questions", map[string]interface{}{
		"session":   "test-session",
		"questions": []interface{}{"Q1"},
	})
	if isErr {
		t.Fatalf("add_questions failed without .sdd: %v", r)
	}

	r2, isErr2 := client.callTool("answer_question", map[string]interface{}{
		"session":  "test-session",
		"question": "Q1",
		"answer":   "A1",
	})
	if isErr2 {
		t.Fatalf("answer_question failed without .sdd: %v", r2)
	}

	r3, _ := client.callTool("get_status", map[string]interface{}{
		"session": "test-session",
	})
	if v, ok := getInt(r3["answered"]); !ok || v != 1 {
		t.Errorf("expected answered=1, got %v", r3["answered"])
	}
}

// ============================================================
// BB-04: tools/list schema
// ============================================================

func TestBB04_ToolsListSchema(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	resp := client.callRaw(map[string]interface{}{
		"method": "tools/list",
	})
	result, _ := resp["result"].(map[string]interface{})
	tools, _ := result["tools"].([]interface{})
	if len(tools) != 11 {
		t.Fatalf("expected 11 tools, got %d", len(tools))
	}

	requiredSessionTools := []string{
		"create_session", "add_questions", "answer_question", "get_status",
		"finalize_questions", "update_answer", "reset_questions",
	}
	for _, want := range requiredSessionTools {
		found := false
		for _, tool := range tools {
			m := tool.(map[string]interface{})
			if m["name"] == want {
				found = true
				schema, _ := m["inputSchema"].(map[string]interface{})
				required, _ := schema["required"].([]interface{})
				hasSession := false
				for _, r := range required {
					if r.(string) == "session" {
						hasSession = true
					}
				}
				if !hasSession {
					t.Errorf("tool %s should require session", want)
				}
			}
		}
		if !found {
			t.Errorf("tool %s not found in tools/list", want)
		}
	}

	// list_sessions must NOT require session
	for _, tool := range tools {
		m := tool.(map[string]interface{})
		if m["name"] == "list_sessions" {
			schema, _ := m["inputSchema"].(map[string]interface{})
			required, _ := schema["required"].([]interface{})
			for _, r := range required {
				if r.(string) == "session" {
					t.Error("list_sessions must NOT require session")
				}
			}
		}
	}
}

// ============================================================
// BB-05: business error isError=true
// ============================================================

func TestBB05_BusinessErrorIsErrorTrue(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	client.callTool("create_session", map[string]interface{}{"session": "test-session"})
	client.callTool("add_questions", map[string]interface{}{
		"session":   "test-session",
		"questions": []interface{}{"Q1"},
	})

	// 选池指引不是错误（isError=false）……
	r, isErr := client.callTool("get_status", map[string]interface{}{
		"session": "nonexistent",
	})
	if isErr {
		t.Fatal("pool-selection guidance must NOT be isError")
	}
	if r["available_sessions"] == nil {
		t.Error("text JSON should still contain available_sessions")
	}

	// ……但真正的业务错误（问题未匹配）必须 isError=true
	r2, isErr2 := client.callTool("answer_question", map[string]interface{}{
		"session":  "test-session",
		"question": "不存在的问题？",
		"answer":   "A",
	})
	if !isErr2 {
		t.Fatal("expected isError=true for business error (unmatched question)")
	}
	if r2["error"] == nil {
		t.Error("business error should carry error field")
	}
}

// ============================================================
// BB-06: normal call has no isError
// ============================================================

func TestBB06_NormalCallNoIsError(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	client.callTool("create_session", map[string]interface{}{"session": "test-session"})
	client.callTool("add_questions", map[string]interface{}{
		"session":   "test-session",
		"questions": []interface{}{"Q1"},
	})

	_, isErr := client.callTool("get_status", map[string]interface{}{
		"session": "test-session",
	})
	if isErr {
		t.Error("normal call should have isError=false")
	}
}

// ============================================================
// BB-07: unknown tool name → protocol error -32602
// ============================================================

func TestBB07_UnknownToolProtocolError(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	resp := client.callRaw(map[string]interface{}{
		"method": "tools/call",
		"params": map[string]interface{}{
			"name":      "no_such_tool",
			"arguments": map[string]interface{}{},
		},
	})
	errObj, ok := resp["error"].(map[string]interface{})
	if !ok {
		t.Fatalf("expected JSON-RPC error, got: %v", resp)
	}
	if v, ok := getInt(errObj["code"]); !ok || v != -32602 {
		t.Errorf("expected error code -32602, got %v", errObj["code"])
	}
	if resp["result"] != nil {
		t.Error("protocol error should not carry result")
	}
}

// ============================================================
// BB-08a/08b/08c: version negotiation
// ============================================================

func TestBB08a_VersionExactMatch(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()

	resp := client.initializeWithVersion("2024-11-05")
	result, _ := resp["result"].(map[string]interface{})
	if result["protocolVersion"] != "2024-11-05" {
		t.Errorf("expected 2024-11-05, got %v", result["protocolVersion"])
	}
}

func TestBB08b_VersionNewerRequested(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()

	resp := client.initializeWithVersion("2025-06-18")
	result, _ := resp["result"].(map[string]interface{})
	if result["protocolVersion"] != "2024-11-05" {
		t.Errorf("expected 2024-11-05 (server latest supported), got %v", result["protocolVersion"])
	}
}

func TestBB08c_VersionMissing(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()

	resp := client.initializeWithVersion("")
	result, _ := resp["result"].(map[string]interface{})
	if result["protocolVersion"] != "2024-11-05" {
		t.Errorf("expected 2024-11-05 when version missing, got %v", result["protocolVersion"])
	}
}

// ============================================================
// BB-09a/09b: protocol error paths
// ============================================================

func TestBB09a_UnknownMethod(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	resp := client.callRaw(map[string]interface{}{
		"method": "unknown/method",
	})
	errObj, _ := resp["error"].(map[string]interface{})
	if v, ok := getInt(errObj["code"]); !ok || v != -32601 {
		t.Errorf("expected -32601, got %v", errObj["code"])
	}
}

func TestBB09b_InvalidJSON(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	resp := client.sendRawText("{broken")
	errObj, _ := resp["error"].(map[string]interface{})
	if v, ok := getInt(errObj["code"]); !ok || v != -32700 {
		t.Errorf("expected -32700, got %v", errObj["code"])
	}
}

// ============================================================
// BB-10: list_sessions stdio flow
// ============================================================

func TestBB10_ListSessionsStdio(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	client.callTool("create_session", map[string]interface{}{"session": "alpha"})
	client.callTool("add_questions", map[string]interface{}{
		"session":   "alpha",
		"questions": []interface{}{"Q1"},
	})
	client.callTool("create_session", map[string]interface{}{"session": "beta"})
	client.callTool("add_questions", map[string]interface{}{
		"session":   "beta",
		"questions": []interface{}{"Q2", "Q3"},
	})

	r, isErr := client.callTool("list_sessions", map[string]interface{}{})
	if isErr {
		t.Fatalf("list_sessions failed: %v", r)
	}
	sessions, _ := r["sessions"].([]interface{})
	if len(sessions) != 2 {
		t.Fatalf("expected 2 sessions, got %d", len(sessions))
	}
	names := map[string]int{}
	for _, s := range sessions {
		m := s.(map[string]interface{})
		name := m["name"].(string)
		if m["path"] == nil || m["path"] == "" {
			t.Error("session should have path")
		}
		if m["total"] == nil || m["pending"] == nil {
			t.Error("session should have total and pending")
		}
		total, _ := getInt(m["total"])
		names[name] = total
	}
	if names["alpha"] != 1 || names["beta"] != 2 {
		t.Errorf("session stats wrong: %v", names)
	}
}

// ============================================================
// BB-11: reopen + delete stdio flow
// ============================================================

func TestBB11_ReopenDeleteStdio(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	client.callTool("create_session", map[string]interface{}{"session": "test-session"})
	client.callTool("add_questions", map[string]interface{}{
		"session":   "test-session",
		"questions": []interface{}{"Q1"},
	})
	client.callTool("answer_question", map[string]interface{}{
		"session":  "test-session",
		"question": "Q1",
		"answer":   "A1",
	})

	r1, _ := client.callTool("finalize_questions", map[string]interface{}{
		"session": "test-session",
	})
	if r1["status"] != "ready" {
		t.Fatalf("expected ready, got %v", r1["status"])
	}

	archives := poolArchiveDirs(t, poolRoot, "test-session")
	if len(archives) != 1 {
		t.Fatalf("expected 1 archived dir, got %d", len(archives))
	}
	archivedName := filepath.Base(archives[0])

	r2, isErr2 := client.callTool("reopen_session", map[string]interface{}{
		"session": archivedName,
	})
	if isErr2 {
		t.Fatalf("reopen_session failed: %v", r2)
	}
	if r2["reopened"] != "test-session" {
		t.Errorf("expected reopened='test-session', got %v", r2["reopened"])
	}

	r3, isErr3 := client.callTool("delete_session", map[string]interface{}{
		"session": "test-session",
		"confirm": true,
	})
	if isErr3 {
		t.Fatalf("delete_session failed: %v", r3)
	}
	if r3["deleted"] != "test-session" {
		t.Errorf("expected deleted='test-session', got %v", r3["deleted"])
	}
	if stateFile := poolStateFile(t, poolRoot, "test-session"); stateFile != "" {
		t.Errorf("pool should be deleted, but state file still exists: %s", stateFile)
	}
}

// ============================================================
// BB-Upgrade: full upgrade link over stdio (IT-UP-10)
// ============================================================

func TestBB_Upgrade_FullLink(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	// Build legacy scene: marker + legacy pool with 1 answered + 1 pending
	os.MkdirAll(filepath.Join(workDir, ".sdd", "SR-001"), 0755)
	os.WriteFile(filepath.Join(workDir, ".sdd", ".current_session"), []byte("./.sdd/SR-001/"), 0644)
	legacyBody := `{"questions":[` +
		`{"id":1,"question":"数据库选型？","status":"answered","answer":"PostgreSQL","source":"user","derivation_note":null,"created_at":"","answered_at":null,"updated_at":null,"history":[]},` +
		`{"id":2,"question":"缓存方案？","status":"pending","answer":null,"source":null,"derivation_note":null,"created_at":"","answered_at":null,"updated_at":null,"history":[]}` +
		`],"next_id":3}`
	os.WriteFile(filepath.Join(workDir, ".sdd", "SR-001", ".question_state.json"), []byte(legacyBody), 0644)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	// 1. get_status WITHOUT session → legacy fallback reads the old pool
	r1, isErr1 := client.callTool("get_status", map[string]interface{}{
		"detail": "summary",
	})
	if isErr1 {
		t.Fatalf("legacy fallback get_status failed: %v", r1)
	}
	if v, ok := getInt(r1["total"]); !ok || v != 2 {
		t.Errorf("expected total=2 from legacy pool, got %v", r1["total"])
	}
	if r1["deprecation_warning"] == nil {
		t.Error("expected deprecation_warning on legacy-route result")
	}

	// 2. answer WITHOUT session → succeeds via legacy route
	r2, isErr2 := client.callTool("answer_question", map[string]interface{}{
		"question": "缓存方案？",
		"answer":   "Redis",
	})
	if isErr2 {
		t.Fatalf("legacy-route answer failed: %v", r2)
	}

	// 3. list_sessions → migrated copy "SR-001" visible
	r3, _ := client.callTool("list_sessions", map[string]interface{}{})
	sessions, _ := r3["sessions"].([]interface{})
	found := false
	for _, s := range sessions {
		if s.(map[string]interface{})["name"] == "SR-001" {
			found = true
		}
	}
	if !found {
		t.Errorf("migrated pool 'SR-001' should appear in list_sessions: %v", r3["sessions"])
	}

	// 4. finalize WITHOUT session → archives into new mechanism
	r4, _ := client.callTool("finalize_questions", map[string]interface{}{})
	if r4["status"] != "ready" {
		t.Errorf("expected ready, got %v", r4["status"])
	}
	archives := poolArchiveDirs(t, poolRoot, "SR-001")
	if len(archives) != 1 {
		t.Errorf("expected 1 archive for SR-001, got %d", len(archives))
	}

	// 5. legacy pool file + marker retired; legacy directory preserved
	if _, err := os.Stat(filepath.Join(workDir, ".sdd", "SR-001", ".question_state.json")); !os.IsNotExist(err) {
		t.Error("legacy pool file should be removed after finalize")
	}
	if _, err := os.Stat(filepath.Join(workDir, ".sdd", ".current_session")); !os.IsNotExist(err) {
		t.Error("legacy marker should be removed after finalize")
	}
	if info, err := os.Stat(filepath.Join(workDir, ".sdd", "SR-001")); err != nil || !info.IsDir() {
		t.Error("legacy session directory must be preserved (user workspace)")
	}
}

// ============================================================
// BB-12: amnesia recovery via list_sessions (M07 path)
// ============================================================

func TestBB12_AmnesiaRecoveryViaList(t *testing.T) {
	origCwd, poolRoot, workDir := bbSetup(t)
	defer os.Chdir(origCwd)

	client := newMCPClient(t, workDir, poolRoot)
	defer client.close()
	client.initialize()

	client.callTool("create_session", map[string]interface{}{"session": "sr001-ar002-支付回调"})
	client.callTool("add_questions", map[string]interface{}{
		"session":   "sr001-ar002-支付回调",
		"questions": []interface{}{"Q1", "Q2"},
	})

	// Simulated amnesia: AI only remembers it was working on "支付"
	r1, _ := client.callTool("list_sessions", map[string]interface{}{})
	sessions, _ := r1["sessions"].([]interface{})
	target := ""
	for _, s := range sessions {
		name := s.(map[string]interface{})["name"].(string)
		if strings.Contains(name, "支付") {
			target = name
		}
	}
	if target != "sr001-ar002-支付回调" {
		t.Fatalf("should find pool by keyword 支付, got: %q", target)
	}

	r2, isErr := client.callTool("get_status", map[string]interface{}{
		"session": target,
	})
	if isErr {
		t.Fatalf("get_status after discovery failed: %v", r2)
	}
	if v, ok := getInt(r2["total"]); !ok || v != 2 {
		t.Errorf("expected total=2 after recovery, got %v", r2["total"])
	}
}
