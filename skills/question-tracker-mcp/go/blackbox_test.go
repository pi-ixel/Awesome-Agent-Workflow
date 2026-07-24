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
)

// ============================================================
// Global: path to the built MCP server binary
// ============================================================

var binaryPath string

func TestMain(m *testing.M) {
	// Build the Go binary
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

// bbSetup creates a temp directory with session marker and chdir into it.
func bbSetup(t *testing.T) (origCwd string, tempDir string) {
	t.Helper()
	origCwd, _ = os.Getwd()
	tempDir = t.TempDir()
	os.Chdir(tempDir)

	// Create session marker
	sddDir := filepath.Join(tempDir, ".sdd")
	sessionDir := filepath.Join(sddDir, "test")
	os.MkdirAll(sessionDir, 0755)
	markerPath := filepath.Join(sddDir, ".current_session")
	os.WriteFile(markerPath, []byte("./.sdd/test/"), 0644)

	return origCwd, tempDir
}

// bbCleanupState removes the question state file.
func bbCleanupState(t *testing.T, tempDir string) {
	t.Helper()
	stateFile := filepath.Join(tempDir, ".sdd", "test", ".question_state.json")
	os.Remove(stateFile)
}

// startMCP starts the MCP server subprocess.
func startMCP(t *testing.T, tempDir string) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(binaryPath)
	cmd.Dir = tempDir
	cmd.Stderr = os.Stderr

	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatalf("failed to get stdin pipe: %v", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatalf("failed to get stdout pipe: %v", err)
	}

	// Store pipes for later use via cmd.ExtraFiles hack... let's use a different approach
	// Actually, let's store them in a context using the cmd itself
	// We'll use a simple wrapper struct
	cmd.Env = os.Environ()

	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start MCP server: %v", err)
	}

	// Store the pipes via the process state
	// Actually, the issue is that we need to keep the pipes alive
	// Let's restructure to avoid this complexity
	// We'll return the cmd and use separate functions

	// Clean up on test completion
	t.Cleanup(func() {
		if cmd.Process != nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
	})

	// We need to set up the IO properly. Let's just store pipes in a struct
	_ = stdin
	_ = stdout
	return cmd
}

// mcpClient wraps the MCP subprocess communication.
type mcpClient struct {
	cmd     *exec.Cmd
	stdin   *bufio.Writer
	stdout  *bufio.Scanner
	t       *testing.T
	nextID  int
}

// newMCPClient starts the MCP server and returns a client for communication.
func newMCPClient(t *testing.T, tempDir string) *mcpClient {
	t.Helper()

	cmd := exec.Command(binaryPath)
	cmd.Dir = tempDir
	cmd.Stderr = os.Stderr

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

// initialize performs the MCP initialize handshake.
func (c *mcpClient) initialize() {
	c.t.Helper()

	c.nextID++
	req := map[string]interface{}{
		"jsonrpc": "2.0",
		"method":  "initialize",
		"params": map[string]interface{}{
			"protocolVersion": "2024-11-05",
			"capabilities":    map[string]interface{}{},
			"clientInfo": map[string]interface{}{
				"name":    "test",
				"version": "1.0.0",
			},
		},
		"id": c.nextID,
	}

	resp := c.sendRequest(req)
	if resp["error"] != nil {
		c.t.Fatalf("initialize failed: %v", resp["error"])
	}
}

// callTool sends a tools/call request and returns the parsed tool result.
func (c *mcpClient) callTool(name string, args map[string]interface{}) map[string]interface{} {
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
		return map[string]interface{}{"error": fmt.Sprintf("%v", errData)}
	}

	result, ok := resp["result"].(map[string]interface{})
	if !ok {
		return map[string]interface{}{"error": "no result in response"}
	}

	content, ok := result["content"].([]interface{})
	if !ok || len(content) == 0 {
		return map[string]interface{}{"error": "no content in result"}
	}

	contentItem, ok := content[0].(map[string]interface{})
	if !ok {
		return map[string]interface{}{"error": "invalid content item"}
	}

	text, ok := contentItem["text"].(string)
	if !ok {
		return map[string]interface{}{"error": "invalid text in content"}
	}

	var toolResult map[string]interface{}
	if err := json.Unmarshal([]byte(text), &toolResult); err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("failed to parse tool result: %v", err)}
	}

	return toolResult
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

