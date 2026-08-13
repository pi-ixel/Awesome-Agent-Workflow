package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// ============================================================
// Constants
// ============================================================

const (
	poolDirName       = ".question-tracker"
	archiveDirName    = ".archive"
	stateFileName     = "state.json"
	homeEnvVar        = "QUESTION_TRACKER_HOME"
	debugEnvVar       = "QUESTION_TRACKER_DEBUG"
	maxSessionNameLen = 128
	serverName        = "question-tracker"
	serverVersion     = "2.0.0"
	protocolVersion   = "2024-11-05"
)

// SUPPORTED_VERSIONS lists protocol versions this server supports, newest first.
var SUPPORTED_VERSIONS = []string{"2024-11-05"}

// archiveSuffixRe matches one trailing archive suffix: -yyyyMMdd,
// -yyyyMMdd-HHmmss, optionally followed by a -N counter.
var (
	dateSuffixRe    = regexp.MustCompile(`-\d{8}$`)
	timeSuffixRe    = regexp.MustCompile(`-\d{6}$`)
	counterSuffixRe = regexp.MustCompile(`-\d{1,2}$`)
)

// stripArchiveSuffix removes ONE archive suffix from an archived pool name.
// Archive names we generate have exactly three shapes:
//
//	<session>-yyyyMMdd
//	<session>-yyyyMMdd-HHmmss
//	<session>-yyyyMMdd-HHmmss-N
//
// Parsing must go right-to-left by shape so that a session name that
// itself ends in 8 digits (e.g. "report-20260130") is not mangled:
// a trailing -HHmmss is only stripped when a -yyyyMMdd remains after it,
// and a trailing counter only when a -HHmmss remains after it.
func stripArchiveSuffix(name string) string {
	rest := name
	// counter: -N (1-2 digits), only when a time suffix remains after removal
	if m := counterSuffixRe.FindString(rest); m != "" {
		base := rest[:len(rest)-len(m)]
		if timeSuffixRe.MatchString(base) {
			rest = base
		}
	}
	// time: -HHmmss, only when a date suffix remains after removal
	if m := timeSuffixRe.FindString(rest); m != "" {
		base := rest[:len(rest)-len(m)]
		if dateSuffixRe.MatchString(base) {
			rest = base
		}
	}
	// date: -yyyyMMdd
	if m := dateSuffixRe.FindString(rest); m != "" {
		rest = rest[:len(rest)-len(m)]
	}
	return rest
}

// ============================================================
// Custom Errors
// ============================================================

// MatchError is raised when question matching fails.
type MatchError struct{}

func (e MatchError) Error() string { return "未匹配到问题" }

// ValidationError is raised when input validation fails.
type ValidationError struct {
	Detail string
}

func (e ValidationError) Error() string {
	if e.Detail != "" {
		return e.Detail
	}
	return "问题列表不能包含空字符串"
}

// MissingSessionError is raised when the session argument is empty.
type MissingSessionError struct{}

func (e MissingSessionError) Error() string {
	return "session 参数缺失。请先 list_sessions 浏览现有会话，或显式命名目标会话。"
}

// SessionNotFoundError is raised when the target pool does not exist.
type SessionNotFoundError struct {
	Requested string
}

func (e SessionNotFoundError) Error() string {
	return "会话不存在: " + e.Requested
}

// ============================================================
// Data Types
// ============================================================

// HistoryEntry records a previous answer and why it was changed.
type HistoryEntry struct {
	Answer    string  `json:"answer"`
	Reason    *string `json:"reason"`
	UpdatedAt string  `json:"updated_at"`
}

// Question represents a tracked question in the pool.
type Question struct {
	ID             int            `json:"id"`
	Question       string         `json:"question"`
	Status         string         `json:"status"`
	Answer         *string        `json:"answer"`
	Source         *string        `json:"source"`
	DerivationNote *string        `json:"derivation_note"`
	CreatedAt      string         `json:"created_at"`
	AnsweredAt     *string        `json:"answered_at"`
	UpdatedAt      *string        `json:"updated_at"`
	History        []HistoryEntry `json:"history"`
}

// ToDict serialises a Question to a map (used for JSON state file).
func (q Question) ToDict() map[string]interface{} {
	return map[string]interface{}{
		"id":              q.ID,
		"question":        q.Question,
		"status":          q.Status,
		"answer":          q.Answer,
		"source":          q.Source,
		"derivation_note": q.DerivationNote,
		"created_at":      q.CreatedAt,
		"answered_at":     q.AnsweredAt,
		"updated_at":      q.UpdatedAt,
		"history":         q.History,
	}
}

// QuestionFromDict deserialises a map into a Question.
func QuestionFromDict(data map[string]interface{}) Question {
	q := Question{
		ID:        int(getFloat64(data, "id")),
		Question:  getString(data, "question"),
		Status:    getStringDefault(data, "status", "pending"),
		CreatedAt: getStringDefault(data, "created_at", ""),
		History:   []HistoryEntry{},
	}

	if v, ok := data["answer"]; ok && v != nil {
		s := fmt.Sprintf("%v", v)
		q.Answer = &s
	}
	if v, ok := data["source"]; ok && v != nil {
		s := fmt.Sprintf("%v", v)
		q.Source = &s
	}
	if v, ok := data["derivation_note"]; ok && v != nil {
		s := fmt.Sprintf("%v", v)
		q.DerivationNote = &s
	}
	if v, ok := data["answered_at"]; ok && v != nil {
		s := fmt.Sprintf("%v", v)
		q.AnsweredAt = &s
	}
	if v, ok := data["updated_at"]; ok && v != nil {
		s := fmt.Sprintf("%v", v)
		q.UpdatedAt = &s
	}
	if v, ok := data["history"]; ok && v != nil {
		if arr, ok := v.([]interface{}); ok {
			for _, item := range arr {
				if m, ok := item.(map[string]interface{}); ok {
					he := HistoryEntry{
						Answer:    getString(m, "answer"),
						UpdatedAt: getString(m, "updated_at"),
					}
					if r, ok := m["reason"]; ok && r != nil {
						s := fmt.Sprintf("%v", r)
						he.Reason = &s
					}
					q.History = append(q.History, he)
				}
			}
		}
	}

	return q
}

// SessionInfo describes one pool for list_sessions output.
type SessionInfo struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Archived  bool   `json:"archived"`
	UpdatedAt string `json:"updated_at"`
	Total     int    `json:"total"`
	Pending   int    `json:"pending"`
}

// isoTimestamp returns the current time in Python-compatible ISO format.
func isoTimestamp() string {
	return time.Now().Format("2006-01-02T15:04:05.000000")
}

// ============================================================
// Pool path resolution
// ============================================================

// poolRoot returns the root directory for all pools.
func poolRoot() string {
	if v := os.Getenv(homeEnvVar); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return poolDirName
	}
	return filepath.Join(home, poolDirName)
}

// validateSessionName validates a session/project name for use as a
// single-level directory name.
//
// Rules: non-blank; <= 128 chars; no '/' or '\\'; not '.'/'..' and no '..'
// segment; not absolute (no leading '/', no ':'); no control chars (< 0x20).
func validateSessionName(name string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return ValidationError{Detail: "session 名不能为空或纯空白"}
	}
	if len(trimmed) > maxSessionNameLen {
		return ValidationError{Detail: fmt.Sprintf("session 名超长（>%d 字符）", maxSessionNameLen)}
	}
	if strings.Contains(trimmed, "/") || strings.Contains(trimmed, "\\") {
		return ValidationError{Detail: "session 名不得包含路径分隔符 '/' 或 '\\'"}
	}
	if trimmed == "." || trimmed == ".." {
		return ValidationError{Detail: "session 名不得为 '.' 或 '..'"}
	}
	if strings.Contains(trimmed, ":") {
		return ValidationError{Detail: "session 名不得包含 ':'（疑似绝对路径/盘符）"}
	}
	for _, r := range trimmed {
		if r < 0x20 {
			return ValidationError{Detail: "session 名不得包含控制字符"}
		}
	}
	return nil
}

