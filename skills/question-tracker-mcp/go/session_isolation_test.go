package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ============================================================
// Session Isolation Test Helpers
// ============================================================

// setupTempWorkdir creates a temp workdir with .sdd/ structure and chdir into it.
func setupTempWorkdir(t *testing.T) (origCwd string) {
	t.Helper()
	origCwd, _ = os.Getwd()
	tmpDir := t.TempDir()
	sddDir := filepath.Join(tmpDir, ".sdd")
	os.MkdirAll(sddDir, 0755)
	os.Chdir(tmpDir)
	return origCwd
}

// writeSessionMarker writes content to .sdd/.current_session
func writeSessionMarker(t *testing.T, content string) {
	t.Helper()
	markerPath := filepath.Join(".sdd", ".current_session")
	dir := filepath.Dir(markerPath)
	os.MkdirAll(dir, 0755)
	os.WriteFile(markerPath, []byte(content), 0644)
}

// writeSessionMarkerAndTarget creates marker and ensures target directory exists
func writeSessionMarkerAndTarget(t *testing.T, content string) {
	t.Helper()
	writeSessionMarker(t, content)
	// Create target directory
	targetDir := filepath.Clean(strings.TrimSpace(content))
	os.MkdirAll(targetDir, 0755)
}

// ============================================================
// UT-SI-01 ~ UT-SI-06: getStateFilePath
// ============================================================

func TestGetStateFilePath_UT_SI_01_MarkerExistsValidContent(t *testing.T) {
	origCwd := setupTempWorkdir(t)
	defer os.Chdir(origCwd)

	writeSessionMarkerAndTarget(t, "./.sdd/SR-123/")

	result, err := getStateFilePath()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result, "SR-123") {
		t.Errorf("path should contain SR-123, got: %s", result)
	}
	if !strings.HasSuffix(result, ".question_state.json") {
		t.Errorf("path should end with .question_state.json, got: %s", result)
	}
	normalized := strings.ReplaceAll(result, "\\", "/")
	if !strings.Contains(normalized, ".sdd/SR-123/.question_state.json") {
		t.Errorf("path should contain .sdd/SR-123/.question_state.json, got: %s", normalized)
	}
}

func TestGetStateFilePath_UT_SI_02_MarkerNotExists(t *testing.T) {
	origCwd := setupTempWorkdir(t)
	defer os.Chdir(origCwd)

	// Ensure marker doesn't exist
	os.Remove(filepath.Join(".sdd", ".current_session"))

	_, err := getStateFilePath()
	if err == nil {
		t.Fatal("expected SessionNotFoundError, got nil")
	}
	if !strings.Contains(err.Error(), "aaw-workflow") {
		t.Errorf("error message should contain aaw-workflow: %s", err.Error())
	}
}

func TestGetStateFilePath_UT_SI_03_MarkerTrailingWhitespace(t *testing.T) {
	origCwd := setupTempWorkdir(t)
	defer os.Chdir(origCwd)

	tests := []string{"./.sdd/SR-123/  \n", "  ./.sdd/SR-123/  ", "./.sdd/SR-123/\n"}
	for _, content := range tests {
		writeSessionMarkerAndTarget(t, content)
		result, err := getStateFilePath()
		if err != nil {
			t.Fatalf("unexpected error for content %q: %v", content, err)
		}
		if strings.Contains(result, "  ") {
			t.Errorf("path should not contain double spaces: %q", result)
		}
		if strings.Contains(result, "\n") {
			t.Errorf("path should not contain newline: %q", result)
		}
		if !strings.HasSuffix(result, ".question_state.json") {
			t.Errorf("path should end with .question_state.json: %s", result)
		}
	}
}

func TestGetStateFilePath_UT_SI_04_MarkerEmptyString(t *testing.T) {
	origCwd := setupTempWorkdir(t)
	defer os.Chdir(origCwd)

	writeSessionMarker(t, "")

	_, err := getStateFilePath()
	if err == nil {
		t.Fatal("expected SessionNotFoundError, got nil")
	}
	if !strings.Contains(err.Error(), "aaw-workflow") {
		t.Errorf("error message should contain aaw-workflow: %s", err.Error())
	}
}

func TestGetStateFilePath_UT_SI_05_MarkerWhitespaceOnly(t *testing.T) {
	origCwd := setupTempWorkdir(t)
	defer os.Chdir(origCwd)

	tests := []string{"  \n  \t  ", "   ", "\n\n"}
	for _, content := range tests {
		writeSessionMarker(t, content)

		_, err := getStateFilePath()
		if err == nil {
			t.Fatalf("expected SessionNotFoundError for content %q, got nil", content)
		}
		if !strings.Contains(err.Error(), "aaw-workflow") {
			t.Errorf("error message should contain aaw-workflow: %s", err.Error())
		}
	}
}

