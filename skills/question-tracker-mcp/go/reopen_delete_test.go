package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ============================================================
// Helpers
// ============================================================

// archivedNameOf returns the archived directory name for a session
// (first entry under .archive starting with "<session>-").
func archivedNameOf(t *testing.T, session string) string {
	t.Helper()
	archDir := archiveDirOf(t)
	entries, err := os.ReadDir(archDir)
	if err != nil {
		t.Fatalf("read archive dir: %v", err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), session+"-") {
			return e.Name()
		}
	}
	t.Fatalf("no archived dir for session %q in %s", session, archDir)
	return ""
}

// ============================================================
// IT-RD-01 / IT-RD-01b: reopen happy path
// ============================================================

func TestReopen_IT_RD_01_HappyPath(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	makeAnsweredPool(t, "s", []string{"Q1"})
	finalizeQuestionsTool("s", "")
	archived := archivedNameOf(t, "s")

	r := reopenSessionTool(archived, "")
	if r["error"] != nil {
		t.Fatalf("reopen failed: %v", r["error"])
	}
	if r["reopened"] != "s" {
		t.Errorf("expected reopened='s', got %v", r["reopened"])
	}
	if !dirExists(poolDirOfSession(t, "s")) {
		t.Error("pool should be back in active area")
	}
	if dirExists(filepath.Join(archiveDirOf(t), archived)) {
		t.Error("archived copy should be moved away")
	}

	u := updateAnswerTool("Q1", "新答案", "纠正", "s", "")
	if u["error"] != nil {
		t.Fatalf("update after reopen failed: %v", u["error"])
	}
}

func TestReopen_IT_RD_01b_ReopenThenFinalizeArchivesAgain(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	makeAnsweredPool(t, "s", []string{"Q1"})
	finalizeQuestionsTool("s", "")
	archived := archivedNameOf(t, "s")
	reopenSessionTool(archived, "")
	updateAnswerTool("Q1", "新答案", "纠正", "s", "")

	r := finalizeQuestionsTool("s", "")
	if r["status"] != "ready" {
		t.Fatalf("expected ready after reopen+update, got: %v", r["status"])
	}
	if !dirExists(filepath.Join(archiveDirOf(t), archived)) {
		t.Error("pool should be archived again after finalize")
	}
}

// ============================================================
// IT-RD-02 ~ IT-RD-04: reopen error paths
// ============================================================

func TestReopen_IT_RD_02_ArchiveNotFoundListsArchived(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	makeAnsweredPool(t, "other", []string{"Q1"})
	finalizeQuestionsTool("other", "")
	existing := archivedNameOf(t, "other")

	r := reopenSessionTool("nonexistent-20260730", "")
	if r["error"] != nil {
		t.Fatalf("guidance must not be an error, got: %v", r["error"])
	}
	if r["reason"] != "session_not_found" {
		t.Fatalf("expected session_not_found guidance, got: %v", r)
	}
	// reopen 的目标在归档区：指引应通过 archived_sessions 列出
	arch, ok := r["archived_sessions"].([]interface{})
	if !ok {
		t.Fatal("expected archived_sessions in guidance")
	}
	found := false
	for _, s := range arch {
		if s.(string) == existing {
			found = true
		}
	}
	if !found {
		t.Errorf("archived_sessions should list archived pool %q: %v", existing, arch)
	}
}

func TestReopen_IT_RD_03_ConflictKeepsBothPools(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	// Active pool "s" with answer A
	mustCreatePool(t, "s")
	addQuestionsTool([]string{"Q1"}, "s", "")
	answerQuestionTool("Q1", "A", "user", "", "s", "")

	// Archived pool "s-..." with answer B (created via a separate cycle)
	makeAnsweredPool(t, "tmp", []string{"QX"})
	finalizeQuestionsTool("tmp", "")
	tmpArchived := archivedNameOf(t, "tmp")
	// Craft an archived pool literally named s-<date> by renaming
	archDir := archiveDirOf(t)
	crafted := filepath.Join(archDir, "s-"+todayStr())
	os.Rename(filepath.Join(archDir, tmpArchived), crafted)
	// Overwrite its content with answer B
	stateFile := filepath.Join(crafted, stateFileName)
	data, _ := os.ReadFile(stateFile)
	content := strings.Replace(string(data), "A-QX", "B", 1)
	os.WriteFile(stateFile, []byte(content), 0644)

	r := reopenSessionTool(filepath.Base(crafted), "")
	if r["error"] != "conflict" {
		t.Fatalf("expected conflict, got: %v", r["error"])
	}
	// Active pool still has answer A
	status := getStatusTool("full", "s", "")
	qs := status["questions"].([]interface{})
	if qs[0].(map[string]interface{})["answer"] != "A" {
		t.Errorf("active pool must keep answer A, got: %v", qs[0])
	}
	// Archived pool still exists
	if !dirExists(crafted) {
		t.Error("archived pool should remain after conflict")
	}
}

func TestReopen_IT_RD_04_VisibleInListAfterReopen(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	makeAnsweredPool(t, "s", []string{"Q1"})
	finalizeQuestionsTool("s", "")
	reopenSessionTool(archivedNameOf(t, "s"), "")

	r := listSessionsTool(false, "")
	sessions, _ := r["sessions"].([]interface{})
	found := false
	for _, s := range sessions {
		if s.(map[string]interface{})["name"] == "s" {
			found = true
		}
	}
	if !found {
		t.Errorf("reopened pool should appear in active list: %v", r["sessions"])
	}
}

// ============================================================
// IT-RD-05 ~ IT-RD-08: delete_session
// ============================================================

