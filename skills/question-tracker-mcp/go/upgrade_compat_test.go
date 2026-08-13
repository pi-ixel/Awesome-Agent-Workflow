package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ============================================================
// Upgrade-compatibility tests (legacy .sdd marker + .question_state.json)
//
// Semantics under test:
//   - Empty session + legacy marker present → legacy route reads/writes the
//     legacy pool file, lazily mirrors it into the new store, and attaches a
//     deprecation_warning to results.
//   - Every legacy-route write is followed by a mirror sync so the new store
//     always holds the latest copy.
//   - finalize on the legacy route archives into the NEW mechanism's
//     .archive/ and removes ONLY the legacy pool file and marker — the
//     legacy directory itself is user workspace and must be preserved.
//   - Empty session + no marker → missing_session (principle preserved).
// ============================================================

const legacyMarkerRel = ".sdd/.current_session"
const legacyStateName = ".question_state.json"

// setupUpgradeScene creates a legacy scene: QUESTION_TRACKER_HOME in a temp
// dir, chdir into a temp project dir, and writes the legacy marker.
// legacySRDir is e.g. "SR-001"; legacyStateJSON may be "" (no legacy pool file).
func setupUpgradeScene(t *testing.T, markerTarget, legacySRDir, legacyStateJSON string) (origCwd string) {
	t.Helper()
	origCwd, _ = os.Getwd()
	poolRoot := t.TempDir()
	t.Setenv("QUESTION_TRACKER_HOME", poolRoot)
	workDir := t.TempDir()
	os.Chdir(workDir)

	os.MkdirAll(".sdd", 0755)
	if markerTarget != "" {
		os.WriteFile(legacyMarkerRel, []byte(markerTarget), 0644)
		if legacyStateJSON != "" {
			dir := filepath.Join(".sdd", legacySRDir)
			os.MkdirAll(dir, 0755)
			os.WriteFile(filepath.Join(dir, legacyStateName), []byte(legacyStateJSON), 0644)
		}
	}
	return origCwd
}

// legacyPoolJSON builds a legacy pool file body with the given questions.
func legacyPoolJSON(questions ...map[string]interface{}) string {
	body := map[string]interface{}{
		"questions": questions,
		"next_id":   float64(len(questions) + 1),
	}
	data, _ := json.Marshal(body)
	return string(data)
}

func legacyQuestion(id int, text, status string, answer interface{}) map[string]interface{} {
	return map[string]interface{}{
		"id":              float64(id),
		"question":        text,
		"status":          status,
		"answer":          answer,
		"source":          nil,
		"derivation_note": nil,
		"created_at":      "",
		"answered_at":     nil,
		"updated_at":      nil,
		"history":         []interface{}{},
	}
}

// readLegacyPool reads the legacy pool file for an SR dir.
func readLegacyPool(t *testing.T, srDir string) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(".sdd", srDir, legacyStateName))
	if err != nil {
		t.Fatalf("read legacy pool: %v", err)
	}
	var state map[string]interface{}
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatalf("parse legacy pool: %v", err)
	}
	return state
}

// findMirroredPool locates the migrated copy <poolRoot>/<proj>/<session>/state.json.
func findMirroredPool(t *testing.T, session string) string {
	t.Helper()
	root := os.Getenv("QUESTION_TRACKER_HOME")
	var found string
	filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && info.Name() == "state.json" {
			if strings.Contains(filepath.ToSlash(path), "/"+session+"/state.json") {
				found = path
			}
		}
		return nil
	})
	return found
}

// readPoolFile reads a state.json as a map.
func readPoolFile(t *testing.T, path string) map[string]interface{} {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read pool file %s: %v", path, err)
	}
	var state map[string]interface{}
	if err := json.Unmarshal(data, &state); err != nil {
		t.Fatalf("parse pool file: %v", err)
	}
	return state
}

// poolQuestions extracts the questions array from a state map.
func poolQuestions(t *testing.T, state map[string]interface{}) []interface{} {
	t.Helper()
	qs, _ := state["questions"].([]interface{})
	return qs
}

// ============================================================
// IT-UP-01: get_status with empty session falls back to legacy route
// ============================================================

