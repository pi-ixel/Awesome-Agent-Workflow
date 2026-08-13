package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// ============================================================
// Helpers
// ============================================================

// setupPool redirects the pool root to a temp dir and chdirs into a
// temp project workdir.
func setupPool(t *testing.T) (origCwd string) {
	t.Helper()
	origCwd, _ = os.Getwd()
	poolRoot := t.TempDir()
	t.Setenv("QUESTION_TRACKER_HOME", poolRoot)
	workDir := t.TempDir()
	os.Chdir(workDir)
	return origCwd
}

// mustCreatePool explicitly creates a pool via the dedicated create_session
// tool. Test setups must use it before the first add_questions — add no
// longer creates pools implicitly.
func mustCreatePool(t *testing.T, session string) {
	t.Helper()
	r := createSessionTool(session, "")
	if e, ok := r["error"]; ok && e != nil && e != "" {
		t.Fatalf("mustCreatePool(%q): %v", session, e)
	}
}

// poolDirOf returns the directory of a pool via resolveStateFilePath.
func poolDirOf(t *testing.T, session, project string) string {
	t.Helper()
	p, err := resolveStateFilePath(session, project)
	if err != nil {
		t.Fatalf("resolveStateFilePath(%q, %q): %v", session, project, err)
	}
	return filepath.Dir(p)
}

// isValidationErr checks for ValidationError type.
func isValidationErr(err error) bool {
	_, ok := err.(ValidationError)
	return ok
}

// isMissingSessionErr checks for MissingSessionError type.
func isMissingSessionErr(err error) bool {
	_, ok := err.(MissingSessionError)
	return ok
}

// ============================================================
// UT-NS-01 ~ UT-NS-03: validateSessionName / missing session
// ============================================================

func TestValidateSessionName_UT_NS_01_ValidNames(t *testing.T) {
	valid := []string{
		"sr001-用户认证",
		"sr001-ar002-支付回调",
		"req-订单状态机",
		"with space inside",
		"中文纯文字",
		"a_b-c.d",
	}
	for _, name := range valid {
		if err := validateSessionName(name); err != nil {
			t.Errorf("session name %q should be valid, got error: %v", name, err)
		}
	}
}

func TestValidateSessionName_UT_NS_02_InvalidNames(t *testing.T) {
	longName := strings.Repeat("a", 129)
	bad := []string{
		"..", "../escape", "a/../b", "a/b", "a\\b",
		"/abs", "C:\\win", "line\nbreak", "tab\there", longName,
	}
	for _, name := range bad {
		err := validateSessionName(name)
		if err == nil {
			t.Errorf("session name %q should be rejected", name)
			continue
		}
		if !isValidationErr(err) {
			t.Errorf("session name %q should return ValidationError, got %T", name, err)
		}
		if isMissingSessionErr(err) {
			t.Errorf("session name %q should NOT return MissingSessionError", name)
		}
	}
}

func TestResolveStateFile_UT_NS_03_EmptyOrBlankIsMissingSession(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	for _, name := range []string{"", "   ", " \t "} {
		_, err := resolveStateFilePath(name, "")
		if err == nil {
			t.Errorf("session %q should return error", name)
			continue
		}
		if !isMissingSessionErr(err) {
			t.Errorf("session %q should return MissingSessionError, got %T", name, err)
		}
		if isValidationErr(err) {
			t.Errorf("session %q should NOT return ValidationError", name)
		}
	}
}

// ============================================================
// UT-NS-10 ~ UT-NS-14: path resolution
// ============================================================

