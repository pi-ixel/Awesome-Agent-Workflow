package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// ============================================================
// Test Helpers
// ============================================================

// setupPoolEnv redirects the pool root to a temp dir and chdirs into a
// temp project workdir.
func setupPoolEnv(t *testing.T) (origCwd string) {
	t.Helper()
	origCwd, _ = os.Getwd()
	poolRoot := t.TempDir()
	t.Setenv("QUESTION_TRACKER_HOME", poolRoot)
	workDir := t.TempDir()
	os.Chdir(workDir)
	return origCwd
}

// stateFileOf locates the state.json path for a session via the public
// resolveStateFilePath entry.
func stateFileOf(t *testing.T, session string) string {
	t.Helper()
	p, err := resolveStateFilePath(session, "")
	if err != nil {
		t.Fatalf("resolveStateFilePath(%q): %v", session, err)
	}
	return p
}

// readPoolState reads the state.json content for a session.
func readPoolState(t *testing.T, session string) map[string]interface{} {
	t.Helper()
	stateFile := stateFileOf(t, session)
	data, err := os.ReadFile(stateFile)
	if err != nil {
		t.Fatalf("failed to read state file %s: %v", stateFile, err)
	}
	var state map[string]interface{}
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatalf("failed to parse state file: %v", err)
	}
	return state
}

// assertPendingCount checks the number of pending questions in the pool.
func assertPendingCount(t *testing.T, session string, expected int) {
	t.Helper()
	state := readPoolState(t, session)
	questions, _ := state["questions"].([]interface{})
	count := 0
	for _, q := range questions {
		m, _ := q.(map[string]interface{})
		if m["status"] == "pending" {
			count++
		}
	}
	if count != expected {
		t.Errorf("expected %d pending questions, got %d", expected, count)
	}
}

// ============================================================
// UT01-UT04: matchQuestion
// ============================================================

func TestMatchQuestion_UT01_ExactMatch(t *testing.T) {
	q1 := Question{ID: 1, Question: "什么是访问令牌", Status: "pending", History: []HistoryEntry{}}
	q2 := Question{ID: 2, Question: "令牌的过期时间是多少", Status: "pending", History: []HistoryEntry{}}
	questions := []Question{q1, q2}

	result, err := matchQuestion("什么是访问令牌", questions)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ID != 1 {
		t.Errorf("expected ID 1, got %d", result.ID)
	}
	if result.Question != "什么是访问令牌" {
		t.Errorf("expected '什么是访问令牌', got '%s'", result.Question)
	}
}

func TestMatchQuestion_UT02_ContainsMatchUnique(t *testing.T) {
	q1 := Question{ID: 1, Question: "用户认证接口的token字段名是什么", Status: "pending", History: []HistoryEntry{}}
	questions := []Question{q1}

	result, err := matchQuestion("token字段名", questions)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ID != 1 {
		t.Errorf("expected ID 1, got %d", result.ID)
	}
}

func TestMatchQuestion_UT03_ContainsMatchAmbiguous(t *testing.T) {
	q1 := Question{ID: 1, Question: "token过期时间是多少", Status: "pending", History: []HistoryEntry{}}
	q2 := Question{ID: 2, Question: "token刷新策略是什么", Status: "pending", History: []HistoryEntry{}}
	questions := []Question{q1, q2}

	_, err := matchQuestion("token", questions)
	if err == nil {
		t.Fatal("expected MatchError, got nil")
	}
}

func TestMatchQuestion_UT04_NoMatch(t *testing.T) {
	q1 := Question{ID: 1, Question: "什么是访问令牌", Status: "pending", History: []HistoryEntry{}}
	questions := []Question{q1}

	_, err := matchQuestion("完全不存在的内容", questions)
	if err == nil {
		t.Fatal("expected MatchError, got nil")
	}
}

// ============================================================
// UT05-UT07: validateQuestionsInput
// ============================================================

func TestValidateQuestionsInput_UT05_ValidInput(t *testing.T) {
	result := validateQuestionsInput([]string{"问题A", "问题B"})
	if result != nil {
		t.Errorf("expected nil error, got: %v", result)
	}
}

