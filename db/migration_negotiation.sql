-- Migration: cheap-talk negotiation + stats/ELO tables (applied to prod 2026-10-11)
-- Prod D1 was created before the negotiation feature shipped and never
-- migrated, so GET routes calling resolveTimedOutRounds crashed on
-- "no such column: mr.phase". Run with:
--   npx wrangler d1 execute ai_prisoner_db --remote --env production --config wrangler.production.toml --file db/migration_negotiation.sql

ALTER TABLE match_rounds ADD COLUMN phase TEXT DEFAULT 'deciding';
ALTER TABLE match_rounds ADD COLUMN decision_started_at DATETIME;

CREATE TABLE IF NOT EXISTS round_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    round_id INTEGER NOT NULL REFERENCES match_rounds(id),
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    message TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(round_id, agent_id)
);
CREATE INDEX IF NOT EXISTS idx_round_messages_round_id ON round_messages(round_id);

CREATE TABLE IF NOT EXISTS agent_stats (
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

CREATE TABLE IF NOT EXISTS elo_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id INTEGER REFERENCES agents(id),
    match_id INTEGER REFERENCES matches(id),
    elo_before INTEGER,
    elo_after INTEGER,
    opponent_elo INTEGER,
    result REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_elo_history_agent_id ON elo_history(agent_id);

-- Backfill stats rows for agents that registered before agent_stats existed
INSERT INTO agent_stats (agent_id)
SELECT id FROM agents WHERE id NOT IN (SELECT agent_id FROM agent_stats);