func TestResolveStateFile_UT_NS_10_PathStructure(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	p, err := resolveStateFilePath("sr001-auth", "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	norm := filepath.ToSlash(p)
	if !strings.HasSuffix(norm, "/sr001-auth/state.json") {
		t.Errorf("path should end with /sr001-auth/state.json, got: %s", norm)
	}
	root := os.Getenv("QUESTION_TRACKER_HOME")
	if !strings.HasPrefix(p, root) {
		t.Errorf("path should be under QUESTION_TRACKER_HOME %s, got: %s", root, p)
	}
}

func TestResolveStateFile_UT_NS_11_ProjectParamOverrides(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	p1, err1 := resolveStateFilePath("s", "project-alpha")
	p2, err2 := resolveStateFilePath("s", "project-beta")
	if err1 != nil || err2 != nil {
		t.Fatalf("unexpected errors: %v / %v", err1, err2)
	}
	if p1 == p2 {
		t.Error("different project params should produce different paths")
	}
	if !strings.Contains(filepath.ToSlash(p1), "project-alpha") {
		t.Errorf("path should contain project-alpha: %s", p1)
	}
}

func TestResolveStateFile_UT_NS_12_DifferentSessionsDifferentPaths(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	p1, _ := resolveStateFilePath("sr001", "")
	p2, _ := resolveStateFilePath("sr002", "")
	if p1 == p2 {
		t.Error("different sessions must map to different state files")
	}
}

func TestPoolRoot_UT_NS_13_EnvOverrideAndHomeFallback(t *testing.T) {
	// Scene A: env override
	t.Setenv("QUESTION_TRACKER_HOME", filepath.Join(t.TempDir(), "custom-pool"))
	got := poolRoot()
	want := os.Getenv("QUESTION_TRACKER_HOME")
	if got != want {
		t.Errorf("env override: expected %s, got %s", want, got)
	}

	// Scene B: no env → home fallback
	os.Unsetenv("QUESTION_TRACKER_HOME")
	got = poolRoot()
	if !strings.HasSuffix(filepath.ToSlash(got), ".question-tracker") {
		t.Errorf("home fallback should end with .question-tracker, got: %s", got)
	}
	home, _ := os.UserHomeDir()
	if !strings.HasPrefix(got, home) {
		t.Errorf("home fallback should be under user home %s, got: %s", home, got)
	}
}

func TestResolveProjectDir_UT_NS_14_CwdSlugStable(t *testing.T) {
	origCwd, _ := os.Getwd()
	poolRoot := t.TempDir()
	t.Setenv("QUESTION_TRACKER_HOME", poolRoot)
	workDir := filepath.Join(t.TempDir(), "someproject")
	os.MkdirAll(workDir, 0755)
	os.Chdir(workDir)
	defer os.Chdir(origCwd)

	d1, err1 := resolveProjectDir("")
	d2, err2 := resolveProjectDir("")
	if err1 != nil || err2 != nil {
		t.Fatalf("unexpected errors: %v / %v", err1, err2)
	}
	if d1 != d2 {
		t.Errorf("same CWD should produce stable slug: %s vs %s", d1, d2)
	}
	base := filepath.Base(d1)
	if !strings.HasPrefix(base, "someproject-") {
		t.Errorf("slug should start with someproject-, got: %s", base)
	}
	suffix := strings.TrimPrefix(base, "someproject-")
	if len(suffix) != 6 {
		t.Errorf("hash suffix should be 6 chars, got: %s", suffix)
	}
}

// ============================================================
// IT-NS-20 ~ IT-NS-24: add_questions pool creation
// ============================================================

func TestAddQuestions_IT_NS_20_AddOnMissingPoolReturnsGuidance(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	// add_questions 不再隐式建池：未建池时返回选池指引，且不落盘
	result := addQuestionsTool([]string{"Q1", "Q2"}, "sr001-auth", "")
	if result["error"] != nil {
		t.Fatalf("guidance must not be an error, got: %v", result["error"])
	}
	if result["action_required"] != "select_session" || result["reason"] != "session_not_found" {
		t.Fatalf("expected session_not_found guidance, got: %v", result)
	}
	if _, err := os.Stat(poolDirOf(t, "sr001-auth", "")); !os.IsNotExist(err) {
		t.Error("pool must NOT be silently created by add_questions")
	}

	// 显式建池后即可正常添加
	mustCreatePool(t, "sr001-auth")
	result = addQuestionsTool([]string{"Q1", "Q2"}, "sr001-auth", "")
	if result["error"] != nil {
		t.Fatalf("add after create should succeed, got: %v", result["error"])
	}
	if v, ok := getIntFromResult(result, "added_count"); !ok || v != 2 {
		t.Errorf("expected added_count 2, got %v", result["added_count"])
	}
	loc, ok := result["pool_location"].(string)
	if !ok || loc == "" {
		t.Fatal("expected pool_location in result")
	}
	data, err := os.ReadFile(loc)
	if err != nil {
		t.Fatalf("state file should exist at pool_location: %v", err)
	}
	var state map[string]interface{}
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatalf("state file should be valid JSON: %v", err)
	}
	qs, _ := state["questions"].([]interface{})
	if len(qs) != 2 {
		t.Errorf("expected 2 questions persisted, got %d", len(qs))
	}
}

