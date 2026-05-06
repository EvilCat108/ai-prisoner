export function calculatePayoff(myAction, opponentAction) {
  if (myAction === 'cooperate' && opponentAction === 'cooperate') return [3, 3];
  if (myAction === 'cooperate' && opponentAction === 'defect')    return [0, 5];
  if (myAction === 'defect'    && opponentAction === 'cooperate') return [5, 0];
  return [1, 1];
}

export async function resolveTimedOutMatch(env, db, matchId, agent1Id, agent2Id, roundId, roundNumber, broadcastSSE, logToDb) {
  // Fetch round_started_at to compute response_time_ms for auto-defects
  const round = await db.prepare('SELECT round_started_at FROM match_rounds WHERE id = ?').bind(roundId).first();
  const now = Date.now();
  let autoResponseTime = null;
  if (round?.round_started_at) {
    const startedAt = new Date(round.round_started_at + 'Z').getTime();
    autoResponseTime = now - startedAt;
  }

  // INSERT OR IGNORE: safe against concurrent Workers both trying to auto-defect the same agent
  await db.batch([agent1Id, agent2Id].map(agentId =>
    db.prepare("INSERT OR IGNORE INTO actions (round_id, agent_id, action, is_auto, response_time_ms, message) VALUES (?, ?, 'defect', 1, ?, NULL)")
      .bind(roundId, agentId, autoResponseTime)
  ));

  // Guard: if payoffs exist another Worker already resolved this round
  const alreadyResolved = await db.prepare(
    "SELECT id FROM ledger_entries WHERE match_id = ? AND reason = ? LIMIT 1"
  ).bind(matchId, `Round ${roundNumber}`).first();
  if (alreadyResolved) return;

  const { results: both } = await db.prepare(
    'SELECT agent_id, action, is_auto FROM actions WHERE round_id = ?'
  ).bind(roundId).all();
  if (!both || both.length !== 2) return;

  const a1row = both.find(a => a.agent_id === agent1Id);
  const a2row = both.find(a => a.agent_id === agent2Id);
  if (!a1row || !a2row) return;
  const a1act = a1row.action;
  const a2act = a2row.action;

  const [rawP1, rawP2] = calculatePayoff(a1act, a2act);
  // Zero-point penalty: timed-out (auto) agent gets 0, opponent gets normal payoff
  const p1 = a1row.is_auto ? 0 : rawP1;
  const p2 = a2row.is_auto ? 0 : rawP2;
  const reason = `Round ${roundNumber}`;
  
  // Fetch match details to get termination_prob
  const match = await db.prepare("SELECT termination_prob FROM matches WHERE id = ?").bind(matchId).first();
  
  const ops = [
    db.prepare('INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, ?, ?)').bind(matchId, agent1Id, p1, reason),
    db.prepare('INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, ?, ?)').bind(matchId, agent2Id, p2, reason),
  ];

  // Three-Strike Forfeit Check
  const checkThreeStrikes = async (agentId) => {
    const recent = await db.prepare(`
      SELECT a.is_auto 
      FROM actions a 
      JOIN match_rounds mr ON a.round_id = mr.id 
      WHERE mr.match_id = ? AND a.agent_id = ? 
      ORDER BY mr.round_number DESC 
      LIMIT 3
    `).bind(matchId, agentId).all();
    return (recent.results && recent.results.length === 3 && recent.results.every(r => r.is_auto));
  };

  const a1Strike = await checkThreeStrikes(agent1Id);
  const a2Strike = await checkThreeStrikes(agent2Id);

  let nextStateEvent = '';
  if (a1Strike || a2Strike) {
    const failedAgent = a1Strike ? agent1Id : agent2Id;
    const activeAgent = a1Strike ? agent2Id : agent1Id;
    const bothStrike = a1Strike && a2Strike;

    ops.push(db.prepare("UPDATE matches SET status = 'failed' WHERE id = ?").bind(matchId));
    nextStateEvent = 'match_failed';

    if (!bothStrike) {
      // Decrease reliability score significantly
      ops.push(db.prepare("UPDATE agents SET reliability_score = MAX(0, reliability_score - 0.2) WHERE id = ?").bind(failedAgent));
      
      // Calculate APPT for compensation
      const stats = await db.prepare(`
        SELECT SUM(score_change) as tp, COUNT(id) as tr 
        FROM ledger_entries WHERE agent_id = ? AND reason LIKE 'Round %'
      `).bind(activeAgent).first();
      const appt = (stats && stats.tr > 0) ? (stats.tp / stats.tr) : 1; 
      const expectedRounds = Math.max(0, (1 / (match?.termination_prob || 0.02)) - roundNumber);
      const compensation = Math.round(appt * expectedRounds);

      if (compensation > 0) {
        ops.push(db.prepare("INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, ?, ?)").bind(matchId, activeAgent, compensation, "Compensation Bonus"));
      }
      ops.push(db.prepare("INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, ?, ?)").bind(matchId, failedAgent, 0, "Forfeit Penalty"));
    } else {
      ops.push(db.prepare("UPDATE agents SET reliability_score = MAX(0, reliability_score - 0.2) WHERE id = ?").bind(agent1Id));
      ops.push(db.prepare("UPDATE agents SET reliability_score = MAX(0, reliability_score - 0.2) WHERE id = ?").bind(agent2Id));
    }
  } else {
    const shouldTerminate = Math.random() < (match?.termination_prob ?? 0.02);
    if (shouldTerminate) {
      ops.push(db.prepare("UPDATE matches SET status = 'completed' WHERE id = ?").bind(matchId));
      ops.push(db.prepare("UPDATE agents SET reliability_score = MIN(1.0, reliability_score + 0.01) WHERE id = ?").bind(agent1Id));
      ops.push(db.prepare("UPDATE agents SET reliability_score = MIN(1.0, reliability_score + 0.01) WHERE id = ?").bind(agent2Id));
      nextStateEvent = 'match_completed';
    } else {
      ops.push(
        db.prepare("INSERT OR IGNORE INTO match_rounds (match_id, round_number, round_started_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
          .bind(matchId, roundNumber + 1)
      );
      nextStateEvent = 'round_advanced';
    }
  }

  await db.batch(ops);
  await broadcastSSE(env, nextStateEvent, { match_id: matchId, round: nextStateEvent === 'round_advanced' ? roundNumber + 1 : roundNumber });
}

export async function resolveTimedOutRounds(env, db, specificMatchId = null, broadcastSSE, logToDb) {
  // 1. Resolve active matches with timed-out rounds (30s) or where both agents have submitted
  const baseActive = `
    SELECT m.id AS match_id, m.agent1_id, m.agent2_id, mr.id AS round_id, mr.round_number
    FROM matches m
    JOIN match_rounds mr ON mr.match_id = m.id
    WHERE m.status = 'active'
      AND mr.round_number = (SELECT MAX(round_number) FROM match_rounds WHERE match_id = m.id)
      AND mr.round_started_at IS NOT NULL
      AND (
        (julianday('now') - julianday(mr.round_started_at)) * 86400 >= 30
        OR (SELECT COUNT(*) FROM actions WHERE round_id = mr.id) >= 2
      )`;
  
  const { results: activeResults } = specificMatchId != null
    ? await db.prepare(baseActive + ' AND m.id = ?').bind(specificMatchId).all()
    : await db.prepare(baseActive).all();
  
  for (const row of (activeResults || [])) {
    const { count } = await db.prepare("SELECT COUNT(*) as count FROM actions WHERE round_id = ?").bind(row.round_id).first();
    if (count < 2) {
      await logToDb(db, 'WARN', `Resolving timed-out round #${row.round_number} for match #${row.match_id}.`);
    }
    await resolveTimedOutMatch(env, db, row.match_id, row.agent1_id, row.agent2_id, row.round_id, row.round_number, broadcastSSE, logToDb);
  }

  // 1b. Fail 'active' matches that are stagnant (no moves for 300s)
  const stagnantActive = await db.prepare(`
    SELECT m.id FROM matches m
    JOIN match_rounds mr ON mr.match_id = m.id
    WHERE m.status = 'active'
      AND mr.round_number = (SELECT MAX(round_number) FROM match_rounds WHERE match_id = m.id)
      AND (julianday('now') - julianday(mr.round_started_at)) * 86400 >= 300
  `).all();
  for (const m of (stagnantActive.results || [])) {
    await logToDb(db, 'ERROR', `Match #${m.id} failed due to stagnation (300s).`);
    await db.prepare("UPDATE matches SET status = 'failed' WHERE id = ?").bind(m.id).run();
  }

  // 1c. Global Stagnation Safety Net: Fail any 'active' match that has existed for a while 
  // but hasn't had a round update in 10 minutes.
  const globalStagnant = await db.prepare(`
    SELECT m.id FROM matches m
    JOIN match_rounds mr ON mr.match_id = m.id
    WHERE m.status = 'active'
      AND mr.round_number = (SELECT MAX(round_number) FROM match_rounds WHERE match_id = m.id)
      AND (julianday('now') - julianday(COALESCE(mr.round_started_at, m.created_at))) * 86400 >= 600
  `).all();
  for (const m of (globalStagnant.results || [])) {
    await logToDb(db, 'ERROR', `Match #${m.id} failed due to global stagnation (600s).`);
    await db.prepare("UPDATE matches SET status = 'failed' WHERE id = ?").bind(m.id).run();
  }

  // 1d. Clean up match_queue (remove agents not seen in 30s, except Sheriff)
  await db.prepare(`
    DELETE FROM match_queue 
    WHERE agent_id IN (
      SELECT id FROM agents 
      WHERE (julianday('now') - julianday(last_seen_at)) * 86400 >= 30 
        AND name != 'Sheriff'
    )
  `).run();

  // 2. Fail 'created' matches that timed out (300s)
  const baseCreated = `SELECT id FROM matches WHERE status = 'created' AND (julianday('now') - julianday(created_at)) * 86400 >= 300`;
  const stagnantCreated = specificMatchId != null
    ? await db.prepare(baseCreated + ' AND id = ?').bind(specificMatchId).all()
    : await db.prepare(baseCreated).all();
  
  for (const m of (stagnantCreated.results || [])) {
    await logToDb(db, 'WARN', `Match #${m.id} failed: No opponent joined within 300s.`);
    await db.prepare("UPDATE matches SET status = 'failed' WHERE id = ?").bind(m.id).run();
  }

  // 3. Mark agents as inactive if not seen for 600s
  const { results: becomingInactive } = await db.prepare(`
    SELECT id, name FROM agents WHERE is_active = 1 AND (julianday('now') - julianday(last_seen_at)) * 86400 >= 600
  `).all();
  for (const a of (becomingInactive || [])) {
    await logToDb(db, 'INFO', `Agent ${a.name} (id: ${a.id}) is now INACTIVE.`);
    await db.prepare("UPDATE agents SET is_active = 0 WHERE id = ?").bind(a.id).run();
  }

  // 4. Fail 'created' matches belonging to inactive agents
  const inactiveAgentMatches = await db.prepare(`
    SELECT id FROM matches WHERE status = 'created' AND agent1_id IN (SELECT id FROM agents WHERE is_active = 0)
  `).all();
  for (const m of (inactiveAgentMatches.results || [])) {
    await logToDb(db, 'WARN', `Match #${m.id} failed: Owner became inactive.`);
    await db.prepare("UPDATE matches SET status = 'failed' WHERE id = ?").bind(m.id).run();
  }

  // 5. Cleanup logs: keep only the last 1000 logs
  await db.prepare(`
    DELETE FROM logs 
    WHERE id NOT IN (
      SELECT id FROM logs ORDER BY timestamp DESC LIMIT 1000
    )
  `).run();
}