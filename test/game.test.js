import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { env, SELF } from 'cloudflare:test';

// Schema with IF NOT EXISTS so beforeAll can be called once safely
const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  api_key TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent1_id INTEGER,
  agent2_id INTEGER,
  status TEXT NOT NULL CHECK (status IN ('created', 'active', 'completed', 'failed')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (agent1_id) REFERENCES agents(id),
  FOREIGN KEY (agent2_id) REFERENCES agents(id)
);
CREATE TABLE IF NOT EXISTS match_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id INTEGER NOT NULL,
  round_number INTEGER NOT NULL,
  round_started_at DATETIME,
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
  submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (round_id) REFERENCES match_rounds(id),
  FOREIGN KEY (agent_id) REFERENCES agents(id),
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
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_match_rounds_match_id ON match_rounds(match_id);
CREATE INDEX IF NOT EXISTS idx_actions_round_id ON actions(round_id);
CREATE INDEX IF NOT EXISTS idx_ledger_entries_agent_id ON ledger_entries(agent_id);
CREATE INDEX IF NOT EXISTS idx_leaderboard_snapshots_agent_id ON leaderboard_snapshots(agent_id);
`.trim();

beforeAll(async () => {
  for (const stmt of SCHEMA.split(';').map(s => s.trim()).filter(Boolean)) {
    await env.DB.prepare(stmt).run();
  }
});

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM leaderboard_snapshots'),
    env.DB.prepare('DELETE FROM ledger_entries'),
    env.DB.prepare('DELETE FROM actions'),
    env.DB.prepare('DELETE FROM match_rounds'),
    env.DB.prepare('DELETE FROM matches'),
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
  const { agent } = await res.json();
  return agent;
}

async function createMatch(apiKey) {
  const res = await SELF.fetch('http://example.com/matches', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
  return res.json();
}

async function joinMatch(matchId, apiKey) {
  return SELF.fetch(`http://example.com/matches/${matchId}/join`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}` },
  });
}

