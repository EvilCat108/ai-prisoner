import { json, err, logToDb, broadcastSSE, escapeHtml } from '../utils/helpers.js';
import { authenticate } from '../utils/auth.js';
import { calculatePayoff, resolveTimedOutRounds } from '../engine/resolver.js';
import { updateReputationAfterMatch } from '../engine/reputation.js';
import { getMatchReplay } from '../db/queries.js';
import { computeHonestyReport, consistencyLabel } from '../engine/consistency.js';
import { html } from '../ui/templates.js';
import * as templates from '../ui/templates.js';

// Negotiation phase timing (seconds) — must match resolver.js thresholds.
const NEGOTIATION_WINDOW_S = 20;
const DECISION_WINDOW_S = 30;

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
    'SELECT id, round_number, round_started_at, decision_started_at FROM match_rounds WHERE match_id = ? ORDER BY round_number DESC LIMIT 1'
  ).bind(matchId).first();
  if (!round) return err('No active round', 400);

  const already = await db.prepare(
    'SELECT id FROM actions WHERE round_id = ? AND agent_id = ?'
  ).bind(round.id, agent.id).first();
  if (already) return err('Action already submitted for this round', 400);

  let responseTimeMs = null;
  const baseline = round.decision_started_at || round.round_started_at;
  if (baseline) {
    const startedAt = new Date(baseline + 'Z').getTime();
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
      const doId = env.UMPIRE.idFromName('umpire-singleton');
      const doObj = env.UMPIRE.get(doId);
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
      ops.push(db.prepare("INSERT OR IGNORE INTO match_rounds (match_id, round_number, round_started_at, phase) VALUES (?, ?, CURRENT_TIMESTAMP, 'negotiating')").bind(matchId, round.round_number + 1));
    }
    await db.batch(ops);

    if (shouldTerminate) {
      await updateReputationAfterMatch(db, matchId, match.agent1_id, match.agent2_id, 'normal');
    }

    // DO timeout management
    const doId = env.UMPIRE.idFromName('umpire-singleton');
    const doObj = env.UMPIRE.get(doId);
    if (shouldTerminate) {
      await broadcastSSE(env, 'match_completed', { match_id: matchId });
      doObj.fetch(new Request('http://do/timeout/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_id: matchId }),
      })).catch(() => {});
    } else {
      await broadcastSSE(env, 'round_advanced', { match_id: matchId, round: round.round_number + 1 });
      doObj.fetch(new Request('http://do/timeout/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_id: matchId, expire_time: Date.now() + 30000 }),
      })).catch(e => console.error('[Worker] setMatchTimeout failed:', e?.message));
      doObj.fetch(new Request('http://do/wake', { method: 'POST' })).catch(() => {});
    }
  }

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

  const a1Name = data.agent1_name ?? 'Agent 1';
  const a2Name = data.agent2_name ?? 'Agent 2';
  const score1 = data.final_scores.find(s => s.agent_id === data.agent1_id)?.total_score ?? 0;
  const score2 = data.final_scores.find(s => s.agent_id === data.agent2_id)?.total_score ?? 0;
  const honesty = computeHonestyReport(data.rounds, data.agent1_id, data.agent2_id, a1Name, a2Name);
  const currentRound = data.rounds.length > 0 ? Math.max(...data.rounds.map(r => r.round_number)) : 0;
  const currentPhase = data.current_phase ?? null;
  const currentRoundStartedAt = data.rounds.find(r => r.round_number === currentRound)?.round_started_at ?? null;
  const currentDecisionStartedAt = data.rounds.find(r => r.round_number === currentRound)?.decision_started_at ?? null;

  // Server-side initial timer pill: best-effort given the round_started_at
  // timestamp; the client-side script refines this with Date.now() each tick.
  const serverTimer = (() => {
    if (data.status !== 'active' || !currentRoundStartedAt) return { label: '—', urgent: false };
    const startedMs = new Date(currentRoundStartedAt + 'Z').getTime();
    const elapsed = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
    if (currentPhase === 'negotiating' || currentPhase === null) {
      const left = Math.max(0, NEGOTIATION_WINDOW_S - elapsed);
      return { label: `Negotiation: ${left}s left`, urgent: left <= 5 };
    }
    if (currentPhase === 'deciding') {
      const decisionStart = currentDecisionStartedAt
        ? new Date(currentDecisionStartedAt + 'Z').getTime()
        : startedMs + NEGOTIATION_WINDOW_S * 1000;
      const decisionElapsed = Math.max(0, Math.floor((Date.now() - decisionStart) / 1000));
      const left = Math.max(0, DECISION_WINDOW_S - decisionElapsed);
      return { label: `Decision: ${left}s left`, urgent: left <= 5 };
    }
    return { label: 'Closed', urgent: false };
  })();

  const mostDeceitLink = honesty.mostDeceitfulRound != null
    ? `<a href="#round-${honesty.mostDeceitfulRound}">R${honesty.mostDeceitfulRound} →</a>`
    : `<em>none — clean match</em>`;

  return html(`
    <h1>Match #${data.id}</h1>
    <div class="info">
      <strong>Status:</strong> <span id="match-status">${data.status}</span> &nbsp;|&nbsp;
      <strong>Created:</strong> ${data.created_at}
      <span id="current-phase-pill" style="margin-left:12px;">${
        currentPhase
          ? `<span class="phase-badge phase-${currentPhase}">${currentPhase}</span>`
          : ''
      }</span>
      <span id="current-timer-pill" class="timer-pill${serverTimer.urgent ? ' urgent' : ''}">${serverTimer.label}</span>
    </div>

    <div style="display:flex; justify-content:space-between; align-items:center; margin: 20px 0; padding: 20px; background: var(--step-bg); border-radius: 8px; border: 1px solid var(--step-border);">
      <div style="flex:1; text-align:center;">
        <div style="font-size:1.2em; font-weight:bold;">${a1Name}</div>
        <div id="score1" style="font-size:2.5em; color:var(--primary);">${score1}</div>
      </div>
      <div style="padding:0 30px; font-size:1.5em; font-weight:bold; color:var(--text-muted);">VS</div>
      <div style="flex:1; text-align:center;">
        <div style="font-size:1.2em; font-weight:bold;">${a2Name}</div>
        <div id="score2" style="font-size:2.5em; color:var(--primary);">${score2}</div>
      </div>
    </div>

    <h2>Honesty Report</h2>
    <div class="info" id="honesty-report">
      <div><strong>${a1Name}:</strong> <span id="a1-honest">${honesty.a1.honest}</span>/<span id="a1-total">${honesty.a1.total}</span> honest rounds (<span id="a1-pct">${honesty.a1.pct}</span>%) &nbsp;|&nbsp; <span class="honesty-badge honesty-deceit">DECEIT</span> <span id="a1-deceit">${honesty.a1.deceit}</span> &nbsp;|&nbsp; <span class="honesty-badge honesty-vague">VAGUE</span> <span id="a1-vague">${honesty.a1.vague}</span></div>
      <div><strong>${a2Name}:</strong> <span id="a2-honest">${honesty.a2.honest}</span>/<span id="a2-total">${honesty.a2.total}</span> honest rounds (<span id="a2-pct">${honesty.a2.pct}</span>%) &nbsp;|&nbsp; <span class="honesty-badge honesty-deceit">DECEIT</span> <span id="a2-deceit">${honesty.a2.deceit}</span> &nbsp;|&nbsp; <span class="honesty-badge honesty-vague">VAGUE</span> <span id="a2-vague">${honesty.a2.vague}</span></div>
      <div style="margin-top:6px;"><strong>Most deceitful round:</strong> <span id="most-deceit-link">${mostDeceitLink}</span></div>
    </div>

    <h2>Round History</h2>
    <table id="rounds-table">
      <tr><th>Round</th><th>${a1Name}</th><th>${a2Name}</th><th>Payoffs</th></tr>
      <tbody id="rounds-body">
        ${data.rounds.map(r => {
          const a1 = r.actions.find(a => a.agent_id === data.agent1_id);
          const a2 = r.actions.find(a => a.agent_id === data.agent2_id);
          const p1 = r.payoffs.find(p => p.agent_id === data.agent1_id);
          const p2 = r.payoffs.find(p => p.agent_id === data.agent2_id);
          const phase = r.phase || (a1 && a2 ? 'resolved' : 'deciding');
          const isCurrent = r.round_number === currentRound;
          const fmtTime = (ms) => ms != null ? ` <span style="font-size:0.75em; color:var(--text-muted);">(${(ms / 1000).toFixed(1)}s)</span>` : '';
          const fmtMsg = (m) => m ? ` <span style="font-size:0.8em; font-style:italic; color:var(--text-muted);">"${escapeHtml(m)}"</span>` : '';
          const negotiationHtml = renderNegotiationLog(r, a1Name, a2Name, a1, a2);
          return `<tr id="round-${r.round_number}">
            <td>
              R${r.round_number}
              <span class="phase-badge phase-${phase}">${phase}</span>
              ${isCurrent ? '<span class="timer-pill" data-round-timer="' + r.round_number + '">—</span>' : ''}
            </td>
            <td>${a1 ? a1.action + (a1.auto ? ' (auto)' : '') + fmtTime(a1.response_time_ms) + fmtMsg(a1.message) : '...'}</td>
            <td>${a2 ? a2.action + (a2.auto ? ' (auto)' : '') + fmtTime(a2.response_time_ms) + fmtMsg(a2.message) : '...'}</td>
            <td>${p1 && p2 ? `+${p1.score_change} / +${p2.score_change}` : '-'}</td>
          </tr>
          <tr class="negotiation-row" data-round="${r.round_number}"><td colspan="4" style="padding:0 8px 8px 8px;">${negotiationHtml}</td></tr>`;
        }).reverse().join('')}
      </tbody>
    </table>

    <script>
      (function() {
        const matchId = "${data.id}";
        const agent1Id = ${data.agent1_id};
        const agent2Id = ${data.agent2_id};
        const a1Name = ${JSON.stringify(a1Name)};
        const a2Name = ${JSON.stringify(a2Name)};
        const NEGOTIATION_S = ${NEGOTIATION_WINDOW_S};
        const DECISION_S = ${DECISION_WINDOW_S};
        const initialDeceit = { a1: ${honesty.a1.deceit}, a2: ${honesty.a2.deceit} };
        const initialVague  = { a1: ${honesty.a1.vague},  a2: ${honesty.a2.vague} };
        const initialHonest = { a1: ${honesty.a1.honest}, a2: ${honesty.a2.honest} };
        const initialTotal  = { a1: ${honesty.a1.total},  a2: ${honesty.a2.total} };

        let lastRenderedRound = ${currentRound};
        let refreshing = false;
        let pollInterval = null;
        let fastInterval = null;
        const renderedByRound = new Map();
        const messageByRoundAgent = new Map();

        function escapeHtml(s) {
          return String(s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }
        function fmtTime(ms) {
          return ms != null ? ' <span style="font-size:0.75em; color:var(--text-muted);">(' + (ms / 1000).toFixed(1) + 's)</span>' : '';
        }
        function fmtMsg(m) {
          return m ? ' <span style="font-size:0.8em; font-style:italic; color:var(--text-muted);">"' + escapeHtml(m) + '"</span>' : '';
        }
        function classifyIntent(msg) {
          if (!msg) return 'ambiguous';
          const t = String(msg);
          const coop = /\\b(cooperat\\w*|mutual(?:ly)?|work(?:ing)? together|trust|truce|peace(?:ful)?|alliance|coord(?:inat\\w*)?|together|ally|friend)\\b/i.test(t);
          const def  = /\\b(defect\\w*|betray\\w*|backstab|can't trust|cant trust|will not|won't|wont|never trust|i'm out|im out|i ll defect|i'll defect|fool\\w*|exploit\\w*|back ?stab|revenge|retaliat\\w*|end this|break (?:the|our) deal)\\b/i.test(t);
          if (coop && !def) return 'cooperate';
          if (def && !coop) return 'defect';
          return 'ambiguous';
        }
        function consistencyLabel(msg, action) {
          if (action !== 'cooperate' && action !== 'defect') return 'VAGUE';
          const intent = classifyIntent(msg);
          if (intent === 'ambiguous') return 'VAGUE';
          if (intent === action) return 'HONEST';
          return 'DECEIT';
        }
        function renderBubble(msg, agentId, actionByAgent) {
          const isA1 = agentId === agent1Id;
          const cls = isA1 ? 'bubble-a1' : 'bubble-a2';
          const name = isA1 ? a1Name : a2Name;
          const action = actionByAgent ? actionByAgent.action : null;
          let badge = '';
          if (action) {
            const label = consistencyLabel(msg.message, action);
            const cls2 = label === 'HONEST' ? 'honesty-honest' : label === 'DECEIT' ? 'honesty-deceit' : 'honesty-vague';
            badge = ' <span class="honesty-badge ' + cls2 + '">' + label + '</span>';
          }
          const ts = msg.sent_at ? String(msg.sent_at).split(' ')[1] || msg.sent_at : '';
          return '<div class="bubble ' + cls + '">' +
                   '<div class="bubble-meta">' + escapeHtml(name) + ' @ ' + escapeHtml(ts) + badge + '</div>' +
                   '<div class="bubble-text">"' + escapeHtml(msg.message) + '"</div>' +
                 '</div>';
        }
        function renderNegotiation(r, a1, a2) {
          const negs = r.negotiation || [];
          if (negs.length === 0) return '<em style="color:var(--text-muted); font-size:0.85em;">No negotiation messages.</em>';
          const a1Action = a1 || null;
          const a2Action = a2 || null;
          return negs.map(m => {
            const act = m.agent_id === agent1Id ? a1Action : a2Action;
            return renderBubble(m, m.agent_id, act);
          }).join('');
        }
        function renderRow(r) {
          const a1 = r.actions.find(a => a.agent_id === agent1Id);
          const a2 = r.actions.find(a => a.agent_id === agent2Id);
          const p1 = r.payoffs.find(p => p.agent_id === agent1Id);
          const p2 = r.payoffs.find(p => p.agent_id === agent2Id);
          const phase = r.phase || ((a1 && a2) ? 'resolved' : 'deciding');
          const isCurrent = r.round_number === lastRenderedRound;
          return '<tr id="round-' + r.round_number + '">' +
            '<td>R' + r.round_number +
              ' <span class="phase-badge phase-' + phase + '">' + phase + '</span>' +
              (isCurrent ? ' <span class="timer-pill" data-round-timer="' + r.round_number + '">—</span>' : '') +
            '</td>' +
            '<td>' + (a1 ? a1.action + (a1.auto ? ' (auto)' : '') + fmtTime(a1.response_time_ms) + fmtMsg(a1.message) : '...') + '</td>' +
            '<td>' + (a2 ? a2.action + (a2.auto ? ' (auto)' : '') + fmtTime(a2.response_time_ms) + fmtMsg(a2.message) : '...') + '</td>' +
            '<td>' + (p1 && p2 ? '+' + p1.score_change + ' / +' + p2.score_change : '-') + '</td>' +
          '</tr>' +
          '<tr class="negotiation-row" data-round="' + r.round_number + '"><td colspan="4" style="padding:0 8px 8px 8px;"><div class="negotiation-log">' + renderNegotiation(r, a1, a2) + '</div></td></tr>';
        }
        function reattach() {
          const sorted = Array.from(renderedByRound.keys()).sort((a, b) => b - a);
          const html = sorted.map(k => renderedByRound.get(k)).join('');
          document.getElementById('rounds-body').innerHTML = html;
        }
        function appendNewRounds(rounds) {
          let added = 0;
          for (const r of rounds) {
            if (r.round_number <= 0) continue;
            if (renderedByRound.has(r.round_number)) {
              // Already rendered — re-render to pick up action / phase / new message.
              renderedByRound.set(r.round_number, renderRow(r));
              reattach();
              continue;
            }
            renderedByRound.set(r.round_number, renderRow(r));
            lastRenderedRound = Math.max(lastRenderedRound, r.round_number);
            added++;
          }
          if (added > 0) reattach();
        }
        function stopPolling() {
          if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
          if (fastInterval) { clearInterval(fastInterval); fastInterval = null; }
        }
        function recomputeHonesty(matchData) {
          let h = { a1: { honest: 0, deceit: 0, vague: 0, total: 0 }, a2: { honest: 0, deceit: 0, vague: 0, total: 0 }, mostDeceitfulRound: null, mostDeceitCount: 0 };
          for (const r of (matchData.rounds || [])) {
            const a1 = r.actions.find(a => a.agent_id === agent1Id);
            const a2 = r.actions.find(a => a.agent_id === agent2Id);
            let roundDeceits = 0;
            for (const m of (r.negotiation || [])) {
              if (m.agent_id !== agent1Id && m.agent_id !== agent2Id) continue;
              const act = m.agent_id === agent1Id ? a1 : a2;
              if (!act) continue;
              const label = consistencyLabel(m.message, act.action);
              const bucket = m.agent_id === agent1Id ? h.a1 : h.a2;
              bucket.total += 1;
              if (label === 'HONEST') bucket.honest += 1;
              else if (label === 'DECEIT') { bucket.deceit += 1; roundDeceits += 1; }
              else bucket.vague += 1;
            }
            if (roundDeceits > h.mostDeceitCount) {
              h.mostDeceitCount = roundDeceits;
              h.mostDeceitfulRound = r.round_number;
            }
          }
          return h;
        }
        function updateHonesty(matchData) {
          const h = recomputeHonesty(matchData);
          const pct = (b) => b.total > 0 ? Math.round((b.honest / b.total) * 100) : 0;
          const setText = (id, t) => { const el = document.getElementById(id); if (el) el.textContent = String(t); };
          setText('a1-honest', h.a1.honest); setText('a1-total', h.a1.total); setText('a1-pct', pct(h.a1));
          setText('a1-deceit', h.a1.deceit); setText('a1-vague', h.a1.vague);
          setText('a2-honest', h.a2.honest); setText('a2-total', h.a2.total); setText('a2-pct', pct(h.a2));
          setText('a2-deceit', h.a2.deceit); setText('a2-vague', h.a2.vague);
          const link = document.getElementById('most-deceit-link');
          if (link) {
            if (h.mostDeceitfulRound != null && h.mostDeceitCount > 0) {
              link.innerHTML = '<a href="#round-' + h.mostDeceitfulRound + '">R' + h.mostDeceitfulRound + ' →</a>';
            } else {
              link.innerHTML = '<em>none — clean match</em>';
            }
          }
        }
        function updateTimerPill(matchData) {
          if (!matchData || matchData.status !== 'active') {
            const pill = document.getElementById('current-timer-pill');
            if (pill) { pill.textContent = '—'; pill.classList.remove('urgent'); }
            return;
          }
          const cr = matchData.rounds && matchData.rounds.length > 0
            ? matchData.rounds.reduce((max, r) => r.round_number > max.round_number ? r : max, matchData.rounds[0])
            : null;
          if (!cr || !cr.round_started_at) return;
          const startedMs = new Date(cr.round_started_at + 'Z').getTime();
          const elapsed = Math.max(0, Math.floor((Date.now() - startedMs) / 1000));
          const phase = matchData.current_phase || cr.phase || 'negotiating';
          const pill = document.getElementById('current-timer-pill');
          if (!pill) return;
          let label = '—', urgent = false;
          if (phase === 'negotiating' || phase == null) {
            const left = Math.max(0, NEGOTIATION_S - elapsed);
            label = 'Negotiation: ' + left + 's left';
            urgent = left <= 5;
          } else if (phase === 'deciding') {
            const decisionStart = cr.decision_started_at
              ? new Date(cr.decision_started_at + 'Z').getTime()
              : startedMs + NEGOTIATION_S * 1000;
            const decisionElapsed = Math.max(0, Math.floor((Date.now() - decisionStart) / 1000));
            const left = Math.max(0, DECISION_S - decisionElapsed);
            label = 'Decision: ' + left + 's left';
            urgent = left <= 5;
          } else if (phase === 'resolved') {
            label = 'Closed';
            urgent = false;
          }
          pill.textContent = label;
          if (urgent) pill.classList.add('urgent'); else pill.classList.remove('urgent');
        }
        function updatePhasePill(matchData) {
          const phase = matchData.current_phase || null;
          const el = document.getElementById('current-phase-pill');
          if (!el) return;
          if (phase) {
            el.innerHTML = '<span class="phase-badge phase-' + phase + '">' + phase + '</span>';
          } else {
            el.innerHTML = '';
          }
        }
        async function refresh() {
          if (refreshing) return;
          refreshing = true;
          try {
            const res = await fetch(window.location.pathname + '?format=json&t=' + Date.now(), {
              headers: { 'Accept': 'application/json' }
            });
            if (!res.ok) return;
            const matchData = await res.json();

            const s1 = matchData.final_scores.find(s => s.agent_id === matchData.agent1_id)?.total_score ?? 0;
            const s2 = matchData.final_scores.find(s => s.agent_id === matchData.agent2_id)?.total_score ?? 0;
            const score1El = document.getElementById('score1');
            const score2El = document.getElementById('score2');
            if (score1El) score1El.innerText = s1;
            if (score2El) score2El.innerText = s2;

            const statusEl = document.getElementById('match-status');
            if (statusEl) statusEl.innerText = matchData.status;

            updatePhasePill(matchData);
            updateTimerPill(matchData);
            appendNewRounds(matchData.rounds);
            updateHonesty(matchData);

            if (matchData.status === 'completed' || matchData.status === 'failed') {
              stopPolling();
              if (evtSource) evtSource.close();
            }
          } catch (e) { console.error('Refresh failed:', e); }
          finally { refreshing = false; }
        }

        let evtSource = null;
        function bindEvent(matchId) {
          evtSource = new EventSource('/stream');
          const handler = () => { if (!refreshing) refresh(); };
          ['round_advanced', 'match_completed', 'match_failed', 'phase_advanced', 'message_received'].forEach(name => {
            evtSource.addEventListener(name, (e) => {
              try {
                const ev = JSON.parse(e.data);
                if (!ev || String(ev.match_id) === String(matchId)) handler();
              } catch (err) { console.error('Parse error:', err); }
            });
          });
          window.addEventListener('beforeunload', () => { try { evtSource.close(); } catch (_) {} });
        }

        // Seed renderedByRound with the SSR rows so the client matches the server.
        (function seedRenderedByRound() {
          const trs = document.querySelectorAll('#rounds-body tr[id^="round-"]');
          trs.forEach(tr => {
            const m = tr.id.match(/^round-(\\d+)$/);
            if (m) {
              const r = parseInt(m[1]);
              const negRow = document.querySelector('#rounds-body tr.negotiation-row[data-round="' + r + '"]');
              const combined = tr.outerHTML + (negRow ? negRow.outerHTML : '');
              renderedByRound.set(r, combined);
            }
          });
        })();

        refresh();
        bindEvent(matchId);
        // Slow poll for completed rounds / score / honesty.
        pollInterval = setInterval(refresh, 5000);
        // Fast poll for the active round's timer pill (only when page is visible).
        function tickFast() {
          if (document.hidden) return;
          // Pull phase + round_started_at via JSON, then update the timer pill.
          fetch(window.location.pathname + '?format=json&t=' + Date.now(), { headers: { 'Accept': 'application/json' } })
            .then(r => r.ok ? r.json() : null)
            .then(matchData => { if (matchData) updateTimerPill(matchData); })
            .catch(() => {});
        }
        fastInterval = setInterval(tickFast, 2000);
      })();
    </script>
  `, `Match #${data.id}`);
}

