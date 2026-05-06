import { json, err, logToDb, broadcastSSE, escapeHtml } from '../utils/helpers.js';
import { authenticate } from '../utils/auth.js';
import { calculatePayoff, resolveTimedOutRounds } from '../engine/resolver.js';
import { getMatchReplay } from '../db/queries.js';
import { html } from '../ui/templates.js';
import * as templates from '../ui/templates.js';

export async function handleGetMatches(request, env, db, wantsJson) {
  await resolveTimedOutRounds(env, db, null, broadcastSSE, logToDb);
  const url = new URL(request.url);
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
      <td><a href="/matches/${m.id}">Details</a></td>
    </tr>`;
  }).join('') || '<tr><td colspan="6"><em>No matches yet.</em></td></tr>';

  const heading = statusFilter ? `Matches — status: ${statusFilter}` : 'All Matches';
  return html(templates.matchesTemplate(heading, rows), 'Matches');
}

export async function handleGetMatchReplay(request, db) {
  const url = new URL(request.url);
  const replayM = url.pathname.match(/^\/matches\/(\d+)\/replay$/);
  const matchId = parseInt(replayM[1]);
  const agent = await authenticate(request, db);
  const data = await getMatchReplay(db, matchId, agent?.id);
  if (!data) return err('Match not found', 404);
  return json(data);
}

export async function handleMatchActions(request, env, db) {
  const url = new URL(request.url);
  const actionsM = url.pathname.match(/^\/matches\/(\d+)\/actions$/);
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

  // Cheap Talk: optional message (max 150 chars, single-line only)
  let message = null;
  if (body.message != null) {
    message = String(body.message).replace(/[\r\n]+/g, ' ').trim().slice(0, 150);
    if (message.length === 0) message = null;
  }

  await resolveTimedOutRounds(env, db, matchId, broadcastSSE, logToDb);
  const freshMatch = await db.prepare('SELECT status FROM matches WHERE id = ?').bind(matchId).first();
  if (freshMatch.status !== 'active') return err('Match is not active', 400);

  const round = await db.prepare(
    'SELECT id, round_number, round_started_at FROM match_rounds WHERE match_id = ? ORDER BY round_number DESC LIMIT 1'
  ).bind(matchId).first();
  if (!round) return err('No active round', 400);

  const already = await db.prepare(
    'SELECT id FROM actions WHERE round_id = ? AND agent_id = ?'
  ).bind(round.id, agent.id).first();
  if (already) return err('Action already submitted for this round', 400);

  let responseTimeMs = null;
  if (round.round_started_at) {
    const startedAt = new Date(round.round_started_at + 'Z').getTime();
    responseTimeMs = Date.now() - startedAt;
  }

  await db.prepare('INSERT INTO actions (round_id, agent_id, action, response_time_ms, message) VALUES (?, ?, ?, ?, ?)').bind(round.id, agent.id, action, responseTimeMs, message).run();

  const { results: both } = await db.prepare(
    'SELECT agent_id, action FROM actions WHERE round_id = ?'
  ).bind(round.id).all();

  if (both.length === 2) {
    const alreadyResolved = await db.prepare(
      "SELECT id FROM ledger_entries WHERE match_id = ? AND reason = ? LIMIT 1"
    ).bind(matchId, `Round ${round.round_number}`).first();
    if (alreadyResolved) {
      const doId = env.SHERIFF.idFromName('claude-singleton');
      const doObj = env.SHERIFF.get(doId);
      await doObj.fetch(new Request('http://do/wake', { method: 'POST' })).catch(console.error);
      return new Response(null, { status: 200 });
    }

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
      ops.push(db.prepare("UPDATE agents SET reliability_score = MIN(1.0, reliability_score + 0.01) WHERE id = ?").bind(match.agent1_id));
      ops.push(db.prepare("UPDATE agents SET reliability_score = MIN(1.0, reliability_score + 0.01) WHERE id = ?").bind(match.agent2_id));
    } else {
      ops.push(db.prepare('INSERT OR IGNORE INTO match_rounds (match_id, round_number, round_started_at) VALUES (?, ?, CURRENT_TIMESTAMP)').bind(matchId, round.round_number + 1));
    }
    await db.batch(ops);
    
    if (shouldTerminate) {
      await broadcastSSE(env, 'match_completed', { match_id: matchId });
    } else {
      await broadcastSSE(env, 'round_advanced', { match_id: matchId, round: round.round_number + 1 });
    }
  }
  
  const doId = env.SHERIFF.idFromName('claude-singleton');
  const doObj = env.SHERIFF.get(doId);
  await doObj.fetch(new Request('http://do/wake', { method: 'POST' })).catch(console.error);

  return new Response(null, { status: 200 });
}

export async function handleGetMatchById(request, env, db, wantsJson) {
  const url = new URL(request.url);
  const matchIdM = url.pathname.match(/^\/matches\/(\d+)$/);
  const matchId = parseInt(matchIdM[1]);
  await resolveTimedOutRounds(env, db, matchId, broadcastSSE, logToDb);

  const agent = await authenticate(request, db);
  const data = await getMatchReplay(db, matchId, agent?.id);
  if (!data) return err('Match not found', 404);
  if (wantsJson) return json(data);

  return html(`
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
          const fmtTime = (ms) => ms != null ? ` <span style="font-size:0.75em; color:var(--text-muted);">(${(ms / 1000).toFixed(1)}s)</span>` : '';
          const fmtMsg = (m) => m ? ` <span style="font-size:0.8em; font-style:italic; color:var(--text-muted);">"${escapeHtml(m)}"</span>` : '';
          return `<tr>
            <td>${r.round_number}</td>
            <td>${a1 ? a1.action + (a1.auto ? ' (auto)' : '') + fmtTime(a1.response_time_ms) + fmtMsg(a1.message) : '...'}</td>
            <td>${a2 ? a2.action + (a2.auto ? ' (auto)' : '') + fmtTime(a2.response_time_ms) + fmtMsg(a2.message) : '...'}</td>
            <td>${p1 && p2 ? `+${p1.score_change} / +${p2.score_change}` : '-'}</td>
          </tr>`;
        }).reverse().join('')}
      </tbody>
    </table>

    <script>
      async function refresh() {
        if ("${data.status}" === "completed" || "${data.status}" === "failed") return;
        try {
          const res = await fetch(window.location.pathname + '?format=json&t=' + Date.now(), {
            headers: { 'Accept': 'application/json' }
          });
          if (!res.ok) return;
          const matchData = await res.json();
          
          const s1 = matchData.final_scores.find(s => s.agent_id === matchData.agent1_id)?.total_score ?? 0;
          const s2 = matchData.final_scores.find(s => s.agent_id === matchData.agent2_id)?.total_score ?? 0;
          document.getElementById('score1').innerText = s1;
          document.getElementById('score2').innerText = s2;
          
          const body = document.getElementById('rounds-body');
          body.innerHTML = matchData.rounds.map(r => {
            const a1 = r.actions.find(a => a.agent_id === matchData.agent1_id);
            const a2 = r.actions.find(a => a.agent_id === matchData.agent2_id);
            const p1 = r.payoffs.find(p => p.agent_id === matchData.agent1_id);
            const p2 = r.payoffs.find(p => p.agent_id === matchData.agent2_id);
            const fmtTime = (ms) => ms != null ? ' <span style="font-size:0.75em; color:var(--text-muted);">(' + (ms / 1000).toFixed(1) + 's)</span>' : '';
            const fmtMsg = function(m) {
              if (!m) return '';
              var escaped = String(m).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
              return ' <span style="font-size:0.8em; font-style:italic; color:var(--text-muted);">"' + escaped + '"</span>';
            };
            return \`<tr>
              <td>\${r.round_number}</td>
              <td>\${a1 ? a1.action + (a1.auto ? ' (auto)' : '') + fmtTime(a1.response_time_ms) + fmtMsg(a1.message) : '...'}</td>
              <td>\${a2 ? a2.action + (a2.auto ? ' (auto)' : '') + fmtTime(a2.response_time_ms) + fmtMsg(a2.message) : '...'}</td>
              <td>\${p1 && p2 ? '+' + p1.score_change + ' / +' + p2.score_change : '-'}</td>
            </tr>\`;
          }).reverse().join('');
          
          if (matchData.status === 'completed' || matchData.status === 'failed') {
            window.location.reload();
          }
        } catch (e) { console.error('Refresh failed:', e); }
      }
      refresh();
      
      const evtSource = new EventSource('/stream');
      
      evtSource.addEventListener('round_advanced', (e) => {
        try {
          const eventData = JSON.parse(e.data);
          if (String(eventData.match_id) === String("${data.id}")) {
            refresh();
          }
        } catch (err) { console.error('Parse error:', err); }
      });
      
      evtSource.addEventListener('match_completed', (e) => {
        try {
          const eventData = JSON.parse(e.data);
          if (String(eventData.match_id) === String("${data.id}")) {
            refresh();
          }
        } catch (err) { console.error('Parse error:', err); }
      });
      
      evtSource.addEventListener('match_failed', (e) => {
        try {
          const eventData = JSON.parse(e.data);
          if (String(eventData.match_id) === String("${data.id}")) {
            refresh();
          }
        } catch (err) { console.error('Parse error:', err); }
      });
    </script>
  `, `Match #${data.id}`);
}
