package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// ============================================================
// Constants
// ============================================================

const (
	stateFileName  = ".question_state.json"
	sessionMarker  = ".sdd/.current_session"
	serverName     = "question-tracker"
	serverVersion  = "1.0.0"
	protocolVersion = "2024-11-05"
)

// ============================================================
// Custom Errors
// ============================================================

// MatchError is raised when question matching fails.
type MatchError struct{}

func (e MatchError) Error() string { return "未匹配到问题" }

// ValidationError is raised when input validation fails.
type ValidationError struct{}

func (e ValidationError) Error() string { return "问题列表不能包含空字符串" }

// SessionNotFoundError is raised when the session marker file is missing.
type SessionNotFoundError struct{}

func (e SessionNotFoundError) Error() string {
	return "未找到 .sdd/.current_session 会话标记文件。\n" +
		"请通过 aaw-workflow 启动工作流（输入 /aaw-workflow 或 \"进入工作流\"），" +
		"不要直接调用 sr-design 子技能。\n" +
		"aaw-workflow 会在调用子技能前自动写入该标记文件。"
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

// isoTimestamp returns the current time in Python-compatible ISO format.
func isoTimestamp() string {
	return time.Now().Format("2006-01-02T15:04:05.000000")
}

// ============================================================
// State Persistence (session-isolated)
// ============================================================

// getStateFilePath returns the path to the question state file for the current session.
func getStateFilePath() (string, error) {
	data, err := os.ReadFile(sessionMarker)
	if err != nil {
		return "", SessionNotFoundError{}
	}
	sessionDir := strings.TrimSpace(string(data))
	if sessionDir == "" {
		return "", SessionNotFoundError{}
	}
	return filepath.Join(sessionDir, stateFileName), nil
}

func loadState() (map[string]interface{}, error) {
	stateFile, err := getStateFilePath()
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

	// Ensure next_id exists
	if _, ok := state["next_id"]; !ok {
		state["next_id"] = float64(1)
	}

	return state, nil
}

func saveState(state map[string]interface{}) error {
	stateFile, err := getStateFilePath()
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
	// Ensure UTF-8, no ASCII escaping (matching Python ensure_ascii=False)
	// json.MarshalIndent in Go already produces valid UTF-8 without escaping

	return os.WriteFile(stateFile, data, 0644)
}

func getQuestions() ([]Question, error) {
	state, err := loadState()
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

func saveQuestions(questions []Question) error {
	state, err := loadState()
	if err != nil {
		return err
	}
	var qList []interface{}
	for _, q := range questions {
		qList = append(qList, q.ToDict())
	}
	state["questions"] = qList
	return saveState(state)
}

func getNextID() (int, error) {
	state, err := loadState()
	if err != nil {
		return 0, err
	}
	if v, ok := state["next_id"].(float64); ok {
		return int(v), nil
	}
	return 1, nil
}

func setNextID(nextID int) error {
	state, err := loadState()
	if err != nil {
		return err
	}
	state["next_id"] = float64(nextID)
	return saveState(state)
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

func addQuestionsTool(questions []string) map[string]interface{} {
	if err := validateQuestionsInput(questions); err != nil {
		return map[string]interface{}{"error": err.Error()}
	}

	allQuestions, err := getQuestions()
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}

	nextID, err := getNextID()
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
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

	if err := saveQuestions(allQuestions); err != nil {
		return map[string]interface{}{"error": err.Error()}
	}
	if err := setNextID(nextID); err != nil {
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
	}
}

func answerQuestionTool(question, answer, source, derivationNote string) map[string]interface{} {
	allQuestions, err := getQuestions()
	if err != nil {
		return map[string]interface{}{"error": err.Error()}
	}

	matchedQ, matchErr := matchQuestion(question, allQuestions)
	if matchErr != nil {
		return map[string]interface{}{
			"error": "未匹配到问题。请使用 get_status 查看准确的问题原文后重试。",
		}
	}

	// Find the index of matched question
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

	if err := saveQuestions(allQuestions); err != nil {
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
	}
}

func getStatusTool(detail string) map[string]interface{} {
	allQuestions, err := getQuestions()
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
			"total":    total,
			"pending":  pending,
			"answered": answered,
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
		"total":     total,
		"pending":   pending,
		"answered":  answered,
		"questions": questionsData,
	}
}

func finalizeQuestionsTool() map[string]interface{} {
	allQuestions, err := getQuestions()
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

	return map[string]interface{}{
		"status":  "ready",
		"summary": summary,
	}
}

func updateAnswerTool(question, answer, reason string) map[string]interface{} {
	allQuestions, err := getQuestions()
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

	if err := saveQuestions(allQuestions); err != nil {
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
	}
	if previousAnswer != nil {
		result["previous_answer"] = *previousAnswer
	}

	return result
}

func resetQuestionsTool(onlyPending bool) map[string]interface{} {
	allQuestions, err := getQuestions()
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
	if err := saveQuestions(remaining); err != nil {
		return map[string]interface{}{"error": err.Error()}
	}

	return map[string]interface{}{
		"cleared_count":   cleared,
		"remaining_count": len(remaining),
		"total_pending":   0,
	}
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
	Name      string                 `json:"name"`
	Arguments map[string]interface{} `json:"arguments"`
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
	Type       string                   `json:"type"`
	Properties map[string]propertyDef   `json:"properties"`
	Required   []string                 `json:"required,omitempty"`
}

type propertyDef struct {
	Type        string `json:"type"`
	Description string `json:"description,omitempty"`
	Items       *propertyDef `json:"items,omitempty"`
}

func toolDefinitions() []toolDef {
	return []toolDef{
		{
			Name:        "add_questions",
			Description: "批量添加待确认问题到问题池",
			InputSchema: inputSchema{
				Type: "object",
				Properties: map[string]propertyDef{
					"questions": {
						Type:        "array",
						Description: "问题文本列表",
						Items:       &propertyDef{Type: "string"},
					},
				},
				Required: []string{"questions"},
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
				},
				Required: []string{"question", "answer"},
			},
		},
		{
			Name:        "get_status",
			Description: "获取问题池状态",
			InputSchema: inputSchema{
				Type: "object",
				Properties: map[string]propertyDef{
					"detail": {Type: "string", Description: `"summary" 或 "full"`},
				},
				Required: []string{},
			},
		},
		{
			Name:        "finalize_questions",
			Description: "最终确认所有问题已澄清",
			InputSchema: inputSchema{
				Type:       "object",
				Properties: map[string]propertyDef{},
				Required:   []string{},
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
				},
				Required: []string{"question", "answer"},
			},
		},
		{
			Name:        "reset_questions",
			Description: "重置问题池（用户确认放弃前序问题后调用）",
			InputSchema: inputSchema{
				Type: "object",
				Properties: map[string]propertyDef{
					"only_pending": {Type: "boolean", Description: "True 仅清除 pending，False 清空全部"},
				},
				Required: []string{},
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
	fmt.Fprintf(os.Stdout, "%s\n", string(data))
}

func handleRequest(req jsonrpcRequest) {
	switch req.Method {
	case "initialize":
		writeResponse(jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"protocolVersion": protocolVersion,
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

		result := dispatchTool(params.Name, params.Arguments)
		resultJSON, _ := json.Marshal(result)

		writeResponse(jsonrpcResponse{
			JSONRPC: "2.0",
			ID:      req.ID,
			Result: map[string]interface{}{
				"content": []map[string]interface{}{
					{
						"type": "text",
						"text": string(resultJSON),
					},
				},
			},
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

func dispatchTool(name string, args map[string]interface{}) map[string]interface{} {
	switch name {
	case "add_questions":
		questions := getStringSlice(args, "questions")
		return addQuestionsTool(questions)

	case "answer_question":
		question := getString(args, "question")
		answer := getString(args, "answer")
		source := getStringDefault(args, "source", "user")
		derivationNote := getStringDefault(args, "derivation_note", "")
		return answerQuestionTool(question, answer, source, derivationNote)

	case "get_status":
		detail := getStringDefault(args, "detail", "full")
		return getStatusTool(detail)

	case "finalize_questions":
		return finalizeQuestionsTool()

	case "update_answer":
		question := getString(args, "question")
		answer := getString(args, "answer")
		reason := getStringDefault(args, "reason", "")
		return updateAnswerTool(question, answer, reason)

	case "reset_questions":
		onlyPending := false
		if v, ok := args["only_pending"]; ok {
			if b, ok := v.(bool); ok {
				onlyPending = b
			}
		}
		return resetQuestionsTool(onlyPending)

	default:
		return map[string]interface{}{
			"error": fmt.Sprintf("Unknown tool: %s", name),
		}
	}
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

	scanner := bufio.NewScanner(os.Stdin)
	// 1 MB buffer for large messages
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			continue
		}

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