func TestAddQuestions_IT_NS_21_IdempotentOnExistingPool(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s1")
	addQuestionsTool([]string{"Q1"}, "s1", "")
	result := addQuestionsTool([]string{"Q2"}, "s1", "")
	if result["error"] != nil {
		t.Fatalf("second add to same pool should succeed: %v", result["error"])
	}

	status := getStatusTool("summary", "s1", "")
	if v, ok := getIntFromResult(status, "total"); !ok || v != 2 {
		t.Errorf("pool should contain 2 questions, got %v", status["total"])
	}
}

func TestAddQuestions_IT_NS_22_InvalidSessionRejected(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	result := addQuestionsTool([]string{"Q1"}, "../escape", "")
	if result["error"] == nil {
		t.Error("path-traversal session name must be rejected")
	}
	// No directory should have been created outside the project dir
	projDir, err := resolveProjectDir("")
	if err != nil {
		t.Fatalf("resolveProjectDir: %v", err)
	}
	entries, _ := os.ReadDir(projDir)
	for _, e := range entries {
		if strings.Contains(e.Name(), "escape") {
			t.Errorf("no directory named escape should exist: %s", e.Name())
		}
	}
}

func TestAddQuestions_IT_NS_23_AllSixToolsMissingSession(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	results := []map[string]interface{}{
		addQuestionsTool([]string{"Q1"}, "", ""),
		answerQuestionTool("Q1", "A1", "user", "", "", ""),
		getStatusTool("summary", "", ""),
		finalizeQuestionsTool("", ""),
		updateAnswerTool("Q1", "A", "r", "", ""),
		resetQuestionsTool(false, "", ""),
	}
	for i, r := range results {
		if r["error"] != nil {
			t.Errorf("tool #%d: missing-session 是指引不是错误, got: %v", i, r["error"])
		}
		if r["action_required"] != "select_session" || r["reason"] != "missing_session" {
			t.Errorf("tool #%d should return missing_session guidance, got: %v", i, r)
		}
	}
	// No default pool should exist anywhere
	root := os.Getenv("QUESTION_TRACKER_HOME")
	found := false
	filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err == nil && info.IsDir() && info.Name() == "default" {
			found = true
		}
		return nil
	})
	if found {
		t.Error("no default pool should be created")
	}
}

func TestAddQuestions_IT_NS_24_EmptyProjectUsesCwd(t *testing.T) {
	origCwd, _ := os.Getwd()
	t.Setenv("QUESTION_TRACKER_HOME", t.TempDir())
	workDir := filepath.Join(t.TempDir(), "someproject")
	os.MkdirAll(workDir, 0755)
	os.Chdir(workDir)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s1")
	result := addQuestionsTool([]string{"Q1"}, "s1", "")
	if result["error"] != nil {
		t.Fatalf("add failed: %v", result["error"])
	}
	loc, _ := result["pool_location"].(string)
	if !strings.Contains(filepath.ToSlash(loc), "someproject-") {
		t.Errorf("pool_location should contain CWD-derived slug 'someproject-', got: %s", loc)
	}
}