// resolveProjectDir resolves the project directory for pools:
// QUESTION_TRACKER_HOME/<project> when project is given, otherwise
// QUESTION_TRACKER_HOME/<cwdDirName>-<sha256(cwd)[:6]>.
func resolveProjectDir(project string) (string, error) {
	root := poolRoot()
	if project != "" {
		if err := validateSessionName(project); err != nil {
			return "", err
		}
		return filepath.Join(root, project), nil
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(cwd)
	if err != nil {
		abs = cwd
	}
	sum := sha256.Sum256([]byte(abs))
	slug := fmt.Sprintf("%s-%s", filepath.Base(abs), hex.EncodeToString(sum[:])[:6])
	return filepath.Join(root, slug), nil
}

// resolveStateFilePath resolves (session, project) to the state.json
// absolute path. Session is REQUIRED: empty returns MissingSessionError.
func resolveStateFilePath(session, project string) (string, error) {
	if strings.TrimSpace(session) == "" {
		return "", MissingSessionError{}
	}
	if err := validateSessionName(session); err != nil {
		return "", err
	}
	projectDir, err := resolveProjectDir(project)
	if err != nil {
		return "", err
	}
	return filepath.Join(projectDir, session, stateFileName), nil
}

// listAvailableSessions enumerates pools under the project directory
// (active pools, plus archived pools when includeArchived is true),
// sorted by updated_at descending.
func listAvailableSessions(project string, includeArchived bool) []SessionInfo {
	projectDir, err := resolveProjectDir(project)
	if err != nil {
		return nil
	}
	var result []SessionInfo
	collect := func(dir string, archived bool) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			statePath := filepath.Join(dir, e.Name(), stateFileName)
			info, err := os.Stat(statePath)
			if err != nil {
				continue
			}
			si := SessionInfo{
				Name:      e.Name(),
				Path:      statePath,
				Archived:  archived,
				UpdatedAt: info.ModTime().Format("2006-01-02T15:04:05.000000"),
				Total:     -1,
				Pending:   -1,
			}
			if data, err := os.ReadFile(statePath); err == nil {
				var state map[string]interface{}
				if json.Unmarshal(data, &state) == nil {
					questions, _ := state["questions"].([]interface{})
					total, pending := 0, 0
					for _, q := range questions {
						if m, ok := q.(map[string]interface{}); ok {
							total++
							if m["status"] == "pending" {
								pending++
							}
						}
					}
					si.Total = total
					si.Pending = pending
				}
			}
			result = append(result, si)
		}
	}
	collect(projectDir, false)
	if includeArchived {
		collect(filepath.Join(projectDir, archiveDirName), true)
	}
	sort.Slice(result, func(i, j int) bool {
		return result[i].UpdatedAt > result[j].UpdatedAt
	})
	return result
}

// ============================================================
// Concurrency: per-pool locks
// ============================================================

var poolLocks sync.Map // map[string]*sync.Mutex

func lockForPool(poolPath string) *sync.Mutex {
	v, _ := poolLocks.LoadOrStore(poolPath, &sync.Mutex{})
	return v.(*sync.Mutex)
}

// ============================================================
// State Persistence
// ============================================================

func loadState(session, project string) (map[string]interface{}, error) {
	stateFile, err := resolveStateFilePath(session, project)
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(stateFile)
	if err != nil {
		return map[string]interface{}{
			"questions": []interface{}{},
			"next_id":   float64(1),
		}, nil
	}

	var state map[string]interface{}
	if err := json.Unmarshal(data, &state); err != nil {
		return map[string]interface{}{
			"questions": []interface{}{},
			"next_id":   float64(1),
		}, nil
	}

	if _, ok := state["questions"]; !ok {
		return map[string]interface{}{
			"questions": []interface{}{},
			"next_id":   float64(1),
		}, nil
	}

	if _, ok := state["next_id"]; !ok {
		state["next_id"] = float64(1)
	}

	return state, nil
}

func saveState(state map[string]interface{}, session, project string) error {
	stateFile, err := resolveStateFilePath(session, project)
	if err != nil {
		return err
	}

	dir := filepath.Dir(stateFile)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(stateFile, data, 0644)
}

func getQuestions(session, project string) ([]Question, error) {
	state, err := loadState(session, project)
	if err != nil {
		return nil, err
	}
	questionsRaw, _ := state["questions"].([]interface{})
	var questions []Question
	for _, qRaw := range questionsRaw {
		if m, ok := qRaw.(map[string]interface{}); ok {
			questions = append(questions, QuestionFromDict(m))
		}
	}
	return questions, nil
}

func saveQuestions(questions []Question, session, project string) error {
	state, err := loadState(session, project)
	if err != nil {
		return err
	}
	var qList []interface{}
	for _, q := range questions {
		qList = append(qList, q.ToDict())
	}
	state["questions"] = qList
	return saveState(state, session, project)
}

func getNextID(session, project string) (int, error) {
	state, err := loadState(session, project)
	if err != nil {
		return 0, err
	}
	if v, ok := state["next_id"].(float64); ok {
		return int(v), nil
	}
	return 1, nil
}

func setNextID(nextID int, session, project string) error {
	state, err := loadState(session, project)
	if err != nil {
		return err
	}
	state["next_id"] = float64(nextID)
	return saveState(state, session, project)
}

// ============================================================
// Upgrade compatibility: legacy .sdd marker route
// ============================================================

const (
	legacyMarkerPath = ".sdd/.current_session"
	legacyStateFile  = ".question_state.json"
)

// legacyRoute bundles the resolved legacy session for one tool call.
type legacyRoute struct {
	session string // session name derived from the marker target dir (e.g. "SR-001")
	dir     string // legacy session directory (e.g. ".sdd/SR-001")
	file    string // legacy pool file path
}

// resolveLegacyRoute reads .sdd/.current_session and resolves the legacy
// session directory. Returns nil when the marker is missing or blank.
//
// The marker content is untrusted input written by old tooling. The target
// must be a relative path strictly inside ".sdd/" (e.g. ".sdd/SR-001" or
// ".sdd/SR-001/AR-001") — anything else (absolute paths, ".." escapes, the
// ".sdd" root itself) is rejected as if no marker existed, so the legacy
// route can never read, write, or delete outside the legacy pool area.
func resolveLegacyRoute() *legacyRoute {
	data, err := os.ReadFile(legacyMarkerPath)
	if err != nil {
		return nil
	}
	target := strings.TrimSpace(string(data))
	if target == "" {
		return nil
	}
	dir := filepath.Clean(target)
	if filepath.IsAbs(dir) {
		return nil
	}
	// After Clean, a relative path can only have ".." as leading segments,
	// so requiring the first segment to be exactly ".sdd" (with at least one
	// segment below it) excludes every escape form.
	parts := strings.Split(filepath.ToSlash(dir), "/")
	if len(parts) < 2 || parts[0] != ".sdd" {
		return nil
	}
	session := parts[len(parts)-1]
	if session == "" || session == "." || session == ".." {
		return nil
	}
	return &legacyRoute{
		session: session,
		dir:     dir,
		file:    filepath.Join(dir, legacyStateFile),
	}
}

// legacyDeprecationWarning is attached to every legacy-route result.
const legacyDeprecationWarning = "当前以兼容模式读写旧版问题池（.sdd 标记机制）。请更新调用方式：为工具传入 session 参数；历史数据已自动迁移至新存储。"

// loadLegacyState reads the legacy pool file (empty pool when missing/corrupt).
func loadLegacyState(lr *legacyRoute) (map[string]interface{}, error) {
	data, err := os.ReadFile(lr.file)
	if err != nil {
		return map[string]interface{}{"questions": []interface{}{}, "next_id": float64(1)}, nil
	}
	var state map[string]interface{}
	if err := json.Unmarshal(data, &state); err != nil {
		return map[string]interface{}{"questions": []interface{}{}, "next_id": float64(1)}, nil
	}
	if _, ok := state["questions"]; !ok {
		return map[string]interface{}{"questions": []interface{}{}, "next_id": float64(1)}, nil
	}
	if _, ok := state["next_id"]; !ok {
		state["next_id"] = float64(1)
	}
	return state, nil
}