func TestUpgrade_IT_UP_01_GetStatusLegacyFallback(t *testing.T) {
	origCwd := setupUpgradeScene(t, "./.sdd/SR-001/", "SR-001", legacyPoolJSON(
		legacyQuestion(1, "数据库选型？", "answered", "PostgreSQL"),
		legacyQuestion(2, "缓存方案？", "pending", nil),
	))
	defer os.Chdir(origCwd)

	r := getStatusTool("summary", "", "")
	if r["error"] != nil {
		t.Fatalf("legacy fallback should not error, got: %v", r["error"])
	}
	if v, ok := getIntFromResult(r, "total"); !ok || v != 2 {
		t.Errorf("expected total=2 from legacy pool, got %v", r["total"])
	}
	if v, ok := getIntFromResult(r, "pending"); !ok || v != 1 {
		t.Errorf("expected pending=1 from legacy pool, got %v", r["pending"])
	}
	if r["deprecation_warning"] == nil || r["deprecation_warning"] == "" {
		t.Error("expected deprecation_warning in legacy-route result")
	}

	// Lazy migration: mirrored copy must exist in the new store
	mirror := findMirroredPool(t, "SR-001")
	if mirror == "" {
		t.Fatal("expected migrated copy under the new store")
	}
	mirrorState := readPoolFile(t, mirror)
	if len(poolQuestions(t, mirrorState)) != 2 {
		t.Errorf("mirrored copy should hold 2 questions, got %d", len(poolQuestions(t, mirrorState)))
	}
}

// ============================================================
// IT-UP-02 / IT-UP-03: missing_session preserved when no usable marker
// ============================================================

func TestUpgrade_IT_UP_02_NoMarkerStillMissingSession(t *testing.T) {
	origCwd := setupUpgradeScene(t, "", "SR-001", "")
	defer os.Chdir(origCwd)

	r := getStatusTool("summary", "", "")
	if r["reason"] != "missing_session" || r["error"] != nil {
		t.Errorf("expected missing_session guidance without marker, got: %v", r)
	}
}

func TestUpgrade_IT_UP_03_BlankMarkerStillMissingSession(t *testing.T) {
	origCwd := setupUpgradeScene(t, "   \n", "SR-001", "")
	defer os.Chdir(origCwd)

	r := getStatusTool("summary", "", "")
	if r["reason"] != "missing_session" || r["error"] != nil {
		t.Errorf("expected missing_session guidance with blank marker, got: %v", r)
	}
}

// ============================================================
// IT-UP-04: answer via legacy route writes legacy file AND mirrors
// ============================================================

func TestUpgrade_IT_UP_04_AnswerWritesLegacyAndSyncsMirror(t *testing.T) {
	origCwd := setupUpgradeScene(t, "./.sdd/SR-001/", "SR-001", legacyPoolJSON(
		legacyQuestion(1, "数据库选型？", "answered", "PostgreSQL"),
		legacyQuestion(2, "缓存方案？", "pending", nil),
	))
	defer os.Chdir(origCwd)

	// Trigger migration first
	getStatusTool("summary", "", "")

	r := answerQuestionTool("缓存方案？", "Redis", "user", "", "", "")
	if r["error"] != nil {
		t.Fatalf("legacy-route answer failed: %v", r["error"])
	}

	// Legacy file updated
	legacy := readLegacyPool(t, "SR-001")
	qs := poolQuestions(t, legacy)
	var q2 map[string]interface{}
	for _, q := range qs {
		m := q.(map[string]interface{})
		if m["question"] == "缓存方案？" {
			q2 = m
		}
	}
	if q2 == nil || q2["status"] != "answered" || q2["answer"] != "Redis" {
		t.Fatalf("legacy file should record the answer, got: %v", q2)
	}

	// Mirrored copy synced with the same answer
	mirror := findMirroredPool(t, "SR-001")
	if mirror == "" {
		t.Fatal("mirror should exist after legacy write")
	}
	mirrorQs := poolQuestions(t, readPoolFile(t, mirror))
	var mq2 map[string]interface{}
	for _, q := range mirrorQs {
		m := q.(map[string]interface{})
		if m["question"] == "缓存方案？" {
			mq2 = m
		}
	}
	if mq2 == nil || mq2["status"] != "answered" || mq2["answer"] != "Redis" {
		t.Fatalf("mirror should be synced with the answer, got: %v", mq2)
	}
}

// ============================================================
// IT-UP-05: after migration, named session reads via new mechanism
// ============================================================

func TestUpgrade_IT_UP_05_NamedSessionUsesNewMechanism(t *testing.T) {
	origCwd := setupUpgradeScene(t, "./.sdd/SR-001/", "SR-001", legacyPoolJSON(
		legacyQuestion(1, "数据库选型？", "answered", "PostgreSQL"),
		legacyQuestion(2, "缓存方案？", "answered", "Redis"),
	))
	defer os.Chdir(origCwd)

	getStatusTool("summary", "", "") // trigger migration

	r := getStatusTool("summary", "SR-001", "")
	if r["error"] != nil {
		t.Fatalf("named session should read migrated pool: %v", r["error"])
	}
	if v, ok := getIntFromResult(r, "total"); !ok || v != 2 {
		t.Errorf("expected total=2 via new mechanism, got %v", r["total"])
	}
	if r["deprecation_warning"] != nil {
		t.Error("new-mechanism call must NOT carry deprecation_warning")
	}
}

// ============================================================
// IT-UP-06: subsequent legacy writes keep the mirror in sync
// ============================================================

