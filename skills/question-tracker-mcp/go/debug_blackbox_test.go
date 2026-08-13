package main_test

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// ============================================================
// 线上取证与协议防御黑盒测试：
//   - 双重编码 arguments 在真实 stdio 链路上自愈（不再 -32602）
//   - QUESTION_TRACKER_DEBUG 调试日志写入文件
//   - 调试日志默认路径（=1 → <poolRoot>/debug.log）
//   - 调试日志路径不可写时服务器照常工作（不得把 MCP 搞崩）
// ============================================================

// rawClient 以原始行方式与 MCP 子进程通信（可发送畸形 payload）。
type rawClient struct {
	cmd    *exec.Cmd
	stdin  *bufio.Writer
	stdout *bufio.Scanner
}

func spawnRaw(t *testing.T, workDir string, env ...string) *rawClient {
	t.Helper()
	cmd := exec.Command(binaryPath)
	cmd.Dir = workDir
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(), env...)

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
	return &rawClient{
		cmd:    cmd,
		stdin:  bufio.NewWriter(stdinPipe),
		stdout: bufio.NewScanner(stdoutPipe),
	}
}

func (c *rawClient) sendLine(t *testing.T, line string) {
	t.Helper()
	if _, err := c.stdin.WriteString(line + "\n"); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := c.stdin.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}
}

func (c *rawClient) readLine(t *testing.T) string {
	t.Helper()
	if !c.stdout.Scan() {
		t.Fatalf("no response line (server died?)")
	}
	return c.stdout.Text()
}

const initLine = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`

// TestBB_DoubleEncodedArgumentsRecovered 复刻用户批次1故障：
// arguments 被双重编码成字符串，此前服务器返回 -32602（宿主显示
// "Function failed"），现在应自动二次解析并正常建池。
func TestBB_DoubleEncodedArgumentsRecovered(t *testing.T) {
	workDir := t.TempDir()
	poolRoot := t.TempDir()
	c := spawnRaw(t, workDir, "QUESTION_TRACKER_HOME="+poolRoot)

	c.sendLine(t, initLine)
	c.readLine(t)

	// 连建池动作本身也用双重编码发送——自愈必须覆盖所有工具
	c.sendLine(t, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_session","arguments":"{\"session\":\"wire-session\"}"}}`)
	resp := c.readLine(t)
	if strings.Contains(resp, "-32602") || !strings.Contains(resp, `created\":true`) {
		t.Fatalf("double-encoded create_session should be recovered, got: %s", resp)
	}

	c.sendLine(t, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_questions","arguments":"{\"session\":\"wire-session\",\"questions\":[\"q？\"]}"}}`)
	resp = c.readLine(t)

	if strings.Contains(resp, "-32602") {
		t.Fatalf("double-encoded arguments should no longer yield -32602, got: %s", resp)
	}
	if !strings.Contains(resp, "added_count") {
		t.Fatalf("expected pool creation via recovered arguments, got: %s", resp)
	}
	if stateFile := poolStateFile(t, poolRoot, "wire-session"); stateFile == "" {
		t.Error("pool state.json should exist for wire-session")
	}
}

// TestBB_DebugLogWritten：设 QUESTION_TRACKER_DEBUG=<path> 后，
// 原始请求/响应必须落盘，供现场取证。
func TestBB_DebugLogWritten(t *testing.T) {
	workDir := t.TempDir()
	poolRoot := t.TempDir()
	logPath := filepath.Join(t.TempDir(), "dbg.log")

	c := spawnRaw(t, workDir,
		"QUESTION_TRACKER_HOME="+poolRoot,
		"QUESTION_TRACKER_DEBUG="+logPath,
	)
	c.sendLine(t, initLine)
	c.readLine(t)
	c.sendLine(t, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_session","arguments":{"session":"dbg-session"}}}`)
	c.readLine(t)
	c.sendLine(t, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_questions","arguments":{"session":"dbg-session","questions":["q？"]}}}`)
	c.readLine(t)

	data, err := os.ReadFile(logPath)
	if err != nil {
		t.Fatalf("debug log should exist: %v", err)
	}
	content := string(data)
	for _, want := range []string{"startup", "cwd=", "[req]", "[resp]", "dbg-session"} {
		if !strings.Contains(content, want) {
			t.Errorf("debug log should contain %q, got:\n%s", want, content)
		}
	}
}

// TestBB_DebugLogDefaultPath：QUESTION_TRACKER_DEBUG=1 → 默认写到
// <QUESTION_TRACKER_HOME>/debug.log（用户侧固定可找的位置）。
func TestBB_DebugLogDefaultPath(t *testing.T) {
	workDir := t.TempDir()
	poolRoot := t.TempDir()

	c := spawnRaw(t, workDir,
		"QUESTION_TRACKER_HOME="+poolRoot,
		"QUESTION_TRACKER_DEBUG=1",
	)
	c.sendLine(t, initLine)
	c.readLine(t)

	if _, err := os.Stat(filepath.Join(poolRoot, "debug.log")); err != nil {
		t.Errorf("default debug log should be at <poolRoot>/debug.log: %v", err)
	}
}

// TestBB_DebugLogBrokenPathDoesNotCrash：日志路径不可写（父路径是文件）
// 时，服务器必须照常响应——调试输出绝不能把 MCP 搞崩。
func TestBB_DebugLogBrokenPathDoesNotCrash(t *testing.T) {
	workDir := t.TempDir()
	poolRoot := t.TempDir()

	blocker := filepath.Join(t.TempDir(), "blocker")
	if err := os.WriteFile(blocker, []byte("file, not dir"), 0644); err != nil {
		t.Fatal(err)
	}
	badPath := filepath.Join(blocker, "sub", "debug.log")

	c := spawnRaw(t, workDir,
		"QUESTION_TRACKER_HOME="+poolRoot,
		"QUESTION_TRACKER_DEBUG="+badPath,
	)
	c.sendLine(t, initLine)
	if resp := c.readLine(t); !strings.Contains(resp, "protocolVersion") {
		t.Fatalf("initialize should work despite broken debug path, got: %s", resp)
	}
	c.sendLine(t, `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"create_session","arguments":{"session":"s1"}}}`)
	c.readLine(t)
	c.sendLine(t, `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"add_questions","arguments":{"session":"s1","questions":["q？"]}}}`)
	if resp := c.readLine(t); !strings.Contains(resp, "added_count") {
		t.Fatalf("tools/call should work despite broken debug path, got: %s", resp)
	}
}
