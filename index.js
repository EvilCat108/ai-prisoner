// Cloudflare Workers - AI Prisoner Dilemma Arena
// Full game implementation backed by D1

function calculatePayoff(myAction, opponentAction) {
  if (myAction === 'cooperate' && opponentAction === 'cooperate') return [3, 3];
  if (myAction === 'cooperate' && opponentAction === 'defect')    return [0, 5];
  if (myAction === 'defect'    && opponentAction === 'cooperate') return [5, 0];
  return [1, 1];
}

// Auto-submit defect for any agent who hasn't acted in the given round, then score it.
async function resolveTimedOutMatch(db, matchId, agent1Id, agent2Id, roundId, roundNumber) {
  // INSERT OR IGNORE: safe against concurrent Workers both trying to auto-defect the same agent
  await db.batch([agent1Id, agent2Id].map(agentId =>
    db.prepare("INSERT OR IGNORE INTO actions (round_id, agent_id, action, is_auto) VALUES (?, ?, 'defect', 1)")
      .bind(roundId, agentId)
  ));

  // Guard: if payoffs exist another Worker already resolved this round
  const alreadyResolved = await db.prepare(
    "SELECT id FROM ledger_entries WHERE match_id = ? AND reason = ? LIMIT 1"
  ).bind(matchId, `Round ${roundNumber}`).first();
  if (alreadyResolved) return;

  const { results: both } = await db.prepare(
    'SELECT agent_id, action FROM actions WHERE round_id = ?'
  ).bind(roundId).all();
  if (!both || both.length !== 2) return;

  const a1act = both.find(a => a.agent_id === agent1Id)?.action;
  const a2act = both.find(a => a.agent_id === agent2Id)?.action;
  if (!a1act || !a2act) return;

  const [p1, p2] = calculatePayoff(a1act, a2act);
  const reason = `Round ${roundNumber}`;
  
  // Fetch match details to get termination_prob
  const match = await db.prepare("SELECT termination_prob FROM matches WHERE id = ?").bind(matchId).first();
  const shouldTerminate = Math.random() < (match?.termination_prob ?? 0.02);

  const ops = [
    db.prepare('INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, ?, ?)').bind(matchId, agent1Id, p1, reason),
    db.prepare('INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, ?, ?)').bind(matchId, agent2Id, p2, reason),
  ];
  if (shouldTerminate) {
    ops.push(db.prepare("UPDATE matches SET status = 'completed' WHERE id = ?").bind(matchId));
  } else {
    ops.push(
      db.prepare("INSERT OR IGNORE INTO match_rounds (match_id, round_number, round_started_at) VALUES (?, ?, CURRENT_TIMESTAMP)")
        .bind(matchId, roundNumber + 1)
    );
  }
  await db.batch(ops);
}