func TestDelete_IT_RD_05_NoConfirmRejected(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"Q1"}, "s", "")

	r := deleteSessionTool("s", false, "")
	if r["error"] != "confirm_required" {
		t.Fatalf("expected confirm_required, got: %v", r["error"])
	}
	status := getStatusTool("summary", "s", "")
	if status["error"] != nil {
		t.Error("pool should still be readable after rejected delete")
	}
}

func TestDelete_IT_RD_06_ConfirmDeletesWithAuditStats(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"Q1", "Q2", "Q3"}, "s", "")
	answerQuestionTool("Q1", "A1", "user", "", "s", "")
	answerQuestionTool("Q2", "A2", "user", "", "s", "")

	r := deleteSessionTool("s", true, "")
	if r["error"] != nil {
		t.Fatalf("delete failed: %v", r["error"])
	}
	if r["deleted"] != "s" {
		t.Errorf("expected deleted='s', got %v", r["deleted"])
	}
	if v, ok := getIntFromResult(r, "total"); !ok || v != 3 {
		t.Errorf("expected total=3, got %v", r["total"])
	}
	if v, ok := getIntFromResult(r, "pending"); !ok || v != 1 {
		t.Errorf("expected pending=1, got %v", r["pending"])
	}
	if v, ok := getIntFromResult(r, "answered"); !ok || v != 2 {
		t.Errorf("expected answered=2, got %v", r["answered"])
	}
	if dirExists(poolDirOfSession(t, "s")) {
		t.Error("pool dir should be deleted")
	}
}

func TestDelete_IT_RD_07_NotFoundListsActive(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "other")
	addQuestionsTool([]string{"Q1"}, "other", "")

	r := deleteSessionTool("ghost", true, "")
	if r["reason"] != "session_not_found" || r["error"] != nil {
		t.Fatalf("expected session_not_found guidance, got: %v", r)
	}
	avail, ok := r["available_sessions"].([]interface{})
	if !ok {
		t.Fatal("expected available_sessions")
	}
	found := false
	for _, s := range avail {
		if s.(string) == "other" {
			found = true
		}
	}
	if !found {
		t.Errorf("available_sessions should contain 'other': %v", avail)
	}
}

func TestDelete_IT_RD_08_DoesNotTouchArchived(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	makeAnsweredPool(t, "s", []string{"Q1"})
	finalizeQuestionsTool("s", "")
	archived := archivedNameOf(t, "s")

	r := deleteSessionTool("s", true, "")
	if r["reason"] != "session_not_found" || r["error"] != nil {
		t.Fatalf("expected session_not_found guidance (searched in active area), got: %v", r)
	}
	if !dirExists(filepath.Join(archiveDirOf(t), archived)) {
		t.Error("archived pool must remain intact")
	}
}

// ============================================================
// IT-RD-09 / IT-RD-10: missing session on new tools
// ============================================================

func TestReopen_IT_RD_09_MissingSession(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	r := reopenSessionTool("", "")
	if r["reason"] != "missing_session" || r["error"] != nil {
		t.Errorf("expected missing_session guidance, got: %v", r)
	}
}

func TestDelete_IT_RD_10_MissingSession(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	r := deleteSessionTool("", true, "")
	if r["reason"] != "missing_session" || r["error"] != nil {
		t.Errorf("expected missing_session guidance, got: %v", r)
	}
}

// ============================================================
// IT-RD-11 / IT-RD-12: suffix stripping edge cases
// ============================================================

// craftArchivedPool manually creates an archived pool directory with a
// simple one-question state.json, bypassing finalize (to control the name).
func craftArchivedPool(t *testing.T, archivedName string) string {
	t.Helper()
	archDir := archiveDirOf(t)
	dir := filepath.Join(archDir, archivedName)
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatalf("mkdir archived pool: %v", err)
	}
	state := `{"questions":[{"id":1,"question":"Q1","status":"answered","answer":"A1","source":"user","created_at":"","answered_at":null,"updated_at":null,"history":[]}],"next_id":2}`
	if err := os.WriteFile(filepath.Join(dir, stateFileName), []byte(state), 0644); err != nil {
		t.Fatalf("write archived state: %v", err)
	}
	return dir
}

func TestReopen_IT_RD_11_DateTimeSuffixStrippedFully(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	// Archived name carrying BOTH date and time suffixes (conflict fallback form)
	craftArchivedPool(t, "s-20260730-150405")

	r := reopenSessionTool("s-20260730-150405", "")
	if r["error"] != nil {
		t.Fatalf("reopen failed: %v", r["error"])
	}
	if r["reopened"] != "s" {
		t.Errorf("expected reopened='s' (both suffixes stripped), got %v", r["reopened"])
	}
	if !dirExists(poolDirOfSession(t, "s")) {
		t.Error("pool should be back in active area under original name")
	}
}

func TestReopen_IT_RD_12_SessionNameContainingDateNotMangled(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	// Original session name itself ends with an 8-digit date:
	// archived as <session>-<yyyyMMdd> = report-20260130-20260715
	craftArchivedPool(t, "report-20260130-20260715")

	r := reopenSessionTool("report-20260130-20260715", "")
	if r["error"] != nil {
		t.Fatalf("reopen failed: %v", r["error"])
	}
	if r["reopened"] != "report-20260130" {
		t.Errorf("expected reopened='report-20260130' (only archive suffix stripped), got %v", r["reopened"])
	}
	if !dirExists(poolDirOfSession(t, "report-20260130")) {
		t.Error("pool should be back under full original name")
	}
}