func TestGetStateFilePath_UT_SI_06_NestedDirectoryPath(t *testing.T) {
	origCwd := setupTempWorkdir(t)
	defer os.Chdir(origCwd)

	tests := []string{"./.sdd/SR-123/nested/deep/", "./.sdd/SR-456/sub/dir/structure/"}
	for _, content := range tests {
		writeSessionMarker(t, content)
		// Create nested target dir
		trimmed := strings.TrimSpace(content)
		os.MkdirAll(filepath.Clean(trimmed), 0755)

		result, err := getStateFilePath()
		if err != nil {
			t.Fatalf("unexpected error for content %q: %v", content, err)
		}
		if !strings.HasSuffix(result, ".question_state.json") {
			t.Errorf("path should end with .question_state.json: %s", result)
		}
		if !strings.Contains(result, ".sdd") {
			t.Errorf("path should contain .sdd: %s", result)
		}
	}
}

// ============================================================
// IT-SI-01 ~ IT-SI-05: State Persistence
// ============================================================

func TestStatePersistence_IT_SI_01_FirstUseRoundtrip(t *testing.T) {
	origCwd := setupTempWorkdir(t)
	defer os.Chdir(origCwd)

	writeSessionMarker(t, "./.sdd/SR-123/")
	os.MkdirAll(".sdd/SR-123", 0755)

	// Clean state file
	stateFile, _ := getStateFilePath()
	os.Remove(stateFile)

	// Write questions
	state, err := loadState()
	if err != nil {
		t.Fatalf("loadState error: %v", err)
	}
	questions, _ := state["questions"].([]interface{})
	nextID := 1
	if v, ok := state["next_id"].(float64); ok {
		nextID = int(v)
	}

	questions = append(questions, map[string]interface{}{
		"id":              nextID,
		"question":        "Q1",
		"status":          "pending",
		"answer":          nil,
		"source":          nil,
		"derivation_note": nil,
		"created_at":      "",
		"answered_at":     nil,
		"updated_at":      nil,
		"history":         []interface{}{},
	})
	state["questions"] = questions
	state["next_id"] = float64(nextID + 1)
	saveState(state)

	// Check file location
	if !strings.Contains(stateFile, "SR-123") {
		t.Errorf("state file path should contain SR-123: %s", stateFile)
	}
	if _, err := os.Stat(stateFile); os.IsNotExist(err) {
		t.Fatal("state file should exist")
	}

	// Read back
	loaded, err := loadState()
	if err != nil {
		t.Fatalf("loadState error: %v", err)
	}
	qs, _ := loaded["questions"].([]interface{})
	if len(qs) != 1 {
		t.Errorf("expected 1 question, got %d", len(qs))
	}
	q1 := qs[0].(map[string]interface{})
	if q1["question"] != "Q1" {
		t.Errorf("expected Q1, got '%s'", q1["question"])
	}
}

func TestStatePersistence_IT_SI_02_AutoCreateTargetDir(t *testing.T) {
	origCwd := setupTempWorkdir(t)
	defer os.Chdir(origCwd)

	writeSessionMarker(t, "./.sdd/SR-AUTO/")
	// Do NOT create the target directory

	targetAbs := filepath.Clean("./.sdd/SR-AUTO")
	if _, err := os.Stat(targetAbs); !os.IsNotExist(err) {
		t.Fatal("target dir should not exist yet")
	}

	state, _ := loadState()
	questions, _ := state["questions"].([]interface{})
	questions = append(questions, map[string]interface{}{
		"id":              1,
		"question":        "Q1",
		"status":          "pending",
		"answer":          nil,
		"source":          nil,
		"derivation_note": nil,
		"created_at":      "",
		"answered_at":     nil,
		"updated_at":      nil,
		"history":         []interface{}{},
	})
	state["questions"] = questions
	state["next_id"] = float64(2)
	saveState(state)

	// Verify directory was created
	if _, err := os.Stat(targetAbs); os.IsNotExist(err) {
		t.Error("target dir should have been auto-created")
	}
}

func TestStatePersistence_IT_SI_03_MarkerMissingRaises(t *testing.T) {
	origCwd := setupTempWorkdir(t)
	defer os.Chdir(origCwd)

	// Ensure marker doesn't exist
	os.Remove(filepath.Join(".sdd", ".current_session"))

	_, err := loadState()
	if err == nil {
		t.Fatal("expected SessionNotFoundError, got nil")
	}
	if !strings.Contains(err.Error(), "aaw-workflow") {
		t.Errorf("error should contain aaw-workflow: %s", err.Error())
	}
}

