package handlers

import (
	"ai-prisoner/internal/db"
	"ai-prisoner/internal/game"
	"ai-prisoner/internal/models"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// CreateMatchRequest represents the request to create a match
type CreateMatchRequest struct{}

// CreateMatch handles match creation
func CreateMatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	agent := GetAgentFromContext(r.Context())

	matchID, err := game.CreateMatch(agent.ID)
	if err != nil {
		log.Printf("Failed to create match for agent %d: %v", agent.ID, err)
		http.Error(w, "Failed to create match", http.StatusInternalServerError)
		return
	}

	log.Printf("Match created: ID=%d, Agent1=%d", matchID, agent.ID)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]int{"match_id": matchID})
}

// SubmitActionRequest represents the request to submit an action
type SubmitActionRequest struct {
	Action string `json:"action"`
}

// SubmitAction handles action submission
func SubmitAction(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	agent := GetAgentFromContext(r.Context())

	// Parse /matches/{id}/actions
	path := strings.TrimPrefix(r.URL.Path, "/matches/")
	parts := strings.Split(path, "/")
	if len(parts) < 2 || parts[1] != "actions" {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	matchID, err := strconv.Atoi(parts[0])
	if err != nil {
		http.Error(w, "Invalid match ID", http.StatusBadRequest)
		return
	}

	var req SubmitActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "Invalid JSON", http.StatusBadRequest)
		return
	}

	action := game.Action(req.Action)
	if action != game.Cooperate && action != game.Defect {
		http.Error(w, "Invalid action: must be 'cooperate' or 'defect'", http.StatusBadRequest)
		return
	}

	err = game.SubmitAction(matchID, agent.ID, action)
	if err != nil {
		log.Printf("Failed to submit action for match %d, agent %d: %v", matchID, agent.ID, err)
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	log.Printf("Action submitted: MatchID=%d, AgentID=%d, Action=%s", matchID, agent.ID, action)

	w.WriteHeader(http.StatusOK)
}

// JoinMatch handles joining a match
func JoinMatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	agent := GetAgentFromContext(r.Context())

	// Parse /matches/{id}/join
	path := strings.TrimPrefix(r.URL.Path, "/matches/")
	parts := strings.Split(path, "/")
	if len(parts) < 2 || parts[1] != "join" {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	matchID, err := strconv.Atoi(parts[0])
	if err != nil {
		http.Error(w, "Invalid match ID", http.StatusBadRequest)
		return
	}

	err = game.JoinMatch(matchID, agent.ID)
	if err != nil {
		log.Printf("Failed to join match %d for agent %d: %v", matchID, agent.ID, err)
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	log.Printf("Match joined: ID=%d, Agent2=%d", matchID, agent.ID)

	w.WriteHeader(http.StatusOK)
}

// GetMatch handles getting match details
func GetMatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse /matches/{id}
	path := strings.TrimPrefix(r.URL.Path, "/matches/")
	parts := strings.Split(path, "/")
	if len(parts) != 1 {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	matchID, err := strconv.Atoi(parts[0])
	if err != nil {
		http.Error(w, "Invalid match ID", http.StatusBadRequest)
		return
	}

	// Get match
	var match models.Match
	err = db.DB.QueryRow("SELECT id, agent1_id, agent2_id, status, created_at FROM matches WHERE id = ?", matchID).Scan(
		&match.ID, &match.Agent1ID, &match.Agent2ID, &match.Status, &match.CreatedAt)
	if err != nil {
		http.Error(w, "Match not found", http.StatusNotFound)
		return
	}

	accept := r.Header.Get("Accept")
	if strings.Contains(accept, "text/html") {
		w.Header().Set("Content-Type", "text/html")
		Templates.ExecuteTemplate(w, "match.html", match)
	} else {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(match)
	}
}

// GetReplay handles getting match replay
func GetReplay(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Parse /matches/{id}/replay
	path := strings.TrimPrefix(r.URL.Path, "/matches/")
	parts := strings.Split(path, "/")
	if len(parts) != 2 || parts[1] != "replay" {
		http.Error(w, "Invalid path", http.StatusBadRequest)
		return
	}

	matchID, err := strconv.Atoi(parts[0])
	if err != nil {
		http.Error(w, "Invalid match ID", http.StatusBadRequest)
		return
	}

	// Get match status
	var status string
	err = db.DB.QueryRow("SELECT status FROM matches WHERE id = ?", matchID).Scan(&status)
	if err != nil {
		http.Error(w, "Match not found", http.StatusNotFound)
		return
	}

	// Get rounds with actions and payoffs
	rows, err := db.DB.Query(`
		SELECT r.round_number, a.agent_id, a.action, a.submitted_at, l.score_change
		FROM match_rounds r
		LEFT JOIN actions a ON r.id = a.round_id
		LEFT JOIN ledger_entries l ON l.match_id = r.match_id AND l.agent_id = a.agent_id AND l.reason = 'Round ' || r.round_number
		WHERE r.match_id = ?
		ORDER BY r.round_number, a.agent_id`, matchID)
	if err != nil {
		http.Error(w, "Failed to get replay", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var rounds []map[string]interface{}
	currentRound := 0
	var roundData map[string]interface{}

	for rows.Next() {
		var roundNum, agentID int
		var action string
		var submittedAt *time.Time
		var scoreChange *int
		rows.Scan(&roundNum, &agentID, &action, &submittedAt, &scoreChange)

		if roundNum != currentRound {
			if roundData != nil {
				rounds = append(rounds, roundData)
			}
			roundData = map[string]interface{}{
				"round_number": roundNum,
				"actions":      []map[string]interface{}{},
				"payoffs":      []map[string]interface{}{},
			}
			currentRound = roundNum
		}

		if action != "" {
			roundData["actions"] = append(roundData["actions"].([]map[string]interface{}), map[string]interface{}{
				"agent_id":     agentID,
				"action":       action,
				"submitted_at": submittedAt,
			})
		}

		if scoreChange != nil {
			roundData["payoffs"] = append(roundData["payoffs"].([]map[string]interface{}), map[string]interface{}{
				"agent_id":      agentID,
				"score_change": *scoreChange,
			})
		}
	}
	if roundData != nil {
		rounds = append(rounds, roundData)
	}

	// Get final scores
	scoreRows, err := db.DB.Query(`
		SELECT agent_id, SUM(score_change) as total_score
		FROM ledger_entries
		WHERE match_id = ?
		GROUP BY agent_id`, matchID)
	if err != nil {
		http.Error(w, "Failed to get scores", http.StatusInternalServerError)
		return
	}
	defer scoreRows.Close()

	var finalScores []map[string]interface{}
	for scoreRows.Next() {
		var agentID, totalScore int
		scoreRows.Scan(&agentID, &totalScore)
		finalScores = append(finalScores, map[string]interface{}{
			"agent_id":    agentID,
			"total_score": totalScore,
		})
	}

	response := map[string]interface{}{
		"match_id":     matchID,
		"status":       status,
		"rounds":       rounds,
		"final_scores": finalScores,
	}

	accept := r.Header.Get("Accept")
	if strings.Contains(accept, "text/html") {
		w.Header().Set("Content-Type", "text/html")
		Templates.ExecuteTemplate(w, "replay.html", response)
	} else {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(response)
	}
}