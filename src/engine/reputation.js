// Reputation engine — ELO (opponent-weighted strength) + behavioral metrics.
// Shared update logic called from BOTH matchController (happy path) and
// resolver (timeout/forfeit path). Do not duplicate this elsewhere.

export function calculateElo(playerElo, opponentElo, result, matchesPlayed) {
  const K = (matchesPlayed ?? 0) < 20 ? 32 : 16;
  const expected = 1 / (1 + Math.pow(10, (opponentElo - playerElo) / 400));
  return Math.round(playerElo + K * (result - expected));
}

// Determine per-agent result (1, 0.5, 0) for ELO from total match points.
// 'normal' = compare ledger sums; forfeits = explicit winner/loser.
async function resolveResults(db, matchId, agent1Id, agent2Id, outcome) {
  if (outcome === 'forfeit_agent1') return [0, 1];
  if (outcome === 'forfeit_agent2') return [1, 0];
  if (outcome === 'forfeit_both')   return [0.5, 0.5];

  // 'normal': compare total ledger points in this match
  const { results } = await db.prepare(
    `SELECT agent_id, SUM(score_change) AS total
       FROM ledger_entries
      WHERE match_id = ? AND agent_id IN (?, ?)
      GROUP BY agent_id`
  ).bind(matchId, agent1Id, agent2Id).all();

  const totals = new Map((results || []).map(r => [r.agent_id, r.total ?? 0]));
  const s1 = totals.get(agent1Id) ?? 0;
  const s2 = totals.get(agent2Id) ?? 0;
  if (s1 > s2) return [1, 0];
  if (s2 > s1) return [0, 1];
  return [0.5, 0.5];
}

// Update agent_stats cooperative/defect/betrayal counts for this match.
// betrayal_count  = agent defected while opponent cooperated (same round)
// been_betrayed   = agent cooperated while opponent defected (same round)
async function updateBehavioralCounts(db, matchId, agent1Id, agent2Id, outcome) {
  const ops = [];

  for (const [agentId, oppId] of [[agent1Id, agent2Id], [agent2Id, agent1Id]]) {
    // Single aggregate pass: counts per (action, opp_action) over all rounds in this match.
    const row = await db.prepare(`
      SELECT
        SUM(CASE WHEN a.action = 'cooperate' THEN 1 ELSE 0 END) AS coop,
        SUM(CASE WHEN a.action = 'defect'    THEN 1 ELSE 0 END) AS defct,
        SUM(CASE WHEN a.action = 'defect'    AND opp.action = 'cooperate' THEN 1 ELSE 0 END) AS betrayals,
        SUM(CASE WHEN a.action = 'cooperate' AND opp.action = 'defect'    THEN 1 ELSE 0 END) AS been_betrayed
      FROM actions a
      JOIN match_rounds mr ON mr.id = a.round_id AND mr.match_id = ?
      LEFT JOIN actions opp
        ON opp.round_id = a.round_id AND opp.agent_id = ?
      WHERE a.agent_id = ?
    `).bind(matchId, oppId, agentId).first();

    const coop    = row?.coop    ?? 0;
    const defct   = row?.defct   ?? 0;
    const betr    = row?.betrayals ?? 0;
    const beenb   = row?.been_betrayed ?? 0;

    ops.push(db.prepare(`
      UPDATE agent_stats
         SET cooperate_count    = cooperate_count    + ?,
             defect_count       = defect_count       + ?,
             betrayal_count     = betrayal_count     + ?,
             been_betrayed_count = been_betrayed_count + ?,
             updated_at         = CURRENT_TIMESTAMP
       WHERE agent_id = ?
    `).bind(coop, defct, betr, beenb, agentId));
  }

  if (ops.length) await db.batch(ops);
}

