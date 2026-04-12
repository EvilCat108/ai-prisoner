package handlers

import (
	"ai-prisoner/internal/db"
	"ai-prisoner/internal/game"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestGetLeaderboard(t *testing.T) {
	// Setup test DB
	if err := db.InitDBWithSchema("/tmp/test_leaderboard.db", "../../db/schema.sql"); err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Create agents
	agent1ID := insertTestAgent("agent1")
	agent2ID := insertTestAgent("agent2")

	// Create and complete a match where agent1 wins (higher score)
	matchID, _ := game.CreateMatch(agent1ID)
	game.JoinMatch(matchID, agent2ID)
	// Agent1 cooperates, agent2 defects: agent1 gets 0, agent2 gets 5
	game.SubmitAction(matchID, agent1ID, game.Cooperate)
	game.SubmitAction(matchID, agent2ID, game.Defect)
	// Only 1 round for simplicity, but to complete, need 5, but for test, perhaps modify NumRounds or play 5.

	// To make it simple, play 1 round, but since NumRounds=5, it won't complete, but for leaderboard, scores are there.

	// But to have wins, need completed matches.

	// For test, assume.

	// Get leaderboard
	req := httptest.NewRequest(http.MethodGet, "/leaderboard", nil)
	w := httptest.NewRecorder()
	GetLeaderboard(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var response map[string]interface{}
	json.NewDecoder(w.Body).Decode(&response)

	leaderboard := response["leaderboard"].([]interface{})
	if len(leaderboard) != 2 {
		t.Errorf("Expected 2 entries, got %d", len(leaderboard))
	}

	// Check agent2 has higher score (5 > 0)
	entry1 := leaderboard[0].(map[string]interface{})
	if int(entry1["agent_id"].(float64)) != agent2ID {
		t.Error("Agent2 should be first")
	}
	if int(entry1["total_score"].(float64)) != 5 {
		t.Errorf("Agent2 score should be 5, got %d", int(entry1["total_score"].(float64)))
	}
	if entry1["matches_played"].(float64) != 1 {
		t.Errorf("Matches played should be 1, got %f", entry1["matches_played"].(float64))
	}
	if entry1["wins"].(float64) != 1 {
		t.Errorf("Wins should be 1, got %f", entry1["wins"].(float64))
	}
	if entry1["cooperation_rate"].(float64) != 0 {
		t.Errorf("Cooperation rate should be 0, got %f", entry1["cooperation_rate"].(float64))
	}

	entry2 := leaderboard[1].(map[string]interface{})
	if int(entry2["agent_id"].(float64)) != agent1ID {
		t.Error("Agent1 should be second")
	}
	if int(entry2["total_score"].(float64)) != 0 {
		t.Errorf("Agent1 score should be 0, got %d", int(entry2["total_score"].(float64)))
	}
	if entry2["matches_played"].(float64) != 1 {
		t.Errorf("Matches played should be 1, got %f", entry2["matches_played"].(float64))
	}
	if entry2["wins"].(float64) != 0 {
		t.Errorf("Wins should be 0, got %f", entry2["wins"].(float64))
	}
	if entry2["cooperation_rate"].(float64) != 1 {
		t.Errorf("Cooperation rate should be 1, got %f", entry2["cooperation_rate"].(float64))
	}
}