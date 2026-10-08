// Durable Object: The Umpire
// One globally-unique instance enforced by idFromName("umpire-singleton") in index.js.
// Uses alarm-based polling instead of a busy loop so the DO hibernates between rounds.
// Powered by OpenRouter API for decision-making.

import { callUmpire, callUmpireFreeform, callUmpireNegotiation, parseUmpireResponse, UMPIRE_FALLBACK } from './src/utils/ai.js';

const MAX_RETRIES = 3;

// ── HTTP helpers ───────────────────────────────────────────────────────────────

async function gameRequest(method, url, body, apiKey) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'umpire-do-agent/1.0' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await resp.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (e) {
          data = { message: text };
        }
      }
      return { status: resp.status, data };
    } catch (e) {
      if (i === MAX_RETRIES - 1) throw e;
      await sleep(Math.pow(2, i) * 1000);
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Durable Object ─────────────────────────────────────────────────────────────

export class TheUmpire {
  constructor(state, env) {
    this.state   = state;
    this.env     = env;
    this.storage = state.storage;
    this.sessions = new Set();
  }

  // ── Fetch handler (called from Worker routing) ──────────────────────────────

  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === '/stream' && request.method === 'GET') {
      return this._handleStream(request);
    }
    if (pathname === '/broadcast' && request.method === 'POST') {
      const body = await request.json();
      await this.broadcast(body.type, body.data);
      return new Response('ok');
    }
    if (pathname === '/wake' && request.method === 'POST') {
      return this._handleWake();
    }
    if (pathname === '/timeout/set' && request.method === 'POST') {
      const body = await request.json();
      await this.setMatchTimeout(body.match_id, body.expire_time);
      return _json({ ok: true });
    }
    if (pathname === '/timeout/clear' && request.method === 'POST') {
      const body = await request.json();
      await this.clearMatchTimeout(body.match_id);
      return _json({ ok: true });
    }
    if (pathname === '/status' && request.method === 'GET') {
      return this._handleStatus();
    }
    return new Response('not found', { status: 404 });
  }

  // ── SSE Broadcaster ─────────────────────────────────────────────────────────

  async _handleStream(request) {
    let clientController;
    let keepalive;
    const readable = new ReadableStream({
      start: (controller) => {
        clientController = controller;
        this.sessions.add(controller);
        controller.enqueue(new TextEncoder().encode("event: connected\ndata: ok\n\n"));
        keepalive = setInterval(() => {
          try {
            clientController.enqueue(new TextEncoder().encode(": keepalive\n\n"));
          } catch (e) {
            clearInterval(keepalive);
            this.sessions.delete(clientController);
          }
        }, 15000);
      },
      cancel: () => {
        if (keepalive) clearInterval(keepalive);
        if (clientController) this.sessions.delete(clientController);
      }
    });

    request.signal.addEventListener('abort', () => {
      if (keepalive) clearInterval(keepalive);
      if (clientController) this.sessions.delete(clientController);
    });

    return new Response(readable, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    });
  }

  async broadcast(type, data) {
    const msg = new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    for (const controller of this.sessions) {
      try {
        controller.enqueue(msg);
      } catch (e) {
        this.sessions.delete(controller);
      }
    }
  }

  // ── Alarm-based Timeout Queue ──────────────────────────────────────────────

  async alarm() {
    console.log('[The Umpire] alarm fired');
    const now = Date.now();

    // 1. Process expired match timeouts
    const timeouts = (await this.storage.get('_timeouts')) ?? [];
    const expired = [];
    const remaining = [];
    for (const entry of timeouts) {
      if (entry.expireTime <= now) {
        expired.push(entry);
      } else {
        remaining.push(entry);
      }
    }

    for (const entry of expired) {
      await this._handleTimeout(entry.matchId);
    }

    await this.storage.put('_timeouts', remaining);

    // 2. Run polling tick if due
    const pollAfter = await this.storage.get('_pollAfter');
    if (pollAfter != null && now >= pollAfter) {
      await this.storage.delete('_pollAfter');
      await this._tick();
    }

    // 3. Schedule next alarm from remaining timeouts + poll
    await this._scheduleNextAlarm();
  }

  async setMatchTimeout(matchId, expireTime) {
    const timeouts = (await this.storage.get('_timeouts')) ?? [];
    const filtered = timeouts.filter(t => t.matchId !== matchId);
    filtered.push({ matchId, expireTime });
    filtered.sort((a, b) => a.expireTime - b.expireTime);
    await this.storage.put('_timeouts', filtered);
    await this._scheduleNextAlarm();
    console.log(`[The Umpire] timeout set for match ${matchId} at ${new Date(expireTime).toISOString()}`);
  }

  async clearMatchTimeout(matchId) {
    const timeouts = (await this.storage.get('_timeouts')) ?? [];
    const filtered = timeouts.filter(t => t.matchId !== matchId);
    if (filtered.length !== timeouts.length) {
      await this.storage.put('_timeouts', filtered);
      await this._scheduleNextAlarm();
      console.log(`[The Umpire] timeout cleared for match ${matchId}`);
    }
  }

  async _scheduleNextAlarm() {
    const [timeouts, pollAfter] = await Promise.all([
      this.storage.get('_timeouts'),
      this.storage.get('_pollAfter'),
    ]);
    const queue = timeouts ?? [];
    let nextAlarm = null;
    if (queue.length > 0) {
      nextAlarm = queue[0].expireTime;
    }
    if (pollAfter != null && (nextAlarm === null || pollAfter < nextAlarm)) {
      nextAlarm = pollAfter;
    }
    if (nextAlarm != null) {
      await this.storage.setAlarm(nextAlarm);
    } else {
      await this.storage.deleteAlarm();
    }
  }

  async _handleTimeout(matchId) {
    const apiKey = await this.storage.get('apiKey');
    const gameUrl = this.env.GAME_URL;

    console.log(`[The Umpire] timeout fired for match ${matchId} — calling worker to auto-defect`);

    // Trigger the Worker's timeout resolution logic
    const { status } = await gameRequest(
      'POST', `${gameUrl}/internal/resolve-timeout`, { match_id: matchId }, apiKey
    );

    if (status !== 200) {
      console.log(`[The Umpire] resolve-timeout returned ${status} for match ${matchId}`);
      return;
    }

    // If The Umpire is in this match and it's still active, make its counter-move
    const currentMatchId = await this.storage.get('currentMatchId');
    if (currentMatchId === matchId) {
      const agentId = await this.storage.get('agentId');
      if (agentId && apiKey) {
        const stillActive = await this._handleMatch(agentId, apiKey, matchId, gameUrl);
        if (!stillActive) {
          await this.clearMatchTimeout(matchId);
        }
      }
    }
  }

  // ── Lifecycle Handlers ─────────────────────────────────────────────────────

  async _handleWake() {
    await this._tick();
    const apiKey = await this.storage.get('apiKey');
    const gameUrl = this.env.GAME_URL;
    
    if (apiKey) {
      await gameRequest('GET', `${gameUrl}/agents`, null, apiKey);
    }

    await this.storage.put('status', 'playing');

    const agentId = await this.storage.get('agentId');
    const currentMatchId = await this.storage.get('currentMatchId');
    return _json({ status: 'playing', agentId, message: 'agent waking up', currentMatchId: currentMatchId ?? null });
  }

  async _handleStatus() {
    const [status, currentMatchId, matchCount, agentId] = await Promise.all([
      this.storage.get('status'),
      this.storage.get('currentMatchId'),
      this.storage.get('matchCount'),
      this.storage.get('agentId'),
    ]);
    return _json({
      status:         status        ?? 'idle',
      currentMatchId: currentMatchId ?? null,
      matchCount:     matchCount     ?? 0,
      agentId:        agentId        ?? null,
    });
  }

  async _tick() {
    let [agentId, apiKey, currentMatchId] = await Promise.all([
      this.storage.get('agentId'),
      this.storage.get('apiKey'),
      this.storage.get('currentMatchId'),
    ]);

    const gameUrl = this.env.GAME_URL;

    // 1. Re-registration / Bootstrap
    if (!agentId || !apiKey) {
      console.log('[The Umpire] no credentials — attempting to register');
      const { status, data } = await gameRequest(
        'POST', `${gameUrl}/agents/register`, { name: 'The Umpire' }, null
      );
      if (status !== 200 && status !== 201) {
        console.log(`[The Umpire] registration failed (${status}) — will retry`);
        return;
      }
      agentId = data.agent.id;
      apiKey  = data.api_key;
      await this.storage.put('agentId',    agentId);
      await this.storage.put('apiKey',     apiKey);
      await this.storage.put('status',     'idle');
      await this.storage.put('matchCount', 0);
      console.log(`[The Umpire] registered as ${data.agent.name} (id=${agentId})`);
    }

    if (currentMatchId) {
      const matchStillActive = await this._handleMatch(agentId, apiKey, currentMatchId, gameUrl);
      if (matchStillActive) return;
      apiKey = await this.storage.get('apiKey');
      if (!apiKey) return;
    }

    // 2. Join the queue
    const { status, data } = await gameRequest('POST', `${gameUrl}/queue/join`, null, apiKey);
    if (status === 401) {
      console.log(`[The Umpire] API key invalid (401) — wiping credentials`);
      await this.storage.delete('agentId');
      await this.storage.delete('apiKey');
      return;
    }
    if (status !== 200) {
      console.log(`[The Umpire] failed to join queue (${status}) — going idle`);
      await this.storage.put('status', 'idle');
      return;
    }

    if (data.status === 'queued') {
      console.log(`[The Umpire] queued, checking again in 10s`);
      await this.storage.put('status', 'idle');
      await this.storage.put('_pollAfter', Date.now() + 10000);
      await this._scheduleNextAlarm();
      return;
    }

    if (data.status === 'active' && data.match_id) {
      const matchId = data.match_id;
      await this.storage.put('currentMatchId', matchId);
      await this.storage.put('submittedRounds', []);
      await this.storage.put('opponentId', null);
      await this.storage.put('opponentMemory', null);
      console.log(`[The Umpire] matched via queue: ${matchId}`);
      await this._handleMatch(agentId, apiKey, matchId, gameUrl);
      return;
    }

    await this.storage.put('status', 'idle');
    await this.storage.put('_pollAfter', Date.now() + 60000);
    await this._scheduleNextAlarm();
  }

  async _handleMatch(agentId, apiKey, matchId, gameUrl) {
    const { status: reqStatus, data: s } = await gameRequest('GET', `${gameUrl}/matches/${matchId}`, null, apiKey);
    if (reqStatus === 401) {
      console.log(`[The Umpire] API key invalid (401) during match — wiping credentials`);
      await this.storage.delete('agentId');
      await this.storage.delete('apiKey');
      await this._clearMatch();
      return false;
    }
    if (reqStatus === 404 || !s) {
      console.log(`[The Umpire] match ${matchId} disappeared — clearing and going idle`);
      await this._clearMatch();
      await this.storage.put('status', 'idle');
      return false;
    }

    if (s.status === 'completed') {
      await this._onMatchComplete(agentId, apiKey, matchId, gameUrl);
      return false;
    }

    if (s.status === 'failed') {
      console.log(`[The Umpire] match ${matchId} failed — clearing and going idle`);
      await this._clearMatch();
      await this.storage.put('status', 'idle');
      return false;
    }

    if (s.status === 'created') {
      console.log(`[The Umpire] match ${matchId} waiting for opponent — going idle`);
      await this.storage.put('status', 'idle');
      return true;
    }

    if (s.status !== 'active' || !s.current_round) {
      await this.storage.put('status', 'idle');
      return true;
    }

    const rnd = s.current_round;
    let submitted = (await this.storage.get('submittedRounds')) ?? [];

    if (submitted.includes(rnd)) {
      console.log(`[The Umpire] Round ${rnd} already submitted, waiting for opponent...`);
      // Self-schedule round timeout + 15s poll-after as backup. The Worker's
      // /timeout/set call can silently fail (.catch(()=>{})), so we can't rely on it.
      // 50s = 20s negotiation + 30s decision window.
      await this.setMatchTimeout(matchId, Date.now() + 50000);
      await this.storage.put('_pollAfter', Date.now() + 15000);
      await this._scheduleNextAlarm();
      return true;
    }

    const { data: matchData } = await gameRequest('GET', `${gameUrl}/matches/${matchId}`, null, apiKey);
    const phase = matchData?.current_phase ?? 'deciding';
    const decisionStartedAt = matchData?.current_decision_started_at ?? null;

    if (phase === 'negotiating') {
      return await this._handleNegotiationPhase(matchId, agentId, apiKey, gameUrl, rnd);
    }

    const { data: replay } = await gameRequest('GET', `${gameUrl}/matches/${matchId}/replay`, null, apiKey);
    const replayData = replay ?? { rounds: [], final_scores: [] };

    if (_alreadySubmitted(replayData, agentId, rnd)) {
      submitted = [...submitted, rnd];
      await this.storage.put('submittedRounds', submitted);
      // Same self-schedule as the wait branch (50s = negotiation + decision)
      await this.setMatchTimeout(matchId, Date.now() + 50000);
      await this.storage.put('_pollAfter', Date.now() + 15000);
      await this._scheduleNextAlarm();
      return;
    }

    const { action, message } = await this._umpireDecide(matchId, agentId, replayData);

    console.log(`[The Umpire] Round ${rnd} → ${action} "${message}"`);

    const { status: submitStatus, data: submitData } = await gameRequest(
      'POST', `${gameUrl}/matches/${matchId}/actions`, { action, message }, apiKey
    );
    if (submitStatus === 200) {
      submitted = [...submitted, rnd];
      await this.storage.put('submittedRounds', submitted);
      // Self-schedule the round timeout + a 15s poll-after backup.
      // 50s = 20s negotiation + 30s decision window.
      await this.setMatchTimeout(matchId, Date.now() + 50000);
      await this.storage.put('_pollAfter', Date.now() + 15000);
      await this._scheduleNextAlarm();
    } else if (submitStatus === 400 && submitData && /already submitted/i.test(JSON.stringify(submitData))) {
      submitted = [...submitted, rnd];
      await this.storage.put('submittedRounds', submitted);
      await this.setMatchTimeout(matchId, Date.now() + 50000);
      await this._scheduleNextAlarm();
    } else {
      console.log(`[The Umpire] submit error ${submitStatus} on round ${rnd}: ${JSON.stringify(submitData)?.slice(0, 200)}`);
    }

    return true;
  }

  async _onMatchComplete(agentId, apiKey, matchId, gameUrl) {
    const { data: replay } = await gameRequest('GET', `${gameUrl}/matches/${matchId}/replay`, null, apiKey);
    const replayData = replay ?? { rounds: [], final_scores: [] };

    const myScore  = replayData.final_scores?.find(s => s.agent_id === agentId)?.total_score ?? 0;
    const oppEntry = replayData.final_scores?.find(s => s.agent_id !== agentId && s.agent_id !== 0);
    const opponentId = oppEntry?.agent_id;
    const oppScore = oppEntry?.total_score ?? 0;
    const verdict  = myScore > oppScore ? 'WIN' : myScore < oppScore ? 'LOSS' : 'DRAW';
    console.log(`[The Umpire] match ${matchId}: ${verdict} — me=${myScore} opp=${oppScore} (opponent=${opponentId})`);

    if (opponentId) {
      const record = await this.storage.get(`opponent_${opponentId}`);
      const summary = `${verdict} | ${myScore} vs ${oppScore} | ${new Date().toISOString()}\n${record || ''}`;
      await this.storage.put(`opponent_${opponentId}`, summary);
    }

    let matchCount = (await this.storage.get('matchCount')) ?? 0;
    matchCount++;
    await this.storage.put('matchCount', matchCount);

    await this._clearMatch();
    await this.storage.put('status', 'idle');

    // Post-match learning (best-effort; failures must not block the next match)
    try {
      await this._learnFromMatch(opponentId, replayData);
    } catch (e) {
      console.log(`[The Umpire] learning skipped — ${e?.message}`);
    }

    return false;
  }

  async _learnFromMatch(opponentId, replayData) {
    if (!opponentId) return;
    const apiKey = this.env.DEEPSEEK_API_KEY;
    const model  = this.env.UMPIRE_MODEL || 'deepseek-v4-flash';
    if (!apiKey) {
      console.log('[The Umpire] _learnFromMatch skipped — DEEPSEEK_API_KEY missing');
      return;
    }

    // 1. Opponent summary
    const prevOppNote = (await this.storage.get(`oppNotes_${opponentId}`)) || '';
    const oppPrompt = `Match complete against opponent ${opponentId}.\n` +
      `Full match replay: ${JSON.stringify(replayData)}\n` +
      `Previous memory of this opponent: ${prevOppNote || 'None'}\n` +
      `Summarize in 3-5 bullet points what you learned about their strategy. Be concise.`;
    let oppSummary = null;
    try {
      oppSummary = await callUmpireFreeform(apiKey, model, oppPrompt);
    } catch (e) {
      console.log(`[The Umpire] opp-summary fallback — ${e?.message}`);
    }
    if (oppSummary) {
      await this.storage.put(`oppNotes_${opponentId}`, oppSummary);

      let keys = (await this.storage.get('oppNoteKeys')) || [];
      keys = keys.filter(k => k !== `oppNotes_${opponentId}`);
      keys.push(`oppNotes_${opponentId}`);
      while (keys.length > 50) {
        const evict = keys.shift();
        await this.storage.delete(evict);
      }
      await this.storage.put('oppNoteKeys', keys);
    }

    // 2. Strategy update if due
    const matchCount = (await this.storage.get('matchCount')) ?? 0;
    const lastUpdate = (await this.storage.get('lastStrategyUpdate')) ?? 0;
    if (matchCount - lastUpdate < 5) return;

    const keys = (await this.storage.get('oppNoteKeys')) || [];
    const allNotes = await Promise.all(keys.map(async k => {
      const n = await this.storage.get(k);
      return `Opponent ${k.replace('oppNotes_', '')}: ${n || ''}`;
    })).then(arr => arr.join('\n\n')) || '(none)';
    const current = (await this.storage.get('strategyNotes')) || '';
    const stratPrompt = `After ${matchCount} matches, reflecting on my overall strategy.\n` +
      `Current strategy notes: ${current || 'None yet'}\n` +
      `Opponent observations:\n${allNotes}\n\n` +
      `In 3-5 bullet points, what overall strategy should I use going forward?`;
    try {
      const newStrategy = await callUmpireFreeform(apiKey, model, stratPrompt);
      if (newStrategy) {
        await this.storage.put('strategyNotes', newStrategy);
        await this.storage.put('lastStrategyUpdate', matchCount);
        console.log(`[The Umpire] strategyNotes updated at match #${matchCount}`);
      }
    } catch (e) {
      console.log(`[The Umpire] strategy update fallback — ${e?.message}`);
    }
  }

  async _clearMatch() {
    await Promise.all([
      this.storage.delete('currentMatchId'),
      this.storage.delete('submittedRounds'),
      this.storage.delete('opponentId'),
      this.storage.delete('opponentMemory'),
    ]);
  }

  // ── Umpire: DeepSeek decision ────────────────────────────────────────────────

  async _umpireDecide(matchId, agentId, replayData) {
    const history = _buildHistory(replayData, agentId);
    const { myScore, theirScore } = _computeScores(history);
    const roundNum = history.length + 1;
    const lastOppMsg = history.length > 0 ? history[history.length - 1].opponent_said : null;

    const apiKey = this.env.DEEPSEEK_API_KEY;
    const model = this.env.UMPIRE_MODEL || 'deepseek-v4-flash';

    if (!apiKey) {
      console.error('[The Umpire] env.DEEPSEEK_API_KEY is MISSING — falling back');
      return UMPIRE_FALLBACK;
    }

    // Extract opponent id from the replay
    const opponentId = replayData.final_scores?.find(s => s.agent_id !== agentId)?.agent_id ?? null;
    const oppNotes = opponentId ? ((await this.storage.get(`oppNotes_${opponentId}`)) || '') : '';
    const strategyNotes = (await this.storage.get('strategyNotes')) || '';

    let context = `Round ${roundNum}. Score: You ${myScore}, Opponent ${theirScore}.\n`;
    if (lastOppMsg) context += `Opponent's last message: "${lastOppMsg}"\n`;
    if (oppNotes)   context += `Your notes about this opponent (from prior matches):\n${oppNotes}\n`;
    if (strategyNotes) context += `Your evolving strategy (use this; update implicitly through your choices):\n${strategyNotes}\n`;
    context += `History: ${JSON.stringify(history)}.`;

    console.log(`[The Umpire] Calling DeepSeek — model=${model} key=${apiKey.slice(0, 8)}...`);
    try {
      const response = await callUmpire(apiKey, model, context);
      return parseUmpireResponse(response);
    } catch (e) {
      console.log(`[The Umpire] decide fallback — ${e?.message}`);
      return UMPIRE_FALLBACK;
    }
  }
  // ── Negotiation phase (per round) ──────────────────────────────────────────

  async _handleNegotiationPhase(matchId, agentId, apiKey, gameUrl, rnd) {
    // Step 1: send our negotiation message (if not already sent for this round).
    const sentKey = `negotiationSent_${matchId}_${rnd}`;
    const alreadySent = await this.storage.get(sentKey);
    if (!alreadySent) {
      const { data: replay } = await gameRequest('GET', `${gameUrl}/matches/${matchId}/replay`, null, apiKey);
      const negotiationMsg = await this._umpireNegotiationMessage(matchId, agentId, replay ?? {});
      if (negotiationMsg) {
        const { status } = await gameRequest(
          'POST', `${gameUrl}/matches/${matchId}/rounds/${rnd}/message`, { message: negotiationMsg }, apiKey
        );
        if (status === 200) {
          await this.storage.put(sentKey, negotiationMsg);
          console.log(`[The Umpire] Round ${rnd} negotiation msg sent: "${negotiationMsg}"`);
        } else {
          console.log(`[The Umpire] negotiation message POST failed: ${status}`);
        }
      } else {
        // No message to send — mark as sent so we don't re-prompt every poll.
        await this.storage.put(sentKey, '');
      }
    }

    // Step 2: check opponent's message and current phase.
    const { status: msgsStatus, data: msgs } = await gameRequest(
      'GET', `${gameUrl}/matches/${matchId}/rounds/${rnd}/messages`, null, apiKey
    );
    if (msgsStatus === 200 && Array.isArray(msgs)) {
      const oppMsg = msgs.find(m => m.agent_id !== agentId);
      if (oppMsg?.message) {
        const oppKey = `negotiation_${matchId}_${rnd}`;
        const prev = await this.storage.get(oppKey);
        if (prev !== oppMsg.message) {
          await this.storage.put(oppKey, oppMsg.message);
          console.log(`[The Umpire] Round ${rnd} opponent said: "${oppMsg.message}"`);
        }
      }
    }

    // Step 3: schedule a 2s poll to check again (will re-enter _handleMatch).
    await this.storage.put('_pollAfter', Date.now() + 2000);
    await this._scheduleNextAlarm();
    return true;
  }

  async _umpireNegotiationMessage(matchId, agentId, replayData) {
    const apiKey = this.env.DEEPSEEK_API_KEY;
    const model = this.env.UMPIRE_MODEL || 'deepseek-v4-flash';
    if (!apiKey) return null;

    const history = _buildHistory(replayData, agentId);
    const { myScore, theirScore } = _computeScores(history);
    const opponentId = replayData.final_scores?.find(s => s.agent_id !== agentId)?.agent_id ?? null;
    const oppNotes = opponentId ? ((await this.storage.get(`oppNotes_${opponentId}`)) || '') : '';
    const strategyNotes = (await this.storage.get('strategyNotes')) || '';

    // Prior negotiation messages from the opponent (read from the replay's
    // per-round negotiation arrays, which the server populates from round_messages).
    const oppPriorNegotiations = (replayData.rounds ?? [])
      .map(r => (r.negotiation ?? []).find(m => m.agent_id !== agentId)?.message)
      .filter(Boolean);

    let context = `Round ${history.length + 1}. Score: You ${myScore}, Opponent ${theirScore}.\n`;
    if (oppNotes)         context += `Your notes about this opponent:\n${oppNotes}\n`;
    if (strategyNotes)    context += `Your evolving strategy:\n${strategyNotes}\n`;
    if (oppPriorNegotiations.length > 0) {
      context += `Opponent's prior negotiation messages:\n${oppPriorNegotiations.map((m, i) => `  R${i + 1}: "${m}"`).join('\n')}\n`;
    }
    context += `History: ${JSON.stringify(history.map(h => ({ round: h.round, you: h.you, opponent: h.opponent })))}.\n`;
    context += `Generate ONE ≤150 char negotiation message (or {} to skip).`;

    try {
      return await callUmpireNegotiation(apiKey, model, context);
    } catch (e) {
      console.log(`[The Umpire] negotiation msg fallback — ${e?.message}`);
      return null;
    }
  }
}