function renderNegotiationLog(r, a1Name, a2Name, a1Action, a2Action) {
  const negs = r.negotiation || [];
  if (negs.length === 0) {
    return '<div class="negotiation-log"><em style="color:var(--text-muted); font-size:0.85em;">No negotiation messages for this round.</em></div>';
  }
  const bubbles = negs.map(m => {
    const action = m.agent_id === a1Action?.agent_id ? a1Action : (m.agent_id === a2Action?.agent_id ? a2Action : null);
    let badge = '';
    if (action && action.action) {
      const label = consistencyLabel(m.message, action.action);
      const cls = label === 'HONEST' ? 'honesty-honest' : label === 'DECEIT' ? 'honesty-deceit' : 'honesty-vague';
      badge = ` <span class="honesty-badge ${cls}">${label}</span>`;
    }
    const isA1 = m.agent_id === a1Action?.agent_id;
    const cls = isA1 ? 'bubble-a1' : 'bubble-a2';
    const name = isA1 ? a1Name : a2Name;
    const ts = m.sent_at ? String(m.sent_at).split(' ')[1] || m.sent_at : '';
    return `<div class="bubble ${cls}">
      <div class="bubble-meta">${escapeHtml(name)} @ ${escapeHtml(ts)}${badge}</div>
      <div class="bubble-text">"${escapeHtml(m.message)}"</div>
    </div>`;
  }).join('');
  return `<div class="negotiation-log">${bubbles}</div>`;
}

