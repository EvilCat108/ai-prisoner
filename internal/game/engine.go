package game

import (
	"ai-prisoner/internal/db"
	"database/sql"
	"errors"
	"fmt"
	"log"
)

// CreateMatch creates a new match with one agent, status created
func CreateMatch(agent1ID int) (int, error) {
	tx, err := db.DB.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	result, err := tx.Exec("INSERT INTO matches (agent1_id, status) VALUES (?, 'created')", agent1ID)
	if err != nil {
		return 0, err
	}
	matchID64, _ := result.LastInsertId()
	matchID := int(matchID64)

	if err = tx.Commit(); err != nil {
		return 0, err
	}

	log.Printf("Match created: ID=%d, Agent1=%d", matchID, agent1ID)
	return matchID, nil
}

// JoinMatch joins an agent to a created match, starting it
func JoinMatch(matchID, agentID int) error {
	tx, err := db.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Check match is created and agent not already in it
	var status string
	var agent1 *int
	err = tx.QueryRow("SELECT status, agent1_id FROM matches WHERE id = ?", matchID).Scan(&status, &agent1)
	if err != nil {
		return err
	}
	if status != "created" {
		return errors.New("match not available for joining")
	}
	if agent1 != nil && *agent1 == agentID {
		return errors.New("cannot join your own match")
	}

	// Set agent2 and start
	_, err = tx.Exec("UPDATE matches SET agent2_id = ?, status = 'active' WHERE id = ?", agentID, matchID)
	if err != nil {
		return err
	}

	// Create first round
	_, err = tx.Exec("INSERT INTO match_rounds (match_id, round_number) VALUES (?, 1)", matchID)
	if err != nil {
		return err
	}

	if err = tx.Commit(); err != nil {
		return err
	}

	log.Printf("Match joined: ID=%d, Agent2=%d", matchID, agentID)
	return nil
}

// GetCurrentRound returns the current round number for a match
func GetCurrentRound(matchID int) (int, error) {
	var round int
	err := db.DB.QueryRow("SELECT COALESCE(MAX(round_number), 0) FROM match_rounds WHERE match_id = ?", matchID).Scan(&round)
	return round, err
}

// SubmitAction submits an action for the current round
func SubmitAction(matchID, agentID int, action Action) error {
	tx, err := db.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// Check match status and agents
	var status string
	var agent1, agent2 int
	err = tx.QueryRow("SELECT status, agent1_id, agent2_id FROM matches WHERE id = ?", matchID).Scan(&status, &agent1, &agent2)
	if err != nil {
		return err
	}
	if status != "active" {
		return errors.New("match not active")
	}
	if agentID != agent1 && agentID != agent2 {
		return errors.New("agent not in match")
	}

	currentRound, err := GetCurrentRound(matchID)
	if err != nil {
		return err
	}
	if currentRound == 0 {
		return errors.New("no rounds available")
	}

	// Check not already submitted
	var count int
	err = tx.QueryRow("SELECT COUNT(*) FROM actions WHERE round_id = (SELECT id FROM match_rounds WHERE match_id = ? AND round_number = ?) AND agent_id = ?", matchID, currentRound, agentID).Scan(&count)
	if err != nil {
		return err
	}
	if count > 0 {
		return errors.New("action already submitted for this round")
	}

	// Insert action
	_, err = tx.Exec("INSERT INTO actions (round_id, agent_id, action) VALUES ((SELECT id FROM match_rounds WHERE match_id = ? AND round_number = ?), ?, ?)", matchID, currentRound, agentID, string(action))
	if err != nil {
		return err
	}

	// Check if both submitted
	err = tx.QueryRow("SELECT COUNT(*) FROM actions WHERE round_id = (SELECT id FROM match_rounds WHERE match_id = ? AND round_number = ?)", matchID, currentRound).Scan(&count)
	if err != nil {
		return err
	}
	if count == 2 {
		// Process round
		err = ProcessRoundTx(tx, matchID, currentRound)
		if err != nil {
			return err
		}
	}

	if err = tx.Commit(); err != nil {
		return err
	}

	log.Printf("Action submitted: MatchID=%d, AgentID=%d, Round=%d, Action=%s", matchID, agentID, currentRound, action)
	return nil
}

// ProcessRound calculates payoffs and updates ledger
func ProcessRound(matchID, roundNum int) error {
	tx, err := db.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	err = ProcessRoundTx(tx, matchID, roundNum)
	if err != nil {
		return err
	}

	return tx.Commit()
}

// ProcessRoundTx calculates payoffs and updates ledger within a transaction
func ProcessRoundTx(tx *sql.Tx, matchID, roundNum int) error {
	// Get actions
	rows, err := tx.Query("SELECT a.agent_id, a.action FROM actions a JOIN match_rounds r ON a.round_id = r.id WHERE r.match_id = ? AND r.round_number = ?", matchID, roundNum)
	if err != nil {
		return err
	}
	defer rows.Close()

	actions := make(map[int]Action)
	for rows.Next() {
		var agentID int
		var act string
		rows.Scan(&agentID, &act)
		actions[agentID] = Action(act)
	}
	if len(actions) != 2 {
		return errors.New("incomplete actions for round")
	}

	// Get agent IDs
	var agent1, agent2 int
	err = tx.QueryRow("SELECT agent1_id, agent2_id FROM matches WHERE id = ?", matchID).Scan(&agent1, &agent2)
	if err != nil {
		return err
	}

	payoff, err := CalculatePayoff(actions[agent1], actions[agent2])
	if err != nil {
		return err
	}

	// Insert ledger entries
	_, err = tx.Exec("INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, ?, ?)", matchID, agent1, payoff.Agent1Score, fmt.Sprintf("Round %d", roundNum))
	if err != nil {
		return err
	}
	_, err = tx.Exec("INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, ?, ?)", matchID, agent2, payoff.Agent2Score, fmt.Sprintf("Round %d", roundNum))
	if err != nil {
		return err
	}

	if roundNum == NumRounds {
		// Complete match
		_, err = tx.Exec("UPDATE matches SET status = 'completed' WHERE id = ?", matchID)
		log.Printf("Match completed: ID=%d", matchID)
	} else {
		// Create next round
		_, err = tx.Exec("INSERT INTO match_rounds (match_id, round_number) VALUES (?, ?)", matchID, roundNum+1)
		log.Printf("Round processed: MatchID=%d, Round=%d, Payoffs=%+v", matchID, roundNum, payoff)
	}
	return err
}