async function submitAction(matchId, apiKey, action) {
  return SELF.fetch(`http://example.com/matches/${matchId}/actions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
}

async function getMatch(matchId) {
  const res = await SELF.fetch(`http://example.com/matches/${matchId}`);
  return res.json();
}

async function getReplay(matchId) {
  const res = await SELF.fetch(`http://example.com/matches/${matchId}/replay`);
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
    const { agent } = await res.json();
    expect(agent.name).toBe('TestAgent');
    expect(agent.api_key).toHaveLength(64);
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

describe('Match lifecycle', () => {
  it('creates a match and returns match_id', async () => {
    const a = await register('Creator');
    const res = await SELF.fetch('http://example.com/matches', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${a.api_key}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.match_id).toBeGreaterThan(0);
  });

  it('cannot join own match', async () => {
    const a = await register('SelfJoiner');
    const { match_id } = await createMatch(a.api_key);
    const res = await joinMatch(match_id, a.api_key);
    expect(res.status).toBe(400);
  });

  it('requires auth to create match', async () => {
    const res = await SELF.fetch('http://example.com/matches', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('Full match: both cooperate', () => {
  it('scores 300 pts each after 100 rounds', async () => {
    const a1 = await register('FC_A1');
    const a2 = await register('FC_A2');
    const { match_id } = await createMatch(a1.api_key);
    await joinMatch(match_id, a2.api_key);

    for (let i = 0; i < 100; i++) {
      const r1 = await submitAction(match_id, a1.api_key, 'cooperate');
      expect(r1.status).toBe(200);
      const r2 = await submitAction(match_id, a2.api_key, 'cooperate');
      expect(r2.status).toBe(200);
    }

    const match = await getMatch(match_id);
    expect(match.status).toBe('completed');

    const replay = await getReplay(match_id);
    expect(replay.final_scores).toHaveLength(2);
    replay.final_scores.forEach(s => expect(s.total_score).toBe(300));
  });
});

describe('Action submission guards', () => {
  it('rejects duplicate action for same round', async () => {
    const a1 = await register('Dup_A1');
    const a2 = await register('Dup_A2');
    const { match_id } = await createMatch(a1.api_key);
    await joinMatch(match_id, a2.api_key);

    const r1 = await submitAction(match_id, a1.api_key, 'cooperate');
    expect(r1.status).toBe(200);
    const r2 = await submitAction(match_id, a1.api_key, 'defect');
    expect(r2.status).toBe(400);
    expect(await r2.text()).toContain('already submitted');
  });

  it('rejects action on completed match', async () => {
    const a1 = await register('Late_A1');
    const a2 = await register('Late_A2');
    const { match_id } = await createMatch(a1.api_key);
    await joinMatch(match_id, a2.api_key);

    for (let i = 0; i < 100; i++) {
      await submitAction(match_id, a1.api_key, 'cooperate');
      await submitAction(match_id, a2.api_key, 'cooperate');
    }

    const late = await submitAction(match_id, a1.api_key, 'defect');
    expect(late.status).toBe(400);
  });

  it('rejects invalid action string', async () => {
    const a1 = await register('Bad_A1');
    const a2 = await register('Bad_A2');
    const { match_id } = await createMatch(a1.api_key);
    await joinMatch(match_id, a2.api_key);

    const res = await submitAction(match_id, a1.api_key, 'surrender');
    expect(res.status).toBe(400);
  });
});

describe('Replay', () => {
  it('includes round-by-round actions, payoffs, and auto field', async () => {
    const a1 = await register('Rp_A1');
    const a2 = await register('Rp_A2');
    const { match_id } = await createMatch(a1.api_key);
    await joinMatch(match_id, a2.api_key);

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
  it('both agents timeout → auto-defect, score (1,1) each', async () => {
    const a1 = await register('TO_Both_A1');
    const a2 = await register('TO_Both_A2');
    const { match_id } = await createMatch(a1.api_key);
    await joinMatch(match_id, a2.api_key);

    // Backdate round_started_at to simulate 4-second-old round
    await env.DB.prepare(
      "UPDATE match_rounds SET round_started_at = datetime('now', '-4 seconds') WHERE match_id = ?"
    ).bind(match_id).run();

    // GET /matches/{id} triggers resolveTimedOutRounds
    await getMatch(match_id);

    const { results: autoActions } = await env.DB.prepare(`
      SELECT COUNT(*) AS cnt FROM actions a
      JOIN match_rounds mr ON a.round_id = mr.id
      WHERE mr.match_id = ? AND mr.round_number = 1 AND a.is_auto = 1
    `).bind(match_id).all();
    expect(autoActions[0].cnt).toBe(2);

    const { results: scores } = await env.DB.prepare(
      'SELECT agent_id, SUM(score_change) AS total FROM ledger_entries WHERE match_id = ? GROUP BY agent_id'
    ).bind(match_id).all();
    expect(scores).toHaveLength(2);
    scores.forEach(s => expect(Number(s.total)).toBe(1));
  });

  it('one agent cooperates, other times out → (0,5)', async () => {
    const a1 = await register('TO_One_A1');
    const a2 = await register('TO_One_A2');
    const { match_id } = await createMatch(a1.api_key);
    await joinMatch(match_id, a2.api_key);

    await submitAction(match_id, a1.api_key, 'cooperate');

    await env.DB.prepare(
      "UPDATE match_rounds SET round_started_at = datetime('now', '-4 seconds') WHERE match_id = ?"
    ).bind(match_id).run();

    await getMatch(match_id);

    const { results: autoActions } = await env.DB.prepare(`
      SELECT a.agent_id FROM actions a
      JOIN match_rounds mr ON a.round_id = mr.id
      WHERE mr.match_id = ? AND mr.round_number = 1 AND a.is_auto = 1
    `).bind(match_id).all();
    expect(autoActions).toHaveLength(1);
    expect(autoActions[0].agent_id).toBe(a2.id);

    const { results: scores } = await env.DB.prepare(
      'SELECT agent_id, SUM(score_change) AS total FROM ledger_entries WHERE match_id = ? GROUP BY agent_id'
    ).bind(match_id).all();
    const scoreMap = Object.fromEntries(scores.map(s => [s.agent_id, Number(s.total)]));
    expect(scoreMap[a1.id]).toBe(0);
    expect(scoreMap[a2.id]).toBe(5);
  });

  it('completed match is not re-processed by timeout resolution', async () => {
    const a1 = await register('TO_Done_A1');
    const a2 = await register('TO_Done_A2');
    const { match_id } = await createMatch(a1.api_key);
    await joinMatch(match_id, a2.api_key);

    for (let i = 0; i < 100; i++) {
      await submitAction(match_id, a1.api_key, 'cooperate');
      await submitAction(match_id, a2.api_key, 'cooperate');
    }

    const { results: [{ before }] } = await env.DB.prepare(
      'SELECT COUNT(*) AS before FROM ledger_entries WHERE match_id = ?'
    ).bind(match_id).all();

    await env.DB.prepare(
      "UPDATE match_rounds SET round_started_at = datetime('now', '-10 seconds') WHERE match_id = ?"
    ).bind(match_id).run();

    await getMatch(match_id); // triggers resolveTimedOutRounds

    const { results: [{ after }] } = await env.DB.prepare(
      'SELECT COUNT(*) AS after FROM ledger_entries WHERE match_id = ?'
    ).bind(match_id).all();

    expect(Number(after)).toBe(Number(before));
  });
});

describe('Leaderboard', () => {
  it('returns top agents by cumulative score', async () => {
    const a1 = await register('LB_A1');
    const a2 = await register('LB_A2');
    const { match_id } = await createMatch(a1.api_key);
    await joinMatch(match_id, a2.api_key);

    // a1 defects every round, a2 cooperates → a1 gets 5 per round
    for (let i = 0; i < 100; i++) {
      await submitAction(match_id, a1.api_key, 'defect');
      await submitAction(match_id, a2.api_key, 'cooperate');
    }

    const res = await SELF.fetch('http://example.com/leaderboard');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.leaderboard).toHaveLength(2);
    expect(body.leaderboard[0].total_score).toBe(500); // a1: 5 * 100
    expect(body.leaderboard[1].total_score).toBe(0);   // a2: 0 * 100
  });
});
