package handlers

import (
	"ai-prisoner/internal/db"
	"encoding/json"
	"net/http"
	"strings"
)

// LeaderboardEntry represents a leaderboard entry
type LeaderboardEntry struct {
	Rank            int     `json:"rank"`
	AgentID         int     `json:"agent_id"`
	AgentName       string  `json:"agent_name"`
	MatchesPlayed   int     `json:"matches_played"`
	Wins            int     `json:"wins"`
	TotalScore      int     `json:"total_score"`
	CooperationRate float64 `json:"cooperation_rate"`
}

// GetLeaderboard handles getting the leaderboard
func GetLeaderboard(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Get top agents by total score
	rows, err := db.DB.Query(`
		SELECT a.id, a.name, COALESCE(SUM(l.score_change), 0) as total_score
		FROM agents a
		LEFT JOIN ledger_entries l ON a.id = l.agent_id
		WHERE a.is_active = 1
		GROUP BY a.id, a.name
		ORDER BY total_score DESC
		LIMIT 10`)
	if err != nil {
		http.Error(w, "Failed to get leaderboard", http.StatusInternalServerError)
		return
	}
	defer rows.Close()

	var entries []LeaderboardEntry
	rank := 1
	for rows.Next() {
		var entry LeaderboardEntry
		entry.Rank = rank
		rows.Scan(&entry.AgentID, &entry.AgentName, &entry.TotalScore)
		// Compute additional fields
		entry.MatchesPlayed = getMatchesPlayed(entry.AgentID)
		entry.Wins = getWins(entry.AgentID)
		entry.CooperationRate = getCooperationRate(entry.AgentID)
		entries = append(entries, entry)
		rank++
	}

	accept := r.Header.Get("Accept")
	if strings.Contains(accept, "text/html") {
		w.Header().Set("Content-Type", "text/html")
		Templates.ExecuteTemplate(w, "leaderboard.html", map[string]interface{}{"leaderboard": entries})
	} else {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{"leaderboard": entries})
	}
}

func getMatchesPlayed(agentID int) int {
	var count int
	db.DB.QueryRow("SELECT COUNT(*) FROM matches WHERE agent1_id = ? OR agent2_id = ?", agentID, agentID).Scan(&count)
	return count
}

func getWins(agentID int) int {
	// Get all matches for the agent
	rows, err := db.DB.Query("SELECT id, agent1_id, agent2_id FROM matches WHERE agent1_id = ? OR agent2_id = ?", agentID, agentID)
	if err != nil {
		return 0
	}
	defer rows.Close()

	wins := 0
	for rows.Next() {
		var matchID, agent1ID, agent2ID int
		rows.Scan(&matchID, &agent1ID, &agent2ID)
		opponentID := agent1ID
		if agentID == agent1ID {
			opponentID = agent2ID
		}
		// Get scores
		var agentScore, opponentScore int
		db.DB.QueryRow("SELECT COALESCE(SUM(score_change), 0) FROM ledger_entries WHERE match_id = ? AND agent_id = ?", matchID, agentID).Scan(&agentScore)
		db.DB.QueryRow("SELECT COALESCE(SUM(score_change), 0) FROM ledger_entries WHERE match_id = ? AND agent_id = ?", matchID, opponentID).Scan(&opponentScore)
		if agentScore > opponentScore {
			wins++
		}
	}
	return wins
}

func getCooperationRate(agentID int) float64 {
	var cooperateCount, totalCount int
	db.DB.QueryRow("SELECT COUNT(*) FROM actions WHERE agent_id = ? AND action = 'cooperate'", agentID).Scan(&cooperateCount)
	db.DB.QueryRow("SELECT COUNT(*) FROM actions WHERE agent_id = ?", agentID).Scan(&totalCount)
	if totalCount == 0 {
		return 0
	}
	return float64(cooperateCount) / float64(totalCount)
}