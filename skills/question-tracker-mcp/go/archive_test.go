package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// ============================================================
// Helpers
// ============================================================

func setupArchivePool(t *testing.T) (origCwd string) {
	t.Helper()
	return setupPool(t)
}

// archiveDirOf returns the .archive directory of the CWD-derived project.
func archiveDirOf(t *testing.T) string {
	t.Helper()
	projDir, err := resolveProjectDir("")
	if err != nil {
		t.Fatalf("resolveProjectDir: %v", err)
	}
	return filepath.Join(projDir, archiveDirName)
}

// poolDirOfSession returns the active pool directory of a session.
func poolDirOfSession(t *testing.T, session string) string {
	t.Helper()
	return poolDirOf(t, session, "")
}

// dirExists checks directory existence.
func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// todayStr returns yyyyMMdd for archive name expectations.
func todayStr() string {
	return time.Now().Format("20060102")
}

// makeAnsweredPool creates a pool with all questions answered.
func makeAnsweredPool(t *testing.T, session string, qs []string) {
	t.Helper()
	mustCreatePool(t, session)
	if r := addQuestionsTool(qs, session, ""); r["error"] != nil {
		t.Fatalf("add to %q failed: %v", session, r["error"])
	}
	for _, q := range qs {
		r := answerQuestionTool(q, "A-"+q, "user", "", session, "")
		if r["error"] != nil {
			t.Fatalf("answer %q failed: %v", q, r["error"])
		}
	}
}

// setMtimeDaysAgo rewrites a directory's mtime to N days ago.
func setMtimeDaysAgo(t *testing.T, path string, days int) {
	t.Helper()
	past := time.Now().Add(-time.Duration(days) * 24 * time.Hour)
	if err := os.Chtimes(path, past, past); err != nil {
		t.Fatalf("chtimes %s: %v", path, err)
	}
}

// ============================================================
// IT-AR-01 ~ IT-AR-04: finalize archiving
// ============================================================

func TestFinalize_IT_AR_01_ReadyArchivesPool(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	makeAnsweredPool(t, "s", []string{"Q1", "Q2"})

	r := finalizeQuestionsTool("s", "")
	if r["status"] != "ready" {
		t.Fatalf("expected ready, got: %v", r["status"])
	}
	if dirExists(poolDirOfSession(t, "s")) {
		t.Error("original pool dir should be moved away")
	}
	archDir := archiveDirOf(t)
	entries, err := os.ReadDir(archDir)
	if err != nil || len(entries) == 0 {
		t.Fatalf("archive dir should contain the archived pool: %v", err)
	}
	loc, _ := r["pool_location"].(string)
	if !strings.Contains(filepath.ToSlash(loc), archiveDirName) {
		t.Errorf("pool_location should point into .archive, got: %s", loc)
	}
	if _, err := os.Stat(loc); err != nil {
		t.Errorf("pool_location should exist: %v", err)
	}
}

func TestFinalize_IT_AR_02_BlockedKeepsPoolAndOriginalLocation(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "s")
	addQuestionsTool([]string{"Q1", "Q2"}, "s", "")
	answerQuestionTool("Q1", "A1", "user", "", "s", "")

	r := finalizeQuestionsTool("s", "")
	if r["status"] != "blocked" {
		t.Fatalf("expected blocked, got: %v", r["status"])
	}
	if !dirExists(poolDirOfSession(t, "s")) {
		t.Error("pool should stay in place when blocked")
	}
	if dirExists(archiveDirOf(t)) {
		t.Error(".archive should not be created when blocked")
	}
	loc, _ := r["pool_location"].(string)
	norm := filepath.ToSlash(loc)
	if !strings.HasSuffix(norm, "/s/state.json") {
		t.Errorf("pool_location should end with /s/state.json, got: %s", norm)
	}
	if strings.Contains(norm, archiveDirName) {
		t.Errorf("blocked pool_location should NOT be in .archive, got: %s", norm)
	}
}

