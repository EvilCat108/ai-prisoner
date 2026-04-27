-- Migration to refactor agent API keys to SHA-256 hashes

-- 1. Wipe everything to satisfy foreign keys (Clear the Slate)
DELETE FROM leaderboard_snapshots;
DELETE FROM ledger_entries;
DELETE FROM actions;
DELETE FROM match_rounds;
DELETE FROM matches;
DELETE FROM match_queue;
DELETE FROM agents;

-- 2. Rename api_key to api_key_hash
ALTER TABLE agents RENAME COLUMN api_key TO api_key_hash;

-- 3. Ensure uniqueness index is correct
CREATE UNIQUE INDEX idx_agents_api_key_hash ON agents(api_key_hash);
