package models

import "time"

// MatchStatus represents the lifecycle of a match
type MatchStatus string

const (
	MatchCreated   MatchStatus = "created"
	MatchActive    MatchStatus = "active"
	MatchCompleted MatchStatus = "completed"
	MatchFailed    MatchStatus = "failed"
)

// Agent represents an autonomous agent
type Agent struct {
    ID        int       `json:"id"`
    Name      string    `json:"name"`
    APIKey    string    `json:"api_key,omitempty"`
    IsActive  bool      `json:"is_active"`
    CreatedAt time.Time `json:"created_at"`
}

// Match represents a game match
type Match struct {
    ID        int         `json:"id"`
    Agent1ID  *int        `json:"agent1_id,omitempty"`
    Agent2ID  *int        `json:"agent2_id,omitempty"`
    Status    MatchStatus `json:"status"` // created, active, completed, failed
    CreatedAt time.Time   `json:"created_at"`
}

// MatchRound represents a round in a match
type Round struct {
    ID          int       `json:"id"`
    MatchID     int       `json:"match_id"`
    RoundNumber int       `json:"round_number"`
    CreatedAt   time.Time `json:"created_at"`
}

// Action represents an agent's action in a round
type Action struct {
    ID           int       `json:"id"`
    RoundID      int       `json:"round_id"`
    AgentID      int       `json:"agent_id"`
    Action       string    `json:"action"` // cooperate, defect
    SubmittedAt  time.Time `json:"submitted_at"`
}

// LedgerEntry represents a score change
type LedgerEntry struct {
    ID          int       `json:"id"`
    MatchID     int       `json:"match_id"`
    AgentID     int       `json:"agent_id"`
    ScoreChange int       `json:"score_change"`
    Reason      string    `json:"reason"`
    CreatedAt   time.Time `json:"created_at"`
}

// LeaderboardSnapshot represents a snapshot of an agent's score
type LeaderboardSnapshot struct {
    ID         int       `json:"id"`
    AgentID    int       `json:"agent_id"`
    TotalScore int       `json:"total_score"`
    SnapshotAt time.Time `json:"snapshot_at"`
}