func TestUpgrade_IT_UP_06_MirrorStaysInSync(t *testing.T) {
	origCwd := setupUpgradeScene(t, "./.sdd/SR-001/", "SR-001", legacyPoolJSON(
		legacyQuestion(1, "数据库选型？", "pending", nil),
		legacyQuestion(2, "缓存方案？", "pending", nil),
	))
	defer os.Chdir(origCwd)

	answerQuestionTool("数据库选型？", "PostgreSQL", "user", "", "", "")
	answerQuestionTool("缓存方案？", "Redis", "user", "", "", "")

	mirror := findMirroredPool(t, "SR-001")
	mirrorQs := poolQuestions(t, readPoolFile(t, mirror))
	answered := 0
	for _, q := range mirrorQs {
		m := q.(map[string]interface{})
		if m["status"] == "answered" {
			answered++
		}
	}
	if answered != 2 {
		t.Errorf("mirror should reflect both answers, answered=%d", answered)
	}
}

// ============================================================
// IT-UP-07: marker points to a non-existent directory
// ============================================================

func TestUpgrade_IT_UP_07_MarkerTargetMissingActsAsEmptyPool(t *testing.T) {
	origCwd := setupUpgradeScene(t, "./.sdd/SR-999/", "SR-999", "")
	defer os.Chdir(origCwd)

	r := getStatusTool("summary", "", "")
	if r["error"] != nil {
		t.Fatalf("missing legacy dir should act as empty pool, got: %v", r["error"])
	}
	if v, ok := getIntFromResult(r, "total"); !ok || v != 0 {
		t.Errorf("expected total=0, got %v", r["total"])
	}

	add := addQuestionsTool([]string{"新问题"}, "", "")
	if add["error"] != nil {
		t.Fatalf("add via legacy route failed: %v", add["error"])
	}
	if _, err := os.Stat(filepath.Join(".sdd", "SR-999", legacyStateName)); err != nil {
		t.Error("add should create the legacy pool file at the marker target")
	}
}

// ============================================================
// IT-UP-08: add via legacy route appends and mirrors
// ============================================================

func TestUpgrade_IT_UP_08_AddAppendsLegacyAndSyncs(t *testing.T) {
	origCwd := setupUpgradeScene(t, "./.sdd/SR-001/", "SR-001", legacyPoolJSON(
		legacyQuestion(1, "数据库选型？", "answered", "PostgreSQL"),
	))
	defer os.Chdir(origCwd)

	r := addQuestionsTool([]string{"部署形态？"}, "", "")
	if r["error"] != nil {
		t.Fatalf("add via legacy route failed: %v", r["error"])
	}

	legacy := readLegacyPool(t, "SR-001")
	if len(poolQuestions(t, legacy)) != 2 {
		t.Errorf("legacy pool should have 2 questions after add, got %d", len(poolQuestions(t, legacy)))
	}

	mirror := findMirroredPool(t, "SR-001")
	if len(poolQuestions(t, readPoolFile(t, mirror))) != 2 {
		t.Errorf("mirror should be synced after add, got %d", len(poolQuestions(t, readPoolFile(t, mirror))))
	}
}

// ============================================================
// IT-UP-09: finalize on legacy route archives into new mechanism
//             and retires the legacy pool file + marker, while
//             preserving the legacy directory (user workspace)
// ============================================================

func TestUpgrade_IT_UP_09_FinalizeArchivesAndRemovesLegacy(t *testing.T) {
	origCwd := setupUpgradeScene(t, "./.sdd/SR-001/", "SR-001", legacyPoolJSON(
		legacyQuestion(1, "数据库选型？", "answered", "PostgreSQL"),
	))
	defer os.Chdir(origCwd)

	r := finalizeQuestionsTool("", "")
	if r["status"] != "ready" {
		t.Fatalf("expected ready, got: %v", r["status"])
	}

	loc, _ := r["pool_location"].(string)
	if !strings.Contains(filepath.ToSlash(loc), archiveDirName) {
		t.Errorf("pool_location should point into new-mechanism .archive, got: %s", loc)
	}
	if _, err := os.Stat(loc); err != nil {
		t.Errorf("archived state should exist at pool_location: %v", err)
	}

	// Pool file and marker must be retired; the legacy directory itself must
	// be preserved — it is the user's SR workspace holding their own docs.
	if _, err := os.Stat(filepath.Join(".sdd", "SR-001", legacyStateName)); !os.IsNotExist(err) {
		t.Error("legacy pool file should be removed after finalize")
	}
	if _, err := os.Stat(legacyMarkerRel); !os.IsNotExist(err) {
		t.Error("legacy marker should be removed after finalize")
	}
	if info, err := os.Stat(filepath.Join(".sdd", "SR-001")); err != nil || !info.IsDir() {
		t.Error("legacy session directory must be preserved (user workspace)")
	}
}

// ============================================================
// IT-UP-10: blackbox — full upgrade link over stdio
// ============================================================

// (implemented in blackbox_test.go companion: see TestBB_Upgrade)