// ============================================================
// IT-NS-30 ~ IT-NS-34: read/write tools list pools on miss
// ============================================================

func setupTwoPools(t *testing.T) (origCwd string) {
	origCwd = setupPool(t)
	mustCreatePool(t, "sr001-用户认证")
	addQuestionsTool([]string{"Q1"}, "sr001-用户认证", "")
	mustCreatePool(t, "sr002-权限模型")
	addQuestionsTool([]string{"Q2"}, "sr002-权限模型", "")
	return origCwd
}

func assertSessionNotFoundShape(t *testing.T, r map[string]interface{}, requested string) {
	t.Helper()
	if r["error"] != nil {
		t.Fatalf("session_not_found 是指引不是错误, got: %v", r["error"])
	}
	if r["action_required"] != "select_session" || r["reason"] != "session_not_found" {
		t.Fatalf("expected session_not_found guidance, got: %v", r)
	}
	if r["requested_session"] != requested {
		t.Errorf("expected requested_session=%q, got %v", requested, r["requested_session"])
	}
	avail, ok := r["available_sessions"].([]interface{})
	if !ok || len(avail) != 2 {
		t.Fatalf("expected 2 available sessions, got: %v", r["available_sessions"])
	}
	names := map[string]bool{}
	for _, s := range avail {
		names[s.(string)] = true
	}
	if !names["sr001-用户认证"] || !names["sr002-权限模型"] {
		t.Errorf("available_sessions should list both pools: %v", names)
	}
	if g, _ := r["guidance"].(string); g == "" {
		t.Error("expected guidance text in result")
	}
}

func TestGetStatus_IT_NS_30_ListsAvailableOnMissingSession(t *testing.T) {
	origCwd := setupTwoPools(t)
	defer os.Chdir(origCwd)

	result := getStatusTool("summary", "sr001-typo", "")
	assertSessionNotFoundShape(t, result, "sr001-typo")
}

func TestAnswerQuestion_IT_NS_31_ListsAvailableOnMissingSession(t *testing.T) {
	origCwd := setupTwoPools(t)
	defer os.Chdir(origCwd)

	result := answerQuestionTool("Q1", "A1", "user", "", "sr001-typo", "")
	assertSessionNotFoundShape(t, result, "sr001-typo")
}

func TestFinalize_IT_NS_32_ListsAvailableOnMissingSession(t *testing.T) {
	origCwd := setupTwoPools(t)
	defer os.Chdir(origCwd)

	result := finalizeQuestionsTool("sr001-typo", "")
	assertSessionNotFoundShape(t, result, "sr001-typo")
}

func TestReset_IT_NS_33_ListsAvailableOnMissingSession(t *testing.T) {
	origCwd := setupTwoPools(t)
	defer os.Chdir(origCwd)

	result := resetQuestionsTool(false, "sr001-typo", "")
	assertSessionNotFoundShape(t, result, "sr001-typo")
}

func TestUpdateAnswer_IT_NS_34_ListsAvailableOnMissingSession(t *testing.T) {
	origCwd := setupTwoPools(t)
	defer os.Chdir(origCwd)

	result := updateAnswerTool("Q1", "A", "r", "sr001-typo", "")
	assertSessionNotFoundShape(t, result, "sr001-typo")
}

// ============================================================
// IT-NS-35 ~ IT-NS-36: pool_location on success paths
// ============================================================

func TestAnswerQuestion_IT_NS_35_SuccessHasPoolLocation(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s1")
	addQuestionsTool([]string{"Q1"}, "s1", "")
	result := answerQuestionTool("Q1", "A1", "user", "", "s1", "")
	if result["error"] != nil {
		t.Fatalf("answer failed: %v", result["error"])
	}
	loc, ok := result["pool_location"].(string)
	if !ok || !strings.HasSuffix(filepath.ToSlash(loc), "/s1/state.json") {
		t.Errorf("pool_location should end with /s1/state.json, got: %v", result["pool_location"])
	}
}