// saveLegacyState writes the legacy pool file, creating the directory if needed.
func saveLegacyState(lr *legacyRoute, state map[string]interface{}) error {
	if err := os.MkdirAll(lr.dir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(lr.file, data, 0644)
}

// syncLegacyToNew mirrors the legacy pool into the new store
// (~/.question-tracker/<proj>/<session>/state.json), overwriting.
func syncLegacyToNew(lr *legacyRoute, project string) error {
	state, err := loadLegacyState(lr)
	if err != nil {
		return err
	}
	return saveState(state, lr.session, project)
}

// legacyQuestions parses the questions array of a legacy state map.
func legacyQuestions(state map[string]interface{}) []Question {
	questionsRaw, _ := state["questions"].([]interface{})
	var questions []Question
	for _, qRaw := range questionsRaw {
		if m, ok := qRaw.(map[string]interface{}); ok {
			questions = append(questions, QuestionFromDict(m))
		}
	}
	return questions
}

// withLegacyLock executes fn while holding the lock of the legacy file.
func withLegacyLock(lr *legacyRoute, fn func() map[string]interface{}) map[string]interface{} {
	mu := lockForPool(lr.file)
	mu.Lock()
	defer mu.Unlock()
	return fn()
}

// ============================================================
// Question Matching
// ============================================================

func matchQuestion(questionText string, questions []Question) (Question, error) {
	// Strategy 1: exact match
	for _, q := range questions {
		if q.Question == questionText {
			return q, nil
		}
	}

	// Strategy 2: contains match (unique substring)
	var matched []Question
	for _, q := range questions {
		if strings.Contains(q.Question, questionText) {
			matched = append(matched, q)
		}
	}

	if len(matched) == 1 {
		return matched[0], nil
	}

	return Question{}, MatchError{}
}

func validateQuestionsInput(questions []string) error {
	for _, q := range questions {
		if q == "" {
			return ValidationError{}
		}
	}
	return nil
}

// ============================================================
// Tool Implementations
// ============================================================

// missingSessionResult builds the missing_session select guidance.
// Deliberately NOT an error: the MCP is healthy, the caller just has to
// pick a pool (or ask the user to pick / create one).
func missingSessionResult(project string) map[string]interface{} {
	return selectSessionGuidance("missing_session", "", project)
}

// sessionNotFoundResult builds the session_not_found select guidance for a
// requested pool that does not exist. includeArchived is accepted for call
// compatibility; guidance always lists archived pools when present so the
// caller can offer reopen_session.
func sessionNotFoundResult(requested string, includeArchived bool, project string) map[string]interface{} {
	return selectSessionGuidance("session_not_found", requested, project)
}

// selectSessionGuidance builds the unified pool-selection guidance payload.
// It lists active pools (and archived ones when any exist) and instructs the
// AI to retry with a listed name, or — when it cannot determine the target —
// to present the list to the user for selection or creation. It must never
// contain an "error" field, so hosts never render it as a failure.
func selectSessionGuidance(reason, requested, project string) map[string]interface{} {
	avail := listAvailableSessions(project, true)
	active := make([]interface{}, 0, len(avail))
	archived := make([]interface{}, 0)
	for _, s := range avail {
		if s.Archived {
			archived = append(archived, s.Name)
		} else {
			active = append(active, s.Name)
		}
	}

	detail := "本次调用未携带问题池名（session），未执行。"
	if reason == "session_not_found" {
		detail = fmt.Sprintf("问题池 %q 不存在，本次调用未执行。", requested)
	}
	guidance := "若上述池中能确定目标，用其名称作为 session 重试本调用；无法确定时，将列表展示给用户，" +
		"请用户选择使用哪个池、或决定新建问题池（用 create_session 建池后重试本调用）。不得自行换名猜测重试。"
	if len(archived) > 0 {
		guidance += " archived_sessions 是已归档的池：如需继续其中某个，先用 reopen_session 重开再操作。"
	}

	r := map[string]interface{}{
		"action_required":    "select_session",
		"reason":             reason,
		"detail":             detail,
		"available_sessions": active,
		"guidance":           guidance,
	}
	if requested != "" {
		r["requested_session"] = requested
	}
	if len(archived) > 0 {
		r["archived_sessions"] = archived
	}
	return r
}

// poolExists checks whether the state.json of (session, project) exists.
func poolExists(session, project string) (string, bool) {
	stateFile, err := resolveStateFilePath(session, project)
	if err != nil {
		return "", false
	}
	info, err := os.Stat(stateFile)
	return stateFile, err == nil && !info.IsDir()
}

// withPoolLock executes fn while holding the lock of the pool path.
func withPoolLock(session, project string, fn func() map[string]interface{}) map[string]interface{} {
	stateFile, err := resolveStateFilePath(session, project)
	if err != nil {
		return fn()
	}
	mu := lockForPool(stateFile)
	mu.Lock()
	defer mu.Unlock()
	return fn()
}

// createSessionTool implements create_session — the ONLY pool-creation
// entry point. Idempotent: an existing pool is reported with created=false,
// never an error, so an AI recovering from amnesia can safely call it.
// No legacy-marker fallback: creation is a 2.0-only action.
func createSessionTool(session, project string) map[string]interface{} {
	if strings.TrimSpace(session) == "" {
		return missingSessionResult(project)
	}
	stateFile, err := resolveStateFilePath(session, project)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}

	return withPoolLock(session, project, func() map[string]interface{} {
		if _, err := os.Stat(stateFile); err == nil {
			return map[string]interface{}{
				"created":       false,
				"note":          "池已存在，直接续用",
				"pool_location": stateFile,
			}
		}
		state := map[string]interface{}{
			"questions": []interface{}{},
			"next_id":   float64(1),
		}
		if err := saveState(state, session, project); err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		return map[string]interface{}{
			"created":       true,
			"pool_location": stateFile,
		}
	})
}

func addQuestionsTool(questions []string, session, project string) map[string]interface{} {
	if strings.TrimSpace(session) == "" {
		if lr := resolveLegacyRoute(); lr != nil {
			return addQuestionsLegacy(lr, questions, project)
		}
		return missingSessionResult(project)
	}
	if err := validateQuestionsInput(questions); err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	stateFile, err := resolveStateFilePath(session, project)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	// Pool creation lives exclusively in create_session: a mistyped pool
	// name must surface the selection guidance, never silently spawn an
	// orphan pool.
	if _, exists := poolExists(session, project); !exists {
		return sessionNotFoundResult(session, false, project)
	}

	return withPoolLock(session, project, func() map[string]interface{} {
		// Single read-modify-write: load once, append questions AND bump
		// next_id, save once — a crash cannot leave questions written
		// with a stale next_id (which would cause ID reuse).
		state, err := loadState(session, project)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		questionsRaw, _ := state["questions"].([]interface{})
		var allQuestions []Question
		for _, qRaw := range questionsRaw {
			if m, ok := qRaw.(map[string]interface{}); ok {
				allQuestions = append(allQuestions, QuestionFromDict(m))
			}
		}

		nextID := 1
		if v, ok := state["next_id"].(float64); ok {
			nextID = int(v)
		}

		for _, qText := range questions {
			q := Question{
				ID:        nextID,
				Question:  qText,
				Status:    "pending",
				CreatedAt: "",
				History:   []HistoryEntry{},
			}
			allQuestions = append(allQuestions, q)
			nextID++
		}

		var qList []interface{}
		for _, q := range allQuestions {
			qList = append(qList, q.ToDict())
		}
		state["questions"] = qList
		state["next_id"] = float64(nextID)
		if err := saveState(state, session, project); err != nil {
			return map[string]interface{}{"error": err.Error()}
		}

		totalPending := 0
		for _, q := range allQuestions {
			if q.Status == "pending" {
				totalPending++
			}
		}

		return map[string]interface{}{
			"added_count":   len(questions),
			"total_pending": totalPending,
			"pool_location": stateFile,
		}
	})
}

// addQuestionsLegacy serves add_questions on the legacy route.
func addQuestionsLegacy(lr *legacyRoute, questions []string, project string) map[string]interface{} {
	if err := validateQuestionsInput(questions); err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	return withLegacyLock(lr, func() map[string]interface{} {
		state, err := loadLegacyState(lr)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		allQuestions := legacyQuestions(state)

		nextID := 1
		if v, ok := state["next_id"].(float64); ok {
			nextID = int(v)
		}
		for _, qText := range questions {
			q := Question{
				ID:        nextID,
				Question:  qText,
				Status:    "pending",
				CreatedAt: "",
				History:   []HistoryEntry{},
			}
			allQuestions = append(allQuestions, q)
			nextID++
		}

		var qList []interface{}
		for _, q := range allQuestions {
			qList = append(qList, q.ToDict())
		}
		state["questions"] = qList
		state["next_id"] = float64(nextID)
		if err := saveLegacyState(lr, state); err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		if err := syncLegacyToNew(lr, project); err != nil {
			log.Printf("warning: legacy mirror sync failed: %v", err)
		}

		totalPending := 0
		for _, q := range allQuestions {
			if q.Status == "pending" {
				totalPending++
			}
		}
		return map[string]interface{}{
			"added_count":         len(questions),
			"total_pending":       totalPending,
			"pool_location":       lr.file,
			"deprecation_warning": legacyDeprecationWarning,
		}
	})
}