func TestValidateQuestionsInput_UT06_EmptyList(t *testing.T) {
	result := validateQuestionsInput([]string{})
	if result != nil {
		t.Errorf("expected nil error, got: %v", result)
	}
}

func TestValidateQuestionsInput_UT07_EmptyString(t *testing.T) {
	err := validateQuestionsInput([]string{""})
	if err == nil {
		t.Fatal("expected ValidationError, got nil")
	}
}

// ============================================================
// IT01: Complete Flow
// ============================================================

func TestIT01_CompleteFlow_FinalizeReady(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "test-session")
	a1 := addQuestionsTool([]string{"问题A", "问题B", "问题C"}, "test-session", "")
	if a1["error"] != nil {
		t.Fatalf("add_questions error: %v", a1["error"])
	}

	a2 := answerQuestionTool("问题A", "答案A", "user", "", "test-session", "")
	if a2["error"] != nil {
		t.Fatalf("answer error: %v", a2["error"])
	}
	a3 := answerQuestionTool("问题B", "答案B", "user", "", "test-session", "")
	if a3["error"] != nil {
		t.Fatalf("answer error: %v", a3["error"])
	}
	a4 := answerQuestionTool("问题C", "答案C", "user", "", "test-session", "")
	if a4["error"] != nil {
		t.Fatalf("answer error: %v", a4["error"])
	}

	result := finalizeQuestionsTool("test-session", "")
	if result["status"] != "ready" {
		t.Errorf("expected status 'ready', got '%s'", result["status"])
	}
	if arr, ok := result["summary"].([]interface{}); ok {
		if len(arr) != 3 {
			t.Errorf("expected 3 summary entries, got %d", len(arr))
		}
	}

	// finalize ready archives the pool; verify state file content in archive
	loc, _ := result["pool_location"].(string)
	if loc == "" {
		t.Fatal("expected pool_location in finalize result")
	}
	data, err := os.ReadFile(loc)
	if err != nil {
		t.Fatalf("failed to read archived state: %v", err)
	}
	var state map[string]interface{}
	json.Unmarshal(data, &state)
	for _, q := range state["questions"].([]interface{}) {
		m := q.(map[string]interface{})
		if m["status"] != "answered" {
			t.Errorf("expected all questions answered, got status=%s", m["status"])
		}
	}
}

// ============================================================
// IT02: Contradiction Correction
// ============================================================

func TestIT02_UpdateCreatesHistory(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"问题A"}, "s", "")
	answerQuestionTool("问题A", "原答案", "user", "", "s", "")

	updateResult := updateAnswerTool("问题A", "新答案", "用户纠正", "s", "")
	if updateResult["error"] != nil {
		t.Fatalf("update error: %v", updateResult["error"])
	}
	if updateResult["matched_question"] != "问题A" {
		t.Errorf("expected '问题A', got '%s'", updateResult["matched_question"])
	}
	if updateResult["previous_answer"] != "原答案" {
		t.Errorf("expected previous_answer='原答案', got '%v'", updateResult["previous_answer"])
	}
	if _, ok := updateResult["total_pending"]; !ok {
		t.Error("expected total_pending in result")
	}
	actionReq, _ := updateResult["action_required"].(map[string]interface{})
	if actionReq["type"] != "reanalyze_all" {
		t.Errorf("expected reanalyze_all, got '%s'", actionReq["type"])
	}

	result := getStatusTool("full", "s", "")
	questions, _ := result["questions"].([]interface{})
	if len(questions) == 0 {
		t.Fatal("expected non-empty questions")
	}
	q := questions[0].(map[string]interface{})
	history, _ := q["history"].([]interface{})
	if len(history) != 1 {
		t.Errorf("expected history length 1, got %d", len(history))
	}
	h := history[0].(map[string]interface{})
	if h["answer"] != "原答案" {
		t.Errorf("expected history answer '原答案', got '%s'", h["answer"])
	}
	if q["answer"] != "新答案" {
		t.Errorf("expected answer '新答案', got '%v'", q["answer"])
	}

	state := readPoolState(t, "s")
	sq := state["questions"].([]interface{})[0].(map[string]interface{})
	sh := sq["history"].([]interface{})
	if len(sh) != 1 {
		t.Errorf("state: expected history length 1, got %d", len(sh))
	}
	if sq["answer"] != "新答案" {
		t.Errorf("state: expected answer '新答案', got '%v'", sq["answer"])
	}
}