// ============================================================
// BB01: Complete Workflow
// ============================================================

func TestBB01_CompleteWorkflow(t *testing.T) {
	origCwd, tempDir := bbSetup(t)
	defer os.Chdir(origCwd)
	defer bbCleanupState(t, tempDir)

	client := newMCPClient(t, tempDir)
	defer client.close()
	client.initialize()

	r1 := client.callTool("add_questions", map[string]interface{}{
		"questions": []interface{}{"问题A", "问题B", "问题C"},
	})
	if r1["added_count"] == nil {
		t.Fatalf("add_questions failed: %v", r1)
	}

	r2 := client.callTool("answer_question", map[string]interface{}{
		"question": "问题A", "answer": "答案A",
	})
	if r2["matched_question"] == nil {
		t.Fatalf("answer_question A failed: %v", r2)
	}

	r3 := client.callTool("answer_question", map[string]interface{}{
		"question": "问题B", "answer": "答案B",
	})
	if r3["matched_question"] == nil {
		t.Fatalf("answer_question B failed: %v", r3)
	}

	r3b := client.callTool("answer_question", map[string]interface{}{
		"question": "问题C", "answer": "答案C",
	})
	if r3b["matched_question"] == nil {
		t.Fatalf("answer_question C failed: %v", r3b)
	}

	r4 := client.callTool("finalize_questions", map[string]interface{}{})
	if r4["status"] != "ready" {
		t.Errorf("expected status 'ready', got '%s'", r4["status"])
	}
	summary, _ := r4["summary"].([]interface{})
	if len(summary) != 3 {
		t.Errorf("expected 3 summary entries, got %d", len(summary))
	}
}

// ============================================================
// BB02: Error Response Format
// ============================================================

func TestBB02_ErrorResponseFormat(t *testing.T) {
	origCwd, tempDir := bbSetup(t)
	defer os.Chdir(origCwd)
	defer bbCleanupState(t, tempDir)

	client := newMCPClient(t, tempDir)
	defer client.close()
	client.initialize()

	client.callTool("add_questions", map[string]interface{}{
		"questions": []interface{}{"问题A"},
	})

	r := client.callTool("answer_question", map[string]interface{}{
		"question": "不存在的原文", "answer": "答案",
	})

	if r["error"] == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(fmt.Sprintf("%v", r["error"]), "未匹配到问题") {
		t.Errorf("expected '未匹配到问题' in error, got '%v'", r["error"])
	}
}

// ============================================================
// BB03: Persistence Recovery
// ============================================================

func TestBB03_PersistenceRecovery(t *testing.T) {
	origCwd, tempDir := bbSetup(t)
	defer os.Chdir(origCwd)
	defer bbCleanupState(t, tempDir)

	client := newMCPClient(t, tempDir)
	client.initialize()

	client.callTool("add_questions", map[string]interface{}{
		"questions": []interface{}{"问题A", "问题B"},
	})
	client.callTool("answer_question", map[string]interface{}{
		"question": "问题A", "answer": "答案A",
	})
	client.close()

	// Start new process
	client2 := newMCPClient(t, tempDir)
	defer client2.close()
	client2.initialize()

	r := client2.callTool("get_status", map[string]interface{}{
		"detail": "full",
	})
	if v, ok := getInt(r["pending"]); !ok || v != 1 {
		t.Errorf("expected pending=1, got %v", r["pending"])
	}
	if v, ok := getInt(r["answered"]); !ok || v != 1 {
		t.Errorf("expected answered=1, got %v", r["answered"])
	}

	questions, _ := r["questions"].([]interface{})
	var texts []string
	for _, q := range questions {
		m := q.(map[string]interface{})
		texts = append(texts, m["question"].(string))
	}
	foundA := false
	foundB := false
	for _, txt := range texts {
		if txt == "问题A" {
			foundA = true
		}
		if txt == "问题B" {
			foundB = true
		}
	}
	if !foundA || !foundB {
		t.Errorf("expected both 问题A and 问题B, got %v", texts)
	}
}

// ============================================================
// BB04: External Clear New Design
// ============================================================