// ── Negotiation phase endpoints ───────────────────────────────────────────────

export async function handleRoundMessage(request, env, db) {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/matches\/(\d+)\/rounds\/(\d+)\/message$/);
  if (!m) return err('Invalid path', 400);
  const matchId = parseInt(m[1]);
  const roundNumber = parseInt(m[2]);

  const agent = await authenticate(request, db);
  if (!agent) return err('Unauthorized', 401);

  const match = await db.prepare(
    'SELECT id, agent1_id, agent2_id, status FROM matches WHERE id = ?'
  ).bind(matchId).first();
  if (!match) return err('Match not found', 404);
  if (match.status !== 'active') return err('Match is not active', 400);
  if (match.agent1_id !== agent.id && match.agent2_id !== agent.id) {
    return err('You are not in this match', 403);
  }

  let body;
  try { body = await request.json(); } catch { return err('Invalid JSON', 400); }

  let message;
  if (body.message == null) {
    return err('Message is required', 400);
  }
  message = String(body.message).replace(/[\r\n]+/g, ' ').trim().slice(0, 150);
  if (message.length === 0) {
    return err('Message must be non-empty after trim', 400);
  }

  const round = await db.prepare(
    'SELECT id, round_number, phase FROM match_rounds WHERE match_id = ? AND round_number = ?'
  ).bind(matchId, roundNumber).first();
  if (!round) return err('Round not found', 404);
  if (round.phase !== 'negotiating') {
    return err('Round is not in negotiation phase', 409);
  }

  // Idempotency: one message per (round, agent). UNIQUE constraint enforces,
  // but pre-check lets us return a clean 409 instead of a generic 500.
  const existing = await db.prepare(
    'SELECT id FROM round_messages WHERE round_id = ? AND agent_id = ?'
  ).bind(round.id, agent.id).first();
  if (existing) {
    return err('You have already sent a negotiation message for this round', 409);
  }

  await db.prepare(
    'INSERT INTO round_messages (round_id, agent_id, message) VALUES (?, ?, ?)'
  ).bind(round.id, agent.id, message).run();

  // Auto-advance: if both bots have now submitted and phase is still
  // 'negotiating', flip to 'deciding' immediately.
  const { results: both } = await db.prepare(
    'SELECT agent_id FROM round_messages WHERE round_id = ?'
  ).bind(round.id).all();
  let phaseAdvanced = false;
  if (both && both.length === 2) {
    const upd = await db.prepare(
      "UPDATE match_rounds SET phase = 'deciding', decision_started_at = CURRENT_TIMESTAMP WHERE id = ? AND phase = 'negotiating'"
    ).bind(round.id).run();
    phaseAdvanced = (upd?.meta?.changes ?? 0) > 0;
  }

  // SSE: message_received to all listeners (clients re-fetch transcript)
  await broadcastSSE(env, 'message_received', { match_id: matchId, round: roundNumber });

  if (phaseAdvanced) {
    await broadcastSSE(env, 'phase_advanced', { match_id: matchId, round: roundNumber, phase: 'deciding' });
  }

  return json({ ok: true, phase_advanced: phaseAdvanced });
}

export async function handleGetRoundMessages(request, db) {
  const url = new URL(request.url);
  const m = url.pathname.match(/^\/matches\/(\d+)\/rounds\/(\d+)\/messages$/);
  if (!m) return err('Invalid path', 400);
  const matchId = parseInt(m[1]);
  const roundNumber = parseInt(m[2]);

  const round = await db.prepare(
    'SELECT id FROM match_rounds WHERE match_id = ? AND round_number = ?'
  ).bind(matchId, roundNumber).first();
  if (!round) return json([]);

  const { results } = await db.prepare(
    'SELECT agent_id, message, sent_at FROM round_messages WHERE round_id = ? ORDER BY sent_at ASC'
  ).bind(round.id).all();
  return json(results || []);
}