func answerQuestionTool(question, answer, source, derivationNote, session, project string) map[string]interface{} {
	if strings.TrimSpace(session) == "" {
		if lr := resolveLegacyRoute(); lr != nil {
			return answerQuestionLegacy(lr, question, answer, source, derivationNote, project)
		}
		return missingSessionResult(project)
	}
	stateFile, exists := poolExists(session, project)
	if !exists {
		return sessionNotFoundResult(session, false, project)
	}

	return withPoolLock(session, project, func() map[string]interface{} {
		allQuestions, err := getQuestions(session, project)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}

		matchedQ, matchErr := matchQuestion(question, allQuestions)
		if matchErr != nil {
			return map[string]interface{}{
				"error": "未匹配到问题。请使用 get_status 查看准确的问题原文后重试。",
			}
		}

		var matchedIdx int
		for i, q := range allQuestions {
			if q.ID == matchedQ.ID {
				matchedIdx = i
				break
			}
		}

		if allQuestions[matchedIdx].Status == "answered" {
			return map[string]interface{}{
				"error":            "该问题已回答。如需修改，请使用 update_answer。",
				"matched_question": allQuestions[matchedIdx].Question,
				"current_answer":   allQuestions[matchedIdx].Answer,
			}
		}

		now := isoTimestamp()
		allQuestions[matchedIdx].Status = "answered"
		allQuestions[matchedIdx].Answer = &answer
		allQuestions[matchedIdx].Source = &source
		if derivationNote != "" {
			allQuestions[matchedIdx].DerivationNote = &derivationNote
		}
		allQuestions[matchedIdx].AnsweredAt = &now
		allQuestions[matchedIdx].UpdatedAt = &now

		if err := saveQuestions(allQuestions, session, project); err != nil {
			return map[string]interface{}{"error": err.Error()}
		}

		totalPending := 0
		for _, q := range allQuestions {
			if q.Status == "pending" {
				totalPending++
			}
		}

		return map[string]interface{}{
			"matched_question": allQuestions[matchedIdx].Question,
			"total_pending":    totalPending,
			"action_required": map[string]interface{}{
				"type": "analyze_and_add_new_questions",
			},
			"pool_location": stateFile,
		}
	})
}

// answerQuestionLegacy serves answer_question on the legacy route.
func answerQuestionLegacy(lr *legacyRoute, question, answer, source, derivationNote, project string) map[string]interface{} {
	return withLegacyLock(lr, func() map[string]interface{} {
		state, err := loadLegacyState(lr)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		allQuestions := legacyQuestions(state)

		matchedQ, matchErr := matchQuestion(question, allQuestions)
		if matchErr != nil {
			return map[string]interface{}{
				"error": "未匹配到问题。请使用 get_status 查看准确的问题原文后重试。",
			}
		}

		var matchedIdx int
		for i, q := range allQuestions {
			if q.ID == matchedQ.ID {
				matchedIdx = i
				break
			}
		}

		if allQuestions[matchedIdx].Status == "answered" {
			return map[string]interface{}{
				"error":            "该问题已回答。如需修改，请使用 update_answer。",
				"matched_question": allQuestions[matchedIdx].Question,
				"current_answer":   allQuestions[matchedIdx].Answer,
			}
		}

		now := isoTimestamp()
		allQuestions[matchedIdx].Status = "answered"
		allQuestions[matchedIdx].Answer = &answer
		allQuestions[matchedIdx].Source = &source
		if derivationNote != "" {
			allQuestions[matchedIdx].DerivationNote = &derivationNote
		}
		allQuestions[matchedIdx].AnsweredAt = &now
		allQuestions[matchedIdx].UpdatedAt = &now

		var qList []interface{}
		for _, q := range allQuestions {
			qList = append(qList, q.ToDict())
		}
		state["questions"] = qList
		if err := saveLegacyState(lr, state); err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		if err := syncLegacyToNew(lr, project); err != nil {
			log.Printf("warning: legacy mirror sync failed: %v", err)
		}

		totalPending := 0
		for _, q := range allQuestions {
			if q.Status == "pending" {
				totalPending++
			}
		}
		return map[string]interface{}{
			"matched_question": allQuestions[matchedIdx].Question,
			"total_pending":    totalPending,
			"action_required": map[string]interface{}{
				"type": "analyze_and_add_new_questions",
			},
			"pool_location":       lr.file,
			"deprecation_warning": legacyDeprecationWarning,
		}
	})
}

func getStatusTool(detail, session, project string) map[string]interface{} {
	if strings.TrimSpace(session) == "" {
		// Upgrade compatibility: fall back to the legacy .sdd marker route.
		if lr := resolveLegacyRoute(); lr != nil {
			return getStatusLegacy(lr, detail, project)
		}
		return missingSessionResult(project)
	}
	stateFile, exists := poolExists(session, project)
	if !exists {
		return sessionNotFoundResult(session, false, project)
	}

	return withPoolLock(session, project, func() map[string]interface{} {
		allQuestions, err := getQuestions(session, project)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}

		total := len(allQuestions)
		pending := 0
		for _, q := range allQuestions {
			if q.Status == "pending" {
				pending++
			}
		}
		answered := total - pending

		if detail == "summary" {
			return map[string]interface{}{
				"total":         total,
				"pending":       pending,
				"answered":      answered,
				"pool_location": stateFile,
			}
		}

		var questionsData []interface{}
		for _, q := range allQuestions {
			questionsData = append(questionsData, map[string]interface{}{
				"question":        q.Question,
				"status":          q.Status,
				"answer":          strPtr(q.Answer),
				"source":          strPtr(q.Source),
				"derivation_note": strPtr(q.DerivationNote),
				"updated_at":      strPtr(q.UpdatedAt),
				"history":         historyToInterface(q.History),
			})
		}

		return map[string]interface{}{
			"total":         total,
			"pending":       pending,
			"answered":      answered,
			"questions":     questionsData,
			"pool_location": stateFile,
		}
	})
}

// getStatusLegacy serves get_status on the legacy route: reads the legacy
// pool, lazily mirrors it into the new store, and attaches the warning.
func getStatusLegacy(lr *legacyRoute, detail, project string) map[string]interface{} {
	return withLegacyLock(lr, func() map[string]interface{} {
		state, err := loadLegacyState(lr)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		allQuestions := legacyQuestions(state)

		// Lazy migration: mirror into the new store (best-effort).
		if err := syncLegacyToNew(lr, project); err != nil {
			log.Printf("warning: legacy mirror sync failed: %v", err)
		}

		total := len(allQuestions)
		pending := 0
		for _, q := range allQuestions {
			if q.Status == "pending" {
				pending++
			}
		}
		answered := total - pending

		if detail == "summary" {
			return map[string]interface{}{
				"total":               total,
				"pending":             pending,
				"answered":            answered,
				"pool_location":       lr.file,
				"deprecation_warning": legacyDeprecationWarning,
			}
		}

		var questionsData []interface{}
		for _, q := range allQuestions {
			questionsData = append(questionsData, map[string]interface{}{
				"question":        q.Question,
				"status":          q.Status,
				"answer":          strPtr(q.Answer),
				"source":          strPtr(q.Source),
				"derivation_note": strPtr(q.DerivationNote),
				"updated_at":      strPtr(q.UpdatedAt),
				"history":         historyToInterface(q.History),
			})
		}

		return map[string]interface{}{
			"total":               total,
			"pending":             pending,
			"answered":            answered,
			"questions":           questionsData,
			"pool_location":       lr.file,
			"deprecation_warning": legacyDeprecationWarning,
		}
	})
}

func finalizeQuestionsTool(session, project string) map[string]interface{} {
	if strings.TrimSpace(session) == "" {
		if lr := resolveLegacyRoute(); lr != nil {
			return finalizeLegacy(lr, project)
		}
		return missingSessionResult(project)
	}
	stateFile, exists := poolExists(session, project)
	if !exists {
		return sessionNotFoundResult(session, false, project)
	}

	return withPoolLock(session, project, func() map[string]interface{} {
		allQuestions, err := getQuestions(session, project)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}

		var pendingQuestions []Question
		for _, q := range allQuestions {
			if q.Status == "pending" {
				pendingQuestions = append(pendingQuestions, q)
			}
		}

		if len(pendingQuestions) > 0 {
			var pqList []map[string]interface{}
			for _, q := range pendingQuestions {
				pqList = append(pqList, map[string]interface{}{
					"question": q.Question,
				})
			}
			return map[string]interface{}{
				"status":            "blocked",
				"pending_count":     len(pendingQuestions),
				"pending_questions": pqList,
				"pool_location":     stateFile,
			}
		}

		var summary []interface{}
		for _, q := range allQuestions {
			summary = append(summary, map[string]interface{}{
				"question":        q.Question,
				"answer":          strPtr(q.Answer),
				"source":          strPtr(q.Source),
				"derivation_note": strPtr(q.DerivationNote),
			})
		}

		// Archive: move the pool into .archive/ with unique naming.
		finalLocation := archivePool(session, project)

		return map[string]interface{}{
			"status":        "ready",
			"summary":       summary,
			"pool_location": finalLocation,
		}
	})
}