func TestBB04_ExternalClearNewDesign(t *testing.T) {
	origCwd, tempDir := bbSetup(t)
	defer os.Chdir(origCwd)
	defer bbCleanupState(t, tempDir)

	client := newMCPClient(t, tempDir)
	client.initialize()

	client.callTool("add_questions", map[string]interface{}{
		"questions": []interface{}{"问题A", "问题B"},
	})
	client.callTool("answer_question", map[string]interface{}{
		"question": "问题A", "answer": "答案A",
	})
	client.close()

	// Delete the state file externally
	stateFile := filepath.Join(tempDir, ".sdd", "test", ".question_state.json")
	os.Remove(stateFile)

	client2 := newMCPClient(t, tempDir)
	defer client2.close()
	client2.initialize()

	client2.callTool("add_questions", map[string]interface{}{
		"questions": []interface{}{"新问题"},
	})
	r := client2.callTool("get_status", map[string]interface{}{
		"detail": "full",
	})
	if v, ok := getInt(r["total"]); !ok || v != 1 {
		t.Errorf("expected total=1, got %v", r["total"])
	}

	// Verify next_id in state file
	stateData, _ := os.ReadFile(stateFile)
	var state map[string]interface{}
	json.Unmarshal(stateData, &state)
	if v, ok := state["next_id"].(float64); !ok || int(v) != 2 {
		t.Errorf("expected next_id=2, got %v", state["next_id"])
	}
}

// ============================================================
// BB05: JSON-RPC Protocol Error
// ============================================================

func TestBB05_JSONRPCProtocolError(t *testing.T) {
	origCwd, tempDir := bbSetup(t)
	defer os.Chdir(origCwd)
	defer bbCleanupState(t, tempDir)

	client := newMCPClient(t, tempDir)
	defer client.close()
	client.initialize()

	// Send invalid JSON
	client.stdin.Write([]byte("这不是有效的JSON\n"))
	client.stdin.Flush()

	if !client.stdout.Scan() {
		t.Fatal("expected response even for invalid input")
	}

	line := client.stdout.Text()
	var resp map[string]interface{}
	if err := json.Unmarshal([]byte(line), &resp); err != nil {
		t.Fatalf("expected valid JSON response, got: %s", line)
	}
}

// ============================================================
// BB-SI-01 ~ BB-SI-04: Session Isolation Blackbox
// ============================================================

func testBBSI_SetupWithMarker(t *testing.T, markerContent string) (origCwd string, tempDir string) {
	t.Helper()
	origCwd, _ = os.Getwd()
	tempDir = t.TempDir()
	os.Chdir(tempDir)

	sddDir := filepath.Join(tempDir, ".sdd")
	os.MkdirAll(sddDir, 0755)
	markerPath := filepath.Join(sddDir, ".current_session")
	os.WriteFile(markerPath, []byte(markerContent), 0644)

	// Create target directory
	trimmed := strings.TrimSpace(markerContent)
	targetDir := filepath.Join(tempDir, trimmed)
	os.MkdirAll(targetDir, 0755)

	return origCwd, tempDir
}

func TestBB_SI_01_WithMarkerNormalFlow(t *testing.T) {
	origCwd, tempDir := testBBSI_SetupWithMarker(t, "./.sdd/SR-123/")
	defer os.Chdir(origCwd)

	client := newMCPClient(t, tempDir)
	defer client.close()
	client.initialize()

	r1 := client.callTool("add_questions", map[string]interface{}{
		"questions": []interface{}{"Q-A", "Q-B", "Q-C"},
	})
	if r1["added_count"] == nil {
		t.Fatalf("add_questions failed: %v", r1)
	}

	client.callTool("answer_question", map[string]interface{}{"question": "Q-A", "answer": "Ans-A"})
	client.callTool("answer_question", map[string]interface{}{"question": "Q-B", "answer": "Ans-B"})
	client.callTool("answer_question", map[string]interface{}{"question": "Q-C", "answer": "Ans-C"})

	r5 := client.callTool("finalize_questions", map[string]interface{}{})
	if r5["status"] != "ready" {
		t.Errorf("expected status 'ready', got '%s'", r5["status"])
	}
	summary, _ := r5["summary"].([]interface{})
	if len(summary) != 3 {
		t.Errorf("expected 3 summary entries, got %d", len(summary))
	}

	// Verify file is in SR-123 directory
	expectedFile := filepath.Join(tempDir, ".sdd", "SR-123", ".question_state.json")
	if _, err := os.Stat(expectedFile); os.IsNotExist(err) {
		t.Errorf("state file should exist at %s", expectedFile)
	}
}