func TestGetStatus_IT_NS_36_SuccessHasPoolLocation(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s1")
	addQuestionsTool([]string{"Q1"}, "s1", "")
	result := getStatusTool("summary", "s1", "")
	if result["error"] != nil {
		t.Fatalf("get_status failed: %v", result["error"])
	}
	loc, ok := result["pool_location"].(string)
	if !ok || !strings.HasSuffix(filepath.ToSlash(loc), "/s1/state.json") {
		t.Errorf("pool_location should end with /s1/state.json, got: %v", result["pool_location"])
	}
}

// ============================================================
// IT-NS-37 ~ IT-NS-38: update/reset pool_location
// ============================================================

func TestUpdateAnswer_IT_NS_37_SuccessHasPoolLocation(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s1")
	addQuestionsTool([]string{"Q1"}, "s1", "")
	answerQuestionTool("Q1", "A1", "user", "", "s1", "")
	result := updateAnswerTool("Q1", "新答案", "纠正", "s1", "")
	if result["error"] != nil {
		t.Fatalf("update failed: %v", result["error"])
	}
	loc, ok := result["pool_location"].(string)
	if !ok || !strings.HasSuffix(filepath.ToSlash(loc), "/s1/state.json") {
		t.Errorf("pool_location should end with /s1/state.json, got: %v", result["pool_location"])
	}
}

func TestResetQuestions_IT_NS_38_SuccessHasPoolLocation(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s1")
	addQuestionsTool([]string{"Q1", "Q2"}, "s1", "")
	answerQuestionTool("Q1", "A1", "user", "", "s1", "")
	result := resetQuestionsTool(true, "s1", "")
	if result["error"] != nil {
		t.Fatalf("reset failed: %v", result["error"])
	}
	loc, ok := result["pool_location"].(string)
	if !ok || !strings.HasSuffix(filepath.ToSlash(loc), "/s1/state.json") {
		t.Errorf("pool_location should end with /s1/state.json, got: %v", result["pool_location"])
	}
}

// ============================================================
// IT-NS-40 / IT-NS-42 / IT-NS-43 / IT-NS-50: isolation & listing
// ============================================================

func TestPoolIsolation_IT_NS_40_TwoPoolsDoNotSeeEachOther(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "sr001")
	addQuestionsTool([]string{"Q-sr1"}, "sr001", "")
	mustCreatePool(t, "sr002")
	addQuestionsTool([]string{"Q-sr2"}, "sr002", "")

	s1 := getStatusTool("full", "sr001", "")
	s2 := getStatusTool("full", "sr002", "")

	qs1, _ := s1["questions"].([]interface{})
	qs2, _ := s2["questions"].([]interface{})
	if len(qs1) != 1 || len(qs2) != 1 {
		t.Fatalf("each pool should hold exactly 1 question: %d / %d", len(qs1), len(qs2))
	}
	q1 := qs1[0].(map[string]interface{})["question"]
	q2 := qs2[0].(map[string]interface{})["question"]
	if q1 != "Q-sr1" || q2 != "Q-sr2" {
		t.Errorf("pools leaked into each other: %v / %v", q1, q2)
	}

	answerQuestionTool("Q-sr1", "A1", "user", "", "sr001", "")
	s2After := getStatusTool("summary", "sr002", "")
	if v, ok := getIntFromResult(s2After, "pending"); !ok || v != 1 {
		t.Errorf("sr002 pool should be untouched, pending=1, got %v", s2After["pending"])
	}
}

