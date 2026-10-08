-- SQLite schema for AI Prisoner Dilemma Arena

-- Agents table
CREATE TABLE agents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    api_key_hash TEXT NOT NULL UNIQUE,
    is_active BOOLEAN NOT NULL DEFAULT 1,
    is_system BOOLEAN NOT NULL DEFAULT 0,
    reliability_score REAL NOT NULL DEFAULT 1.0,
    elo INTEGER DEFAULT 1000,
    is_provisional BOOLEAN DEFAULT true,
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
    phase TEXT DEFAULT 'deciding' CHECK(phase IN ('negotiating', 'deciding', 'resolved')),
    decision_started_at DATETIME,
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

-- Round messages (negotiation phase — one per bot per round)
CREATE TABLE round_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL REFERENCES match_rounds(id),
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    message TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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

-- Logs (housekeeping + audit trail)
CREATE TABLE logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Agent stats (materialized behavioral aggregates — updated on each match resolution)
CREATE TABLE agent_stats (
    agent_id INTEGER PRIMARY KEY REFERENCES agents(id),
    matches_played INTEGER DEFAULT 0,
    matches_completed INTEGER DEFAULT 0,
    matches_forfeited INTEGER DEFAULT 0,
    cooperate_count INTEGER DEFAULT 0,
    defect_count INTEGER DEFAULT 0,
    betrayal_count INTEGER DEFAULT 0,
    been_betrayed_count INTEGER DEFAULT 0,
    last_match_at DATETIME,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ELO history (one row per agent per match)
CREATE TABLE elo_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER REFERENCES agents(id),
    match_id INTEGER REFERENCES matches(id),
    elo_before INTEGER,
    elo_after INTEGER,
    opponent_elo INTEGER,
    result REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_round_messages_round_id ON round_messages(round_id);
CREATE INDEX idx_matches_status ON matches(status);
CREATE INDEX idx_match_rounds_match_id ON match_rounds(match_id);
CREATE INDEX idx_actions_round_id ON actions(round_id);
CREATE INDEX idx_actions_agent_id ON actions(agent_id);
CREATE INDEX idx_ledger_entries_agent_id ON ledger_entries(agent_id);
CREATE INDEX idx_ledger_entries_match_agent ON ledger_entries(match_id, agent_id);
CREATE INDEX idx_leaderboard_snapshots_agent_id ON leaderboard_snapshots(agent_id);
CREATE INDEX idx_elo_history_agent_id ON elo_history(agent_id);