// ============================================================
// IT03: Derivation Resolution
// ============================================================

func TestIT03_DerivedHasDerivationNote(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"问题1", "问题2", "问题3"}, "s", "")
	answerQuestionTool("问题2", "答案2", "user", "", "s", "")

	result := answerQuestionTool("问题1", "推导答案1", "derived", "基于问题2", "s", "")
	if result["error"] != nil {
		t.Fatalf("answer error: %v", result["error"])
	}

	status := getStatusTool("full", "s", "")
	questions, _ := status["questions"].([]interface{})

	var q1 map[string]interface{}
	for _, q := range questions {
		m := q.(map[string]interface{})
		if m["question"] == "问题1" {
			q1 = m
			break
		}
	}
	if q1 == nil {
		t.Fatal("问题1 not found")
	}
	if q1["source"] != "derived" {
		t.Errorf("expected source 'derived', got '%v'", q1["source"])
	}
	if q1["derivation_note"] != "基于问题2" {
		t.Errorf("expected derivation_note '基于问题2', got '%v'", q1["derivation_note"])
	}

	state := readPoolState(t, "s")
	var q1FromFile map[string]interface{}
	for _, q := range state["questions"].([]interface{}) {
		m := q.(map[string]interface{})
		if m["question"] == "问题1" {
			q1FromFile = m
			break
		}
	}
	if q1FromFile["source"] != "derived" {
		t.Errorf("state: expected source 'derived', got '%v'", q1FromFile["source"])
	}
}

// ============================================================
// IT04: Answer Not Found
// ============================================================

func TestIT04_ErrorAndStatusUnchanged(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"问题A"}, "s", "")

	result := answerQuestionTool("不存在的原文", "答案", "user", "", "s", "")
	if result["error"] == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(result["error"].(string), "未匹配到问题") {
		t.Errorf("expected '未匹配到问题' in error, got '%s'", result["error"])
	}

	state := readPoolState(t, "s")
	q := state["questions"].([]interface{})[0].(map[string]interface{})
	if q["status"] != "pending" {
		t.Errorf("expected status 'pending', got '%s'", q["status"])
	}
}

// ============================================================
// IT05: Duplicate Answer
// ============================================================

func TestIT05_SecondAnswerError(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"问题A"}, "s", "")
	answerQuestionTool("问题A", "第一次答案", "user", "", "s", "")

	result := answerQuestionTool("问题A", "第二次答案", "user", "", "s", "")
	if result["error"] == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(result["error"].(string), "已回答") {
		t.Errorf("expected '已回答' in error, got '%s'", result["error"])
	}
	if _, ok := result["current_answer"]; !ok {
		t.Error("expected current_answer in result")
	}

	state := readPoolState(t, "s")
	q := state["questions"].([]interface{})[0].(map[string]interface{})
	if q["answer"] != "第一次答案" {
		t.Errorf("expected answer '第一次答案', got '%v'", q["answer"])
	}
}

// ============================================================
// IT06: Update Pending
// ============================================================

func TestIT06_UpdatePendingError(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"问题A"}, "s", "")

	result := updateAnswerTool("问题A", "新答案", "", "s", "")
	if result["error"] == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(result["error"].(string), "尚未回答") {
		t.Errorf("expected '尚未回答' in error, got '%s'", result["error"])
	}

	state := readPoolState(t, "s")
	q := state["questions"].([]interface{})[0].(map[string]interface{})
	if q["status"] != "pending" {
		t.Errorf("expected status 'pending', got '%s'", q["status"])
	}
}

// ============================================================
// IT07: Finalize Blocked
// ============================================================

