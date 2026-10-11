import { updateReputationAfterMatch } from './reputation.js';

export function calculatePayoff(myAction, opponentAction) {
  if (myAction === 'cooperate' && opponentAction === 'cooperate') return [3, 3];
  if (myAction === 'cooperate' && opponentAction === 'defect')    return [0, 5];
  if (myAction === 'defect'    && opponentAction === 'cooperate') return [5, 0];
  return [1, 1];
}

export async function resolveTimedOutMatch(env, db, matchId, agent1Id, agent2Id, roundId, roundNumber, broadcastSSE, logToDb) {
  // Guard: if payoffs exist another Worker already resolved this round
  const alreadyResolved = await db.prepare(
    "SELECT id FROM ledger_entries WHERE match_id = ? AND reason = ? LIMIT 1"
  ).bind(matchId, `Round ${roundNumber}`).first();
  if (alreadyResolved) return;

  // Determine which agents actually submitted an action this round.
  // No more auto-defect insert — a missing row means a missed round.
  const { results: submitted } = await db.prepare(
    'SELECT agent_id, action FROM actions WHERE round_id = ?'
  ).bind(roundId).all();
  const submittedIds = new Set((submitted || []).map(s => s.agent_id));
  const a1Failed = !submittedIds.has(agent1Id);
  const a2Failed = !submittedIds.has(agent2Id);

  // Payoff under the new rule:
  //   - both submitted: standard matrix
  //   - one failed: failing agent = 0; opponent gets R=3 (if opp cooperated)
  //     or T=5 (if opp defected) — as if the failing agent had cooperated
  //   - both failed: 0/0
  let p1, p2;
  if (a1Failed && a2Failed) {
    p1 = 0; p2 = 0;
  } else if (a1Failed) {
    p1 = 0;
    const a2act = submitted.find(s => s.agent_id === agent2Id).action;
    p2 = a2act === 'defect' ? 5 : 3;
  } else if (a2Failed) {
    p2 = 0;
    const a1act = submitted.find(s => s.agent_id === agent1Id).action;
    p1 = a1act === 'defect' ? 5 : 3;
  } else {
    const a1act = submitted.find(s => s.agent_id === agent1Id).action;
    const a2act = submitted.find(s => s.agent_id === agent2Id).action;
    [p1, p2] = calculatePayoff(a1act, a2act);
  }
  const reason = `Round ${roundNumber}`;

  // Fetch match details to get termination_prob
  const match = await db.prepare("SELECT termination_prob FROM matches WHERE id = ?").bind(matchId).first();

  const ops = [
    db.prepare('INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, ?, ?)').bind(matchId, agent1Id, p1, reason),
    db.prepare('INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, ?, ?)').bind(matchId, agent2Id, p2, reason),
  ];

  // Three-Strike Forfeit Check
  // A "strike" is a round where this agent has no action row at all.
  // Only an agent that failed THIS round can be newly on a 3-streak.
  const checkThreeStrikes = async (agentId) => {
    const { results: last3 } = await db.prepare(`
      SELECT mr.round_number
      FROM match_rounds mr
      WHERE mr.match_id = ?
        AND mr.round_number IN (
          SELECT round_number FROM match_rounds
          WHERE match_id = ? ORDER BY round_number DESC LIMIT 3
        )
        AND NOT EXISTS (
          SELECT 1 FROM actions a
          WHERE a.round_id = mr.id AND a.agent_id = ?
        )
    `).bind(matchId, matchId, agentId).all();
    return (last3 && last3.length === 3);
  };

  const a1Strike = a1Failed ? await checkThreeStrikes(agent1Id) : false;
  const a2Strike = a2Failed ? await checkThreeStrikes(agent2Id) : false;

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
      ops.push(db.prepare("INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, ?, ?)").bind(matchId, agent1Id, 0, "Forfeit Penalty"));
      ops.push(db.prepare("INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, ?, ?)").bind(matchId, agent2Id, 0, "Forfeit Penalty"));
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
        db.prepare("INSERT OR IGNORE INTO match_rounds (match_id, round_number, round_started_at, phase) VALUES (?, ?, CURRENT_TIMESTAMP, 'negotiating')")
          .bind(matchId, roundNumber + 1)
      );
      nextStateEvent = 'round_advanced';
    }
  }

  await db.batch(ops);

  // Reputation update — single source of truth via updateReputationAfterMatch.
  // Skip round_advanced (match continues); only update on terminal states.
  if (nextStateEvent === 'match_completed') {
    await updateReputationAfterMatch(db, matchId, agent1Id, agent2Id, 'normal');
  } else if (nextStateEvent === 'match_failed') {
    if (a1Strike && a2Strike) {
      await updateReputationAfterMatch(db, matchId, agent1Id, agent2Id, 'forfeit_both');
    } else if (a1Strike) {
      await updateReputationAfterMatch(db, matchId, agent1Id, agent2Id, 'forfeit_agent1');
    } else if (a2Strike) {
      await updateReputationAfterMatch(db, matchId, agent1Id, agent2Id, 'forfeit_agent2');
    }
  }

  // DO timeout management: set alarm for next round, clear on end.
  if (nextStateEvent === 'round_advanced') {
    try {
      const doId = env.UMPIRE.idFromName('umpire-singleton');
      const doObj = env.UMPIRE.get(doId);
      doObj.fetch(new Request('http://do/timeout/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_id: matchId, expire_time: Date.now() + 30000 }),
      })).catch(e => console.error('[Worker] setMatchTimeout failed:', e?.message));
    } catch (_) { /* non-critical */ }
  } else if (nextStateEvent === 'match_failed' || nextStateEvent === 'match_completed') {
    try {
      const doId = env.UMPIRE.idFromName('umpire-singleton');
      const doObj = env.UMPIRE.get(doId);
      doObj.fetch(new Request('http://do/timeout/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_id: matchId }),
      })).catch(() => {});
    } catch (_) { /* non-critical */ }
  }

  await broadcastSSE(env, nextStateEvent, { match_id: matchId, round: nextStateEvent === 'round_advanced' ? roundNumber + 1 : roundNumber });
}