func TestBB_SI_02_NoMarkerReturnsError(t *testing.T) {
	origCwd, tempDir := bbSetup(t)
	defer os.Chdir(origCwd)

	// Remove the session marker
	markerPath := filepath.Join(tempDir, ".sdd", ".current_session")
	os.Remove(markerPath)

	client := newMCPClient(t, tempDir)
	defer client.close()
	client.initialize()

	r := client.callTool("add_questions", map[string]interface{}{
		"questions": []interface{}{"Q1"},
	})
	if r["error"] == nil {
		t.Fatalf("expected error, got: %v", r)
	}
	if !strings.Contains(fmt.Sprintf("%v", r["error"]), "aaw-workflow") {
		t.Errorf("error should mention aaw-workflow: %v", r["error"])
	}
}

func TestBB_SI_03_SwitchMarkerIsolation(t *testing.T) {
	origCwd, tempDir := testBBSI_SetupWithMarker(t, "./.sdd/SR-123/")
	defer os.Chdir(origCwd)

	client := newMCPClient(t, tempDir)
	defer client.close()
	client.initialize()

	r1 := client.callTool("add_questions", map[string]interface{}{
		"questions": []interface{}{"Q1-SR123"},
	})
	if r1["added_count"] == nil {
		t.Fatalf("add_questions failed: %v", r1)
	}

	// Switch marker to SR-456
	markerPath := filepath.Join(tempDir, ".sdd", ".current_session")
	os.MkdirAll(filepath.Join(tempDir, ".sdd", "SR-456"), 0755)
	os.WriteFile(markerPath, []byte("./.sdd/SR-456/"), 0644)

	r2 := client.callTool("add_questions", map[string]interface{}{
		"questions": []interface{}{"Q2-SR456"},
	})
	if r2["added_count"] == nil {
		t.Fatalf("add_questions SR456 failed: %v", r2)
	}

	r3 := client.callTool("get_status", map[string]interface{}{"detail": "full"})
	if v, ok := getInt(r3["total"]); !ok || v != 1 {
		t.Errorf("SR-456 session should have 1 question, got %v", r3["total"])
	}
}

func TestBB_SI_04_RestartRecovery(t *testing.T) {
	origCwd, tempDir := testBBSI_SetupWithMarker(t, "./.sdd/SR-123/")
	defer os.Chdir(origCwd)

	// First round
	client1 := newMCPClient(t, tempDir)
	client1.initialize()
	client1.callTool("add_questions", map[string]interface{}{
		"questions": []interface{}{"Q1", "Q2"},
	})
	client1.callTool("answer_question", map[string]interface{}{
		"question": "Q1", "answer": "Ans1",
	})
	client1.close()

	// Second round: restart
	client2 := newMCPClient(t, tempDir)
	defer client2.close()
	client2.initialize()

	r := client2.callTool("get_status", map[string]interface{}{"detail": "full"})
	if v, ok := getInt(r["total"]); !ok || v != 2 {
		t.Errorf("expected total=2 after restart, got %v", r["total"])
	}
	if v, ok := getInt(r["pending"]); !ok || v != 1 {
		t.Errorf("expected pending=1 after restart, got %v", r["pending"])
	}
	if v, ok := getInt(r["answered"]); !ok || v != 1 {
		t.Errorf("expected answered=1 after restart, got %v", r["answered"])
	}

	questions, _ := r["questions"].([]interface{})
	var texts []string
	for _, q := range questions {
		m := q.(map[string]interface{})
		texts = append(texts, m["question"].(string))
	}
	if !containsStr(texts, "Q1") || !containsStr(texts, "Q2") {
		t.Errorf("expected both Q1 and Q2, got %v", texts)
	}
}

// ============================================================
// Helpers
// ============================================================

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

func containsStr(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}