func TestStatePersistence_IT_SI_04_CrossSRIsolation(t *testing.T) {
	origCwd := setupTempWorkdir(t)
	defer os.Chdir(origCwd)

	// Write in SR-123
	writeSessionMarker(t, "./.sdd/SR-123/")
	os.MkdirAll(".sdd/SR-123", 0755)
	state, _ := loadState()
	questions, _ := state["questions"].([]interface{})
	questions = append(questions, map[string]interface{}{
		"id":              1,
		"question":        "Q1-SR123",
		"status":          "pending",
		"answer":          nil,
		"source":          nil,
		"derivation_note": nil,
		"created_at":      "",
		"answered_at":     nil,
		"updated_at":      nil,
		"history":         []interface{}{},
	})
	state["questions"] = questions
	state["next_id"] = float64(2)
	saveState(state)

	// Switch to SR-456
	writeSessionMarker(t, "./.sdd/SR-456/")
	os.MkdirAll(".sdd/SR-456", 0755)
	state2, _ := loadState()
	questions2, _ := state2["questions"].([]interface{})
	questions2 = append(questions2, map[string]interface{}{
		"id":              1,
		"question":        "Q2-SR456",
		"status":          "pending",
		"answer":          nil,
		"source":          nil,
		"derivation_note": nil,
		"created_at":      "",
		"answered_at":     nil,
		"updated_at":      nil,
		"history":         []interface{}{},
	})
	state2["questions"] = questions2
	state2["next_id"] = float64(2)
	saveState(state2)

	// Verify SR-123 file has only Q1
	sr123File := filepath.Join(".sdd", "SR-123", ".question_state.json")
	sr123Data, _ := os.ReadFile(sr123File)
	var sr123State map[string]interface{}
	json.Unmarshal(sr123Data, &sr123State)
	sr123Qs, _ := sr123State["questions"].([]interface{})
	if len(sr123Qs) != 1 {
		t.Errorf("SR-123 should have 1 question, got %d", len(sr123Qs))
	}
	sr123Q := sr123Qs[0].(map[string]interface{})
	if sr123Q["question"] != "Q1-SR123" {
		t.Errorf("SR-123 question should be Q1-SR123, got '%s'", sr123Q["question"])
	}

	// Verify SR-456 file has only Q2
	sr456File := filepath.Join(".sdd", "SR-456", ".question_state.json")
	sr456Data, _ := os.ReadFile(sr456File)
	var sr456State map[string]interface{}
	json.Unmarshal(sr456Data, &sr456State)
	sr456Qs, _ := sr456State["questions"].([]interface{})
	if len(sr456Qs) != 1 {
		t.Errorf("SR-456 should have 1 question, got %d", len(sr456Qs))
	}
	sr456Q := sr456Qs[0].(map[string]interface{})
	if sr456Q["question"] != "Q2-SR456" {
		t.Errorf("SR-456 question should be Q2-SR456, got '%s'", sr456Q["question"])
	}
}

func TestStatePersistence_IT_SI_05_SessionRecovery(t *testing.T) {
	origCwd := setupTempWorkdir(t)
	defer os.Chdir(origCwd)

	writeSessionMarker(t, "./.sdd/SR-123/")
	os.MkdirAll(".sdd/SR-123", 0755)

	// Write Q1(answered) and Q2(pending)
	state, _ := loadState()
	state["questions"] = []interface{}{
		map[string]interface{}{
			"id":              1,
			"question":        "Q1",
			"status":          "answered",
			"answer":          "Answer1",
			"source":          "user",
			"derivation_note": nil,
			"created_at":      "2026-01-01T00:00:00",
			"answered_at":     "2026-01-01T00:01:00",
			"updated_at":      "2026-01-01T00:01:00",
			"history":         []interface{}{},
		},
		map[string]interface{}{
			"id":              2,
			"question":        "Q2",
			"status":          "pending",
			"answer":          nil,
			"source":          nil,
			"derivation_note": nil,
			"created_at":      "2026-01-01T00:02:00",
			"answered_at":     nil,
			"updated_at":      nil,
			"history":         []interface{}{},
		},
	}
	state["next_id"] = float64(3)
	saveState(state)

	// Simulate restart: reload
	loaded, _ := loadState()
	if v, ok := loaded["next_id"].(float64); !ok || int(v) != 3 {
		t.Errorf("expected next_id=3, got %v", loaded["next_id"])
	}
	qs, _ := loaded["questions"].([]interface{})
	if len(qs) != 2 {
		t.Errorf("expected 2 questions, got %d", len(qs))
	}

	var answered, pending []map[string]interface{}
	for _, q := range qs {
		m := q.(map[string]interface{})
		if m["status"] == "answered" {
			answered = append(answered, m)
		} else {
			pending = append(pending, m)
		}
	}
	if len(answered) != 1 {
		t.Errorf("expected 1 answered, got %d", len(answered))
	}
	if answered[0]["question"] != "Q1" {
		t.Errorf("expected Q1, got '%s'", answered[0]["question"])
	}
	if answered[0]["answer"] != "Answer1" {
		t.Errorf("expected Answer1, got '%v'", answered[0]["answer"])
	}
	if len(pending) != 1 {
		t.Errorf("expected 1 pending, got %d", len(pending))
	}
	if pending[0]["question"] != "Q2" {
		t.Errorf("expected Q2, got '%s'", pending[0]["question"])
	}
}
