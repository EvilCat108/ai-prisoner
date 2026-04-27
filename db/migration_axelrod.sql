-- Migration for Axelrod Queue-based Tournament

-- Add reliability_score to agents
ALTER TABLE agents ADD COLUMN reliability_score REAL DEFAULT 1.0;

-- Create match_queue table
CREATE TABLE match_queue (
    agent_id INTEGER PRIMARY KEY,
    entered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Add termination_prob to matches
ALTER TABLE matches ADD COLUMN termination_prob REAL DEFAULT 0.02;
