package main

import (
	"encoding/json"
	"os"
	"testing"
)

// ============================================================
// 防御性修复单元测试：parseArguments 双重编码自愈 +
// dispatchTool 的 invalid_session / missing_session 区分
//
// 背景（2026-08 用户现场）：宿主把 arguments 双重编码成字符串 →
// 协议级 -32602，宿主只显示 "Function failed"；session 以非字符串形态
// 到达 → 被归一为空串报出误导性的 missing_session。两类故障都让
// "传了 session 却建不了池" 无法定位。
// ============================================================

func TestParseArguments(t *testing.T) {
	cases := []struct {
		name      string
		raw       string
		wantSess  string // "" 表示期望整体为 nil
		wantNilOK bool
	}{
		{"标准对象", `{"session":"s1","questions":["q"]}`, "s1", false},
		{"双重编码字符串", `"{\"session\":\"s1\",\"questions\":[\"q\"]}"`, "s1", false},
		{"空 raw", ``, "", true},
		{"null 字面量", `null`, "", true},
		{"非 JSON 字符串", `"not json at all"`, "", true},
		{"数组不是对象", `[1,2,3]`, "", true},
		{"空对象", `{}`, "", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			args := parseArguments(json.RawMessage(c.raw))
			if c.wantSess == "" {
				if len(args) != 0 {
					t.Errorf("expected nil/empty args, got %v", args)
				}
				return
			}
			if args["session"] != c.wantSess {
				t.Errorf("expected session=%q, got %v", c.wantSess, args["session"])
			}
		})
	}
}

// isolateDispatchEnv 把测试隔离到无 legacy 标记的临时 CWD + 临时池根。
// 返回 origCwd，调用方须 defer os.Chdir(origCwd)（与 setupUpgradeScene 同
// 一惯例：defer 在测试函数返回时执行，先于 TempDir 的清理，避免 Windows
// 下 CWD 占用导致目录删不掉）。
func isolateDispatchEnv(t *testing.T) string {
	t.Helper()
	origCwd, _ := os.Getwd()
	os.Chdir(t.TempDir())
	t.Setenv("QUESTION_TRACKER_HOME", t.TempDir())
	return origCwd
}

func TestDispatchInvalidSessionType(t *testing.T) {
	origCwd := isolateDispatchEnv(t)
	defer os.Chdir(origCwd)

	cases := map[string]interface{}{
		"数字":   float64(123),
		"布尔":   true,
		"对象":   map[string]interface{}{"name": "x"},
		"数组":   []interface{}{"x"},
		"null": nil,
	}
	for label, v := range cases {
		r, isErr := dispatchTool("add_questions", map[string]interface{}{
			"questions": []interface{}{"问题？"},
			"session":   v,
		})
		if !isErr || r["error"] != "invalid_session" {
			t.Errorf("%s: expected invalid_session, got error=%v isErr=%v", label, r["error"], isErr)
		}
		if r["hint"] == "" || r["received"] == "" {
			t.Errorf("%s: hint/received should be populated, got %v", label, r)
		}
	}
}

func TestDispatchMissingSessionStillMissingSession(t *testing.T) {
	origCwd := isolateDispatchEnv(t)
	defer os.Chdir(origCwd)

	// 键缺失
	r, isErr := dispatchTool("add_questions", map[string]interface{}{
		"questions": []interface{}{"问题？"},
	})
	if isErr || r["error"] != nil {
		t.Errorf("no key: 指引不得是错误, got %v isErr=%v", r["error"], isErr)
	}
	if r["action_required"] != "select_session" || r["reason"] != "missing_session" {
		t.Errorf("no key: expected missing_session guidance, got %v", r)
	}
	// 空字符串（保留 legacy 回退语义：无标记时给出 missing_session 指引）
	r, isErr = dispatchTool("add_questions", map[string]interface{}{
		"questions": []interface{}{"问题？"},
		"session":   "",
	})
	if isErr || r["error"] != nil {
		t.Errorf("empty string: 指引不得是错误, got %v isErr=%v", r["error"], isErr)
	}
	if r["action_required"] != "select_session" || r["reason"] != "missing_session" {
		t.Errorf("empty string: expected missing_session guidance, got %v", r)
	}
}

func TestDispatchValidSessionUnaffected(t *testing.T) {
	origCwd := isolateDispatchEnv(t)
	defer os.Chdir(origCwd)

	// 用户现场的名字（带点 + 中文）必须照常建池
	if r := createSessionTool("SR.IR20260807000137.008-TypeSlab迁移", ""); r["error"] != nil {
		t.Fatalf("create_session: %v", r["error"])
	}
	r, isErr := dispatchTool("add_questions", map[string]interface{}{
		"questions": []interface{}{"迁移策略？"},
		"session":   "SR.IR20260807000137.008-TypeSlab迁移",
	})
	if isErr || r["error"] != nil {
		t.Fatalf("valid session should succeed, got error=%v isErr=%v", r["error"], isErr)
	}
	if v, ok := r["added_count"].(int); !ok || v != 1 {
		t.Errorf("expected added_count=1, got %v", r["added_count"])
	}
}

func TestDispatchInvalidSessionCoversAllSessionTools(t *testing.T) {
	origCwd := isolateDispatchEnv(t)
	defer os.Chdir(origCwd)

	for tool := range sessionRequiredTools {
		args := map[string]interface{}{"session": float64(1)}
		r, isErr := dispatchTool(tool, args)
		if !isErr || r["error"] != "invalid_session" {
			t.Errorf("%s: expected invalid_session for numeric session, got %v isErr=%v", tool, r["error"], isErr)
		}
	}
	// 免 session 工具不得被误伤
	r, _ := dispatchTool("list_sessions", map[string]interface{}{})
	if r["error"] == "invalid_session" {
		t.Error("list_sessions must not require session")
	}
}

func TestTruncateForLog(t *testing.T) {
	short := "abc"
	if truncateForLog(short) != short {
		t.Error("short string should pass through")
	}
	long := make([]byte, 70*1024)
	for i := range long {
		long[i] = 'x'
	}
	out := truncateForLog(string(long))
	if len(out) > 64*1024+20 {
		t.Errorf("should be truncated, got len=%d", len(out))
	}
}