// Increment match counters for both agents. Returns the post-update
// matches_completed values so the caller can check provisional graduation.
async function bumpMatchCounters(db, agent1Id, agent2Id, outcome) {
  const completedInc = outcome === 'normal' ? 1 : 0;

  // Only the forfeiting agent gets matches_forfeited++.
  // 'forfeit_both' (both 3-strikes simultaneously) increments both.
  let a1ForfeitInc = 0, a2ForfeitInc = 0;
  if (outcome === 'forfeit_agent1') a1ForfeitInc = 1;
  else if (outcome === 'forfeit_agent2') a2ForfeitInc = 1;
  else if (outcome === 'forfeit_both') { a1ForfeitInc = 1; a2ForfeitInc = 1; }

  await db.batch([
    db.prepare(`
      UPDATE agent_stats
         SET matches_played    = matches_played + 1,
             matches_completed = matches_completed + ?,
             matches_forfeited = matches_forfeited + ?,
             last_match_at     = CURRENT_TIMESTAMP,
             updated_at        = CURRENT_TIMESTAMP
       WHERE agent_id = ?
    `).bind(completedInc, a1ForfeitInc, agent1Id),
    db.prepare(`
      UPDATE agent_stats
         SET matches_played    = matches_played + 1,
             matches_completed = matches_completed + ?,
             matches_forfeited = matches_forfeited + ?,
             last_match_at     = CURRENT_TIMESTAMP,
             updated_at        = CURRENT_TIMESTAMP
       WHERE agent_id = ?
    `).bind(completedInc, a2ForfeitInc, agent2Id),
  ]);
}

// Apply ELO update + record elo_history. K-factor uses the pre-match
// matches_played passed in from updateReputationAfterMatch (must be read
// before bumpMatchCounters runs, otherwise the 20-match boundary is off-by-one).
async function applyEloUpdate(db, matchId, agent1Id, agent2Id, result1, result2, preMp1, preMp2) {
  const [a1, a2] = await db.batch([
    db.prepare('SELECT elo FROM agents WHERE id = ?').bind(agent1Id),
    db.prepare('SELECT elo FROM agents WHERE id = ?').bind(agent2Id),
  ]);
  const elo1 = a1.results?.[0]?.elo ?? 1000;
  const elo2 = a2.results?.[0]?.elo ?? 1000;

  const newElo1 = calculateElo(elo1, elo2, result1, preMp1);
  const newElo2 = calculateElo(elo2, elo1, result2, preMp2);

  await db.batch([
    db.prepare('UPDATE agents SET elo = ? WHERE id = ?').bind(newElo1, agent1Id),
    db.prepare('UPDATE agents SET elo = ? WHERE id = ?').bind(newElo2, agent2Id),
    db.prepare(`INSERT INTO elo_history (agent_id, match_id, elo_before, elo_after, opponent_elo, result)
                VALUES (?, ?, ?, ?, ?, ?)`).bind(agent1Id, matchId, elo1, newElo1, elo2, result1),
    db.prepare(`INSERT INTO elo_history (agent_id, match_id, elo_before, elo_after, opponent_elo, result)
                VALUES (?, ?, ?, ?, ?, ?)`).bind(agent2Id, matchId, elo2, newElo2, elo1, result2),
  ]);
}

// Flip is_provisional → false once matches_completed reaches 20.
// Per spec: single UPDATE guarded by current is_provisional = true.
async function checkProvisionalGraduation(db, agentId) {
  await db.prepare(`
    UPDATE agents
       SET is_provisional = false
     WHERE id = ?
       AND is_provisional = true
       AND (SELECT matches_completed FROM agent_stats WHERE agent_id = ?) >= 20
  `).bind(agentId, agentId).run();
}

// Single entry point called from BOTH resolution paths.
// outcome: 'normal' | 'forfeit_agent1' | 'forfeit_agent2' | 'forfeit_both'
export async function updateReputationAfterMatch(db, matchId, agent1Id, agent2Id, outcome) {
  // Snapshot pre-match matches_played for the K-factor (spec: K=32 if matchesPlayed<20).
  // Read BEFORE bumpMatchCounters so the boundary is correct at the 20th match.
  const [mp1Row, mp2Row] = await db.batch([
    db.prepare('SELECT matches_played FROM agent_stats WHERE agent_id = ?').bind(agent1Id),
    db.prepare('SELECT matches_played FROM agent_stats WHERE agent_id = ?').bind(agent2Id),
  ]);
  const preMp1 = mp1Row.results?.[0]?.matches_played ?? 0;
  const preMp2 = mp2Row.results?.[0]?.matches_played ?? 0;

  const [result1, result2] = await resolveResults(db, matchId, agent1Id, agent2Id, outcome);

  // Behavioral metrics always apply (even on forfeit, the partial rounds the
  // agent did play still count toward cooperator/defector rates).
  await updateBehavioralCounts(db, matchId, agent1Id, agent2Id, outcome);

  // Match counters first so K-factor uses pre-this-match matches_played.
  await bumpMatchCounters(db, agent1Id, agent2Id, outcome);

  await applyEloUpdate(db, matchId, agent1Id, agent2Id, result1, result2, preMp1, preMp2);

  await checkProvisionalGraduation(db, agent1Id);
  await checkProvisionalGraduation(db, agent2Id);
}