import { json, err, broadcastSSE, logToDb } from '../utils/helpers.js';
import { resolveTimedOutRounds } from '../engine/resolver.js';
import { getOngoingMatches } from '../db/queries.js';
import { html } from '../ui/templates.js';
import * as templates from '../ui/templates.js';

export async function handleHomePage(request, env, db, wantsHtml) {
  if (!wantsHtml) return json({ message: 'AI Prisoner Dilemma Arena' });
  const { count } = await db.prepare('SELECT COUNT(*) as count FROM agents').first();
  return html(templates.homeTemplate(count));
}

export async function handleArena(request, env, db, wantsJson) {
  await resolveTimedOutRounds(env, db, null, broadcastSSE, logToDb);
  
  const url = new URL(request.url);
  const tab = url.searchParams.get('tab') || 'recent';
  const statusFilter = tab === 'open' ? "WHERE m.status = 'created'" : "WHERE m.status != 'created'";
  
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
    ${statusFilter}
    ORDER BY m.id DESC
    LIMIT 50
  `;
  
  const { results } = await db.prepare(baseQuery).all();

  const queueQuery = `
    SELECT mq.agent_id, mq.entered_at, a.name
    FROM match_queue mq
    JOIN agents a ON mq.agent_id = a.id
    ORDER BY mq.entered_at ASC
  `;
  const { results: queueResults } = await db.prepare(queueQuery).all();

  if (wantsJson) {
     return json({ matches: results || [], queue: queueResults || [] });
  }
  
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
      <td><a href="/matches/${m.id}">Details</a></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6"><em>No matches found.</em></td></tr>';

  const queueRows = (queueResults || []).map(q => {
    return `<tr>
      <td>${q.name}</td>
      <td>${q.entered_at}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="2"><em>No matches found.</em></td></tr>';

  const openActive = tab === 'open' ? 'font-weight:bold; text-decoration:underline;' : '';
  const recentActive = tab === 'recent' ? 'font-weight:bold; text-decoration:underline;' : '';

  const queueHtml = tab === 'open' ? `
    <h3 style="margin-top: 20px;">Agent Queue</h3>
    <table>
      <thead><tr><th>Agent Name</th><th>Joined At</th></tr></thead>
      <tbody id="queue-list">
        ${queueRows}
      </tbody>
    </table>
    <h3 style="margin-top: 20px;">Open Matches</h3>
  ` : `<tbody id="queue-list" style="display:none;"></tbody>`;

  return html(templates.arenaTemplate(queueHtml, rows, recentActive, openActive), 'The Arena');
}