func TestIT07_FinalizeBlocked(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"问题A", "问题B"}, "s", "")
	answerQuestionTool("问题A", "答案A", "user", "", "s", "")

	result := finalizeQuestionsTool("s", "")
	if result["status"] != "blocked" {
		t.Errorf("expected status 'blocked', got '%s'", result["status"])
	}
	if v, ok := getIntFromResult(result, "pending_count"); !ok || v != 1 {
		t.Errorf("expected pending_count 1, got %v", result["pending_count"])
	}

	state := readPoolState(t, "s")
	qs := state["questions"].([]interface{})
	var q1, q2 map[string]interface{}
	for _, q := range qs {
		m := q.(map[string]interface{})
		if m["question"] == "问题A" {
			q1 = m
		} else if m["question"] == "问题B" {
			q2 = m
		}
	}
	if q1["status"] != "answered" {
		t.Errorf("问题A should be answered, got %s", q1["status"])
	}
	if q2["status"] != "pending" {
		t.Errorf("问题B should be pending, got %s", q2["status"])
	}
}

// ============================================================
// IT08: Empty List Add
// ============================================================

func TestIT08_EmptyListReturnsZero(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"问题A", "问题B"}, "s", "")

	result := addQuestionsTool([]string{}, "s", "")
	if v, ok := getIntFromResult(result, "added_count"); !ok || v != 0 {
		t.Errorf("expected added_count 0, got %v", result["added_count"])
	}

	state := readPoolState(t, "s")
	qs := state["questions"].([]interface{})
	if len(qs) != 2 {
		t.Errorf("expected 2 questions, got %d", len(qs))
	}
}

// ============================================================
// IT09: Include Match Unique
// ============================================================

func TestIT09_IncludeMatchUnique(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"用户认证接口的token字段名是什么"}, "s", "")

	result := answerQuestionTool("token字段名", "字段名是token", "user", "", "s", "")
	if result["error"] != nil {
		t.Fatalf("unexpected error: %v", result["error"])
	}
	if result["matched_question"] != "用户认证接口的token字段名是什么" {
		t.Errorf("expected matched_question, got '%s'", result["matched_question"])
	}

	state := readPoolState(t, "s")
	q := state["questions"].([]interface{})[0].(map[string]interface{})
	if q["status"] != "answered" {
		t.Errorf("expected status 'answered', got '%s'", q["status"])
	}
}

// ============================================================
// IT10: Include Match Not Unique
// ============================================================

func TestIT10_IncludeMatchNotUniqueError(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"token过期时间是多少", "token刷新策略是什么"}, "s", "")

	result := answerQuestionTool("token", "答案", "user", "", "s", "")
	if result["error"] == nil {
		t.Fatal("expected error, got nil")
	}
	if !strings.Contains(result["error"].(string), "未匹配到问题") {
		t.Errorf("expected '未匹配到问题' in error, got '%s'", result["error"])
	}

	state := readPoolState(t, "s")
	for _, q := range state["questions"].([]interface{}) {
		m := q.(map[string]interface{})
		if m["status"] != "pending" {
			t.Errorf("expected all pending, got %s", m["status"])
		}
	}
}

// ============================================================
// IT11: All Derived Finalize
// ============================================================

func TestIT11_AllDerivedFinalizeReady(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"问题1", "问题2", "问题3"}, "s", "")
	answerQuestionTool("问题2", "推导答案2", "derived", "基于外部推理", "s", "")
	answerQuestionTool("问题1", "推导答案1", "derived", "基于问题2", "s", "")
	answerQuestionTool("问题3", "推导答案3", "derived", "基于问题2", "s", "")

	result := finalizeQuestionsTool("s", "")
	if result["status"] != "ready" {
		t.Errorf("expected status 'ready', got '%s'", result["status"])
	}

	loc, _ := result["pool_location"].(string)
	data, err := os.ReadFile(loc)
	if err != nil {
		t.Fatalf("failed to read archived state: %v", err)
	}
	var state map[string]interface{}
	json.Unmarshal(data, &state)
	for _, q := range state["questions"].([]interface{}) {
		m := q.(map[string]interface{})
		if m["source"] != "derived" {
			t.Errorf("expected all source='derived', got '%v'", m["source"])
		}
	}
}

// ============================================================
// IT12: Multiple History
// ============================================================