func TestListSessions_IT_AR_03_ArchivedHiddenByDefault(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	makeAnsweredPool(t, "s", []string{"Q1"})
	finalizeQuestionsTool("s", "")

	r1 := listSessionsTool(false, "")
	s1, _ := r1["sessions"].([]interface{})
	for _, s := range s1 {
		name := s.(map[string]interface{})["name"].(string)
		if strings.HasPrefix(name, "s") {
			t.Errorf("archived pool should not appear in default list: %s", name)
		}
	}

	r2 := listSessionsTool(true, "")
	s2, _ := r2["sessions"].([]interface{})
	found := false
	for _, s := range s2 {
		m := s.(map[string]interface{})
		name := m["name"].(string)
		if strings.HasPrefix(name, "s-") && m["archived"] == true {
			found = true
		}
	}
	if !found {
		t.Error("include_archived=true should list the archived pool with archived=true")
	}
}

func TestFinalize_IT_AR_04_DuplicateArchiveNamesGetSuffix(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	// First archive of pool "s"
	makeAnsweredPool(t, "s", []string{"Q1"})
	finalizeQuestionsTool("s", "")

	// Rebuild same-named pool and archive again
	makeAnsweredPool(t, "s", []string{"Q2"})
	finalizeQuestionsTool("s", "")

	entries, err := os.ReadDir(archiveDirOf(t))
	if err != nil {
		t.Fatalf("read archive dir: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 archived dirs, got %d", len(entries))
	}
	if entries[0].Name() == entries[1].Name() {
		t.Errorf("duplicate archive dirs must have different names: %s", entries[0].Name())
	}
}

// ============================================================
// IT-AR-05 ~ IT-AR-08: cleanup_sessions
// ============================================================

func TestCleanup_IT_AR_05_ListExpiredOnlyLists(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	makeAnsweredPool(t, "s", []string{"Q1"})
	finalizeQuestionsTool("s", "")
	archDir := archiveDirOf(t)
	entries, _ := os.ReadDir(archDir)
	target := filepath.Join(archDir, entries[0].Name())
	setMtimeDaysAgo(t, target, 100)

	r := cleanupSessionsTool("list_expired", 90, false, "")
	if r["error"] != nil {
		t.Fatalf("list_expired should not error: %v", r["error"])
	}
	cands, _ := r["candidates"].([]interface{})
	if len(cands) != 1 {
		t.Fatalf("expected 1 candidate, got %d", len(cands))
	}
	if !dirExists(target) {
		t.Error("list_expired must not delete anything")
	}
}

func TestCleanup_IT_AR_06_PurgeWithoutConfirmRejected(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	makeAnsweredPool(t, "s", []string{"Q1"})
	finalizeQuestionsTool("s", "")
	archDir := archiveDirOf(t)
	entries, _ := os.ReadDir(archDir)
	target := filepath.Join(archDir, entries[0].Name())
	setMtimeDaysAgo(t, target, 100)

	r := cleanupSessionsTool("purge_archived", 90, false, "")
	if r["error"] != "confirm_required" {
		t.Errorf("expected confirm_required, got: %v", r["error"])
	}
	if !dirExists(target) {
		t.Error("purge without confirm must not delete")
	}
}

func TestCleanup_IT_AR_07_PurgeConfirmDeletesOnlyArchived(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	makeAnsweredPool(t, "old", []string{"Q1"})
	finalizeQuestionsTool("old", "")
	archDir := archiveDirOf(t)
	entries, _ := os.ReadDir(archDir)
	target := filepath.Join(archDir, entries[0].Name())
	setMtimeDaysAgo(t, target, 100)

	mustCreatePool(t, "active")
	addQuestionsTool([]string{"Q-active"}, "active", "")

	r := cleanupSessionsTool("purge_archived", 90, true, "")
	if r["error"] != nil {
		t.Fatalf("purge failed: %v", r["error"])
	}
	deleted, _ := r["deleted"].([]interface{})
	if len(deleted) != 1 {
		t.Fatalf("expected 1 deleted, got %d", len(deleted))
	}
	if dirExists(target) {
		t.Error("archived dir should be deleted")
	}
	activeState := poolDirOfSession(t, "active")
	if !dirExists(activeState) {
		t.Error("active pool must remain intact")
	}
	status := getStatusTool("summary", "active", "")
	if v, ok := getIntFromResult(status, "total"); !ok || v != 1 {
		t.Errorf("active pool should still have 1 question, got %v", status["total"])
	}
}