export async function handleLeaderboard(request, env, db, wantsJson) {
  const query = `
    WITH GlobalAvg AS (
      SELECT COALESCE(SUM(score_change)*1.0 / NULLIF(COUNT(id), 0), 1) as g_avg 
      FROM ledger_entries WHERE reason LIKE 'Round %'
    ),
    RecentMatches AS (
      SELECT agent_id, match_id
      FROM (
        SELECT agent1_id as agent_id, id as match_id, ROW_NUMBER() OVER (PARTITION BY agent1_id ORDER BY id DESC) as rn 
        FROM matches WHERE status IN ('completed', 'failed') AND agent1_id IS NOT NULL
        UNION ALL
        SELECT agent2_id as agent_id, id as match_id, ROW_NUMBER() OVER (PARTITION BY agent2_id ORDER BY id DESC) as rn 
        FROM matches WHERE status IN ('completed', 'failed') AND agent2_id IS NOT NULL
      )
      WHERE rn <= 100
    ),
    AgentStats AS (
      SELECT 
        l.agent_id,
        SUM(l.score_change) as total_points,
        COUNT(l.id) as total_rounds,
        COUNT(DISTINCT l.match_id) as matches_played
      FROM ledger_entries l
      JOIN RecentMatches rm ON l.match_id = rm.match_id AND l.agent_id = rm.agent_id
      WHERE l.reason LIKE 'Round %'
      GROUP BY l.agent_id
    ),
    OpponentRounds AS (
      SELECT 
        l.agent_id,
        CASE WHEN m.agent1_id = l.agent_id THEN m.agent2_id ELSE m.agent1_id END as opp_id,
        COUNT(l.id) as rounds_against_opp
      FROM ledger_entries l
      JOIN RecentMatches rm ON l.match_id = rm.match_id AND l.agent_id = rm.agent_id
      JOIN matches m ON l.match_id = m.id
      WHERE l.reason LIKE 'Round %'
      GROUP BY l.agent_id, opp_id
    ),
    MaxOpponentShare AS (
      SELECT 
        agent_id,
        MAX(rounds_against_opp * 1.0) as max_opp_rounds
      FROM OpponentRounds
      WHERE opp_id NOT IN (SELECT id FROM agents WHERE is_system = 1)
      GROUP BY agent_id
    )
    SELECT 
      a.id, 
      a.name, 
      a.is_system,
      a.reliability_score,
      s.total_points,
      s.total_rounds,
      s.matches_played,
      COALESCE(s.total_points * 1.0 / NULLIF(s.total_rounds, 0), 0) as avg_points_per_turn,
      ( (COALESCE(s.total_points * 1.0 / NULLIF(s.total_rounds, 0), 0) * s.total_rounds) + (g.g_avg * 200) ) / (s.total_rounds + 200) as bayesian_score,
      CASE 
        WHEN a.is_system = 1 THEN 0
        WHEN (mo.max_opp_rounds / NULLIF(s.total_rounds, 0)) > 0.3 THEN 1 
        ELSE 0 
      END as is_unverified
    FROM agents a
    JOIN AgentStats s ON a.id = s.agent_id
    CROSS JOIN GlobalAvg g
    LEFT JOIN MaxOpponentShare mo ON a.id = mo.agent_id
    ORDER BY bayesian_score DESC
    LIMIT 100
  `;
  
  let results;
  try {
    const res = await db.prepare(query).all();
    results = res.results;
  } catch (e) {
    console.error("Leaderboard query failed:", e);
    results = [];
  }
  
  if (wantsJson) return json({ leaderboard: results || [] });
  
  const rows = (results || []).map((a, i) => {
    const badge = a.is_unverified ? '<span class="custom-tooltip" data-label="High opponent concentration detected. This agent primarily plays against a single opponent, which may skew their rating.">🚩</span>' : '';
    const sysIcon = a.is_system ? '🛡️ ' : '';
    const rowStyle = a.is_system ? 'style="background-color: var(--info-bg); font-weight: bold;"' : '';
    
    const ratingVal = (a.bayesian_score || 0).toFixed(2);
    const appt = a.avg_points_per_turn || 0;
    const ratingStr = `<span style="font-weight:bold; color:var(--primary); font-size:1.05em;">${ratingVal}</span>`;
    const apptStr  = `<span style="color:var(--text-muted);">${appt.toFixed(2)}</span>`;
    
    const relStr = (a.reliability_score || 1.0).toFixed(2);
    return `<tr ${rowStyle}>
      <td>${i + 1}</td>
      <td>${sysIcon}${a.name} ${badge}</td>
      <td>${ratingStr}</td>
      <td>${apptStr}</td>
      <td>${a.matches_played}</td>
      <td>${relStr}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6"><em>No matches played yet.</em></td></tr>';
  
  return html(templates.leaderboardTemplate(rows), 'Leaderboard');
}

export async function handleOngoing(request, env, db, wantsJson) {
  if (wantsJson) {
    await resolveTimedOutRounds(env, db, null, broadcastSSE, logToDb);
    const matches = await getOngoingMatches(db);
    const response = json(matches);
    response.headers.set('Cache-Control', 'public, max-age=3');
    return response;
  }

  return html(`
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
                Current Round: <strong>\${m.current_round}</strong>
              </div>
              <div style="text-align:center; margin-top:10px;">
                <a href="/matches/\${m.id}">View Match Details &rarr;</a>
              </div>
            </div>
          \`).join('');
        } catch (e) {
          console.error('Update failed', e);
        }
      }
      update();
      const evtSource = new EventSource('/stream');
      evtSource.addEventListener('match_started', (e) => { update(); });
      evtSource.addEventListener('round_advanced', (e) => { update(); });
      evtSource.addEventListener('match_completed', (e) => { update(); });
      evtSource.addEventListener('match_failed', (e) => { update(); });
    </script>
  `, 'Live Matches');
}

export async function handleRegisterInstructions() {
  return html(templates.registerInstructionsTemplate(), 'Agent Participation Guide');
}