func TestIT12_MultipleHistoryLengthAndAnswer(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"问题A"}, "s", "")
	answerQuestionTool("问题A", "答案A", "user", "", "s", "")

	r1 := updateAnswerTool("问题A", "答案B", "第一次修改", "s", "")
	if r1["matched_question"] != "问题A" {
		t.Errorf("r1: expected '问题A', got '%s'", r1["matched_question"])
	}
	if r1["previous_answer"] != "答案A" {
		t.Errorf("r1: expected previous_answer '答案A', got '%v'", r1["previous_answer"])
	}
	ar1, _ := r1["action_required"].(map[string]interface{})
	if ar1["type"] != "reanalyze_all" {
		t.Errorf("r1: expected reanalyze_all, got '%s'", ar1["type"])
	}

	r2 := updateAnswerTool("问题A", "答案C", "第二次修改", "s", "")
	if r2["matched_question"] != "问题A" {
		t.Errorf("r2: expected '问题A', got '%s'", r2["matched_question"])
	}
	if r2["previous_answer"] != "答案B" {
		t.Errorf("r2: expected previous_answer '答案B', got '%v'", r2["previous_answer"])
	}

	result := getStatusTool("full", "s", "")
	questions, _ := result["questions"].([]interface{})
	q := questions[0].(map[string]interface{})
	history, _ := q["history"].([]interface{})
	if len(history) != 2 {
		t.Errorf("expected history length 2, got %d", len(history))
	}
	if q["answer"] != "答案C" {
		t.Errorf("expected answer '答案C', got '%v'", q["answer"])
	}

	state := readPoolState(t, "s")
	sq := state["questions"].([]interface{})[0].(map[string]interface{})
	sh := sq["history"].([]interface{})
	if len(sh) != 2 {
		t.Errorf("state: expected history length 2, got %d", len(sh))
	}
	if sq["answer"] != "答案C" {
		t.Errorf("state: expected answer '答案C', got '%v'", sq["answer"])
	}
}

// ============================================================
// IT13: Total Pending Count
// ============================================================

func TestIT13_PendingCountSequence(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	r1 := addQuestionsTool([]string{"问题A", "问题B"}, "s", "")
	if v, ok := getIntFromResult(r1, "total_pending"); ok && v != 2 {
		t.Errorf("r1: expected total_pending=2, got %d", v)
	}

	r2 := addQuestionsTool([]string{"问题C", "问题D", "问题E"}, "s", "")
	if v, ok := getIntFromResult(r2, "total_pending"); ok && v != 5 {
		t.Errorf("r2: expected total_pending=5, got %d", v)
	}

	answerQuestionTool("问题A", "答案A", "user", "", "s", "")
	r3 := getStatusTool("summary", "s", "")
	if v, ok := getIntFromResult(r3, "pending"); ok && v != 4 {
		t.Errorf("r3: expected pending=4, got %d", v)
	}

	answerQuestionTool("问题B", "答案B", "derived", "基于问题A", "s", "")
	r4 := getStatusTool("summary", "s", "")
	if v, ok := getIntFromResult(r4, "pending"); ok && v != 3 {
		t.Errorf("r4: expected pending=3, got %d", v)
	}

	answerQuestionTool("问题C", "答案C", "user", "", "s", "")
	r5 := getStatusTool("summary", "s", "")
	if v, ok := getIntFromResult(r5, "pending"); ok && v != 2 {
		t.Errorf("r5: expected pending=2, got %d", v)
	}

	assertPendingCount(t, "s", 2)
}

// ============================================================
// IT14: GetStatus Summary
// ============================================================

func TestIT14_SummaryReturnsCorrectCounts(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"问题A", "问题B"}, "s", "")

	result := getStatusTool("summary", "s", "")
	if v, ok := getIntFromResult(result, "total"); ok && v != 2 {
		t.Errorf("expected total=2, got %d", v)
	}
	if v, ok := getIntFromResult(result, "pending"); ok && v != 2 {
		t.Errorf("expected pending=2, got %d", v)
	}
	if v, ok := getIntFromResult(result, "answered"); ok && v != 0 {
		t.Errorf("expected answered=0, got %d", v)
	}
}

