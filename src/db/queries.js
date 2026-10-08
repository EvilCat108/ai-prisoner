// Fetch all active matches with their current round and live scores.
// Also surfaces the current phase and the latest negotiation message so
// the arena lobby can render a phase pill + snippet per match.
export async function getOngoingMatches(db) {
  const { results } = await db.prepare(`
    SELECT
      m.id,
      m.agent1_id, a1.name as agent1_name,
      m.agent2_id, a2.name as agent2_name,
      (SELECT MAX(round_number) FROM match_rounds WHERE match_id = m.id) as current_round,
      COALESCE((SELECT SUM(score_change) FROM ledger_entries WHERE match_id = m.id AND agent_id = m.agent1_id), 0) as agent1_score,
      COALESCE((SELECT SUM(score_change) FROM ledger_entries WHERE match_id = m.id AND agent_id = m.agent2_id), 0) as agent2_score,
      mr.phase as current_phase,
      mr.round_started_at as current_round_started_at,
      lm.message as latest_negotiation_msg,
      lm.sent_at as latest_negotiation_at,
      lm.author_id as latest_negotiation_author_id,
      lm.author_name as latest_negotiation_author_name
    FROM matches m
    JOIN agents a1 ON m.agent1_id = a1.id
    JOIN agents a2 ON m.agent2_id = a2.id
    JOIN match_rounds mr ON mr.match_id = m.id
    LEFT JOIN (
      SELECT rm.round_id, rm.message, rm.sent_at, rm.agent_id AS author_id, a.name AS author_name
        FROM round_messages rm
        JOIN agents a ON a.id = rm.agent_id
       WHERE (rm.round_id, rm.sent_at) IN (
         SELECT round_id, MAX(sent_at) FROM round_messages GROUP BY round_id
       )
    ) lm ON lm.round_id = mr.id
    WHERE m.status = 'active'
      AND mr.round_number = (SELECT MAX(round_number) FROM match_rounds WHERE match_id = m.id)
      AND (julianday('now') - julianday(mr.round_started_at)) * 86400 < 300
    ORDER BY m.id DESC
  `).all();
  return results || [];
}

