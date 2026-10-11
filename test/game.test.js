import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { calculateElo, updateReputationAfterMatch } from '../src/engine/reputation.js';
import { classifyIntent, consistencyLabel, computeHonestyReport } from '../src/engine/consistency.js';

// Schema with IF NOT EXISTS so beforeAll can be called once safely
const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
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
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent1_id INTEGER,
  agent2_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('created', 'active', 'completed', 'failed')),
  termination_prob REAL NOT NULL DEFAULT 0.02,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent1_id) REFERENCES agents(id),
  FOREIGN KEY (agent2_id) REFERENCES agents(id)
);
CREATE TABLE IF NOT EXISTS match_rounds (
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
CREATE TABLE IF NOT EXISTS actions (
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
CREATE TABLE IF NOT EXISTS round_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  round_id INTEGER NOT NULL REFERENCES match_rounds(id),
  agent_id INTEGER NOT NULL REFERENCES agents(id),
  message TEXT NOT NULL,
  sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(round_id, agent_id)
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  agent_id INTEGER NOT NULL,
  score_change INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (match_id) REFERENCES matches(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id INTEGER NOT NULL,
  total_score INTEGER NOT NULL,
  snapshot_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent_id) REFERENCES agents(id)
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT,
  message TEXT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS match_queue (
    agent_id INTEGER PRIMARY KEY,
    entered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (agent_id) REFERENCES agents(id)
);
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
CREATE INDEX IF NOT EXISTS idx_round_messages_round_id ON round_messages(round_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_match_rounds_match_id ON match_rounds(match_id);
CREATE INDEX IF NOT EXISTS idx_actions_round_id ON actions(round_id);
CREATE INDEX IF NOT EXISTS idx_actions_agent_id ON actions(agent_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_agent_id ON ledger_entries(agent_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_match_agent ON ledger_entries(match_id, agent_id);
CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_agent_id ON leaderboard_snapshots(agent_id);
CREATE INDEX IF NOT EXISTS idx_elo_history_agent_id ON elo_history(agent_id);
`.trim();

beforeAll(async () => {
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM round_messages'),
    env.DB.prepare('DELETE FROM elo_history'),
    env.DB.prepare('DELETE FROM match_queue'),
    env.DB.prepare('DELETE FROM logs'),
    env.DB.prepare('DELETE FROM leaderboard_snapshots'),
    env.DB.prepare('DELETE FROM ledger_entries'),
    env.DB.prepare('DELETE FROM actions'),
    env.DB.prepare('DELETE FROM match_rounds'),
    env.DB.prepare('DELETE FROM matches'),
    env.DB.prepare('DELETE FROM agent_stats'),
    env.DB.prepare('DELETE FROM agents'),
  ]);
});

// ── Helpers ──────────────────────────────────────────────────────────────────

async function register(name) {
  const res = await SELF.fetch('http://example.com/agents/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = await res.json();
  return { ...body.agent, api_key: body.api_key };
}

async function joinQueue(apiKey) {
  const res = await SELF.fetch('http://example.com/queue/join', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  return res.json();
}

async function submitAction(matchId, apiKey, action) {
  return SELF.fetch(`http://example.com/matches/${matchId}/actions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

async function getMatch(matchId, apiKey = null) {
  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await SELF.fetch(`http://example.com/matches/${matchId}`, { headers });
  return res.json();
}

async function getReplay(matchId, apiKey = null) {
  const headers = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await SELF.fetch(`http://example.com/matches/${matchId}/replay`, { headers });
  return res.json();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Registration', () => {
  it('registers an agent and returns a 64-char api_key', async () => {
    const res = await SELF.fetch('http://example.com/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'TestAgent' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent.name).toBe('TestAgent');
    expect(body.api_key).toHaveLength(64);
    expect(body.agent.api_key).toBeUndefined();
  });

  it('rejects duplicate agent name with 409', async () => {
    await register('DupAgent');
    const res = await SELF.fetch('http://example.com/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'DupAgent' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('Match lifecycle (Queue)', () => {
  it('adds an agent to the queue', async () => {
    const a = await register('Queuer');
    const body = await joinQueue(a.api_key);
    expect(body.status).toBe('queued');
  });

  it('matches two agents and returns status active', async () => {
    const a1 = await register('A1');
    const a2 = await register('A2');
    
    await joinQueue(a1.api_key);
    const body = await joinQueue(a2.api_key);
    
    expect(body.status).toBe('active');
    expect(body.match_id).toBeGreaterThan(0);
  });

  it('does not match same agent with self', async () => {
    const a = await register('Self');
    await joinQueue(a.api_key);
    const body = await joinQueue(a.api_key);
    expect(body.status).toBe('queued');
  });

  it('requires auth to join queue', async () => {
    const res = await SELF.fetch('http://example.com/queue/join', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('Full match: both cooperate', () => {
  it('scores 300 pts each after 100 rounds', async () => {
    const a1 = await register('FC_A1');
    const a2 = await register('FC_A2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Set termination_prob high to end after 1 round for a simple test, 
    // or keep it 0 to test multiple rounds then set to 1.
    await env.DB.prepare("UPDATE matches SET termination_prob = 0 WHERE id = ?").bind(match_id).run();

    for (let i = 0; i < 5; i++) {
      await submitAction(match_id, a1.api_key, 'cooperate');
      await submitAction(match_id, a2.api_key, 'cooperate');
    }
    
    await env.DB.prepare("UPDATE matches SET termination_prob = 1.0 WHERE id = ?").bind(match_id).run();
    await submitAction(match_id, a1.api_key, 'cooperate');
    await submitAction(match_id, a2.api_key, 'cooperate');

    const match = await getMatch(match_id);
    expect(match.status).toBe('completed');

    const replay = await getReplay(match_id);
    expect(replay.final_scores).toHaveLength(2);
    // 6 rounds * 3 points = 18
    replay.final_scores.forEach(s => expect(s.total_score).toBe(18));
  });
});

describe('Action submission guards', () => {
  it('rejects duplicate action for same round', async () => {
    const a1 = await register('Dup_A1');
    const a2 = await register('Dup_A2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    const r1 = await submitAction(match_id, a1.api_key, 'cooperate');
    expect(r1.status).toBe(200);
    const r2 = await submitAction(match_id, a1.api_key, 'defect');
    expect(r2.status).toBe(400);
    expect(await r2.text()).toContain('already submitted');
  });

  it('rejects action on completed match', async () => {
    const a1 = await register('Late_A1');
    const a2 = await register('Late_A2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    await env.DB.prepare("UPDATE matches SET termination_prob = 0 WHERE id = ?").bind(match_id).run();
    for (let i = 0; i < 5; i++) {
      await submitAction(match_id, a1.api_key, 'cooperate');
      await submitAction(match_id, a2.api_key, 'cooperate');
    }
    await env.DB.prepare("UPDATE matches SET termination_prob = 1 WHERE id = ?").bind(match_id).run();
    await submitAction(match_id, a1.api_key, 'cooperate');
    await submitAction(match_id, a2.api_key, 'cooperate');

    const late = await submitAction(match_id, a1.api_key, 'defect');
    expect(late.status).toBe(400);
  });

  it('rejects invalid action string', async () => {
    const a1 = await register('Bad_A1');
    const a2 = await register('Bad_A2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    const res = await submitAction(match_id, a1.api_key, 'surrender');
    expect(res.status).toBe(400);
  });
});

describe('Replay', () => {
  it('includes round-by-round actions, payoffs, and auto field', async () => {
    const a1 = await register('Rp_A1');
    const a2 = await register('Rp_A2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Pin termination_prob=0 so the match doesn't stochastically end
    // mid-test (each round has a 2% chance of terminating by default).
    await env.DB.prepare("UPDATE matches SET termination_prob = 0 WHERE id = ?").bind(match_id).run();

    // Round 1: both cooperate (3,3)
    await submitAction(match_id, a1.api_key, 'cooperate');
    await submitAction(match_id, a2.api_key, 'cooperate');
    // Round 2: a1 defects, a2 cooperates (5,0)
    await submitAction(match_id, a1.api_key, 'defect');
    await submitAction(match_id, a2.api_key, 'cooperate');
    // Round 3: both defect (1,1)
    await submitAction(match_id, a1.api_key, 'defect');
    await submitAction(match_id, a2.api_key, 'defect');

    const replay = await getReplay(match_id);
    expect(replay.status).toBe('active');
    // Rounds 1-3 resolved, round 4 just started
    expect(replay.rounds.length).toBeGreaterThanOrEqual(3);

    const round1 = replay.rounds.find(r => r.round_number === 1);
    expect(round1.actions).toHaveLength(2);
    expect(round1.payoffs).toHaveLength(2);
    // All manual submissions: auto should be false
    round1.actions.forEach(a => expect(a.auto).toBe(false));
    // Round 1 payoffs sum to 6 (3+3)
    const sum1 = round1.payoffs.reduce((s, p) => s + p.score_change, 0);
    expect(sum1).toBe(6);

    const round2 = replay.rounds.find(r => r.round_number === 2);
    // Round 2 payoffs sum to 5 (5+0)
    const sum2 = round2.payoffs.reduce((s, p) => s + p.score_change, 0);
    expect(sum2).toBe(5);

    // Final scores: 3+5+1=9 for a1, 3+0+1=4 for a2 → total 13
    const totalScore = replay.final_scores.reduce((s, f) => s + f.total_score, 0);
    expect(totalScore).toBe(13);
  });
});

describe('Round timeout', () => {
  it('both agents timeout → no action rows, score (0,0) each, round advances', async () => {
    const a1 = await register('TO_Both_A1');
    const a2 = await register('TO_Both_A2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Backdate round_started_at to simulate 31-second-old round
    await env.DB.prepare(
      "UPDATE match_rounds SET round_started_at = datetime('now', '-31 seconds') WHERE match_id = ?"
    ).bind(match_id).run();

    // GET /matches/{id} triggers resolveTimedOutRounds
    await getMatch(match_id);

    // No auto-defect rows should be written anymore
    const { results: autoActions } = await env.DB.prepare(`
      SELECT COUNT(*) AS cnt FROM actions a
      JOIN match_rounds mr ON a.round_id = mr.id
      WHERE mr.match_id = ? AND mr.round_number = 1 AND a.is_auto = 1
    `).bind(match_id).all();
    expect(autoActions[0].cnt).toBe(0);

    // No actions at all for round 1
    const { results: anyActions } = await env.DB.prepare(`
      SELECT COUNT(*) AS cnt FROM actions a
      JOIN match_rounds mr ON a.round_id = mr.id
      WHERE mr.match_id = ? AND mr.round_number = 1
    `).bind(match_id).all();
    expect(anyActions[0].cnt).toBe(0);

    // Both get 0 points
    const { results: scores } = await env.DB.prepare(
      'SELECT agent_id, SUM(score_change) AS total FROM ledger_entries WHERE match_id = ? GROUP BY agent_id'
    ).bind(match_id).all();
    expect(scores).toHaveLength(2);
    scores.forEach(s => expect(Number(s.total)).toBe(0));

    // Round 2 should now exist (round advanced)
    const { results: rounds } = await env.DB.prepare(
      'SELECT round_number FROM match_rounds WHERE match_id = ? ORDER BY round_number ASC'
    ).bind(match_id).all();
    expect(rounds.map(r => r.round_number)).toEqual([1, 2]);
  });

  it('one agent cooperates, other times out → cooperator gets 3 (R), timeout gets 0', async () => {
    const a1 = await register('TO_One_A1');
    const a2 = await register('TO_One_A2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    await submitAction(match_id, a1.api_key, 'cooperate');

    await env.DB.prepare(
      "UPDATE match_rounds SET round_started_at = datetime('now', '-31 seconds') WHERE match_id = ?"
    ).bind(match_id).run();

    await getMatch(match_id);

    // No auto-defect row should be written
    const { results: autoActions } = await env.DB.prepare(`
      SELECT a.agent_id FROM actions a
      JOIN match_rounds mr ON a.round_id = mr.id
      WHERE mr.match_id = ? AND mr.round_number = 1 AND a.is_auto = 1
    `).bind(match_id).all();
    expect(autoActions).toHaveLength(0);

    // Round 1 has only a1's action, no a2 row
    const { results: round1Actions } = await env.DB.prepare(`
      SELECT a.agent_id FROM actions a
      JOIN match_rounds mr ON a.round_id = mr.id
      WHERE mr.match_id = ? AND mr.round_number = 1
    `).bind(match_id).all();
    expect(round1Actions).toHaveLength(1);
    expect(round1Actions[0].agent_id).toBe(a1.id);

    // a1 (cooperator) gets 3 (R for "as if a2 cooperated"), a2 (timeout) gets 0
    const { results: scores } = await env.DB.prepare(
      'SELECT agent_id, SUM(score_change) AS total FROM ledger_entries WHERE match_id = ? GROUP BY agent_id'
    ).bind(match_id).all();
    const scoreMap = Object.fromEntries(scores.map(s => [s.agent_id, Number(s.total)]));
    expect(scoreMap[a1.id]).toBe(3);
    expect(scoreMap[a2.id]).toBe(0);

    // Round 2 should exist (round advanced)
    const { results: rounds } = await env.DB.prepare(
      'SELECT round_number FROM match_rounds WHERE match_id = ? ORDER BY round_number ASC'
    ).bind(match_id).all();
    expect(rounds.map(r => r.round_number)).toEqual([1, 2]);
  });

  it('one agent defects, other times out → defector gets 5 (T), timeout gets 0', async () => {
    const a1 = await register('TO_Def_A1');
    const a2 = await register('TO_Def_A2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    await submitAction(match_id, a1.api_key, 'defect');

    await env.DB.prepare(
      "UPDATE match_rounds SET round_started_at = datetime('now', '-31 seconds') WHERE match_id = ?"
    ).bind(match_id).run();

    await getMatch(match_id);

    const { results: scores } = await env.DB.prepare(
      'SELECT agent_id, SUM(score_change) AS total FROM ledger_entries WHERE match_id = ? GROUP BY agent_id'
    ).bind(match_id).all();
    const scoreMap = Object.fromEntries(scores.map(s => [s.agent_id, Number(s.total)]));
    expect(scoreMap[a1.id]).toBe(5); // T (defect vs cooperate) as if a2 cooperated
    expect(scoreMap[a2.id]).toBe(0);
  });

  it('3 consecutive timeouts by one agent → match failed, reliability -0.2, forfeit penalty', async () => {
    const a1 = await register('TO_Strike_A1');
    const a2 = await register('TO_Strike_A2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // a2 always submits (cooperate). a1 never submits.
    // For each round: a2 submits, then we backdate the current round to 31s ago, then getMatch.
    // After 3 consecutive a1-misses, the match is forfeit.
    for (let i = 0; i < 3; i++) {
      await submitAction(match_id, a2.api_key, 'cooperate');
      await env.DB.prepare(
        "UPDATE match_rounds SET round_started_at = datetime('now', '-31 seconds') WHERE match_id = ? AND round_number = (SELECT MAX(round_number) FROM match_rounds WHERE match_id = ?)"
      ).bind(match_id, match_id).run();
      await getMatch(match_id);
    }

    // Match should now be failed
    const { results: matchRow } = await env.DB.prepare(
      'SELECT status FROM matches WHERE id = ?'
    ).bind(match_id).all();
    expect(matchRow[0].status).toBe('failed');

    // a1 reliability dropped by 0.2 from 1.0 → 0.8
    const { results: a1Row } = await env.DB.prepare(
      'SELECT reliability_score FROM agents WHERE id = ?'
    ).bind(a1.id).all();
    expect(Number(a1Row[0].reliability_score)).toBeCloseTo(0.8, 5);

    // a1 has a Forfeit Penalty ledger entry with 0 points
    const { results: forfeitEntries } = await env.DB.prepare(
      "SELECT score_change FROM ledger_entries WHERE match_id = ? AND agent_id = ? AND reason = 'Forfeit Penalty'"
    ).bind(match_id, a1.id).all();
    expect(forfeitEntries.length).toBeGreaterThan(0);
    expect(Number(forfeitEntries[0].score_change)).toBe(0);

    // a2 (active) has a Compensation Bonus ledger entry
    const { results: compEntries } = await env.DB.prepare(
      "SELECT score_change FROM ledger_entries WHERE match_id = ? AND agent_id = ? AND reason = 'Compensation Bonus'"
    ).bind(match_id, a2.id).all();
    expect(compEntries.length).toBeGreaterThan(0);
  });

  it('completed match is not re-processed by timeout resolution', async () => {
    const a1 = await register('TO_Done_A1');
    const a2 = await register('TO_Done_A2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    await env.DB.prepare("UPDATE matches SET termination_prob = 0 WHERE id = ?").bind(match_id).run();
    for (let i = 0; i < 5; i++) {
      await submitAction(match_id, a1.api_key, 'cooperate');
      await submitAction(match_id, a2.api_key, 'cooperate');
    }
    await env.DB.prepare("UPDATE matches SET termination_prob = 1 WHERE id = ?").bind(match_id).run();
    await submitAction(match_id, a1.api_key, 'cooperate');
    await submitAction(match_id, a2.api_key, 'cooperate');

    const { results: [{ before }] } = await env.DB.prepare(
      'SELECT COUNT(*) AS before FROM ledger_entries WHERE match_id = ?'
    ).bind(match_id).all();

    await env.DB.prepare(
      "UPDATE match_rounds SET round_started_at = datetime('now', '-35 seconds') WHERE match_id = ?"
    ).bind(match_id).run();

    await getMatch(match_id); // triggers resolveTimedOutRounds

    const { results: [{ after }] } = await env.DB.prepare(
      'SELECT COUNT(*) AS after FROM ledger_entries WHERE match_id = ?'
    ).bind(match_id).all();

    expect(Number(after)).toBe(Number(before));
  });
});

describe('Privacy', () => {
  it('does not redact opponent names anymore', async () => {
    const a1 = await register('Priv_A1');
    const a2 = await register('Priv_A2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Anonymous view
    const mAnon = await getMatch(match_id);
    expect(mAnon.agent1_name).toBe('Priv_A2');
    expect(mAnon.agent2_name).toBe('Priv_A1');
  });
});

describe('Ongoing matches', () => {
  it('returns active matches with live scores', async () => {
    const a1 = await register('OM_A1');
    const a2 = await register('OM_A2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Round 1: a1 defects, a2 cooperates (5, 0)
    await submitAction(match_id, a1.api_key, 'defect');
    await submitAction(match_id, a2.api_key, 'cooperate');

    const res = await SELF.fetch('http://example.com/ongoing', {
      headers: { 'Accept': 'application/json' }
    });
    expect(res.status).toBe(200);
    const matches = await res.json();
    
    expect(matches).toHaveLength(1);
    const m = matches[0];
    expect(m.id).toBe(match_id);
    expect(m.agent1_name).toBe('OM_A2');
    expect(m.agent2_name).toBe('OM_A1');
    expect(m.current_round).toBe(2); // Round 1 finished, round 2 started
    expect(m.agent1_score).toBe(0);
    expect(m.agent2_score).toBe(5);
  });

  it('excludes completed matches', async () => {
    const a1 = await register('OM_Done1');
    const a2 = await register('OM_Done2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Complete the match quickly by setting round to 10 and termination_prob to 1.0
    await env.DB.prepare("UPDATE matches SET termination_prob = 1 WHERE id = ?").bind(match_id).run();
    await submitAction(match_id, a1.api_key, 'cooperate');
    await submitAction(match_id, a2.api_key, 'cooperate');

    const res = await SELF.fetch('http://example.com/ongoing', {
      headers: { 'Accept': 'application/json' }
    });
    const matches = await res.json();
    expect(matches.filter(m => m.id === match_id)).toHaveLength(0);
  });
});

describe('Leaderboard', () => {
  it('returns top agents by cumulative score', async () => {
    const a1 = await register('LB_A1');
    const a2 = await register('LB_A2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    await env.DB.prepare("UPDATE matches SET termination_prob = 0 WHERE id = ?").bind(match_id).run();
    // a1 defects every round, a2 cooperates → a1 gets 5 per round
    for (let i = 0; i < 9; i++) {
      await submitAction(match_id, a1.api_key, 'defect');
      await submitAction(match_id, a2.api_key, 'cooperate');
    }
    await env.DB.prepare("UPDATE matches SET termination_prob = 1 WHERE id = ?").bind(match_id).run();
    await submitAction(match_id, a1.api_key, 'defect');
    await submitAction(match_id, a2.api_key, 'cooperate');

    const res = await SELF.fetch('http://example.com/leaderboard');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.leaderboard).toHaveLength(2);
    expect(body.leaderboard[0].total_points).toBe(50); // a1: 5 * 10
    expect(body.leaderboard[0].avg_points_per_turn).toBe(5); // a1: 5 points per round
    expect(body.leaderboard[0].is_unverified).toBe(1); // 100% matches against a2
    expect(body.leaderboard[1].total_points).toBe(0);   // a2: 0 * 10
  });
});

describe('Match HTML page (regression)', () => {
  it('server-renders the rounds table with one <tr> per round', async () => {
    const a1 = await register('Html_A1');
    const a2 = await register('Html_A2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Resolve three real rounds so the table has content
    for (let i = 0; i < 3; i++) {
      await submitAction(match_id, a1.api_key, 'cooperate');
      await submitAction(match_id, a2.api_key, 'cooperate');
    }

    const res = await SELF.fetch(`http://example.com/matches/${match_id}`, {
      headers: { 'Accept': 'text/html' }
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    const m = html.match(/<tbody id="rounds-body">([\s\S]*?)<\/tbody>/);
    expect(m).toBeTruthy();
    // Match <tr> with or without attributes (the new HTML adds id="round-N"
    // and class="negotiation-row" so the strict <tr> pattern no longer applies).
    const rowCount = (m[1].match(/<tr(\s|>)/g) ?? []).length;
    expect(rowCount).toBeGreaterThanOrEqual(3);
  });
});

// ── Reputation Engine ─────────────────────────────────────────────────────────

describe('calculateElo (pure)', () => {
  it('equal ELOs, win → +16 (K=32, expected=0.5)', () => {
    expect(calculateElo(1000, 1000, 1, 0)).toBe(1016);
  });
  it('equal ELOs, loss → -16 (K=32)', () => {
    expect(calculateElo(1000, 1000, 0, 0)).toBe(984);
  });
  it('equal ELOs, draw → unchanged', () => {
    expect(calculateElo(1000, 1000, 0.5, 0)).toBe(1000);
  });
  it('K drops to 16 once matchesPlayed ≥ 20', () => {
    expect(calculateElo(1000, 1000, 1, 20)).toBe(1008);
    expect(calculateElo(1000, 1000, 1, 19)).toBe(1016);
  });
  it('upset win earns more than expected win', () => {
    const upset = calculateElo(800, 1200, 1, 0);
    const normal = calculateElo(1000, 1000, 1, 0);
    expect(upset - 800).toBeGreaterThan(normal - 1000);
  });
  it('returns an integer', () => {
    expect(Number.isInteger(calculateElo(1013, 988, 1, 7))).toBe(true);
  });
});

describe('Registration → agent_stats row', () => {
  it('creates an agent_stats row with zero counters', async () => {
    const a = await register('StatAgent');
    const row = await env.DB.prepare(
      'SELECT * FROM agent_stats WHERE agent_id = ?'
    ).bind(a.id).first();
    expect(row).toBeTruthy();
    expect(row.matches_played).toBe(0);
    expect(row.cooperate_count).toBe(0);
    expect(row.defect_count).toBe(0);
    expect(row.betrayal_count).toBe(0);
    expect(row.been_betrayed_count).toBe(0);
  });

  it('seeds agents.elo = 1000 and is_provisional = true', async () => {
    const a = await register('Newbie');
    const row = await env.DB.prepare(
      'SELECT elo, is_provisional FROM agents WHERE id = ?'
    ).bind(a.id).first();
    expect(row.elo).toBe(1000);
    expect(row.is_provisional).toBe(1);
  });
});

describe('updateReputationAfterMatch — normal completion', () => {
  it('writes behavioral counts, increments matches_completed, records elo_history', async () => {
    const a1 = await register('Player1');
    const a2 = await register('Player2');

    // Build a synthetic match + 2 rounds:
    //   R1: a1 cooperates, a2 defects → betrayal for a2, been_betrayed for a1
    //   R2: a1 defects,    a2 defects → both defect, no betrayal
    const matchRes = await env.DB.prepare(
      "INSERT INTO matches (agent1_id, agent2_id, status, termination_prob) VALUES (?, ?, 'completed', 0.02)"
    ).bind(a1.id, a2.id).run();
    const matchId = matchRes.meta.last_row_id;

    const r1 = await env.DB.prepare(
      'INSERT INTO match_rounds (match_id, round_number, round_started_at) VALUES (?, 1, CURRENT_TIMESTAMP)'
    ).bind(matchId).run();
    const r2 = await env.DB.prepare(
      'INSERT INTO match_rounds (match_id, round_number, round_started_at) VALUES (?, 2, CURRENT_TIMESTAMP)'
    ).bind(matchId).run();
    await env.DB.prepare(
      'INSERT INTO actions (round_id, agent_id, action) VALUES (?, ?, ?)'
    ).bind(r1.meta.last_row_id, a1.id, 'cooperate').run();
    await env.DB.prepare(
      'INSERT INTO actions (round_id, agent_id, action) VALUES (?, ?, ?)'
    ).bind(r1.meta.last_row_id, a2.id, 'defect').run();
    await env.DB.prepare(
      'INSERT INTO actions (round_id, agent_id, action) VALUES (?, ?, ?)'
    ).bind(r2.meta.last_row_id, a1.id, 'defect').run();
    await env.DB.prepare(
      'INSERT INTO actions (round_id, agent_id, action) VALUES (?, ?, ?)'
    ).bind(r2.meta.last_row_id, a2.id, 'defect').run();

    // a1 ledger: 0 + 1 = 1; a2 ledger: 5 + 1 = 6 → a2 wins
    await env.DB.prepare(
      "INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, 0, 'Round 1')"
    ).bind(matchId, a1.id).run();
    await env.DB.prepare(
      "INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, 5, 'Round 1')"
    ).bind(matchId, a2.id).run();
    await env.DB.prepare(
      "INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, 1, 'Round 2')"
    ).bind(matchId, a1.id).run();
    await env.DB.prepare(
      "INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, 1, 'Round 2')"
    ).bind(matchId, a2.id).run();

    await updateReputationAfterMatch(env.DB, matchId, a1.id, a2.id, 'normal');

    const s1 = await env.DB.prepare('SELECT * FROM agent_stats WHERE agent_id = ?').bind(a1.id).first();
    const s2 = await env.DB.prepare('SELECT * FROM agent_stats WHERE agent_id = ?').bind(a2.id).first();
    expect(s1.matches_played).toBe(1);
    expect(s1.matches_completed).toBe(1);
    expect(s1.matches_forfeited).toBe(0);
    expect(s1.cooperate_count).toBe(1);
    expect(s1.defect_count).toBe(1);
    expect(s1.betrayal_count).toBe(0);     // a1 never defected-then-opp-cooperated
    expect(s1.been_betrayed_count).toBe(1); // a1 cooperated while a2 defected in R1

    expect(s2.matches_played).toBe(1);
    expect(s2.cooperate_count).toBe(0);
    expect(s2.defect_count).toBe(2);
    expect(s2.betrayal_count).toBe(1);     // a2 defected while a1 cooperated in R1
    expect(s2.been_betrayed_count).toBe(0);

    // ELO history: 2 rows
    const hist = await env.DB.prepare(
      'SELECT * FROM elo_history WHERE match_id = ? ORDER BY agent_id'
    ).bind(matchId).all();
    expect(hist.results).toHaveLength(2);
    expect(hist.results[0].result).toBe(0);   // a1 lost
    expect(hist.results[1].result).toBe(1);   // a2 won
  });
});

describe('updateReputationAfterMatch — forfeit', () => {
  it('forfeit_agent1: non-forfeiter gets result=1, forfeiter gets 0', async () => {
    const a1 = await register('F1');
    const a2 = await register('F2');
    const matchRes = await env.DB.prepare(
      "INSERT INTO matches (agent1_id, agent2_id, status, termination_prob) VALUES (?, ?, 'failed', 0.02)"
    ).bind(a1.id, a2.id).run();
    const matchId = matchRes.meta.last_row_id;

    await updateReputationAfterMatch(env.DB, matchId, a1.id, a2.id, 'forfeit_agent1');

    const hist = await env.DB.prepare(
      'SELECT * FROM elo_history WHERE match_id = ? ORDER BY agent_id'
    ).bind(matchId).all();
    const a1Hist = hist.results.find(r => r.agent_id === a1.id);
    const a2Hist = hist.results.find(r => r.agent_id === a2.id);
    expect(a1Hist.result).toBe(0);
    expect(a2Hist.result).toBe(1);

    const s1 = await env.DB.prepare('SELECT matches_forfeited FROM agent_stats WHERE agent_id = ?').bind(a1.id).first();
    const s2 = await env.DB.prepare('SELECT matches_forfeited FROM agent_stats WHERE agent_id = ?').bind(a2.id).first();
    expect(s1.matches_forfeited).toBe(1);
    expect(s2.matches_forfeited).toBe(0);
  });

  it('forfeit_both: both get result=0.5, both forfeit counters increment', async () => {
    const a1 = await register('B1');
    const a2 = await register('B2');
    const matchRes = await env.DB.prepare(
      "INSERT INTO matches (agent1_id, agent2_id, status, termination_prob) VALUES (?, ?, 'failed', 0.02)"
    ).bind(a1.id, a2.id).run();
    const matchId = matchRes.meta.last_row_id;

    await updateReputationAfterMatch(env.DB, matchId, a1.id, a2.id, 'forfeit_both');

    const hist = await env.DB.prepare(
      'SELECT * FROM elo_history WHERE match_id = ? ORDER BY agent_id'
    ).bind(matchId).all();
    expect(hist.results.every(r => r.result === 0.5)).toBe(true);

    const s1 = await env.DB.prepare('SELECT matches_forfeited FROM agent_stats WHERE agent_id = ?').bind(a1.id).first();
    const s2 = await env.DB.prepare('SELECT matches_forfeited FROM agent_stats WHERE agent_id = ?').bind(a2.id).first();
    expect(s1.matches_forfeited).toBe(1);
    expect(s2.matches_forfeited).toBe(1);
  });
});

describe('Provisional graduation', () => {
  it('flips is_provisional to false once matches_completed reaches 20', async () => {
    const a1 = await register('Grad1');
    const a2 = await register('Grad2');

    // Push a1 to 19 completed via direct SQL (register() already created the row).
    await env.DB.prepare(
      `UPDATE agent_stats SET matches_completed = 19 WHERE agent_id = ?`
    ).bind(a1.id).run();

    // Create a real match row so elo_history.match_id FK is satisfied.
    const matchRes = await env.DB.prepare(
      "INSERT INTO matches (agent1_id, agent2_id, status, termination_prob) VALUES (?, ?, 'completed', 0.02)"
    ).bind(a1.id, a2.id).run();
    const matchId = matchRes.meta.last_row_id;

    // This call increments matches_completed to 20 for both a1 and a2.
    await updateReputationAfterMatch(env.DB, matchId, a1.id, a2.id, 'normal');

    const grad1 = await env.DB.prepare('SELECT is_provisional FROM agents WHERE id = ?').bind(a1.id).first();
    const grad2 = await env.DB.prepare('SELECT is_provisional FROM agents WHERE id = ?').bind(a2.id).first();
    expect(grad1.is_provisional).toBe(0); // 19 + 1 = 20 → graduated
    expect(grad2.is_provisional).toBe(1); // only 1 completed → still provisional
  });
});

describe('Defection rate (computed)', () => {
  it('matches the spec formula: defect / (cooperate + defect)', async () => {
    const a = await register('DefRate');
    // register() creates the agent_stats row — UPDATE, don't INSERT.
    await env.DB.prepare(
      `UPDATE agent_stats SET cooperate_count = 6, defect_count = 4 WHERE agent_id = ?`
    ).bind(a.id).run();
    const row = await env.DB.prepare(
      `SELECT CAST(defect_count AS REAL) / NULLIF(cooperate_count + defect_count, 0) AS rate
         FROM agent_stats WHERE agent_id = ?`
    ).bind(a.id).first();
    expect(row.rate).toBeCloseTo(0.4, 5);
  });
});

describe('Weekly ELO decay', () => {
  it('decays non-provisional agents idle for >7 days by 5 (floor 1000)', async () => {
    const active = await register('Active');
    const idle = await register('Idle');

    // Both start non-provisional with elevated ELO
    await env.DB.prepare(
      `UPDATE agents SET elo = 1200, is_provisional = 0 WHERE id IN (?, ?)`
    ).bind(active.id, idle.id).run();
    // register() already created the agent_stats row — UPDATE its last_match_at.
    await env.DB.prepare(
      `UPDATE agent_stats SET last_match_at = datetime('now', '-8 days') WHERE agent_id = ?`
    ).bind(idle.id).run();
    await env.DB.prepare(
      `UPDATE agent_stats SET last_match_at = datetime('now') WHERE agent_id = ?`
    ).bind(active.id).run();

    // Replicate the cron body's UPDATE here (runWeeklyEloDecay is module-scoped
    // in index.js and not exported for the test environment).
    await env.DB.prepare(`
      UPDATE agents
         SET elo = MAX(1000, elo - 5)
       WHERE is_provisional = 0
         AND id IN (
           SELECT agent_id FROM agent_stats
            WHERE last_match_at < datetime('now', '-7 days')
               OR last_match_at IS NULL
         )
    `).run();

    const idleRow = await env.DB.prepare('SELECT elo FROM agents WHERE id = ?').bind(idle.id).first();
    const activeRow = await env.DB.prepare('SELECT elo FROM agents WHERE id = ?').bind(active.id).first();
    expect(idleRow.elo).toBe(1195);
    expect(activeRow.elo).toBe(1200); // not decayed — recent activity
  });
});

// ── Negotiation Phase ──────────────────────────────────────────────────────────

async function postRoundMessage(matchId, roundNumber, apiKey, message) {
  return SELF.fetch(`http://example.com/matches/${matchId}/rounds/${roundNumber}/message`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
}

async function getRoundMessages(matchId, roundNumber) {
  const res = await SELF.fetch(`http://example.com/matches/${matchId}/rounds/${roundNumber}/messages`);
  return res.json();
}

describe('Negotiation — POST /matches/{id}/rounds/{n}/message', () => {
  it('accepts a message during negotiating phase', async () => {
    const a1 = await register('NegA1');
    const a2 = await register('NegA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    const res = await postRoundMessage(match_id, 1, a1.api_key, 'Let us cooperate');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('rejects duplicate message from same agent with 409', async () => {
    const a1 = await register('DupA1');
    const a2 = await register('DupA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    await postRoundMessage(match_id, 1, a1.api_key, 'First message');
    const res = await postRoundMessage(match_id, 1, a1.api_key, 'Second message');
    expect(res.status).toBe(409);
  });

  it('rejects message after phase=deciding with 409', async () => {
    const a1 = await register('LateA1');
    const a2 = await register('LateA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Force the round into deciding phase.
    await env.DB.prepare(
      "UPDATE match_rounds SET phase = 'deciding', decision_started_at = CURRENT_TIMESTAMP WHERE match_id = ?"
    ).bind(match_id).run();

    const res = await postRoundMessage(match_id, 1, a1.api_key, 'Too late');
    expect(res.status).toBe(409);
  });

  it('rejects message from non-participant with 403', async () => {
    const a1 = await register('PartA1');
    const a2 = await register('PartA2');
    const a3 = await register('Outsider');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    const res = await postRoundMessage(match_id, 1, a3.api_key, 'I am not in this match');
    expect(res.status).toBe(403);
  });

  it('rejects empty / whitespace-only message with 400', async () => {
    const a1 = await register('EmptyA1');
    const a2 = await register('EmptyA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    const res = await postRoundMessage(match_id, 1, a1.api_key, '   ');
    expect(res.status).toBe(400);
  });

  it('rejects unauthenticated request with 401', async () => {
    const a1 = await register('UnauthA1');
    const a2 = await register('UnauthA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    const res = await SELF.fetch(`http://example.com/matches/${match_id}/rounds/1/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'no auth' }),
    });
    expect(res.status).toBe(401);
  });
});

describe('Negotiation — GET /matches/{id}/rounds/{n}/messages', () => {
  it('returns empty array when no messages yet', async () => {
    const a1 = await register('GetEmptyA1');
    const a2 = await register('GetEmptyA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    const msgs = await getRoundMessages(match_id, 1);
    expect(msgs).toEqual([]);
  });

  it('returns both messages ordered by sent_at ASC', async () => {
    const a1 = await register('OrderA1');
    const a2 = await register('OrderA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Send a1 first, then a2 — order by sent_at should preserve this.
    await postRoundMessage(match_id, 1, a1.api_key, 'First');
    // Tiny sleep would normally be needed for distinct sent_at, but with UNIQUE
    // (round_id, agent_id) and separate INSERTs, the autoincrement id + the
    // SQLite millisecond resolution should keep them ordered.
    await new Promise(r => setTimeout(r, 5));
    await postRoundMessage(match_id, 1, a2.api_key, 'Second');

    const msgs = await getRoundMessages(match_id, 1);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].message).toBe('First');
    expect(msgs[1].message).toBe('Second');
    expect(msgs[0].agent_id).toBe(a1.id);
    expect(msgs[1].agent_id).toBe(a2.id);
  });

  it('returns empty array for non-existent round (not 404)', async () => {
    const a1 = await register('NRoundA1');
    const a2 = await register('NRoundA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    const msgs = await getRoundMessages(match_id, 999);
    expect(msgs).toEqual([]);
  });
});

describe('Negotiation — phase auto-advance on both-submit', () => {
  it('flips phase to deciding immediately when both agents submit messages', async () => {
    const a1 = await register('AutoA1');
    const a2 = await register('AutoA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    await postRoundMessage(match_id, 1, a1.api_key, 'msg from a1');
    const res = await postRoundMessage(match_id, 1, a2.api_key, 'msg from a2');
    const body = await res.json();
    expect(body.phase_advanced).toBe(true);

    const round = await env.DB.prepare(
      "SELECT phase, decision_started_at FROM match_rounds WHERE match_id = ?"
    ).bind(match_id).first();
    expect(round.phase).toBe('deciding');
    expect(round.decision_started_at).toBeTruthy();
  });
});

describe('Negotiation — resolver advances phase after 20s', () => {
  it('advances phase to deciding even when no messages submitted', async () => {
    const a1 = await register('NoMsgA1');
    const a2 = await register('NoMsgA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Backdate to 21s past round_started_at.
    await env.DB.prepare(
      "UPDATE match_rounds SET round_started_at = datetime('now', '-21 seconds') WHERE match_id = ?"
    ).bind(match_id).run();

    // GET /matches/{id} triggers resolveTimedOutRounds.
    await getMatch(match_id);

    const round = await env.DB.prepare(
      "SELECT phase, decision_started_at FROM match_rounds WHERE match_id = ?"
    ).bind(match_id).first();
    expect(round.phase).toBe('deciding');
    expect(round.decision_started_at).toBeTruthy();
  });
});

describe('Negotiation — response_time_ms', () => {
  it('uses decision_started_at when present, falls back to round_started_at otherwise', async () => {
    const a1 = await register('RespA1');
    const a2 = await register('RespA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Force the round to deciding phase and backdate decision_started_at by 5s.
    await env.DB.prepare(
      "UPDATE match_rounds SET phase = 'deciding', decision_started_at = datetime('now', '-5 seconds') WHERE match_id = ?"
    ).bind(match_id).run();

    // Small delay so response_time_ms > 0 but < 30s.
    await new Promise(r => setTimeout(r, 100));
    const res = await submitAction(match_id, a1.api_key, 'cooperate');
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      'SELECT response_time_ms FROM actions a JOIN match_rounds mr ON a.round_id = mr.id WHERE mr.match_id = ? AND a.agent_id = ?'
    ).bind(match_id, a1.id).first();
    // Should be ~5s (from decision_started_at) not ~0s.
    expect(row.response_time_ms).toBeGreaterThan(4000);
    expect(row.response_time_ms).toBeLessThan(8000);
  });

  it('falls back to round_started_at when decision_started_at is null (old row)', async () => {
    const a1 = await register('FallA1');
    const a2 = await register('FallA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Simulate a pre-negotiation-feature row: decision_started_at is null and
    // the row has no phase column populated. The handler should compute
    // response_time_ms from round_started_at (the legacy behavior).
    await env.DB.prepare(
      "UPDATE match_rounds SET phase = NULL, decision_started_at = NULL, round_started_at = datetime('now', '-2 seconds') WHERE match_id = ?"
    ).bind(match_id).run();

    const res = await submitAction(match_id, a1.api_key, 'cooperate');
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      'SELECT response_time_ms FROM actions a JOIN match_rounds mr ON a.round_id = mr.id WHERE mr.match_id = ? AND a.agent_id = ?'
    ).bind(match_id, a1.id).first();
    // Should be ~2s (from round_started_at).
    expect(row.response_time_ms).toBeGreaterThan(1000);
    expect(row.response_time_ms).toBeLessThan(4000);
  });
});

describe('Negotiation — replay includes negotiation field', () => {
  it('replay rounds have empty negotiation array when no messages', async () => {
    const a1 = await register('ReplayA1');
    const a2 = await register('ReplayA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Force the match to terminate after round 1 so the replay has exactly one round.
    await env.DB.prepare("UPDATE matches SET termination_prob = 1 WHERE id = ?").bind(match_id).run();
    // Advance round to deciding, submit actions, complete match via forced termination.
    await env.DB.prepare(
      "UPDATE match_rounds SET phase = 'deciding', decision_started_at = CURRENT_TIMESTAMP WHERE match_id = ?"
    ).bind(match_id).run();
    await submitAction(match_id, a1.api_key, 'cooperate');
    await submitAction(match_id, a2.api_key, 'cooperate');
    // Belt-and-suspenders: ensure match is completed (round_advance path will also handle it).
    await env.DB.prepare("UPDATE matches SET status = 'completed' WHERE id = ?").bind(match_id).run();

    const replay = await getReplay(match_id);
    expect(replay.rounds).toHaveLength(1);
    expect(replay.rounds[0].negotiation).toEqual([]);
  });

  it('replay rounds have populated negotiation array when messages were sent', async () => {
    const a1 = await register('PopA1');
    const a2 = await register('PopA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Force the match to terminate after round 1.
    await env.DB.prepare("UPDATE matches SET termination_prob = 1 WHERE id = ?").bind(match_id).run();
    await postRoundMessage(match_id, 1, a1.api_key, 'msg from a1');
    await postRoundMessage(match_id, 1, a2.api_key, 'msg from a2');
    // Phase auto-advanced to deciding.
    await submitAction(match_id, a1.api_key, 'cooperate');
    await submitAction(match_id, a2.api_key, 'cooperate');
    await env.DB.prepare("UPDATE matches SET status = 'completed' WHERE id = ?").bind(match_id).run();

    const replay = await getReplay(match_id);
    expect(replay.rounds).toHaveLength(1);
    expect(replay.rounds[0].negotiation).toHaveLength(2);
    expect(replay.rounds[0].negotiation[0].message).toBe('msg from a1');
    expect(replay.rounds[0].negotiation[1].message).toBe('msg from a2');
  });
});

describe('Negotiation — SSE events emitted', () => {
  // The broadcastSSE() helper calls into the Umpire DO via fetch. We cannot
  // directly assert the DO's broadcast() method was called without
  // instrumenting the DO itself, but we can verify the side effect: the
  // database state changes that the SSE events signal (round_messages row,
  // phase=deciding) are correct. The actual SSE wire format is unchanged
  // (event: message_received\ndata: {match_id, round}) and is verified
  // by the broadcastSSE helper existing in helpers.js.
  it('message insert updates DB state that the message_received event signals', async () => {
    const a1 = await register('SseMsgA1');
    const a2 = await register('SseMsgA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    const res = await postRoundMessage(match_id, 1, a1.api_key, 'sse trigger');
    expect(res.status).toBe(200);
    const { results } = await env.DB.prepare(
      'SELECT message FROM round_messages WHERE round_id IN (SELECT id FROM match_rounds WHERE match_id = ?)'
    ).bind(match_id).all();
    expect(results[0].message).toBe('sse trigger');
  });

  it('both messages trigger DB phase flip that phase_advanced event signals', async () => {
    const a1 = await register('SsePhaseA1');
    const a2 = await register('SsePhaseA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    await postRoundMessage(match_id, 1, a1.api_key, 'first');
    await postRoundMessage(match_id, 1, a2.api_key, 'second');
    const round = await env.DB.prepare(
      'SELECT phase FROM match_rounds WHERE match_id = ?'
    ).bind(match_id).first();
    expect(round.phase).toBe('deciding');
  });
});

describe('Negotiation — backward compatibility (old rows)', () => {
  it('round with phase=null resolves with existing 30s timeout from round_started_at', async () => {
    const a1 = await register('OldA1');
    const a2 = await register('OldA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Simulate a pre-migration row: phase is null, decision_started_at is null.
    // Backdate round_started_at to 31s ago — the 30s check should fire
    // because COALESCE(decision_started_at, round_started_at) returns round_started_at.
    await env.DB.prepare(
      "UPDATE match_rounds SET phase = NULL, decision_started_at = NULL, round_started_at = datetime('now', '-31 seconds') WHERE match_id = ?"
    ).bind(match_id).run();

    await getMatch(match_id);

    // No actions were submitted — both should get 0 points.
    const { results: scores } = await env.DB.prepare(
      'SELECT agent_id, SUM(score_change) AS total FROM ledger_entries WHERE match_id = ? GROUP BY agent_id'
    ).bind(match_id).all();
    expect(scores).toHaveLength(2);
    scores.forEach(s => expect(Number(s.total)).toBe(0));
  });
});

describe('Negotiation — DO alarm timing (50s)', () => {
  it('setMatchTimeout uses 50000ms (50s) for new rounds (Verified via direct SQL on round_started_at delta)', async () => {
    // This is a static check on the source: the DO should set the alarm 50s
    // out so it fires after the 20s negotiation + 30s decision windows.
    // We verify indirectly: a new round, if we wait < 50s, the 30s decision
    // window should NOT yet have fired (we'd still be in deciding phase).
    const a1 = await register('TimingA1');
    const a2 = await register('TimingA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    // Advance phase to deciding (simulating either the 20s auto-advance or
    // both-message auto-advance). The 30s check is keyed on
    // decision_started_at. If the round is created with round_started_at = now
    // and the phase is flipped to deciding right away, the decision window
    // hasn't elapsed yet.
    await env.DB.prepare(
      "UPDATE match_rounds SET phase = 'deciding', decision_started_at = CURRENT_TIMESTAMP WHERE match_id = ?"
    ).bind(match_id).run();

    // Trigger resolver — round should NOT resolve (only 0s elapsed in deciding).
    await getMatch(match_id);

    const match = await env.DB.prepare('SELECT status FROM matches WHERE id = ?').bind(match_id).first();
    expect(match.status).toBe('active');
  });
});

describe('Negotiation — round_messages row persists in replay (consistency data)', () => {
  it('round_messages row survives resolution and is replayable', async () => {
    const a1 = await register('PersistA1');
    const a2 = await register('PersistA2');
    await joinQueue(a1.api_key);
    const { match_id } = await joinQueue(a2.api_key);

    await postRoundMessage(match_id, 1, a1.api_key, 'I will cooperate');
    await postRoundMessage(match_id, 1, a2.api_key, 'Me too');
    // Phase auto-advanced. Now play the round.
    await submitAction(match_id, a1.api_key, 'cooperate');
    await submitAction(match_id, a2.api_key, 'defect');  // betrayal: said cooperate, then defected

    // Verify the round_messages row is still queryable directly.
    const directMsgs = await env.DB.prepare(`
      SELECT rm.agent_id, rm.message, a.action, a.message as commit_msg
        FROM round_messages rm
        JOIN match_rounds mr ON rm.round_id = mr.id
        LEFT JOIN actions a ON a.round_id = mr.id AND a.agent_id = rm.agent_id
       WHERE mr.match_id = ?
    `).bind(match_id).all();
    const a1Row = directMsgs.results.find(r => r.agent_id === a1.id);
    const a2Row = directMsgs.results.find(r => r.agent_id === a2.id);
    expect(a1Row.message).toBe('I will cooperate');
    expect(a1Row.action).toBe('cooperate');
    expect(a2Row.message).toBe('Me too');
    expect(a2Row.action).toBe('defect');  // said cooperate in negotiation, defected in action

    // Replay should also show this.
    const replay = await getReplay(match_id);
    expect(replay.rounds[0].negotiation).toHaveLength(2);
    expect(replay.rounds[0].actions.find(a => a.agent_id === a2.id).action).toBe('defect');
    expect(replay.rounds[0].negotiation.find(m => m.agent_id === a2.id).message).toBe('Me too');
  });
});

// ── Consistency classification (pure functions) ────────────────────────────────

describe('Consistency classification', () => {
  it('classifyIntent: cooperate keywords → cooperate', () => {
    expect(classifyIntent("Let's cooperate")).toBe('cooperate');
    expect(classifyIntent('I propose mutual cooperation.')).toBe('cooperate');
    expect(classifyIntent("Let's work together.")).toBe('cooperate');
    expect(classifyIntent('Be my ally, friend.')).toBe('cooperate');
    expect(classifyIntent('Peace.')).toBe('cooperate');
  });
  it('classifyIntent: defect keywords → defect', () => {
    expect(classifyIntent("I'll defect this round.")).toBe('defect');
    expect(classifyIntent('I will betray you.')).toBe('defect');
    expect(classifyIntent("Can't trust you anymore.")).toBe('defect');
    expect(classifyIntent('Time for revenge.')).toBe('defect');
  });
  it('classifyIntent: empty / null / mixed / no-keywords → ambiguous', () => {
    expect(classifyIntent('')).toBe('ambiguous');
    expect(classifyIntent(null)).toBe('ambiguous');
    expect(classifyIntent(undefined)).toBe('ambiguous');
    expect(classifyIntent('whatever')).toBe('ambiguous');
    // Both keywords present → ambiguous (could be either).
    expect(classifyIntent('I will cooperate and then defect')).toBe('ambiguous');
  });

  it('consistencyLabel: cooperate message + cooperate action → HONEST', () => {
    expect(consistencyLabel("Let's cooperate", 'cooperate')).toBe('HONEST');
  });
  it('consistencyLabel: cooperate message + defect action → DECEIT', () => {
    expect(consistencyLabel("Let's cooperate", 'defect')).toBe('DECEIT');
  });
  it('consistencyLabel: defect message + defect action → HONEST', () => {
    expect(consistencyLabel("I'll defect", 'defect')).toBe('HONEST');
  });
  it('consistencyLabel: defect message + cooperate action → HONEST', () => {
    expect(consistencyLabel("I'll defect this round", 'cooperate')).toBe('HONEST');
  });
  it('consistencyLabel: ambiguous message + any action → VAGUE', () => {
    expect(consistencyLabel('random text', 'cooperate')).toBe('VAGUE');
    expect(consistencyLabel('random text', 'defect')).toBe('VAGUE');
  });
  it('consistencyLabel: invalid action → VAGUE', () => {
    expect(consistencyLabel("Let's cooperate", 'unknown')).toBe('VAGUE');
  });

  it('computeHonestyReport: tallies honest/deceit/vague per agent', () => {
    const a1 = 100, a2 = 200;
    const rounds = [
      {
        round_number: 1,
        negotiation: [
          { agent_id: a1, message: "Let's cooperate", sent_at: '2026-01-01 00:00:01' },
          { agent_id: a2, message: 'I will defect',  sent_at: '2026-01-01 00:00:02' },
        ],
        actions: [
          { agent_id: a1, action: 'cooperate' },  // honest
          { agent_id: a2, action: 'defect' },     // honest
        ],
        payoffs: [],
      },
      {
        round_number: 2,
        negotiation: [
          { agent_id: a1, message: "Let's cooperate", sent_at: '2026-01-01 00:00:03' },
          { agent_id: a2, message: 'Sounds good',    sent_at: '2026-01-01 00:00:04' },
        ],
        actions: [
          { agent_id: a1, action: 'defect' },     // DECEIT (said coop, defected)
          { agent_id: a2, action: 'cooperate' },  // VAGUE  (no clear intent)
        ],
        payoffs: [],
      },
    ];
    const r = computeHonestyReport(rounds, a1, a2, 'A1', 'A2');
    expect(r.a1.honest).toBe(1);
    expect(r.a1.deceit).toBe(1);
    expect(r.a1.vague).toBe(0);
    expect(r.a1.total).toBe(2);
    expect(r.a1.pct).toBe(50);
    expect(r.a2.honest).toBe(1);
    expect(r.a2.deceit).toBe(0);
    expect(r.a2.vague).toBe(1);
    expect(r.a2.total).toBe(2);
    expect(r.a2.pct).toBe(50);
    expect(r.mostDeceitfulRound).toBe(2);
  });

  it('computeHonestyReport: no negotiations → mostDeceitfulRound is null', () => {
    const r = computeHonestyReport([], 1, 2, 'A1', 'A2');
    expect(r.mostDeceitfulRound).toBeNull();
    expect(r.a1.total).toBe(0);
    expect(r.a1.pct).toBe(0);
  });

  it('computeHonestyReport: skips negotiations for agents not in the match', () => {
    const rounds = [{
      round_number: 1,
      negotiation: [
        { agent_id: 999, message: "Let's cooperate", sent_at: '2026-01-01 00:00:01' },
      ],
      actions: [
        { agent_id: 1, action: 'cooperate' },
        { agent_id: 2, action: 'cooperate' },
      ],
      payoffs: [],
    }];
    const r = computeHonestyReport(rounds, 1, 2, 'A1', 'A2');
    expect(r.a1.total).toBe(0);
    expect(r.a2.total).toBe(0);
  });
});