func TestListSessions_IT_NS_42_ReturnsAllPools(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "alpha")
	addQuestionsTool([]string{"Q1"}, "alpha", "")
	mustCreatePool(t, "beta")
	addQuestionsTool([]string{"Q2"}, "beta", "")
	mustCreatePool(t, "中文会话")
	addQuestionsTool([]string{"Q3"}, "中文会话", "")

	result := listSessionsTool(false, "")
	sessions, ok := result["sessions"].([]interface{})
	if !ok || len(sessions) != 3 {
		t.Fatalf("expected 3 sessions, got: %v", result["sessions"])
	}
	names := map[string]bool{}
	for _, s := range sessions {
		m := s.(map[string]interface{})
		names[m["name"].(string)] = true
		if m["path"] == nil || m["path"] == "" {
			t.Error("session should have path")
		}
		if m["total"] == nil || m["pending"] == nil {
			t.Error("session should have total and pending")
		}
		if m["archived"] != false {
			t.Error("active session should have archived=false")
		}
	}
	for _, want := range []string{"alpha", "beta", "中文会话"} {
		if !names[want] {
			t.Errorf("missing session %q in list: %v", want, names)
		}
	}
}

func TestListSessions_IT_NS_43_EmptyWhenProjectMissing(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	result := listSessionsTool(false, "")
	if result["error"] != nil {
		t.Fatalf("should not return error: %v", result["error"])
	}
	sessions, ok := result["sessions"].([]interface{})
	if !ok {
		t.Fatalf("sessions should be a list, got: %v", result["sessions"])
	}
	if len(sessions) != 0 {
		t.Errorf("expected empty sessions, got %d", len(sessions))
	}
}

func TestProjectIsolation_IT_NS_50_SameSessionDifferentProjects(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	createSessionTool("s", "project-a")
	createSessionTool("s", "project-b")
	addQuestionsTool([]string{"Q-projA"}, "s", "project-a")
	addQuestionsTool([]string{"Q-projB"}, "s", "project-b")

	sa := getStatusTool("full", "s", "project-a")
	sb := getStatusTool("full", "s", "project-b")
	qa, _ := sa["questions"].([]interface{})
	qb, _ := sb["questions"].([]interface{})
	if len(qa) != 1 || len(qb) != 1 {
		t.Fatalf("each project pool should have 1 question: %d / %d", len(qa), len(qb))
	}
	if qa[0].(map[string]interface{})["question"] != "Q-projA" {
		t.Error("project-a pool contaminated")
	}
	if qb[0].(map[string]interface{})["question"] != "Q-projB" {
		t.Error("project-b pool contaminated")
	}
}

// ============================================================
// IT-NS-60 ~ IT-NS-62: concurrency
// ============================================================

func TestConcurrency_IT_NS_60_SamePoolAnswersSerialized(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	questions := []string{"Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7", "Q8", "Q9", "Q10"}
	mustCreatePool(t, "s")
	addQuestionsTool(questions, "s", "")

	var wg sync.WaitGroup
	errs := make(chan map[string]interface{}, 10)
	for i, q := range questions {
		wg.Add(1)
		go func(qtext, ans string) {
			defer wg.Done()
			r := answerQuestionTool(qtext, ans, "user", "", "s", "")
			if r["error"] != nil {
				errs <- r
			}
		}(q, "A"+strings.Repeat("x", i+1))
	}
	wg.Wait()
	close(errs)
	for r := range errs {
		t.Errorf("concurrent answer failed: %v", r["error"])
	}

	s := getStatusTool("summary", "s", "")
	if v, ok := getIntFromResult(s, "pending"); !ok || v != 0 {
		t.Errorf("expected pending=0, got %v", s["pending"])
	}
	if v, ok := getIntFromResult(s, "answered"); !ok || v != 10 {
		t.Errorf("expected answered=10, got %v", s["answered"])
	}
}

func TestConcurrency_IT_NS_61_DifferentPoolsAddInParallel(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			pool := "pool-" + strings.Repeat("p", idx+1)
			// 建池并发必须无竞争；建成后再 add
			if r := createSessionTool(pool, ""); r["error"] != nil {
				t.Errorf("concurrent create failed: %v", r["error"])
				return
			}
			if r := addQuestionsTool([]string{"Q"}, pool, ""); r["error"] != nil {
				t.Errorf("add after create failed: %v", r["error"])
			}
		}(i)
	}
	wg.Wait()

	r := listSessionsTool(false, "")
	sessions, _ := r["sessions"].([]interface{})
	if len(sessions) != 10 {
		t.Errorf("expected 10 pools, got %d", len(sessions))
	}
}