func TestIT14_SummaryDoesNotChangeFile(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"问题A", "问题B"}, "s", "")

	stateFile := stateFileOf(t, "s")
	before, _ := os.ReadFile(stateFile)

	getStatusTool("summary", "s", "")

	after, _ := os.ReadFile(stateFile)
	if string(before) != string(after) {
		t.Error("get_status(summary) should not modify the state file")
	}
}

// ============================================================
// IT15: External Clear Recovery
// ============================================================

func TestIT15_RebuildAfterExternalDelete(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"问题A", "问题B", "问题C"}, "s", "")
	answerQuestionTool("问题A", "答案A", "user", "", "s", "")

	stateFile := stateFileOf(t, "s")
	os.Remove(stateFile)

	state, err := loadState("s", "")
	if err != nil {
		t.Fatalf("loadState error: %v", err)
	}
	questions, _ := state["questions"].([]interface{})
	if len(questions) != 0 {
		t.Errorf("expected empty questions, got %v", questions)
	}
	if v, ok := state["next_id"].(float64); !ok || int(v) != 1 {
		t.Errorf("expected next_id=1, got %v", state["next_id"])
	}
}

// ============================================================
// IT16: Reset Questions
// ============================================================

func TestIT16_FullResetClearsAll(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"问题A", "问题B", "问题C"}, "s", "")
	answerQuestionTool("问题A", "答案A", "user", "", "s", "")

	result := resetQuestionsTool(false, "s", "")
	if v, ok := getIntFromResult(result, "cleared_count"); ok && v != 3 {
		t.Errorf("expected cleared_count=3, got %d", v)
	}
	if v, ok := getIntFromResult(result, "remaining_count"); ok && v != 0 {
		t.Errorf("expected remaining_count=0, got %d", v)
	}
	if v, ok := getIntFromResult(result, "total_pending"); ok && v != 0 {
		t.Errorf("expected total_pending=0, got %d", v)
	}

	status := getStatusTool("summary", "s", "")
	if v, ok := getIntFromResult(status, "total"); ok && v != 0 {
		t.Errorf("expected total=0, got %d", v)
	}
	if finalizeQuestionsTool("s", "")["status"] != "ready" {
		t.Error("expected finalize to be ready after reset")
	}
}

func TestIT16_OnlyPendingKeepsAnswered(t *testing.T) {
	origCwd := setupPoolEnv(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"问题A", "问题B", "问题C"}, "s", "")
	answerQuestionTool("问题A", "答案A", "user", "", "s", "")
	answerQuestionTool("问题B", "答案B", "derived", "基于问题A", "s", "")

	result := resetQuestionsTool(true, "s", "")
	if v, ok := getIntFromResult(result, "cleared_count"); ok && v != 1 {
		t.Errorf("expected cleared_count=1, got %d", v)
	}
	if v, ok := getIntFromResult(result, "remaining_count"); ok && v != 2 {
		t.Errorf("expected remaining_count=2, got %d", v)
	}
	if v, ok := getIntFromResult(result, "total_pending"); ok && v != 0 {
		t.Errorf("expected total_pending=0, got %d", v)
	}

	status := getStatusTool("full", "s", "")
	questions, _ := status["questions"].([]interface{})
	if len(questions) != 2 {
		t.Fatalf("expected 2 remaining questions, got %d", len(questions))
	}

	var qA, qB map[string]interface{}
	for _, q := range questions {
		m := q.(map[string]interface{})
		if m["question"] == "问题A" {
			qA = m
		} else {
			qB = m
		}
	}
	if qA == nil || qB == nil {
		t.Fatal("expected both 问题A and 问题B")
	}
	if qA["answer"] != "答案A" {
		t.Errorf("问题A answer should be '答案A', got '%v'", qA["answer"])
	}
	if qB["source"] != "derived" {
		t.Errorf("问题B source should be 'derived', got '%v'", qB["source"])
	}
}

// ============================================================
// Helpers
// ============================================================

func getIntFromResult(result map[string]interface{}, key string) (int, bool) {
	v, ok := result[key]
	if !ok {
		return 0, false
	}
	switch val := v.(type) {
	case float64:
		return int(val), true
	case int:
		return val, true
	default:
		return 0, false
	}
}