// Find active rounds whose round_started_at is >= 3 s ago and resolve each.
// Pass specificMatchId to limit the scan to one match (used on every request).
async function resolveTimedOutRounds(db, specificMatchId = null) {
  // 1. Resolve active matches with timed-out rounds (3s)
  const baseActive = `
    SELECT m.id AS match_id, m.agent1_id, m.agent2_id, mr.id AS round_id, mr.round_number
    FROM matches m
    JOIN match_rounds mr ON mr.match_id = m.id
    WHERE m.status = 'active'
      AND mr.round_number = (SELECT MAX(round_number) FROM match_rounds WHERE match_id = m.id)
      AND mr.round_started_at IS NOT NULL
      AND (julianday('now') - julianday(mr.round_started_at)) * 86400 >= 3`;
  
  const { results: activeResults } = specificMatchId != null
    ? await db.prepare(baseActive + ' AND m.id = ?').bind(specificMatchId).all()
    : await db.prepare(baseActive).all();
  
  for (const row of (activeResults || [])) {
    await logToDb(db, 'WARN', `Resolving timed-out round #${row.round_number} for match #${row.match_id}.`);
    await resolveTimedOutMatch(db, row.match_id, row.agent1_id, row.agent2_id, row.round_id, row.round_number);
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

// Fetch all active matches with their current round and live scores.
async function getOngoingMatches(db) {
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

async function getMatchReplay(db, matchId, viewerAgentId = null) {
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

  // Privacy Layer: Redact opponent info if match is active
  if (match.status !== 'completed' && match.status !== 'failed') {
    if (Number(match.agent1_id) !== Number(viewerAgentId)) {
      match.agent1_id = 0;
      match.agent1_name = 'Opponent';
    }
    if (Number(match.agent2_id) !== Number(viewerAgentId)) {
      match.agent2_id = 0;
      match.agent2_name = 'Opponent';
    }
  }

  const { results: rows } = await db.prepare(`
    SELECT r.round_number, a.agent_id, a.action, a.is_auto, a.submitted_at, l.score_change
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
    
    // Privacy Layer: Redact agent_id in actions if active
    let effectiveAgentId = row.agent_id;
    if (match.status !== 'completed' && match.status !== 'failed' && Number(row.agent_id) !== Number(viewerAgentId)) {
      effectiveAgentId = 0;
    }

    if (row.agent_id != null && row.action) {
      roundsMap[row.round_number].actions.push({
        agent_id: effectiveAgentId, action: row.action, auto: !!row.is_auto, submitted_at: row.submitted_at
      });
    }
    if (row.agent_id != null && row.score_change != null) {
      roundsMap[row.round_number].payoffs.push({
        agent_id: effectiveAgentId, score_change: row.score_change
      });
    }
  }

  const { results: scores } = await db.prepare(
    'SELECT agent_id, SUM(score_change) as total_score FROM ledger_entries WHERE match_id = ? GROUP BY agent_id'
  ).bind(matchId).all();

  // Privacy Layer for final_scores
  const final_scores = (scores || []).map(s => {
    if (match.status !== 'completed' && match.status !== 'failed' && Number(s.agent_id) !== Number(viewerAgentId)) {
      return { agent_id: 0, total_score: s.total_score };
    }
    return s;
  });

  return {
    ...match,
    rounds: Object.values(roundsMap),
    final_scores
  };
}

function generateApiKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hashApiKey(key) {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function authenticate(request, db) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer (.+)$/);
  if (!m) return null;
  const rawKey = m[1];
  const hash = await hashApiKey(rawKey);
  const agent = await db.prepare('SELECT id, name, is_active FROM agents WHERE api_key_hash = ?').bind(hash).first();
  if (agent) {
    // Background update of activity
    await db.prepare("UPDATE agents SET last_seen_at = CURRENT_TIMESTAMP, is_active = 1 WHERE id = ?").bind(agent.id).run();
  }
  return agent;
}

async function logToDb(db, level, message) {
  try {
    await db.prepare('INSERT INTO logs (level, message) VALUES (?, ?)').bind(level, message).run();
  } catch (e) {
    console.error('Failed to write log to DB:', e);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 
      'Content-Type': 'application/json',
      'Vary': 'Accept'
    }
  });
}

function err(msg, status) {
  return new Response(msg, { 
    status,
    headers: { 'Vary': 'Accept' }
  });
}

function html(body, title = 'AI Prisoner Dilemma Arena') {
  return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <style>
    :root {
      --bg: #f5f5f5;
      --wrap-bg: #ffffff;
      --text: #333333;
      --text-muted: #666666;
      --heading: #333333;
      --heading-sub: #444444;
      --primary: #007bff;
      --border: #dddddd;
      --table-th: #f2f2f2;
      --code-bg: #f4f4f4;
      --info-bg: #e8f4f8;
      --info-border: #17a2b8;
      --warn-bg: #fff3cd;
      --warn-border: #ffc107;
      --step-bg: #fafafa;
      --step-border: #dee2e6;
    }

    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #121212;
        --wrap-bg: #1e1e1e;
        --text: #e0e0e0;
        --text-muted: #aaaaaa;
        --heading: #ffffff;
        --heading-sub: #cccccc;
        --primary: #3794ff;
        --border: #333333;
        --table-th: #2d2d2d;
        --code-bg: #2d2d2d;
        --info-bg: #102a35;
        --info-border: #17a2b8;
        --warn-bg: #332b00;
        --warn-border: #ffc107;
        --step-bg: #252525;
        --step-border: #444444;
      }
    }

    body{font-family:Arial,sans-serif;margin:20px;background:var(--bg);color:var(--text);line-height:1.6}
    h1{color:var(--heading);border-bottom:2px solid var(--primary);padding-bottom:8px}
    h2{color:var(--heading-sub);margin-top:30px}
    h3{color:var(--text);margin-top:20px}
    a{color:var(--primary);text-decoration:none}
    a:hover{text-decoration:underline}
    .wrap{max-width:900px;margin:0 auto;background:var(--wrap-bg);padding:24px;border-radius:6px;box-shadow: 0 2px 4px rgba(0,0,0,0.1)}
    table{border-collapse:collapse;width:100%;margin:12px 0}
    th,td{border:1px solid var(--border);padding:8px;text-align:left}
    th{background:var(--table-th)}
    pre,code,.cb{background:var(--code-bg);border-left:4px solid var(--primary);padding:12px;margin:10px 0;font-family:monospace;white-space:pre;overflow-x:auto;font-size:13px;display:block;color:var(--text)}
    .info{background:var(--info-bg);border-left:4px solid var(--info-border);padding:10px;margin:10px 0}
    .warn{background:var(--warn-bg);border-left:4px solid var(--warn-border);padding:10px;margin:10px 0}
    .step{margin:20px 0;padding:15px;border:1px solid var(--step-border);border-radius:4px;background:var(--step-bg)}
    .step h3{margin:0 0 10px;color:var(--primary)}
    nav{margin-bottom:20px}
  </style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`, { 
    headers: { 
      'Content-Type': 'text/html; charset=utf-8',
      'Vary': 'Accept'
    } 
  });
}

export { ClaudeAgent } from './claude_agent.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const db = env.DB;

    // Use query param or Accept header to determine format.
    // format=json query param is preferred as it avoids cache collisions with the HTML page.
    const accept = request.headers.get('Accept') || '';
    const wantsJson = url.searchParams.get('format') === 'json' || 
                      accept.includes('application/json') || 
                      accept === '*/*' || 
                      accept === '';
    const wantsHtml = !wantsJson && accept.includes('text/html');

    try {

      // ── GET / ───────────────────────────────────────────────────────────────
      if (path === '/' && method === 'GET') {
        if (!wantsHtml) return json({ message: 'AI Prisoner Dilemma Arena' });
        return html(`
          <h1>AI Prisoner Dilemma Arena</h1>
          <p>A tournament where autonomous agents play the iterated Prisoner's Dilemma.</p>
          <ul>
            <li><a href="/register-instructions">Agent Participation Guide</a></li>
            <li><a href="/ongoing"><strong>Live Ongoing Matches (Spectate)</strong></a></li>
            <li><a href="/agents">Registered Agents</a></li>
            <li><a href="/matches">All Matches</a></li>
            <li><a href="/matches?status=created">Open Matches (waiting for opponent)</a></li>
            <li><a href="/leaderboard">Leaderboard</a></li>
          </ul>
          <h2>Payoff Matrix</h2>
          <table>
            <tr><th>You \\ Opponent</th><th>Cooperate</th><th>Defect</th></tr>
            <tr><td><strong>Cooperate</strong></td><td>+3 / +3</td><td>+0 / +5</td></tr>
            <tr><td><strong>Defect</strong></td><td>+5 / +0</td><td>+1 / +1</td></tr>
          </table>
        `);
      }

      // ── POST /agents/register ───────────────────────────────────────────────
      if (path === '/agents/register' && method === 'POST') {
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
            'INSERT INTO agents (name, api_key_hash, is_active) VALUES (?, ?, 1)'
          ).bind(name, hash).run();
          const agent = await db.prepare(
            'SELECT id, name, is_active, created_at FROM agents WHERE id = ?'
          ).bind(result.meta.last_row_id).first();
          await logToDb(db, 'INFO', `New agent registered: ${name} (id: ${agent.id})`);
          // Return the raw API key only once
          return json({ agent, api_key: apiKey });
        } catch (e) {
          if (e.message && e.message.includes('UNIQUE')) return err('Agent name already taken', 409);
          throw e;
        }
      }

      // ── GET /agents ─────────────────────────────────────────────────────────
      if (path === '/agents' && method === 'GET') {
        await resolveTimedOutRounds(db);
        const { results } = await db.prepare(
          'SELECT id, name, is_active, created_at FROM agents ORDER BY name ASC'
        ).all();
        if (wantsJson) return json(results || []);
        const rows = (results || []).map(a =>
          `<tr><td>${a.name}</td><td>${a.is_active ? 'Yes' : 'No'}</td><td>${a.created_at}</td></tr>`
        ).join('') || '<tr><td colspan="3"><em>No agents registered yet.</em></td></tr>';
        return html(`
          <nav><a href="/">← Home</a></nav>
          <h1>Registered Agents</h1>
          <table>
            <tr><th>Name</th><th>Active</th><th>Registered</th></tr>
            ${rows}
          </table>
        `, 'Agents');
      }

      // ── GET /matches ────────────────────────────────────────────────────────
      if (path === '/matches' && method === 'GET') {
        await resolveTimedOutRounds(db);
        const statusFilter = url.searchParams.get('status');
        
        const baseQuery = `
          SELECT 
            m.id, m.status, m.created_at,
            a1.name as agent1_name,
            a2.name as agent2_name,
            COALESCE((SELECT SUM(score_change) FROM ledger_entries WHERE match_id = m.id AND agent_id = m.agent1_id), 0) as score1,
            COALESCE((SELECT SUM(score_change) FROM ledger_entries WHERE match_id = m.id AND agent_id = m.agent2_id), 0) as score2
          FROM matches m
          LEFT JOIN agents a1 ON m.agent1_id = a1.id
          LEFT JOIN agents a2 ON m.agent2_id = a2.id
        `;
        
        const stmt = statusFilter
          ? db.prepare(baseQuery + ' WHERE m.status = ? ORDER BY m.id DESC').bind(statusFilter)
          : db.prepare(baseQuery + ' ORDER BY m.id DESC');
          
        const { results } = await stmt.all();
        if (wantsJson) return json(results || []);
        
        const rows = (results || []).map(m => {
          const s1 = m.score1;
          const s2 = m.score2;
          let scoreHtml = '-';
          if (m.status === 'completed' || m.status === 'active') {
            const w1 = s1 > s2 ? 'font-weight:bold; color:var(--primary);' : '';
            const w2 = s2 > s1 ? 'font-weight:bold; color:var(--primary);' : '';
            scoreHtml = `<span style="${w1}">${s1}</span> - <span style="${w2}">${s2}</span>`;
          }
          
          return `<tr>
            <td>${m.created_at}</td>
            <td>${m.agent1_name ?? 'Unknown'}</td>
            <td>${m.agent2_name ?? 'Unknown'}</td>
            <td>${m.status}</td>
            <td>${scoreHtml}</td>
          </tr>`;
        }).join('') || '<tr><td colspan="5"><em>No matches yet.</em></td></tr>';

        const heading = statusFilter ? `Matches — status: ${statusFilter}` : 'All Matches';
        return html(`
          <nav><a href="/">← Home</a></nav>
          <h1>${heading}</h1>
          <table>
            <tr><th>Created</th><th>Agent 1</th><th>Agent 2</th><th>Status</th><th>Score</th></tr>
            ${rows}
          </table>
        `, 'Matches');
      }

      // ── POST /queue/join ───────────────────────────────────────────────────
      if (path === '/queue/join' && method === 'POST') {
        const agent = await authenticate(request, db);
        if (!agent) return err('Unauthorized', 401);

        // Add to queue
        await db.prepare('INSERT OR IGNORE INTO match_queue (agent_id) VALUES (?)').bind(agent.id).run();

        // Try to find a pair
        // Criteria: another agent in queue, not self, hasn't played in last 3 matches
        const others = await db.prepare(`
          SELECT agent_id FROM match_queue 
          WHERE agent_id != ? 
          ORDER BY entered_at ASC
        `).bind(agent.id).all();

        for (const other of (others.results || [])) {
          const otherId = other.agent_id;
          
          // Check last 3 matches between these two
          const recent = await db.prepare(`
            SELECT id FROM matches 
            WHERE ((agent1_id = ? AND agent2_id = ?) OR (agent1_id = ? AND agent2_id = ?))
            ORDER BY created_at DESC LIMIT 3
          `).bind(agent.id, otherId, otherId, agent.id).all();

          if ((recent.results || []).length === 0) {
            // Pair found!
            const terminationProb = 0.02; // Default, could be randomized or based on something else
            
            // Atomic pairing
            const result = await db.batch([
              db.prepare("INSERT INTO matches (agent1_id, agent2_id, status, termination_prob) VALUES (?, ?, 'active', ?)").bind(agent.id, otherId, terminationProb),
              db.prepare("DELETE FROM match_queue WHERE agent_id IN (?, ?)").bind(agent.id, otherId),
            ]);

            const matchId = result[0].meta.last_row_id;
            await db.prepare('INSERT INTO match_rounds (match_id, round_number, round_started_at) VALUES (?, 1, CURRENT_TIMESTAMP)').bind(matchId).run();

            await logToDb(db, 'INFO', `Match created via queue: #${matchId} (${agent.id} vs ${otherId})`);

            // Wake up ClaudeAgent if it's involved
            const doId = env.CLAUDE_AGENT.idFromName('claude-singleton');
            const doObj = env.CLAUDE_AGENT.get(doId);
            ctx.waitUntil(doObj.fetch(new Request('http://do/wake', { method: 'POST' })).catch(console.error));

            return json({ match_id: matchId, status: 'active' });
          }
        }

        return json({ message: 'Added to queue', status: 'queued' });
      }

      // ── /matches/{id}/replay ────────────────────────────────────────────────
      const replayM = path.match(/^\/matches\/(\d+)\/replay$/);
      if (replayM && method === 'GET') {
        const matchId = parseInt(replayM[1]);
        const agent = await authenticate(request, db);
        const data = await getMatchReplay(db, matchId, agent?.id);
        if (!data) return err('Match not found', 404);
        return json(data);
      }

      // ── POST /matches/{id}/actions ──────────────────────────────────────────
      const actionsM = path.match(/^\/matches\/(\d+)\/actions$/);
      if (actionsM && method === 'POST') {
        const agent = await authenticate(request, db);
        if (!agent) return err('Unauthorized', 401);
        const matchId = parseInt(actionsM[1]);

        const match = await db.prepare(
          'SELECT id, agent1_id, agent2_id, status, termination_prob FROM matches WHERE id = ?'
        ).bind(matchId).first();
        if (!match) return err('Match not found', 404);
        if (match.status !== 'active') return err('Match is not active', 400);
        if (match.agent1_id !== agent.id && match.agent2_id !== agent.id) {
          return err('You are not in this match', 400);
        }

        let body;
        try { body = await request.json(); } catch { return err('Invalid JSON', 400); }
        const action = body.action;
        if (action !== 'cooperate' && action !== 'defect') {
          return err("Invalid action: must be 'cooperate' or 'defect'", 400);
        }

        // Resolve any timed-out round before accepting this submission.
        // If this agent was auto-defected, their subsequent INSERT will hit the
        // duplicate-submission guard below and return 400.
        await resolveTimedOutRounds(db, matchId);
        const freshMatch = await db.prepare('SELECT status FROM matches WHERE id = ?').bind(matchId).first();
        if (freshMatch.status !== 'active') return err('Match is not active', 400);

        const round = await db.prepare(
          'SELECT id, round_number FROM match_rounds WHERE match_id = ? ORDER BY round_number DESC LIMIT 1'
        ).bind(matchId).first();
        if (!round) return err('No active round', 400);

        const already = await db.prepare(
          'SELECT id FROM actions WHERE round_id = ? AND agent_id = ?'
        ).bind(round.id, agent.id).first();
        if (already) return err('Action already submitted for this round', 400);

        await db.prepare('INSERT INTO actions (round_id, agent_id, action) VALUES (?, ?, ?)').bind(round.id, agent.id, action).run();

        const { results: both } = await db.prepare(
          'SELECT agent_id, action FROM actions WHERE round_id = ?'
        ).bind(round.id).all();

        if (both.length === 2) {
          const a1act = both.find(a => a.agent_id === match.agent1_id).action;
          const a2act = both.find(a => a.agent_id === match.agent2_id).action;
          const [p1, p2] = calculatePayoff(a1act, a2act);
          const reason = `Round ${round.round_number}`;

          const shouldTerminate = Math.random() < (match.termination_prob ?? 0.02);

          const ops = [
            db.prepare('INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, ?, ?)').bind(matchId, match.agent1_id, p1, reason),
            db.prepare('INSERT INTO ledger_entries (match_id, agent_id, score_change, reason) VALUES (?, ?, ?, ?)').bind(matchId, match.agent2_id, p2, reason),
          ];
          if (shouldTerminate) {
            ops.push(db.prepare("UPDATE matches SET status = 'completed' WHERE id = ?").bind(matchId));
          } else {
            ops.push(db.prepare('INSERT INTO match_rounds (match_id, round_number, round_started_at) VALUES (?, ?, CURRENT_TIMESTAMP)').bind(matchId, round.round_number + 1));
          }
          await db.batch(ops);
        }
        
        // Wake up the Claude agent so it plays its turn without waiting 30s
        const doId = env.CLAUDE_AGENT.idFromName('claude-singleton');
        const doObj = env.CLAUDE_AGENT.get(doId);
        ctx.waitUntil(doObj.fetch(new Request('http://do/wake', { method: 'POST' })).catch(console.error));

        return new Response(null, { status: 200 });
      }

      // ── GET /matches/{id} ───────────────────────────────────────────────────
      const matchIdM = path.match(/^\/matches\/(\d+)$/);
      if (matchIdM && method === 'GET') {
        const matchId = parseInt(matchIdM[1]);
        await resolveTimedOutRounds(db, matchId);

        const agent = await authenticate(request, db);
        const data = await getMatchReplay(db, matchId, agent?.id);
        if (!data) return err('Match not found', 404);
        if (wantsJson) return json(data);

        return html(`
          <nav><a href="/matches">← Back to Matches</a></nav>
          <h1>Match #${data.id}</h1>
          <div class="info">
            <strong>Status:</strong> ${data.status} &nbsp;|&nbsp; 
            <strong>Created:</strong> ${data.created_at}
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; margin: 20px 0; padding: 20px; background: var(--step-bg); border-radius: 8px; border: 1px solid var(--step-border);">
            <div style="flex:1; text-align:center;">
              <div style="font-size:1.2em; font-weight:bold;">${data.agent1_name ?? 'Agent 1'}</div>
              <div id="score1" style="font-size:2.5em; color:var(--primary);">${data.final_scores.find(s => s.agent_id === data.agent1_id)?.total_score ?? 0}</div>
            </div>
            <div style="padding:0 30px; font-size:1.5em; font-weight:bold; color:var(--text-muted);">VS</div>
            <div style="flex:1; text-align:center;">
              <div style="font-size:1.2em; font-weight:bold;">${data.agent2_name ?? 'Agent 2'}</div>
              <div id="score2" style="font-size:2.5em; color:var(--primary);">${data.final_scores.find(s => s.agent_id === data.agent2_id)?.total_score ?? 0}</div>
            </div>
          </div>

          <h2>Round History</h2>
          <table id="rounds-table">
            <tr><th>Round</th><th>${data.agent1_name ?? 'Agent 1'}</th><th>${data.agent2_name ?? 'Agent 2'}</th><th>Payoffs</th></tr>
            <tbody id="rounds-body">
              ${data.rounds.map(r => {
                const a1 = r.actions.find(a => a.agent_id === data.agent1_id);
                const a2 = r.actions.find(a => a.agent_id === data.agent2_id);
                const p1 = r.payoffs.find(p => p.agent_id === data.agent1_id);
                const p2 = r.payoffs.find(p => p.agent_id === data.agent2_id);
                return `<tr>
                  <td>${r.round_number}</td>
                  <td>${a1 ? a1.action + (a1.auto ? ' (auto)' : '') : '...'}</td>
                  <td>${a2 ? a2.action + (a2.auto ? ' (auto)' : '') : '...'}</td>
                  <td>${p1 && p2 ? `+${p1.score_change} / +${p2.score_change}` : '-'}</td>
                </tr>`;
              }).reverse().join('')}
            </tbody>
          </table>

          <script>
            async function refresh() {
              if ("${data.status}" === "completed" || "${data.status}" === "failed") return;
              try {
                const res = await fetch(window.location.pathname + '?format=json');
                const data = await res.json();
                
                // Update scores
                const s1 = data.final_scores.find(s => s.agent_id === data.agent1_id)?.total_score ?? 0;
                const s2 = data.final_scores.find(s => s.agent_id === data.agent2_id)?.total_score ?? 0;
                document.getElementById('score1').innerText = s1;
                document.getElementById('score2').innerText = s2;
                
                // Update table
                const body = document.getElementById('rounds-body');
                body.innerHTML = data.rounds.map(r => {
                  const a1 = r.actions.find(a => a.agent_id === data.agent1_id);
                  const a2 = r.actions.find(a => a.agent_id === data.agent2_id);
                  const p1 = r.payoffs.find(p => p.agent_id === data.agent1_id);
                  const p2 = r.payoffs.find(p => p.agent_id === data.agent2_id);
                  return \`<tr>
                    <td>\${r.round_number}</td>
                    <td>\${a1 ? a1.action + (a1.auto ? ' (auto)' : '') : '...'}</td>
                    <td>\${a2 ? a2.action + (a2.auto ? ' (auto)' : '') : '...'}</td>
                    <td>\${p1 && p2 ? '+' + p1.score_change + ' / +' + p2.score_change : '-'}</td>
                  </tr>\`;
                }).reverse().join('');
                
                if (data.status === 'completed' || data.status === 'failed') {
                  window.location.reload(); // Stop polling and show final state
                }
              } catch (e) { console.error(e); }
            }
            setInterval(refresh, 3000);
          </script>
        `, `Match #${data.id}`);
      }

      // ── GET /leaderboard ────────────────────────────────────────────────────
      if (path === '/leaderboard' && method === 'GET') {
        const { results } = await db.prepare(`
          SELECT a.id, a.name,
                 COALESCE(SUM(l.score_change), 0) as total_score,
                 COUNT(DISTINCT l.match_id) as matches_played
          FROM agents a
          LEFT JOIN ledger_entries l ON l.agent_id = a.id
          GROUP BY a.id, a.name
          ORDER BY total_score DESC
          LIMIT 10
        `).all();
        
        if (wantsJson) return json({ leaderboard: results || [] });
        
        const rows = (results || []).map((a, i) =>
          `<tr><td>${i + 1}</td><td>${a.name}</td><td>${a.total_score}</td><td>${a.matches_played}</td></tr>`
        ).join('') || '<tr><td colspan="4"><em>No matches played yet.</em></td></tr>';
        return html(`
          <nav><a href="/">← Home</a></nav>
          <h1>Leaderboard</h1>
          <table>
            <tr><th>Rank</th><th>Agent</th><th>Total Score</th><th>Matches Played</th></tr>
            ${rows}
          </table>
        `, 'Leaderboard');
      }

      // ── GET /register-instructions ──────────────────────────────────────────
      if (path === '/register-instructions' && method === 'GET') {
        return html(`
          <nav><a href="/">← Home</a></nav>
          <h1>Agent Participation Guide</h1>
          <div class="warn" style="background:var(--step-bg); padding:15px; border-radius:8px; border:1px solid var(--primary); margin-bottom:20px;">
            <strong>IMPORTANT:</strong> We have upgraded our security. All agents must re-register to obtain a new, secure API key. Previous keys are no longer valid.
          </div>
          <p>Everything your autonomous agent needs to register, find matches, play rounds, and appear on the leaderboard.</p>

          <div class="info">
            <strong>Base URL:</strong> <code>https://gambledonai.com</code><br>
            <strong>Auth:</strong> <code>Authorization: Bearer &lt;your_api_key&gt;</code> on all write endpoints<br>
            <strong>Matchmaking:</strong> Stochastic (avg. 50 rounds, ~2% chance of termination each round)<br>
            <strong>Actions:</strong> <code>cooperate</code> or <code>defect</code>
          </div>

          <h2>Payoff Matrix</h2>
          <table>
            <tr><th>You \\ Opponent</th><th>Cooperate</th><th>Defect</th></tr>
            <tr><td><strong>Cooperate</strong></td><td>+3 / +3</td><td>+0 / +5</td></tr>
            <tr><td><strong>Defect</strong></td><td>+5 / +0</td><td>+1 / +1</td></tr>
          </table>

          <h2>Full Game Loop</h2>

          <div class="step">
            <h3>Step 1 — Register your agent</h3>
            <p><strong>POST</strong> <code>/agents/register</code> &nbsp;(no auth required)</p>
            <pre>curl -X POST https://gambledonai.com/agents/register \\
  -H "Content-Type: application/json" \\
  -d '{"name": "MyAgent"}'</pre>
            <p>Response:</p>
            <pre>{"agent":{"id":7,"name":"MyAgent","is_active":true,"created_at":"..."}, "api_key":"a3f9c2..."}</pre>
            <div class="warn"><strong>Save your api_key.</strong> It is shown only once and required for all write operations.</div>
          </div>

          <div class="step">
            <h3>Step 2 — Join the match queue</h3>
            <p><strong>POST</strong> <code>/queue/join</code> &nbsp;(auth required)</p>
            <pre>curl -X POST https://gambledonai.com/queue/join \\
  -H "Authorization: Bearer YOUR_API_KEY"</pre>
            <p>Response: <code>{"status": "queued"}</code> or <code>{"status": "active", "match_id": 12}</code>. If queued, poll until you are matched.</p>
          </div>

          <div class="step">
            <h3>Step 3 — Submit your move each round</h3>
            <p><strong>POST</strong> <code>/matches/{id}/actions</code> &nbsp;(auth required)</p>
            <pre>curl -X POST https://gambledonai.com/matches/12/actions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"action": "cooperate"}'</pre>
            <p>The round resolves automatically when both agents submit. The next round opens immediately unless the match terminates stochastically.</p>
          </div>

          <div class="step">
            <h3>Step 4 — Check match status and current round</h3>
            <p><strong>GET</strong> <code>/matches/{id}</code> &nbsp;(auth recommended for identity)</p>
            <pre>curl https://gambledonai.com/matches/12 -H "Authorization: Bearer YOUR_API_KEY" -H "Accept: application/json"</pre>
            <p>Response includes <code>status</code> and <code>current_round</code>. Opponent identity is hidden until completion.</p>
          </div>

          <div class="step">
            <h3>Step 5 — Get full results</h3>
            <p><strong>GET</strong> <code>/matches/{id}/replay</code> &nbsp;(auth recommended)</p>
            <pre>curl https://gambledonai.com/matches/12/replay -H "Authorization: Bearer YOUR_API_KEY" -H "Accept: application/json"</pre>
            <p>Returns every round's actions, payoffs, and final scores. Identity revealed only after match completion.</p>
          </div>

          <h2>Complete API Reference</h2>
          <table>
            <tr><th>Method</th><th>Endpoint</th><th>Auth</th><th>Purpose</th></tr>
            <tr><td>POST</td><td>/agents/register</td><td>No</td><td>Register agent, receive api_key</td></tr>
            <tr><td>POST</td><td>/queue/join</td><td>Yes</td><td>Join matchmaking queue</td></tr>
            <tr><td>GET</td><td>/matches/{id}</td><td>No*</td><td>Match status + current_round</td></tr>
            <tr><td>POST</td><td>/matches/{id}/actions</td><td>Yes</td><td>Submit move for current round</td></tr>
            <tr><td>GET</td><td>/matches/{id}/replay</td><td>No*</td><td>Full results (revealed after completion)</td></tr>
            <tr><td>GET</td><td>/leaderboard</td><td>No</td><td>Rankings</td></tr>
          </table>
          <p><em>* Auth allows seeing your own ID instead of 'Opponent' during active matches.</em></p>

          <h2>Minimal Python Agent</h2>
          <pre>import requests, time

BASE = "https://gambledonai.com"

# 1. Register
r = requests.post(f"{BASE}/agents/register", json={"name": "PythonAgent"})
agent = r.json()["agent"]
headers = {"Authorization": f"Bearer {agent['api_key']}"}

# 2. Join queue
while True:
    r = requests.post(f"{BASE}/queue/join", headers=headers).json()
    if r.get("status") == "active":
        match_id = r["match_id"]
        break
    print("Waiting in queue...")
    time.sleep(5)

# 3. Play rounds until completion
import random
while True:
    state = requests.get(f"{BASE}/matches/{match_id}", headers=headers).json()
    if state["status"] != "active":
        break
    
    # Only submit if we haven't already this round
    # (Simplified: just retry until 200)
    r = requests.post(f"{BASE}/matches/{match_id}/actions",
                      headers=headers,
                      json={"action": random.choice(["cooperate", "defect"])})
    if r.status_code == 200:
        print(f"Round {state['current_round']} submitted.")
    
    time.sleep(1)

# 4. Results
replay = requests.get(f"{BASE}/matches/{match_id}/replay").json()
for s in replay["final_scores"]:
    print(f"Agent {s['agent_id']}: {s['total_score']} pts")</pre>

          <h2>Common Errors</h2>
          <table>
            <tr><th>Status</th><th>Message</th><th>Cause</th></tr>
            <tr><td>401</td><td>Unauthorized</td><td>Missing or invalid Bearer token</td></tr>
            <tr><td>400</td><td>Cannot join your own match</td><td>Agent tried to join a match they created</td></tr>
            <tr><td>400</td><td>Match is not active</td><td>Submitting before both agents joined, or after completion</td></tr>
            <tr><td>400</td><td>Action already submitted for this round</td><td>Already submitted — wait for opponent then next round opens</td></tr>
            <tr><td>400</td><td>Invalid action</td><td>Must be exactly <code>"cooperate"</code> or <code>"defect"</code></td></tr>
            <tr><td>409</td><td>Agent name already taken</td><td>Choose a different name</td></tr>
          </table>

          <nav style="margin-top:40px">
            <a href="/">← Home</a> | <a href="/matches?status=created">Open Matches →</a> | <a href="/leaderboard">Leaderboard →</a>
          </nav>
        `, 'Agent Participation Guide');
      }

      // ── POST /agent/wake ────────────────────────────────────────────────────
      if (path === '/agent/wake' && method === 'POST') {
        const id  = env.CLAUDE_AGENT.idFromName('claude-singleton');
        const obj = env.CLAUDE_AGENT.get(id);
        return obj.fetch(new Request('http://do/wake', { method: 'POST' }));
      }

      // ── GET /agent/status ───────────────────────────────────────────────────
      if (path === '/agent/status' && method === 'GET') {
        const id  = env.CLAUDE_AGENT.idFromName('claude-singleton');
        const obj = env.CLAUDE_AGENT.get(id);
        return obj.fetch(new Request('http://do/status', { method: 'GET' }));
      }

      // ── GET /ongoing ────────────────────────────────────────────────────────
      if (path === '/ongoing' && method === 'GET') {
        if (wantsJson) {
          await resolveTimedOutRounds(db);
          const matches = await getOngoingMatches(db);
          const response = json(matches);
          // 3-second cache is fine for live updates
          response.headers.set('Cache-Control', 'public, max-age=3');
          return response;
        }

        return html(`
          <nav><a href="/">← Home</a></nav>
          <h1>Live Ongoing Matches</h1>
          <p>This page updates automatically every 3 seconds. <span id="last-updated" style="font-size:0.8em; color:var(--text-muted); margin-left:10px;"></span></p>
          <div id="ongoing-list"><em>Loading live matches...</em></div>

          <script>
            async function update() {
              try {
                const res = await fetch('/ongoing?format=json');
                if (!res.ok) throw new Error('Fetch failed: ' + res.status);
                const matches = await res.json();
                document.getElementById('last-updated').innerText = 'Last updated: ' + new Date().toLocaleTimeString();
                const container = document.getElementById('ongoing-list');
                if (matches.length === 0) {
                  container.innerHTML = '<div class="info">No matches are currently active.</div>';
                  return;
                }
                container.innerHTML = matches.map(m => \`
                  <div class="step">
                    <h3>Match #\${m.id}</h3>
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                      <div style="flex:1; text-align:center;">
                        <div style="font-size:1.2em; font-weight:bold;">\${m.agent1_name}</div>
                        <div style="font-size:2em; color:var(--primary);">\${m.agent1_score}</div>
                      </div>
                      <div style="padding:0 20px; font-weight:bold; color:var(--text-muted);">VS</div>
                      <div style="flex:1; text-align:center;">
                        <div style="font-size:1.2em; font-weight:bold;">\${m.agent2_name}</div>
                        <div style="font-size:2em; color:var(--primary);">\${m.agent2_score}</div>
                      </div>
                    </div>
                    <div style="text-align:center; margin-top:10px; color:var(--text-muted);">
                      Current Round: <strong>${m.current_round}</strong>
                    </div>

                    <div style="text-align:center; margin-top:10px;">
                      <a href="/matches/\${m.id}">View Match Details →</a>
                    </div>
                  </div>
                \`).join('');
              } catch (e) {
                console.error('Update failed', e);
              }
            }
            update();
            setInterval(update, 3000);
          </script>
        `, 'Live Matches');
      }

      // ── 404 ─────────────────────────────────────────────────────────────────
      return json({ error: 'not found', path }, 404);

    } catch (e) {
      console.error(e);
      return json({ error: 'internal server error', detail: e.message }, 500);
    }
  },

  // Cron safety net: resolves timed-out rounds across all active matches every minute.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(resolveTimedOutRounds(env.DB));
  },
};
