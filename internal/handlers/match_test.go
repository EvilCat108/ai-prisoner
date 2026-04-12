package handlers

import (
	"ai-prisoner/internal/db"
	"ai-prisoner/internal/game"
	"ai-prisoner/internal/models"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func TestFullMatch(t *testing.T) {
	// Setup test DB
	if err := db.InitDBWithSchema("/tmp/test.db", "../../db/schema.sql"); err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	// Create two agents
	agent1ID := insertTestAgent("agent1")
	agent2ID := insertTestAgent("agent2")

	// Create match
	matchID, err := game.CreateMatch(agent1ID)
	if err != nil {
		t.Fatal(err)
	}

	// Join match
	err = game.JoinMatch(matchID, agent2ID)
	if err != nil {
		t.Fatal(err)
	}

	// Simulate full match: both cooperate each round
	for round := 1; round <= game.NumRounds; round++ {
		// Agent1 submits
		err = game.SubmitAction(matchID, agent1ID, game.Cooperate)
		if err != nil {
			t.Fatalf("Round %d agent1 submit: %v", round, err)
		}

		// Agent2 submits
		err = game.SubmitAction(matchID, agent2ID, game.Cooperate)
		if err != nil {
			t.Fatalf("Round %d agent2 submit: %v", round, err)
		}
	}

	// Check match completed
	var status string
	err = db.DB.QueryRow("SELECT status FROM matches WHERE id = ?", matchID).Scan(&status)
	if err != nil {
		t.Fatal(err)
	}
	if status != "completed" {
		t.Errorf("Expected completed, got %s", status)
	}

	// Check scores: 5 rounds * 3 = 15 each
	score1 := getTotalScore(agent1ID)
	score2 := getTotalScore(agent2ID)
	if score1 != 15 {
		t.Errorf("Agent1 score: expected 15, got %d", score1)
	}
	if score2 != 15 {
		t.Errorf("Agent2 score: expected 15, got %d", score2)
	}
}

func TestDuplicateActionRejection(t *testing.T) {
	if err := db.InitDBWithSchema("/tmp/test_duplicate.db", "../../db/schema.sql"); err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	agent1ID := insertTestAgent("agent1")
	agent2ID := insertTestAgent("agent2")
	matchID, _ := game.CreateMatch(agent1ID)
	game.JoinMatch(matchID, agent2ID)

	// Submit first time
	err := game.SubmitAction(matchID, agent1ID, game.Cooperate)
	if err != nil {
		t.Fatal(err)
	}

	// Submit again - should fail
	err = game.SubmitAction(matchID, agent1ID, game.Defect)
	if err == nil {
		t.Error("Expected error for duplicate action")
	}
}

func TestLateActionRejection(t *testing.T) {
	if err := db.InitDBWithSchema("/tmp/test_late.db", "../../db/schema.sql"); err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	agent1ID := insertTestAgent("agent1")
	agent2ID := insertTestAgent("agent2")
	matchID, _ := game.CreateMatch(agent1ID)
	game.JoinMatch(matchID, agent2ID)

	// Complete the match
	for round := 1; round <= game.NumRounds; round++ {
		game.SubmitAction(matchID, agent1ID, game.Cooperate)
		game.SubmitAction(matchID, agent2ID, game.Cooperate)
	}

	// Try to submit after completion
	err := game.SubmitAction(matchID, agent1ID, game.Defect)
	if err == nil {
		t.Error("Expected error for late action")
	}
}

func insertTestAgent(name string) int {
	result, _ := db.DB.Exec("INSERT INTO agents (name, api_key, is_active) VALUES (?, ?, 1)", name, name+"key")
	id, _ := result.LastInsertId()
	return int(id)
}

func getTotalScore(agentID int) int {
	var score int
	db.DB.QueryRow("SELECT COALESCE(SUM(score_change), 0) FROM ledger_entries WHERE agent_id = ?", agentID).Scan(&score)
	return score
}

func TestCreateMatchHandler(t *testing.T) {
	if err := db.InitDBWithSchema(":memory:", "../../db/schema.sql"); err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	agentID := insertTestAgent("agent")

	// Mock auth context
	req := httptest.NewRequest(http.MethodPost, "/matches", nil)
	ctx := context.WithValue(req.Context(), "agent", &models.Agent{ID: agentID})
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()

	CreateMatch(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected 200, got %d", w.Code)
	}

	var resp map[string]int
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["match_id"] == 0 {
		t.Error("Expected match_id")
	}
}

func TestReplayMatchesStoredEvents(t *testing.T) {
	if err := db.InitDBWithSchema("/tmp/test_replay.db", "../../db/schema.sql"); err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	agent1ID := insertTestAgent("agent1")
	agent2ID := insertTestAgent("agent2")
	matchID, _ := game.CreateMatch(agent1ID)
	game.JoinMatch(matchID, agent2ID)

	// Play a mixed match: round 1 both cooperate, round 2 agent1 defects, round 3 both defect
	rounds := []struct {
		a1, a2 game.Action
	}{
		{game.Cooperate, game.Cooperate}, // 3,3
		{game.Defect, game.Cooperate},    // 5,0
		{game.Defect, game.Defect},       // 1,1
	}

	for _, r := range rounds {
		game.SubmitAction(matchID, agent1ID, r.a1)
		game.SubmitAction(matchID, agent2ID, r.a2)
	}

	// Get replay via handler
	req := httptest.NewRequest(http.MethodGet, "/matches/"+strconv.Itoa(matchID)+"/replay", nil)
	w := httptest.NewRecorder()
	GetReplay(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected 200, got %d", w.Code)
	}

	var response map[string]interface{}
	json.NewDecoder(w.Body).Decode(&response)

	// Check structure
	if response["match_id"].(float64) != float64(matchID) {
		t.Error("Wrong match_id")
	}
	if response["status"] != "active" { // Not completed yet
		t.Error("Wrong status")
	}

	roundsData := response["rounds"].([]interface{})
	if len(roundsData) != 4 {
		t.Errorf("Expected 4 rounds, got %d", len(roundsData))
	}

	// Check round 1: both cooperate, payoffs 3,3
	round1 := roundsData[0].(map[string]interface{})
	actions1 := round1["actions"].([]interface{})
	if len(actions1) != 2 {
		t.Error("Round 1 should have 2 actions")
	}
	payoffs1 := round1["payoffs"].([]interface{})
	if len(payoffs1) != 2 {
		t.Error("Round 1 should have 2 payoffs")
	}
	// Check payoffs sum to 6
	totalPayoff1 := 0
	for _, p := range payoffs1 {
		totalPayoff1 += int(p.(map[string]interface{})["score_change"].(float64))
	}
	if totalPayoff1 != 6 {
		t.Errorf("Round 1 payoffs should sum to 6, got %d", totalPayoff1)
	}

	// Check round 4: no actions yet
	round4 := roundsData[3].(map[string]interface{})
	actions4 := round4["actions"].([]interface{})
	if len(actions4) != 0 {
		t.Error("Round 4 should have no actions")
	}
	payoffs4 := round4["payoffs"].([]interface{})
	if len(payoffs4) != 0 {
		t.Error("Round 4 should have no payoffs")
	}

	// Check final scores
	finalScores := response["final_scores"].([]interface{})
	if len(finalScores) != 2 {
		t.Error("Should have 2 final scores")
	}
	totalScore := 0
	for _, s := range finalScores {
		totalScore += int(s.(map[string]interface{})["total_score"].(float64))
	}
	if totalScore != 13 { // 3+3 +0+5 +1+1 = 13
		t.Errorf("Total score should be 13, got %d", totalScore)
	}
}