func TestConcurrency_IT_NS_62_FirstAddSamePoolNoRace(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "race-pool")
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			qs := []string{"Q" + strings.Repeat("a", idx+1) + "-1", "Q" + strings.Repeat("a", idx+1) + "-2"}
			r := addQuestionsTool(qs, "race-pool", "")
			if r["error"] != nil {
				t.Errorf("concurrent first-add failed: %v", r["error"])
			}
		}(i)
	}
	wg.Wait()

	s := getStatusTool("summary", "race-pool", "")
	if v, ok := getIntFromResult(s, "total"); !ok || v != 10 {
		t.Errorf("expected total=10, got %v", s["total"])
	}
}

// ============================================================
// IT-NS-63 / IT-NS-64: review follow-ups
// ============================================================

func TestConcurrency_IT_NS_63_GetStatusNeverSeesTornState(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	// Pool with 5 questions; one writer keeps mutating, readers keep reading.
	questions := []string{"Q1", "Q2", "Q3", "Q4", "Q5"}
	mustCreatePool(t, "s")
	addQuestionsTool(questions, "s", "")
	answerQuestionTool("Q1", "A1", "user", "", "s", "")
	answerQuestionTool("Q2", "A2", "user", "", "s", "")

	stop := make(chan struct{})
	var writerWg sync.WaitGroup
	writerWg.Add(1)
	go func() {
		defer writerWg.Done()
		for {
			select {
			case <-stop:
				return
			default:
				updateAnswerTool("Q1", "A1b", "r", "s", "")
				updateAnswerTool("Q1", "A1c", "r", "s", "")
			}
		}
	}()

	// Readers run a fixed number of iterations; every read must see a
	// consistent state (total always 5, never a torn/empty pool).
	var readerWg sync.WaitGroup
	failures := make(chan string, 16)
	for i := 0; i < 4; i++ {
		readerWg.Add(1)
		go func() {
			defer readerWg.Done()
			for j := 0; j < 200; j++ {
				r := getStatusTool("summary", "s", "")
				if r["error"] != nil {
					select {
					case failures <- "get_status returned error: " + r["error"].(string):
					default:
					}
					return
				}
				total, _ := getIntFromResult(r, "total")
				if total != 5 {
					select {
					case failures <- fmt.Sprintf("get_status saw torn state: total=%d (want 5)", total):
					default:
					}
					return
				}
			}
		}()
	}

	readerWg.Wait()
	close(stop)
	writerWg.Wait()

	select {
	case f := <-failures:
		t.Fatal(f)
	default:
	}
}

func TestAddQuestions_IT_NS_64_StateAndNextIDConsistent(t *testing.T) {
	origCwd := setupPool(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"Q1", "Q2", "Q3"}, "s", "")

	stateFile := poolDirOf(t, "s", "") + "/state.json"
	data, err := os.ReadFile(stateFile)
	if err != nil {
		t.Fatalf("read state: %v", err)
	}
	var state map[string]interface{}
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatalf("parse state: %v", err)
	}
	qs, _ := state["questions"].([]interface{})
	if len(qs) != 3 {
		t.Fatalf("expected 3 questions, got %d", len(qs))
	}
	maxID := 0
	for _, q := range qs {
		m := q.(map[string]interface{})
		id := int(m["id"].(float64))
		if id > maxID {
			maxID = id
		}
	}
	nextID := int(state["next_id"].(float64))
	if nextID != maxID+1 {
		t.Errorf("next_id should equal max(id)+1 (%d), got %d — questions and next_id must be written in one save", maxID+1, nextID)
	}
}