// finalizeLegacy serves finalize_questions on the legacy route: archives the
// pool into the NEW mechanism's .archive/, then removes ONLY the legacy pool
// file and the legacy marker. It must never remove the legacy directory
// itself: .sdd/{SR}/ is the user's SR workspace holding their own design
// documents — the MCP manages pool files only.
func finalizeLegacy(lr *legacyRoute, project string) map[string]interface{} {
	return withLegacyLock(lr, func() map[string]interface{} {
		state, err := loadLegacyState(lr)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		allQuestions := legacyQuestions(state)

		var pendingQuestions []Question
		for _, q := range allQuestions {
			if q.Status == "pending" {
				pendingQuestions = append(pendingQuestions, q)
			}
		}
		if len(pendingQuestions) > 0 {
			var pqList []map[string]interface{}
			for _, q := range pendingQuestions {
				pqList = append(pqList, map[string]interface{}{"question": q.Question})
			}
			return map[string]interface{}{
				"status":            "blocked",
				"pending_count":     len(pendingQuestions),
				"pending_questions": pqList,
				"pool_location":     lr.file,
			}
		}

		var summary []interface{}
		for _, q := range allQuestions {
			summary = append(summary, map[string]interface{}{
				"question":        q.Question,
				"answer":          strPtr(q.Answer),
				"source":          strPtr(q.Source),
				"derivation_note": strPtr(q.DerivationNote),
			})
		}

		// Mirror latest content into the new store, then archive the mirrored
		// pool using the standard archiving logic. Only after a successful
		// mirror, retire the legacy mechanism by removing its own two files:
		// the pool file and the marker. Directories are never touched.
		finalLocation := lr.file
		if err := syncLegacyToNew(lr, project); err != nil {
			log.Printf("warning: legacy mirror sync failed: %v", err)
		} else {
			finalLocation = archivePool(lr.session, project)
			if err := os.Remove(lr.file); err != nil && !os.IsNotExist(err) {
				log.Printf("warning: failed to remove legacy pool file %s: %v", lr.file, err)
			}
			if err := os.Remove(legacyMarkerPath); err != nil && !os.IsNotExist(err) {
				log.Printf("warning: failed to remove legacy marker %s: %v", legacyMarkerPath, err)
			}
		}

		return map[string]interface{}{
			"status":              "ready",
			"summary":             summary,
			"pool_location":       finalLocation,
			"deprecation_warning": legacyDeprecationWarning,
		}
	})
}

// archivePool moves an active pool of the NEW mechanism into .archive/ with
// unique naming (date, date-time, date-time-N). Returns the archived
// state.json path, or the active path when archiving failed.
func archivePool(session, project string) string {
	stateFile, err := resolveStateFilePath(session, project)
	if err != nil {
		return ""
	}
	finalLocation := stateFile
	projectDir, err := resolveProjectDir(project)
	if err != nil {
		return finalLocation
	}
	archiveDir := filepath.Join(projectDir, archiveDirName)
	dateStr := time.Now().Format("20060102")
	candidates := []string{
		session + "-" + dateStr,
		session + "-" + time.Now().Format("20060102-150405"),
	}
	for i := 2; i <= 99; i++ {
		candidates = append(candidates, fmt.Sprintf("%s-%s-%d", session, time.Now().Format("20060102-150405"), i))
	}
	for _, name := range candidates {
		target := filepath.Join(archiveDir, name)
		if _, err := os.Stat(target); err == nil {
			continue
		}
		if err := os.MkdirAll(archiveDir, 0755); err != nil {
			log.Printf("warning: archive mkdir failed: %v", err)
			break
		}
		if err := os.Rename(filepath.Join(projectDir, session), target); err != nil {
			log.Printf("warning: archive rename failed for %s: %v", name, err)
			continue
		}
		return filepath.Join(target, stateFileName)
	}
	log.Printf("warning: archive failed for session %s; pool remains in active area", session)
	return finalLocation
}

func updateAnswerTool(question, answer, reason, session, project string) map[string]interface{} {
	if strings.TrimSpace(session) == "" {
		if lr := resolveLegacyRoute(); lr != nil {
			return updateAnswerLegacy(lr, question, answer, reason, project)
		}
		return missingSessionResult(project)
	}
	stateFile, exists := poolExists(session, project)
	if !exists {
		return sessionNotFoundResult(session, false, project)
	}

	return withPoolLock(session, project, func() map[string]interface{} {
		allQuestions, err := getQuestions(session, project)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}

		matchedQ, matchErr := matchQuestion(question, allQuestions)
		if matchErr != nil {
			return map[string]interface{}{
				"error": "未匹配到问题。请使用 get_status 查看准确的问题原文后重试。",
			}
		}

		var matchedIdx int
		for i, q := range allQuestions {
			if q.ID == matchedQ.ID {
				matchedIdx = i
				break
			}
		}

		if allQuestions[matchedIdx].Status == "pending" {
			return map[string]interface{}{
				"error": "该问题尚未回答，请使用 answer_question 而不是 update_answer。",
			}
		}

		previousAnswer := allQuestions[matchedIdx].Answer
		now := isoTimestamp()

		var reasonPtr *string
		if reason != "" {
			reasonPtr = &reason
		}

		entry := HistoryEntry{
			Answer:    *previousAnswer,
			Reason:    reasonPtr,
			UpdatedAt: now,
		}
		allQuestions[matchedIdx].History = append(allQuestions[matchedIdx].History, entry)
		allQuestions[matchedIdx].Answer = &answer
		allQuestions[matchedIdx].UpdatedAt = &now

		if err := saveQuestions(allQuestions, session, project); err != nil {
			return map[string]interface{}{"error": err.Error()}
		}

		totalPending := 0
		for _, q := range allQuestions {
			if q.Status == "pending" {
				totalPending++
			}
		}

		result := map[string]interface{}{
			"matched_question": allQuestions[matchedIdx].Question,
			"total_pending":    totalPending,
			"action_required": map[string]interface{}{
				"type": "reanalyze_all",
			},
			"pool_location": stateFile,
		}
		if previousAnswer != nil {
			result["previous_answer"] = *previousAnswer
		}

		return result
	})
}

// updateAnswerLegacy serves update_answer on the legacy route.
func updateAnswerLegacy(lr *legacyRoute, question, answer, reason, project string) map[string]interface{} {
	return withLegacyLock(lr, func() map[string]interface{} {
		state, err := loadLegacyState(lr)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		allQuestions := legacyQuestions(state)

		matchedQ, matchErr := matchQuestion(question, allQuestions)
		if matchErr != nil {
			return map[string]interface{}{
				"error": "未匹配到问题。请使用 get_status 查看准确的问题原文后重试。",
			}
		}

		var matchedIdx int
		for i, q := range allQuestions {
			if q.ID == matchedQ.ID {
				matchedIdx = i
				break
			}
		}

		if allQuestions[matchedIdx].Status == "pending" {
			return map[string]interface{}{
				"error": "该问题尚未回答，请使用 answer_question 而不是 update_answer。",
			}
		}

		previousAnswer := allQuestions[matchedIdx].Answer
		now := isoTimestamp()

		var reasonPtr *string
		if reason != "" {
			reasonPtr = &reason
		}

		entry := HistoryEntry{
			Answer:    *previousAnswer,
			Reason:    reasonPtr,
			UpdatedAt: now,
		}
		allQuestions[matchedIdx].History = append(allQuestions[matchedIdx].History, entry)
		allQuestions[matchedIdx].Answer = &answer
		allQuestions[matchedIdx].UpdatedAt = &now

		var qList []interface{}
		for _, q := range allQuestions {
			qList = append(qList, q.ToDict())
		}
		state["questions"] = qList
		if err := saveLegacyState(lr, state); err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		if err := syncLegacyToNew(lr, project); err != nil {
			log.Printf("warning: legacy mirror sync failed: %v", err)
		}

		totalPending := 0
		for _, q := range allQuestions {
			if q.Status == "pending" {
				totalPending++
			}
		}
		result := map[string]interface{}{
			"matched_question": allQuestions[matchedIdx].Question,
			"total_pending":    totalPending,
			"action_required": map[string]interface{}{
				"type": "reanalyze_all",
			},
			"pool_location":       lr.file,
			"deprecation_warning": legacyDeprecationWarning,
		}
		if previousAnswer != nil {
			result["previous_answer"] = *previousAnswer
		}
		return result
	})
}