export async function getMatchReplay(db, matchId, viewerAgentId = null) {
  const match = await db.prepare(`
    SELECT m.id, m.status, m.created_at, m.agent1_id, m.agent2_id,
           a1.name as agent1_name, a2.name as agent2_name,
           COALESCE((SELECT MAX(round_number) FROM match_rounds WHERE match_id = m.id), 0) as current_round
    FROM matches m
    LEFT JOIN agents a1 ON m.agent1_id = a1.id
    LEFT JOIN agents a2 ON m.agent2_id = a2.id
    WHERE m.id = ?
  `).bind(matchId).first();

  if (!match) return null;

  // Per-round metadata (phase, decision_started_at) — separate from action rows.
  const { results: roundMeta } = await db.prepare(`
    SELECT id, round_number, phase, round_started_at, decision_started_at
      FROM match_rounds
     WHERE match_id = ?
     ORDER BY round_number ASC
  `).bind(matchId).all();

  const { results: rows } = await db.prepare(`
    SELECT r.round_number, a.agent_id, a.action, a.is_auto, a.response_time_ms, a.submitted_at, a.message, l.score_change
    FROM match_rounds r
    LEFT JOIN actions a ON r.id = a.round_id
    LEFT JOIN ledger_entries l
      ON l.match_id = r.match_id AND l.agent_id = a.agent_id
      AND l.reason = 'Round ' || r.round_number
    WHERE r.match_id = ?
    ORDER BY r.round_number ASC, a.agent_id ASC
  `).bind(matchId).all();

  const roundsMap = {};
  for (const row of (rows || [])) {
    if (!roundsMap[row.round_number]) {
      roundsMap[row.round_number] = {
        round_number: row.round_number,
        actions: [],
        payoffs: [],
        negotiation: [],
        phase: null,
        round_started_at: null,
        decision_started_at: null,
      };
    }

    if (row.agent_id != null && row.action) {
      roundsMap[row.round_number].actions.push({
        agent_id: row.agent_id, action: row.action, auto: !!row.is_auto,
        response_time_ms: row.response_time_ms, submitted_at: row.submitted_at,
        message: row.message || null
      });
    }
    if (row.agent_id != null && row.score_change != null) {
      roundsMap[row.round_number].payoffs.push({
        agent_id: row.agent_id, score_change: row.score_change
      });
    }
  }

  // Fill in round metadata + negotiation messages
  for (const rm of (roundMeta || [])) {
    const slot = roundsMap[rm.round_number] || {
      round_number: rm.round_number, actions: [], payoffs: [], negotiation: [],
    };
    slot.phase = rm.phase;
    slot.round_started_at = rm.round_started_at;
    slot.decision_started_at = rm.decision_started_at;
    roundsMap[rm.round_number] = slot;
  }

  const roundIds = (roundMeta || []).map(r => r.id);
  if (roundIds.length > 0) {
    const placeholders = roundIds.map(() => '?').join(',');
    const { results: msgs } = await db.prepare(
      `SELECT round_id, agent_id, message, sent_at
         FROM round_messages
        WHERE round_id IN (${placeholders})
        ORDER BY round_id ASC, sent_at ASC`
    ).bind(...roundIds).all();
    for (const m of (msgs || [])) {
      const roundNumber = (roundMeta || []).find(r => r.id === m.round_id)?.round_number;
      if (roundNumber == null) continue;
      if (!roundsMap[roundNumber]) continue;
      roundsMap[roundNumber].negotiation.push({
        agent_id: m.agent_id, message: m.message, sent_at: m.sent_at,
      });
    }
  }

  const { results: scores } = await db.prepare(
    'SELECT agent_id, SUM(score_change) as total_score FROM ledger_entries WHERE match_id = ? GROUP BY agent_id'
  ).bind(matchId).all();

  return {
    ...match,
    rounds: Object.values(roundsMap),
    final_scores: scores || [],
    // Convenience: surface the current (latest) round's phase at the top level
    // so clients don't have to dig into rounds[rounds.length-1].
    current_phase: roundsMap[match.current_round]?.phase ?? null,
    current_decision_started_at: roundsMap[match.current_round]?.decision_started_at ?? null,
  };
}

// Helper: get the latest round's phase + decision_started_at for a match.
export async function getCurrentRound(db, matchId) {
  return db.prepare(`
    SELECT id, round_number, phase, round_started_at, decision_started_at
      FROM match_rounds
     WHERE match_id = ?
     ORDER BY round_number DESC
     LIMIT 1
  `).bind(matchId).first();
}

export async function getMatchContext(db, matchId) {
  const scores = await db.prepare(`
    SELECT agent_id, SUM(score_change) as total
    FROM ledger_entries WHERE match_id = ?
    GROUP BY agent_id
  `).bind(matchId).all();

  const { results: rounds } = await db.prepare(`
    SELECT mr.round_number, a.agent_id, a.action, a.is_auto, a.message, l.score_change
    FROM match_rounds mr
    JOIN actions a ON a.round_id = mr.id
    LEFT JOIN ledger_entries l ON l.match_id = mr.match_id AND l.agent_id = a.agent_id AND l.reason = 'Round ' || mr.round_number
    WHERE mr.match_id = ?
    ORDER BY mr.round_number DESC
    LIMIT 6
  `).bind(matchId).all();

  let context = 'SCORES:';
  for (const s of (scores.results || [])) {
    context += ` agent_${s.agent_id}=${s.total}`;
  }

  context += '\nLAST_ROUNDS:';
  for (const r of (rounds || [])) {
    context += ` R${r.round_number}:a${r.agent_id}=${r.action}(pts=${r.score_change ?? '?'},auto=${r.is_auto},msg=${r.message || '-'})`;
  }

  return context;
}