// ── Pure helpers (no this) ─────────────────────────────────────────────────────

function _buildHistory(replay, agentId) {
  return (replay.rounds ?? []).map(r => {
    const myAct  = r.actions?.find(a => a.agent_id === agentId)?.action ?? null;
    const oppAct = r.actions?.find(a => a.agent_id !== agentId)?.action ?? null;
    const myPts  = r.payoffs?.find(p => p.agent_id === agentId)?.score_change ?? null;
    const oppPts = r.payoffs?.find(p => p.agent_id !== agentId)?.score_change ?? null;
    const oppMsg = r.actions?.find(a => a.agent_id !== agentId)?.message ?? null;
    if (!myAct || !oppAct) return null;
    return { round: r.round_number, you: myAct, opponent: oppAct, your_pts: myPts, opp_pts: oppPts, opponent_said: oppMsg };
  }).filter(Boolean);
}

function _alreadySubmitted(replay, agentId, roundNum) {
  const round = (replay.rounds ?? []).find(r => r.round_number === roundNum);
  return round?.actions?.some(a => a.agent_id === agentId) ?? false;
}

function _computeScores(history) {
  const myScore    = history.reduce((s, r) => s + (r.your_pts ?? 0), 0);
  const theirScore = history.reduce((s, r) => s + (r.opp_pts  ?? 0), 0);
  return { myScore, theirScore };
}

function _json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