func resetQuestionsTool(onlyPending bool, session, project string) map[string]interface{} {
	if strings.TrimSpace(session) == "" {
		if lr := resolveLegacyRoute(); lr != nil {
			return resetQuestionsLegacy(lr, onlyPending, project)
		}
		return missingSessionResult(project)
	}
	stateFile, exists := poolExists(session, project)
	if !exists {
		return sessionNotFoundResult(session, false, project)
	}

	return withPoolLock(session, project, func() map[string]interface{} {
		allQuestions, err := getQuestions(session, project)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}

		var remaining []Question
		if onlyPending {
			for _, q := range allQuestions {
				if q.Status != "pending" {
					remaining = append(remaining, q)
				}
			}
		}

		cleared := len(allQuestions) - len(remaining)
		if err := saveQuestions(remaining, session, project); err != nil {
			return map[string]interface{}{"error": err.Error()}
		}

		return map[string]interface{}{
			"cleared_count":   cleared,
			"remaining_count": len(remaining),
			"total_pending":   0,
			"pool_location":   stateFile,
		}
	})
}

// resetQuestionsLegacy serves reset_questions on the legacy route.
func resetQuestionsLegacy(lr *legacyRoute, onlyPending bool, project string) map[string]interface{} {
	return withLegacyLock(lr, func() map[string]interface{} {
		state, err := loadLegacyState(lr)
		if err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		allQuestions := legacyQuestions(state)

		var remaining []Question
		if onlyPending {
			for _, q := range allQuestions {
				if q.Status != "pending" {
					remaining = append(remaining, q)
				}
			}
		}

		cleared := len(allQuestions) - len(remaining)
		var qList []interface{}
		for _, q := range remaining {
			qList = append(qList, q.ToDict())
		}
		state["questions"] = qList
		if err := saveLegacyState(lr, state); err != nil {
			return map[string]interface{}{"error": err.Error()}
		}
		if err := syncLegacyToNew(lr, project); err != nil {
			log.Printf("warning: legacy mirror sync failed: %v", err)
		}

		return map[string]interface{}{
			"cleared_count":       cleared,
			"remaining_count":     len(remaining),
			"total_pending":       0,
			"pool_location":       lr.file,
			"deprecation_warning": legacyDeprecationWarning,
		}
	})
}

func listSessionsTool(includeArchived bool, project string) map[string]interface{} {
	projectDir, err := resolveProjectDir(project)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	avail := listAvailableSessions(project, includeArchived)
	sessions := make([]interface{}, 0, len(avail))
	for _, s := range avail {
		sessions = append(sessions, map[string]interface{}{
			"name":       s.Name,
			"path":       s.Path,
			"archived":   s.Archived,
			"updated_at": s.UpdatedAt,
			"total":      s.Total,
			"pending":    s.Pending,
		})
	}
	return map[string]interface{}{
		"project_dir": projectDir,
		"sessions":    sessions,
	}
}

func cleanupSessionsTool(action string, olderThanDays int, confirm bool, project string) map[string]interface{} {
	projectDir, err := resolveProjectDir(project)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	archiveDir := filepath.Join(projectDir, archiveDirName)

	type candidate struct {
		name string
		path string
		info os.FileInfo
	}
	var expired []candidate

	if olderThanDays <= 0 {
		olderThanDays = 90
	}
	cutoff := time.Now().Add(-time.Duration(olderThanDays) * 24 * time.Hour)

	if entries, err := os.ReadDir(archiveDir); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			dirPath := filepath.Join(archiveDir, e.Name())
			info, err := os.Stat(dirPath)
			if err != nil {
				continue
			}
			if info.ModTime().Before(cutoff) {
				expired = append(expired, candidate{name: e.Name(), path: dirPath, info: info})
			}
		}
	}

	if action == "purge_archived" {
		if !confirm {
			return map[string]interface{}{
				"error":  "confirm_required",
				"detail": "purge_archived 需要 confirm: true 才执行删除",
			}
		}
		var deleted, failed []interface{}
		for _, c := range expired {
			if err := os.RemoveAll(c.path); err != nil {
				failed = append(failed, map[string]interface{}{"name": c.name, "error": err.Error()})
			} else {
				deleted = append(deleted, c.name)
			}
		}
		return map[string]interface{}{
			"deleted": deleted,
			"failed":  failed,
		}
	}

	// Default: list_expired (never deletes)
	cands := make([]interface{}, 0, len(expired))
	for _, c := range expired {
		cands = append(cands, map[string]interface{}{
			"name":        c.name,
			"path":        c.path,
			"archived_at": c.info.ModTime().Format("2006-01-02T15:04:05.000000"),
		})
	}
	return map[string]interface{}{
		"candidates": cands,
		"note":       "purge_archived + confirm: true 将删除以上归档池",
	}
}

func reopenSessionTool(session, project string) map[string]interface{} {
	if strings.TrimSpace(session) == "" {
		return missingSessionResult(project)
	}
	projectDir, err := resolveProjectDir(project)
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}

	src := filepath.Join(projectDir, archiveDirName, session)
	if info, err := os.Stat(src); err != nil || !info.IsDir() {
		return sessionNotFoundResult(session, true, project)
	}

	// Restore original name: strip one archive suffix by shape.
	stripped := stripArchiveSuffix(session)

	dst := filepath.Join(projectDir, stripped)
	if _, err := os.Stat(dst); err == nil {
		return map[string]interface{}{
			"error":               "conflict",
			"detail":              "活跃区已存在同名池",
			"conflicting_session": stripped,
		}
	}

	if err := os.Rename(src, dst); err != nil {
		return map[string]interface{}{"error": fmt.Sprintf("重开失败: %v", err)}
	}

	total, pending := -1, -1
	statePath := filepath.Join(dst, stateFileName)
	if data, err := os.ReadFile(statePath); err == nil {
		var state map[string]interface{}
		if json.Unmarshal(data, &state) == nil {
			questions, _ := state["questions"].([]interface{})
			total, pending = 0, 0
			for _, q := range questions {
				if m, ok := q.(map[string]interface{}); ok {
					total++
					if m["status"] == "pending" {
						pending++
					}
				}
			}
		}
	}

	return map[string]interface{}{
		"reopened":      stripped,
		"pool_location": statePath,
		"total":         total,
		"pending":       pending,
	}
}

func deleteSessionTool(session string, confirm bool, project string) map[string]interface{} {
	if strings.TrimSpace(session) == "" {
		return missingSessionResult(project)
	}
	if !confirm {
		return map[string]interface{}{
			"error":  "confirm_required",
			"detail": "delete_session 需要 confirm: true 才执行删除",
		}
	}
	stateFile, exists := poolExists(session, project)
	if !exists {
		return sessionNotFoundResult(session, false, project)
	}

	return withPoolLock(session, project, func() map[string]interface{} {
		// Audit stats and deletion under the same lock — the numbers
		// returned always describe the pool exactly as deleted.
		total, pending, answered := 0, 0, 0
		if data, err := os.ReadFile(stateFile); err == nil {
			var state map[string]interface{}
			if json.Unmarshal(data, &state) == nil {
				questions, _ := state["questions"].([]interface{})
				for _, q := range questions {
					if m, ok := q.(map[string]interface{}); ok {
						total++
						if m["status"] == "pending" {
							pending++
						} else {
							answered++
						}
					}
				}
			}
		}

		poolDir := filepath.Dir(stateFile)
		if err := os.RemoveAll(poolDir); err != nil {
			return map[string]interface{}{"error": fmt.Sprintf("删除失败: %v", err)}
		}
		return map[string]interface{}{
			"deleted":  session,
			"total":    total,
			"pending":  pending,
			"answered": answered,
		}
	})
}

