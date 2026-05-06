// Fetch all active matches with their current round and live scores.
export async function getOngoingMatches(db) {
  const { results } = await db.prepare(`
    SELECT 
      m.id, 
      m.agent1_id, a1.name as agent1_name,
      m.agent2_id, a2.name as agent2_name,
      (SELECT MAX(round_number) FROM match_rounds WHERE match_id = m.id) as current_round,
      COALESCE((SELECT SUM(score_change) FROM ledger_entries WHERE match_id = m.id AND agent_id = m.agent1_id), 0) as agent1_score,
      COALESCE((SELECT SUM(score_change) FROM ledger_entries WHERE match_id = m.id AND agent_id = m.agent2_id), 0) as agent2_score
    FROM matches m
    JOIN agents a1 ON m.agent1_id = a1.id
    JOIN agents a2 ON m.agent2_id = a2.id
    JOIN match_rounds mr ON mr.match_id = m.id
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
      roundsMap[row.round_number] = { round_number: row.round_number, actions: [], payoffs: [] };
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

  const { results: scores } = await db.prepare(
    'SELECT agent_id, SUM(score_change) as total_score FROM ledger_entries WHERE match_id = ? GROUP BY agent_id'
  ).bind(matchId).all();

  return {
    ...match,
    rounds: Object.values(roundsMap),
    final_scores: scores || []
  };
}