export async function resolveTimedOutRounds(env, db, specificMatchId = null, broadcastSSE, logToDb) {
  // 0. Advance 'negotiating' rounds that have exceeded the 20s negotiation window.
  // Only target the LATEST round of each match; older rounds are historical.
  // decision_started_at is set to (round_started_at + 20s) so the 30s decision
  // window measures the time SINCE negotiation ended, not from the moment of
  // auto-advance. If a round has been in 'negotiating' for >30s (past the
  // decision window too), clamp decision_started_at to round_started_at so the
  // next step's 30s check fires immediately.
  const negBase = `
    SELECT mr.id AS round_id, mr.round_number, mr.round_started_at, m.id AS match_id
      FROM matches m
      JOIN match_rounds mr ON mr.match_id = m.id
     WHERE m.status = 'active'
       AND mr.round_number = (SELECT MAX(round_number) FROM match_rounds WHERE match_id = m.id)
       AND mr.phase = 'negotiating'
       AND mr.round_started_at IS NOT NULL
       AND (julianday('now') - julianday(mr.round_started_at)) * 86400 >= 20
  `;
  const negQuery = specificMatchId != null ? `${negBase} AND m.id = ?` : negBase;
  const negStmt = db.prepare(negQuery);
  const { results: negResults } = specificMatchId != null
    ? await negStmt.bind(specificMatchId).all()
    : await negStmt.all();
  for (const r of (negResults || [])) {
    // If the round is already past the 30s decision window, treat the
    // decision phase as having started at round_started_at (so the next
    // step's 30s check fires immediately). Otherwise start the decision
    // phase at round_started_at + 20s (= when negotiation should have ended).
    const upd = await db.prepare(
      `UPDATE match_rounds
          SET phase = 'deciding',
              decision_started_at = CASE
                WHEN (julianday('now') - julianday(round_started_at)) * 86400 >= 30
                THEN round_started_at
                ELSE datetime(round_started_at, '+20 seconds')
              END
        WHERE id = ? AND phase = 'negotiating'`
    ).bind(r.round_id).run();
    if ((upd?.meta?.changes ?? 0) > 0) {
      await broadcastSSE(env, 'phase_advanced', { match_id: r.match_id, round: r.round_number, phase: 'deciding' });
    }
  }

  // 1. Resolve active matches with timed-out rounds (30s) or where both agents have submitted.
  // Timeout baseline: decision_started_at when present (new rounds), else round_started_at (old rounds).
  const baseActive = `
    SELECT m.id AS match_id, m.agent1_id, m.agent2_id, mr.id AS round_id, mr.round_number
    FROM matches m
    JOIN match_rounds mr ON mr.match_id = m.id
    WHERE m.status = 'active'
      AND mr.round_number = (SELECT MAX(round_number) FROM match_rounds WHERE match_id = m.id)
      AND mr.round_started_at IS NOT NULL
      AND (
        (julianday('now') - julianday(COALESCE(mr.decision_started_at, mr.round_started_at))) * 86400 >= 30
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

  // 1b. Fail 'active' matches that are stagnant (no moves for 60s)
  const stagnantActive = await db.prepare(`
    SELECT m.id FROM matches m
    JOIN match_rounds mr ON mr.match_id = m.id
    WHERE m.status = 'active'
      AND mr.round_number = (SELECT MAX(round_number) FROM match_rounds WHERE match_id = m.id)
      AND (julianday('now') - julianday(mr.round_started_at)) * 86400 >= 60
  `).all();
  for (const m of (stagnantActive.results || [])) {
    await logToDb(db, 'ERROR', `Match #${m.id} failed due to stagnation (60s).`);
    await db.prepare("UPDATE matches SET status = 'failed' WHERE id = ?").bind(m.id).run();
    await broadcastSSE(env, 'match_failed', { match_id: m.id });
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
    await broadcastSSE(env, 'match_failed', { match_id: m.id });
  }

  // 1d. Clean up match_queue (remove agents not seen in 30s)
  await db.prepare(`
    DELETE FROM match_queue 
    WHERE agent_id IN (
      SELECT id FROM agents 
      WHERE (julianday('now') - julianday(last_seen_at)) * 86400 >= 30
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
    await broadcastSSE(env, 'match_failed', { match_id: m.id });
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
    await broadcastSSE(env, 'match_failed', { match_id: m.id });
  }

  // 5. Cleanup logs: keep only the last 1000 logs
  await db.prepare(`
    DELETE FROM logs 
    WHERE id NOT IN (
      SELECT id FROM logs ORDER BY timestamp DESC LIMIT 1000
    )
  `).run();
}