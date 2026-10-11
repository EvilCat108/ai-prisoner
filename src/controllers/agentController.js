import { json, err, logToDb, broadcastSSE } from '../utils/helpers.js';
import { generateApiKey, hashApiKey, authenticate } from '../utils/auth.js';
import { resolveTimedOutRounds } from '../engine/resolver.js';
import { html } from '../ui/templates.js';
import * as templates from '../ui/templates.js';

export async function handleRegisterAgent(request, env, db) {
  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400); }
  const name = body.name ?? '';
  if (!name) return err('Name is required', 400);
  if (name.length > 100) return err('Name too long (max 100 chars)', 400);
  if (name !== name.trim()) return err('Name must not have leading or trailing whitespace', 400);

  const apiKey = generateApiKey();
  const hash = await hashApiKey(apiKey);
  try {
    const result = await db.prepare(
      'INSERT INTO agents (name, api_key_hash, is_active, is_system) VALUES (?, ?, 1, ?)'
    ).bind(name, hash, name === 'The Umpire' ? 1 : 0).run();
    const agent = await db.prepare(
      'SELECT id, name, is_active, created_at FROM agents WHERE id = ?'
    ).bind(result.meta.last_row_id).first();
    await db.prepare('INSERT OR IGNORE INTO agent_stats (agent_id) VALUES (?)').bind(agent.id).run();
    await logToDb(db, 'INFO', `New agent registered: ${name} (id: ${agent.id})`);
    return json({ agent, api_key: apiKey });
  } catch (e) {
    if (e.message && e.message.includes('UNIQUE')) {
      return err('Agent name already taken', 409);
    }
    throw e;
  }
}

export async function handleGetAgents(request, env, db, wantsJson) {
  await resolveTimedOutRounds(env, db, null, broadcastSSE, logToDb);
  const { results } = await db.prepare(
    'SELECT id, name, is_active, created_at FROM agents ORDER BY name ASC'
  ).all();
  if (wantsJson) return json(results || []);
  const rows = (results || []).map(a =>
    `<tr><td>${a.name}</td><td>${a.is_active ? 'Yes' : 'No'}</td><td>${a.created_at}</td></tr>`
  ).join('') || '<tr><td colspan="3"><em>No agents registered yet.</em></td></tr>';
  return html(templates.agentsTemplate(rows), 'Agents');
}

export async function handleQueueJoin(request, env, db) {
  const agent = await authenticate(request, db);
  if (!agent) return err('Unauthorized', 401);

  const existingMatch = await db.prepare(`
    SELECT id FROM matches
    WHERE status = 'active' AND (agent1_id = ? OR agent2_id = ?)
    ORDER BY id DESC LIMIT 1
  `).bind(agent.id, agent.id).first();

  if (existingMatch) {
    await db.prepare('DELETE FROM match_queue WHERE agent_id = ?').bind(agent.id).run();
    return json({ match_id: existingMatch.id, status: 'active' });
  }

  await db.prepare('INSERT OR IGNORE INTO match_queue (agent_id) VALUES (?)').bind(agent.id).run();
  await broadcastSSE(env, 'queue_updated', { agent_id: agent.id });

  const meRow = await db.prepare('SELECT id, elo, is_provisional FROM agents WHERE id = ?').bind(agent.id).first();
  const myElo = meRow?.elo ?? 1000;
  const myProvisional = meRow?.is_provisional ? 1 : 0;

  const isMatchAcceptable = async (otherId) => {
    const recent = await db.prepare(`
      SELECT id FROM matches
      WHERE ((agent1_id = ? AND agent2_id = ?) OR (agent1_id = ? AND agent2_id = ?))
      ORDER BY created_at DESC LIMIT 3
    `).bind(agent.id, otherId, otherId, agent.id).all();
    return (recent.results || []).length === 0;
  };

  const tryCreateMatch = async (otherId) => {
    if (!(await isMatchAcceptable(otherId))) return null;

    const terminationProb = 0.02;
    const result = await db.batch([
      db.prepare("INSERT INTO matches (agent1_id, agent2_id, status, termination_prob) VALUES (?, ?, 'active', ?)")
        .bind(agent.id, otherId, terminationProb),
      db.prepare("DELETE FROM match_queue WHERE agent_id IN (?, ?)").bind(agent.id, otherId),
    ]);

    const matchId = result[0].meta.last_row_id;
    await db.prepare("INSERT INTO match_rounds (match_id, round_number, round_started_at, phase) VALUES (?, 1, CURRENT_TIMESTAMP, 'negotiating')")
      .bind(matchId).run();

    await logToDb(db, 'INFO', `Match created via queue: #${matchId} (${agent.id} vs ${otherId})`);
    await broadcastSSE(env, 'match_started', { match_id: matchId });

    try {
      const doId = env.UMPIRE.idFromName('umpire-singleton');
      const doObj = env.UMPIRE.get(doId);
      doObj.fetch(new Request('http://do/timeout/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_id: matchId, expire_time: Date.now() + 30000 }),
      })).catch(() => {});
    } catch (_) { /* non-critical */ }

    return json({ match_id: matchId, status: 'active' });
  };

  // Pass 1 — strict band: provisional↔provisional, non-provisional within ±150 ELO.
  // Candidates must also have last_seen ≤ 15s.
  const strictWhere = `
    mq.agent_id != ?
      AND (julianday('now') - julianday(a.last_seen_at)) * 86400 <= 15
      AND (
        (? = 1 AND a.is_provisional = 1)
        OR
        (? = 0 AND a.is_provisional = 0
            AND a.elo BETWEEN ? - 150 AND ? + 150)
      )
  `;
  const { results: strictCandidates } = await db.prepare(`
    SELECT mq.agent_id, mq.entered_at
      FROM match_queue mq
      JOIN agents a ON mq.agent_id = a.id
     WHERE ${strictWhere}
     ORDER BY mq.entered_at ASC
  `).bind(agent.id, myProvisional, myProvisional, myElo, myElo).all();

  for (const cand of (strictCandidates || [])) {
    const resp = await tryCreateMatch(cand.agent_id);
    if (resp) return resp;
  }

  // Pass 2 — expanded band: if either party has been waiting >60s, allow ±300 ELO.
  // Provisionals still only pair with provisionals (no ELO climb for new bots).
  const expandedWhere = `
    mq.agent_id != ?
      AND (julianday('now') - julianday(mq.entered_at)) * 86400 > 60
      AND (julianday('now') - julianday(a.last_seen_at)) * 86400 <= 15
      AND (
        (? = 1 AND a.is_provisional = 1)
        OR
        (? = 0 AND a.is_provisional = 0
            AND a.elo BETWEEN ? - 300 AND ? + 300)
      )
  `;
  const { results: expandedCandidates } = await db.prepare(`
    SELECT mq.agent_id, mq.entered_at
      FROM match_queue mq
      JOIN agents a ON mq.agent_id = a.id
     WHERE ${expandedWhere}
     ORDER BY mq.entered_at ASC
  `).bind(agent.id, myProvisional, myProvisional, myElo, myElo).all();

  for (const cand of (expandedCandidates || [])) {
    const resp = await tryCreateMatch(cand.agent_id);
    if (resp) return resp;
  }

    return json({ message: 'Added to queue', status: 'queued' });
}
