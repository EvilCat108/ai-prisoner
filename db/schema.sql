-- SQLite schema for AI Prisoner Dilemma Arena

-- Agents table
CREATE TABLE agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    api_key_hash TEXT NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT 1,
    is_system BOOLEAN NOT NULL DEFAULT 0,
    reliability_score REAL NOT NULL DEFAULT 1.0,
    last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Matches table
CREATE TABLE matches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent1_id INTEGER,
    agent2_id INTEGER,
    status TEXT NOT NULL CHECK (status IN ('created', 'active', 'completed', 'failed')),
    termination_prob REAL NOT NULL DEFAULT 0.02,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (agent1_id) REFERENCES agents(id),
    FOREIGN KEY (agent2_id) REFERENCES agents(id)
);

-- Match rounds
CREATE TABLE match_rounds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL,
    round_number INTEGER NOT NULL,
    round_started_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (match_id) REFERENCES matches(id),
    UNIQUE(match_id, round_number)
);

-- Actions table
CREATE TABLE actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL,
    agent_id INTEGER NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('cooperate', 'defect')),
    is_auto BOOLEAN NOT NULL DEFAULT 0,
    response_time_ms INTEGER,
    message TEXT,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (round_id) REFERENCES match_rounds(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id),
    UNIQUE(round_id, agent_id)
);

-- Ledger entries (append-only score changes)
CREATE TABLE ledger_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    match_id INTEGER NOT NULL,
    agent_id INTEGER NOT NULL,
    score_change INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (match_id) REFERENCES matches(id),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Leaderboard snapshots (for historical leaderboards)
CREATE TABLE leaderboard_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER NOT NULL,
    total_score INTEGER NOT NULL,
    snapshot_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Match queue for Axelrod tournament
CREATE TABLE match_queue (
    agent_id INTEGER PRIMARY KEY,
    entered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
);

-- Indexes for performance
CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_match_rounds_match_id ON match_rounds(match_id);
CREATE INDEX idx_actions_round_id ON actions(round_id);
CREATE INDEX idx_ledger_entries_agent_id ON ledger_entries(agent_id);
CREATE INDEX idx_ledger_entries_match_agent ON ledger_entries(match_id, agent_id);
CREATE INDEX idx_leaderboard_snapshots_agent_id ON leaderboard_snapshots(agent_id);