func TestCleanup_IT_AR_08_OlderThanDaysFilter(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	// Old archive (100 days)
	makeAnsweredPool(t, "old", []string{"Q1"})
	finalizeQuestionsTool("old", "")
	archDir := archiveDirOf(t)
	entries, _ := os.ReadDir(archDir)
	var oldDir string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "old-") {
			oldDir = filepath.Join(archDir, e.Name())
		}
	}
	setMtimeDaysAgo(t, oldDir, 100)

	// New archive (today)
	makeAnsweredPool(t, "new", []string{"Q2"})
	finalizeQuestionsTool("new", "")

	r := cleanupSessionsTool("list_expired", 90, false, "")
	cands, _ := r["candidates"].([]interface{})
	if len(cands) != 1 {
		t.Fatalf("expected exactly 1 candidate (only the old one), got %d", len(cands))
	}
	name := cands[0].(map[string]interface{})["name"].(string)
	if !strings.HasPrefix(name, "old-") {
		t.Errorf("candidate should be the old archive, got: %s", name)
	}
}

// ============================================================
// IT-AR-09 / IT-AR-10: edge cases
// ============================================================

func TestFinalize_IT_AR_09_FinalizeArchivedPoolReturnsNotFound(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	mustCreatePool(t, "other")
	addQuestionsTool([]string{"Q-other"}, "other", "")
	makeAnsweredPool(t, "s", []string{"Q1"})
	finalizeQuestionsTool("s", "")

	r := finalizeQuestionsTool("s", "")
	if r["error"] != nil {
		t.Fatalf("select guidance must not be an error, got: %v", r["error"])
	}
	if r["action_required"] != "select_session" || r["reason"] != "session_not_found" {
		t.Fatalf("expected session_not_found guidance, got: %v", r)
	}
	avail, ok := r["available_sessions"].([]interface{})
	if !ok {
		t.Fatal("expected available_sessions in guidance")
	}
	found := false
	for _, s := range avail {
		if s.(string) == "other" {
			found = true
		}
	}
	if !found {
		t.Errorf("available_sessions should contain active pool 'other': %v", avail)
	}
	if r["guidance"] == nil || r["guidance"] == "" {
		t.Error("expected guidance text in result")
	}
}

func TestCleanup_IT_AR_10_NoArchiveDirReturnsEmpty(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	// Project dir exists (created by resolveProjectDir via a pool), but no .archive
	mustCreatePool(t, "s")
	addQuestionsTool([]string{"Q1"}, "s", "")

	r := cleanupSessionsTool("list_expired", 90, false, "")
	if r["error"] != nil {
		t.Fatalf("should not error when .archive missing: %v", r["error"])
	}
	cands, ok := r["candidates"].([]interface{})
	if !ok {
		t.Fatalf("candidates should be a list, got: %v", r["candidates"])
	}
	if len(cands) != 0 {
		t.Errorf("expected empty candidates, got %d", len(cands))
	}
}

// ============================================================
// IT-AR-11: double archive conflict still produces a unique name
// ============================================================

func TestFinalize_IT_AR_11_DoubleConflictStillArchives(t *testing.T) {
	origCwd := setupArchivePool(t)
	defer os.Chdir(origCwd)

	archDir := archiveDirOf(t)
	dateSuffix := todayStr()
	// Pre-create BOTH fallback names so the first two candidates collide:
	//   s-<yyyyMMdd>  and  s-<yyyyMMdd-HHmmss(current second)
	os.MkdirAll(filepath.Join(archDir, "s-"+dateSuffix), 0755)
	os.MkdirAll(filepath.Join(archDir, "s-"+dateSuffix+"-"+time.Now().Format("150405")), 0755)

	makeAnsweredPool(t, "s", []string{"Q1"})
	r := finalizeQuestionsTool("s", "")
	if r["status"] != "ready" {
		t.Fatalf("expected ready, got: %v", r["status"])
	}

	// The pool must have been archived into a THIRD unique directory
	loc, _ := r["pool_location"].(string)
	if !strings.Contains(filepath.ToSlash(loc), archiveDirName) {
		t.Fatalf("pool_location should be inside .archive, got: %s", loc)
	}
	if _, err := os.Stat(loc); err != nil {
		t.Fatalf("archived state should exist at pool_location: %v", err)
	}

	entries, _ := os.ReadDir(archDir)
	names := map[string]bool{}
	for _, e := range entries {
		names[e.Name()] = true
	}
	if len(entries) != 3 {
		t.Fatalf("expected 3 archive dirs after double conflict, got %d: %v", len(entries), names)
	}
}