// ============================================================
// Debug logging (QUESTION_TRACKER_DEBUG)
// ============================================================
//
// Enabled by env var QUESTION_TRACKER_DEBUG:
//   - "1" / "true" / "on" (case-insensitive) → log to <poolRoot>/debug.log
//   - any other non-empty value              → treated as the log file path
//
// Every raw request line and every response line is appended to the file,
// so field incidents can be diagnosed from the user's machine. The debug
// path must NEVER take the server down: open/write failures only disable
// logging, and debugf recovers from any panic.

var debugLogger *log.Logger

func initDebugLogger() {
	v := strings.TrimSpace(os.Getenv(debugEnvVar))
	if v == "" {
		return
	}
	path := v
	if strings.EqualFold(v, "1") || strings.EqualFold(v, "true") || strings.EqualFold(v, "on") {
		path = filepath.Join(poolRoot(), "debug.log")
	}
	if dir := filepath.Dir(path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0755); err != nil {
			log.Printf("debug log disabled: cannot create dir %s: %v", dir, err)
			return
		}
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		log.Printf("debug log disabled: cannot open %s: %v", path, err)
		return
	}
	debugLogger = log.New(f, "", log.Ldate|log.Ltime|log.Lmicroseconds)
	cwd, _ := os.Getwd()
	debugf("startup version=%s pid=%d cwd=%s %s=%q",
		serverVersion, os.Getpid(), cwd, homeEnvVar, os.Getenv(homeEnvVar))
}

// debugf appends one line to the debug log. Nil-safe, error-swallowing,
// panic-recovering — a broken debug sink must never crash the server.
func debugf(format string, args ...interface{}) {
	if debugLogger == nil {
		return
	}
	defer func() { _ = recover() }()
	debugLogger.Printf(format, args...)
}

// truncateForLog bounds one logged line so a pathological request cannot
// blow up the debug file.
func truncateForLog(s string) string {
	const maxLine = 64 * 1024
	if len(s) > maxLine {
		return s[:maxLine] + "...[truncated]"
	}
	return s
}

// ============================================================
// JSON-RPC / MCP Transport
// ============================================================

type jsonrpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
	ID      *int            `json:"id,omitempty"`
}

type jsonrpcResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	Result  interface{} `json:"result,omitempty"`
	Error   *rpcError   `json:"error,omitempty"`
	ID      *int        `json:"id,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type toolsCallParams struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

// parseArguments decodes tool-call arguments into a map. Defensive against
// hosts that forward the model's arguments as a JSON string (OpenAI-style
// function calling defines arguments AS a string; a host that skips the
// parse step double-encodes it) — one extra unmarshal round recovers the
// call instead of failing with an opaque protocol error.
func parseArguments(raw json.RawMessage) map[string]interface{} {
	if len(raw) == 0 {
		return nil
	}
	var args map[string]interface{}
	if err := json.Unmarshal(raw, &args); err == nil {
		return args
	}
	var s string
	if err := json.Unmarshal(raw, &s); err == nil {
		if err := json.Unmarshal([]byte(s), &args); err == nil {
			return args
		}
	}
	return nil
}

type toolsListResult struct {
	Tools []toolDef `json:"tools"`
}

type toolDef struct {
	Name        string      `json:"name"`
	Description string      `json:"description"`
	InputSchema inputSchema `json:"inputSchema"`
}

type inputSchema struct {
	Type       string                 `json:"type"`
	Properties map[string]propertyDef `json:"properties"`
	Required   []string               `json:"required,omitempty"`
}

type propertyDef struct {
	Type        string       `json:"type"`
	Description string       `json:"description,omitempty"`
	Items       *propertyDef `json:"items,omitempty"`
}

var sessionProp = propertyDef{Type: "string", Description: "目标会话池名（必填）"}
var projectProp = propertyDef{Type: "string", Description: "项目维度覆盖，通常无需指定"}

func toolDefinitions() []toolDef {
	return []toolDef{
		{
			Name:        "create_session",
			Description: "新建问题池（唯一建池入口；同名池已存在时幂等返回，不报错）",
			InputSchema: inputSchema{
				Type: "object",
				Properties: map[string]propertyDef{
					"session": sessionProp,
					"project": projectProp,
				},
				Required: []string{"session"},
			},
		},
		{
			Name:        "add_questions",
			Description: "批量添加待确认问题到问题池（池须已存在，先 create_session 建池；池不存在时返回选池指引）",
			InputSchema: inputSchema{
				Type: "object",
				Properties: map[string]propertyDef{
					"questions": {Type: "array", Description: "问题文本列表", Items: &propertyDef{Type: "string"}},
					"session":   sessionProp,
					"project":   projectProp,
				},
				Required: []string{"questions", "session"},
			},
		},
		{
			Name:        "answer_question",
			Description: "记录用户对某个问题的答案",
			InputSchema: inputSchema{
				Type: "object",
				Properties: map[string]propertyDef{
					"question":        {Type: "string", Description: "问题原文"},
					"answer":          {Type: "string", Description: "答案内容"},
					"source":          {Type: "string", Description: `"user" 或 "derived"`},
					"derivation_note": {Type: "string", Description: "推导依据"},
					"session":         sessionProp,
					"project":         projectProp,
				},
				Required: []string{"question", "answer", "session"},
			},
		},
		{
			Name:        "get_status",
			Description: "获取问题池状态",
			InputSchema: inputSchema{
				Type: "object",
				Properties: map[string]propertyDef{
					"detail":  {Type: "string", Description: `"summary" 或 "full"`},
					"session": sessionProp,
					"project": projectProp,
				},
				Required: []string{"session"},
			},
		},
		{
			Name:        "finalize_questions",
			Description: "最终确认所有问题已澄清（ready 后自动归档该池）",
			InputSchema: inputSchema{
				Type: "object",
				Properties: map[string]propertyDef{
					"session": sessionProp,
					"project": projectProp,
				},
				Required: []string{"session"},
			},
		},
		{
			Name:        "update_answer",
			Description: "修改某个已记录问题的答案",
			InputSchema: inputSchema{
				Type: "object",
				Properties: map[string]propertyDef{
					"question": {Type: "string", Description: "问题原文"},
					"answer":   {Type: "string", Description: "新答案"},
					"reason":   {Type: "string", Description: "修改原因"},
					"session":  sessionProp,
					"project":  projectProp,
				},
				Required: []string{"question", "answer", "session"},
			},
		},
		{
			Name:        "reset_questions",
			Description: "重置问题池（用户确认放弃前序问题后调用）",
			InputSchema: inputSchema{
				Type: "object",
				Properties: map[string]propertyDef{
					"only_pending": {Type: "boolean", Description: "True 仅清除 pending，False 清空全部"},
					"session":      sessionProp,
					"project":      projectProp,
				},
				Required: []string{"session"},
			},
		},
		{
			Name:        "list_sessions",
			Description: "列出当前项目下的所有会话池（失忆恢复与审计入口）",
			InputSchema: inputSchema{
				Type: "object",
				Properties: map[string]propertyDef{
					"include_archived": {Type: "boolean", Description: "是否包含归档池"},
					"project":          projectProp,
				},
				Required: []string{},
			},
		},
		{
			Name:        "cleanup_sessions",
			Description: "归档池的受控清理（默认只列不删）",
			InputSchema: inputSchema{
				Type: "object",
				Properties: map[string]propertyDef{
					"action":          {Type: "string", Description: `"list_expired"（默认）或 "purge_archived"`},
					"older_than_days": {Type: "number", Description: "归档时间超过该天数的池纳入范围（默认 90）"},
					"confirm":         {Type: "boolean", Description: "purge_archived 时必须为 true"},
					"project":         projectProp,
				},
				Required: []string{},
			},
		},
		{
			Name:        "reopen_session",
			Description: "将归档池重开回活跃区",
			InputSchema: inputSchema{
				Type: "object",
				Properties: map[string]propertyDef{
					"session": {Type: "string", Description: "归档池名（含日期后缀）"},
					"project": projectProp,
				},
				Required: []string{"session"},
			},
		},
		{
			Name:        "delete_session",
			Description: "删除活跃池（需要 confirm: true）",
			InputSchema: inputSchema{
				Type: "object",
				Properties: map[string]propertyDef{
					"session": {Type: "string", Description: "目标活跃池名"},
					"confirm": {Type: "boolean", Description: "必须为 true 才执行删除"},
					"project": projectProp,
				},
				Required: []string{"session"},
			},
		},
	}
}

func writeResponse(resp jsonrpcResponse) {
	data, err := json.Marshal(resp)
	if err != nil {
		log.Printf("ERROR: failed to marshal response: %v", err)
		return
	}
	debugf("[resp] %s", truncateForLog(string(data)))
	fmt.Fprintf(os.Stdout, "%s\n", string(data))
}

func handleRequest(req jsonrpcRequest) {
	switch req.Method {
	case "initialize":
		respondVersion := SUPPORTED_VERSIONS[0]
		var initParams struct {
			ProtocolVersion string `json:"protocolVersion"`
		}
		if len(req.Params) > 0 {
			if err := json.Unmarshal(req.Params, &initParams); err == nil {
				for _, v := range SUPPORTED_VERSIONS {
					if initParams.ProtocolVersion == v {
						respondVersion = v
						break
					}
				}
			}
		}
		writeResponse(jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"protocolVersion": respondVersion,
				"capabilities": map[string]interface{}{
					"tools": map[string]interface{}{},
				},
				"serverInfo": map[string]interface{}{
					"name":    serverName,
					"version": serverVersion,
				},
			},
		})

	case "notifications/initialized":
		// No response for notifications

	case "tools/list":
		writeResponse(jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  toolsListResult{Tools: toolDefinitions()},
		})

	case "tools/call":
		var params toolsCallParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			writeResponse(jsonrpcResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   &rpcError{Code: -32602, Message: "Invalid params"},
			})
			return
		}

		result, isErr := dispatchTool(params.Name, parseArguments(params.Arguments))
		if result == nil {
			// Unknown tool → protocol error per MCP spec
			writeResponse(jsonrpcResponse{
				JSONRPC: "2.0",
				ID:      req.ID,
				Error:   &rpcError{Code: -32602, Message: fmt.Sprintf("Unknown tool: %s", params.Name)},
			})
			return
		}
		resultJSON, _ := json.Marshal(result)

		toolResult := map[string]interface{}{
			"content": []map[string]interface{}{
				{
					"type": "text",
					"text": string(resultJSON),
				},
			},
		}
		if isErr {
			toolResult["isError"] = true
		}

		writeResponse(jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  toolResult,
		})

	case "ping":
		writeResponse(jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result:  map[string]interface{}{},
		})

	default:
		writeResponse(jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Error:   &rpcError{Code: -32601, Message: fmt.Sprintf("Method not found: %s", req.Method)},
		})
	}
}

// sessionRequiredTools take a mandatory session argument.
var sessionRequiredTools = map[string]bool{
	"create_session":     true,
	"add_questions":      true,
	"answer_question":    true,
	"get_status":         true,
	"finalize_questions": true,
	"update_answer":      true,
	"reset_questions":    true,
	"reopen_session":     true,
	"delete_session":     true,
}

func dispatchTool(name string, args map[string]interface{}) (map[string]interface{}, bool) {
	// A session argument arriving as a non-string (number/bool/object/array)
	// or explicit null is a host serialization artifact, NOT "session
	// omitted" — report it distinctly so it can never be mistaken for
	// missing_session, and point at the debug log for forensics.
	if sessionRequiredTools[name] {
		if v, present := args["session"]; present {
			if _, isStr := v.(string); !isStr {
				return map[string]interface{}{
					"error":    "invalid_session",
					"received": fmt.Sprintf("%v", v),
					"hint": fmt.Sprintf("session 参数必须是字符串，实际收到类型 %T——疑似宿主参数封装/序列化异常。"+
						"设 %s=1 重试后可从调试日志文件取证原始请求。", v, debugEnvVar),
				}, true
			}
		}
	}

	var result map[string]interface{}
	switch name {
	case "create_session":
		session := getString(args, "session")
		project := getString(args, "project")
		result = createSessionTool(session, project)

	case "add_questions":
		questions := getStringSlice(args, "questions")
		session := getString(args, "session")
		project := getString(args, "project")
		result = addQuestionsTool(questions, session, project)

	case "answer_question":
		question := getString(args, "question")
		answer := getString(args, "answer")
		source := getStringDefault(args, "source", "user")
		derivationNote := getStringDefault(args, "derivation_note", "")
		session := getString(args, "session")
		project := getString(args, "project")
		result = answerQuestionTool(question, answer, source, derivationNote, session, project)

	case "get_status":
		detail := getStringDefault(args, "detail", "full")
		session := getString(args, "session")
		project := getString(args, "project")
		result = getStatusTool(detail, session, project)

	case "finalize_questions":
		session := getString(args, "session")
		project := getString(args, "project")
		result = finalizeQuestionsTool(session, project)

	case "update_answer":
		question := getString(args, "question")
		answer := getString(args, "answer")
		reason := getStringDefault(args, "reason", "")
		session := getString(args, "session")
		project := getString(args, "project")
		result = updateAnswerTool(question, answer, reason, session, project)

	case "reset_questions":
		onlyPending := false
		if v, ok := args["only_pending"]; ok {
			if b, ok := v.(bool); ok {
				onlyPending = b
			}
		}
		session := getString(args, "session")
		project := getString(args, "project")
		result = resetQuestionsTool(onlyPending, session, project)

	case "list_sessions":
		includeArchived := false
		if v, ok := args["include_archived"]; ok {
			if b, ok := v.(bool); ok {
				includeArchived = b
			}
		}
		project := getString(args, "project")
		result = listSessionsTool(includeArchived, project)

	case "cleanup_sessions":
		action := getStringDefault(args, "action", "list_expired")
		olderThanDays := 90
		if v, ok := args["older_than_days"]; ok {
			if f, ok := v.(float64); ok {
				olderThanDays = int(f)
			}
		}
		confirm := false
		if v, ok := args["confirm"]; ok {
			if b, ok := v.(bool); ok {
				confirm = b
			}
		}
		project := getString(args, "project")
		result = cleanupSessionsTool(action, olderThanDays, confirm, project)

	case "reopen_session":
		session := getString(args, "session")
		project := getString(args, "project")
		result = reopenSessionTool(session, project)

	case "delete_session":
		session := getString(args, "session")
		confirm := false
		if v, ok := args["confirm"]; ok {
			if b, ok := v.(bool); ok {
				confirm = b
			}
		}
		project := getString(args, "project")
		result = deleteSessionTool(session, confirm, project)

	default:
		return nil, false // unknown tool handled by caller as protocol error
	}

	_, hasError := result["error"]
	return result, hasError
}

// ============================================================
// Output Helpers — convert Go types to JSON-compatible values
// ============================================================

// strPtr dereferences *string for JSON output (string or nil).
func strPtr(s *string) interface{} {
	if s == nil {
		return nil
	}
	return *s
}

// historyToInterface converts []HistoryEntry to []interface{} for JSON output.
func historyToInterface(h []HistoryEntry) []interface{} {
	if h == nil {
		return nil
	}
	result := make([]interface{}, 0, len(h))
	for _, he := range h {
		var reason interface{}
		if he.Reason != nil {
			reason = *he.Reason
		}
		result = append(result, map[string]interface{}{
			"answer":     he.Answer,
			"reason":     reason,
			"updated_at": he.UpdatedAt,
		})
	}
	return result
}

// ============================================================
// Helpers
// ============================================================

func getString(m map[string]interface{}, key string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return ""
}

func getStringDefault(m map[string]interface{}, key, defaultVal string) string {
	if v, ok := m[key]; ok {
		if s, ok := v.(string); ok {
			return s
		}
	}
	return defaultVal
}

func getFloat64(m map[string]interface{}, key string) float64 {
	if v, ok := m[key]; ok {
		if f, ok := v.(float64); ok {
			return f
		}
	}
	return 0
}

func getStringSlice(m map[string]interface{}, key string) []string {
	var result []string
	if v, ok := m[key]; ok {
		if arr, ok := v.([]interface{}); ok {
			for _, item := range arr {
				if s, ok := item.(string); ok {
					result = append(result, s)
				}
			}
		}
	}
	return result
}

// ============================================================
// Main
// ============================================================

func main() {
	// Ensure all logging goes to stderr so stdout is clean JSON-RPC
	log.SetOutput(os.Stderr)
	log.SetFlags(0)
	initDebugLogger()

	scanner := bufio.NewScanner(os.Stdin)
	// 1 MB buffer for large messages
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}
		debugf("[req] %s", truncateForLog(line))

		var req jsonrpcRequest
		if err := json.Unmarshal([]byte(line), &req); err != nil {
			writeResponse(jsonrpcResponse{
				JSONRPC: "2.0",
				ID:      nil,
				Error:   &rpcError{Code: -32700, Message: "Parse error"},
			})
			continue
		}

		handleRequest(req)
	}

	if err := scanner.Err(); err != nil {
		log.Printf("stdin scanner error: %v", err)
	}
}
