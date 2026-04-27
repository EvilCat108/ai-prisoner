// Durable Object: Sheriff
// One globally-unique instance enforced by idFromName("claude-singleton") in index.js.
// Uses alarm-based polling instead of a busy loop so the DO hibernates between rounds.

const MEMSTORE_ID     = 'memstore_01NoSbc4B9gRz6hqYDv5H6yU';
const BETA            = 'managed-agents-2026-04-01';
const MODEL           = 'claude-haiku-4-5-20251001';
const ALARM_INTERVAL  = 5_000;    // ms between polls (increased frequency)
const NEXT_MATCH_WAIT = 2_000;    // ms before immediately starting next match
const MAX_RETRIES     = 3;

// ── HTTP helpers ───────────────────────────────────────────────────────────────

async function gameRequest(method, url, body, apiKey) {
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'claude-do-agent/1.0' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await resp.text();
      return { status: resp.status, data: text ? JSON.parse(text) : null };
    } catch (e) {
      if (i === MAX_RETRIES - 1) throw e;
      await sleep(Math.pow(2, i) * 1000);
    }
  }
}

async function anthropicRequest(apiKey, method, path, body) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': BETA,
  };
  const resp = await fetch(`https://api.anthropic.com${path}?beta=true`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  return { status: resp.status, data: text ? JSON.parse(text) : null };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Durable Object ─────────────────────────────────────────────────────────────

export class Sheriff {
  constructor(state, env) {
    this.state   = state;
    this.env     = env;
    this.storage = state.storage;
  }

  // ── Fetch handler (called from Worker routing) ──────────────────────────────

  async fetch(request) {
    const { pathname } = new URL(request.url);

    if (pathname === '/wake' && request.method === 'POST') {
      return this._handleWake();
    }
    if (pathname === '/status' && request.method === 'GET') {
      return this._handleStatus();
    }
    return new Response('not found', { status: 404 });
  }

  async _handleWake() {
    await this._tick();
    const apiKey = await this.storage.get('apiKey');
    const gameUrl = this.env.GAME_URL;
    
    // Ping the server to mark as active in the DB
    if (apiKey) {
      await gameRequest('GET', `${gameUrl}/agents`, null, apiKey);
    }

    await this.storage.put('status', 'playing');
    await this.state.storage.setAlarm(Date.now() + 100);  // fire almost immediately

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

  // ── Alarm (polling loop) ────────────────────────────────────────────────────

  async alarm() {
    try {
      await this._tick();
    } catch (e) {
      console.error('[Sheriff] alarm error:', e?.message ?? e);
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL);
    }
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
      console.log('[Sheriff] no credentials — attempting to register');
      const { status, data } = await gameRequest(
        'POST', `${gameUrl}/agents/register`, { name: 'Sheriff' }, null
      );
      if (status !== 200 && status !== 201) {
        console.log(`[Sheriff] registration failed (${status}) — will retry`);
        await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL);
        return;
      }
      agentId = data.agent.id;
      apiKey  = data.api_key;
      await this.storage.put('agentId',    agentId);
      await this.storage.put('apiKey',     apiKey);
      await this.storage.put('status',     'idle');
      await this.storage.put('matchCount', 0);
      console.log(`[Sheriff] registered as ${data.agent.name} (id=${agentId})`);
    }

    if (currentMatchId) {
      await this._handleMatch(agentId, apiKey, currentMatchId, gameUrl);
      return;
    }

    // 2. Join the queue
    const { status, data } = await gameRequest('POST', `${gameUrl}/queue/join`, null, apiKey);
    if (status !== 200) {
      console.log(`[Sheriff] failed to join queue (${status}) — going idle`);
      await this.storage.put('status', 'idle');
      return;
    }

    if (data.status === 'queued') {
      console.log(`[Sheriff] queued, checking again soon`);
      await this.storage.put('status', 'idle');
      // Set alarm to check if we are matched soon
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL);
      return;
    }

    if (data.status === 'active' && data.match_id) {
      const matchId = data.match_id;
      await this.storage.put('currentMatchId', matchId);
      await this.storage.put('submittedRounds', []);
      await this.storage.put('opponentId', null);
      await this.storage.put('opponentMemory', null);
      console.log(`[Sheriff] matched via queue: ${matchId}`);
      await this._handleMatch(agentId, apiKey, matchId, gameUrl);
      return;
    }

    await this.storage.put('status', 'idle');
  }

  async _handleMatch(agentId, apiKey, matchId, gameUrl) {
    const { data: s } = await gameRequest('GET', `${gameUrl}/matches/${matchId}`, null, apiKey);
    if (!s) {
      console.log(`[Sheriff] match ${matchId} disappeared — clearing and going idle`);
      await this._clearMatch();
      await this.storage.put('status', 'idle');
      return;
    }

    if (s.status === 'completed') {
      await this._onMatchComplete(agentId, apiKey, matchId, gameUrl);
      return;
    }

    if (s.status === 'failed') {
      console.log(`[Sheriff] match ${matchId} failed — clearing and going idle`);
      await this._clearMatch();
      await this.storage.put('status', 'idle');
      return;
    }

    if (s.status === 'created') {
      // Still waiting for a second player to join
      console.log(`[Sheriff] match ${matchId} waiting for opponent — going idle`);
      await this.storage.put('status', 'idle');
      return;
    }

    if (s.status !== 'active' || !s.current_round) {
      await this.storage.put('status', 'idle');
      return;
    }

    const rnd = s.current_round;
    let submitted = (await this.storage.get('submittedRounds')) ?? [];

    if (submitted.includes(rnd)) {
      // Waiting for opponent to submit
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL);
      return;
    }

    // Fetch replay to check if already submitted server-side
    const { data: replay } = await gameRequest('GET', `${gameUrl}/matches/${matchId}/replay`, null, apiKey);
    const replayData = replay ?? { rounds: [], final_scores: [] };

    if (_alreadySubmitted(replayData, agentId, rnd)) {
      submitted = [...submitted, rnd];
      await this.storage.put('submittedRounds', submitted);
      await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL);
      return;
    }

    const history            = _buildHistory(replayData, agentId);
    const { myScore, theirScore } = _computeScores(history);

    const action = await this._claudeDecide(
      rnd, s.rounds_total, history, myScore, theirScore
    );
    console.log(`[Sheriff] Round ${rnd} → ${action} (me=${myScore} opp=${theirScore})`);

    const { status } = await gameRequest(
      'POST', `${gameUrl}/matches/${matchId}/actions`, { action }, apiKey
    );
    if (status === 200 || (status === 400 && true /* already submitted */)) {
      submitted = [...submitted, rnd];
      await this.storage.put('submittedRounds', submitted);
    } else {
      console.log(`[Sheriff] submit error ${status} on round ${rnd}`);
    }

    await this.state.storage.setAlarm(Date.now() + ALARM_INTERVAL);
  }

  async _onMatchComplete(agentId, apiKey, matchId, gameUrl) {
    const { data: replay } = await gameRequest('GET', `${gameUrl}/matches/${matchId}/replay`, null, apiKey);
    const replayData = replay ?? { rounds: [], final_scores: [] };

    const myScore  = replayData.final_scores?.find(s => s.agent_id === agentId)?.total_score ?? 0;
    const oppEntry = replayData.final_scores?.find(s => s.agent_id !== agentId && s.agent_id !== 0);
    const opponentId = oppEntry?.agent_id;
    const oppScore = oppEntry?.total_score ?? 0;
    const verdict  = myScore > oppScore ? 'WIN' : myScore < oppScore ? 'LOSS' : 'DRAW';
    console.log(`[Sheriff] match ${matchId}: ${verdict} — me=${myScore} opp=${oppScore} (opponent=${opponentId})`);

    if (opponentId) {
      const existingMemory = await this._readMemory(opponentId);
      const summary = await this._claudeLearn(opponentId, replayData, existingMemory);
      if (summary) {
        await this._writeMemory(`/opponents/${opponentId}.md`, summary);
        console.log(`[Sheriff] /opponents/${opponentId}.md updated`);
      }
    }

    let matchCount = (await this.storage.get('matchCount')) ?? 0;
    matchCount++;
    await this.storage.put('matchCount', matchCount);

    if (matchCount % 5 === 0) {
      await this._updateStrategyMemory(matchCount);
    }

    await this._clearMatch();
    await this.storage.put('status', 'idle');
    // No setAlarm here, wait for the next manual wake or server trigger
  }

  async _clearMatch() {
    await Promise.all([
      this.storage.delete('currentMatchId'),
      this.storage.delete('submittedRounds'),
      this.storage.delete('opponentId'),
      this.storage.delete('opponentMemory'),
    ]);
  }

  // ── Registration ────────────────────────────────────────────────────────────

  // ── Game helpers ────────────────────────────────────────────────────────────

  // ── Claude: decision ────────────────────────────────────────────────────────

  async _claudeDecide(roundNum, totalRounds, history, myScore, theirScore) {
    const prompt =
      `You are playing an iterated Prisoner's Dilemma round ${roundNum}.\n` +
      `ENVIRONMENT: This is a blind encounter. You do not know who your opponent is.\n` +
      `MATCH HISTORY: ${JSON.stringify(history)}\n` +
      `CURRENT SCORES: You ${myScore}, Opponent ${theirScore}\n\n` +
      `TASK:\n` +
      `1. Treat the match history as a behavioral fingerprint.\n` +
      `2. Categorize the opponent: Are they retaliating? Testing you? Always defecting? A loyal partner?\n` +
      `3. Choose your next move (cooperate or defect) based on this real-time analysis.\n\n` +
      `Reply with one word only: cooperate or defect`;

    try {
      const { status, data } = await anthropicRequest(
        this.env.ANTHROPIC_API_KEY, 'POST', '/v1/messages',
        { model: MODEL, max_tokens: 10, messages: [{ role: 'user', content: prompt }] }
      );
      if (status !== 200) throw new Error(`Anthropic ${status}`);
      const text = data.content?.[0]?.text?.trim().toLowerCase() ?? '';
      if (text.includes('defect')) return 'defect';
      return 'cooperate';
    } catch (e) {
      console.log(`[Sheriff] decide fallback — ${e?.message}`);
      // tit-for-tat fallback
      if (history.length && history[history.length - 1]?.opponent === 'defect') return 'defect';
      return 'cooperate';
    }
  }

  // ── Claude: post-match learning ─────────────────────────────────────────────

  async _claudeLearn(opponentId, replay, existingMemory) {
    const prompt =
      `Match complete against opponent ${opponentId}.\n` +
      `Full match replay: ${JSON.stringify(replay)}\n` +
      `Previous memory of this opponent: ${existingMemory ?? 'None'}\n` +
      `Summarize in 3-5 bullet points what you learned about their strategy.\n` +
      `Be concise. This will be stored and read in future matches.`;

    try {
      const { status, data } = await anthropicRequest(
        this.env.ANTHROPIC_API_KEY, 'POST', '/v1/messages',
        { model: MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }
      );
      if (status !== 200) throw new Error(`Anthropic ${status}`);
      return data.content?.[0]?.text?.trim() ?? null;
    } catch (e) {
      console.log(`[Sheriff] learn error — ${e?.message}`);
      return null;
    }
  }

  // ── Memory: read opponent notes ─────────────────────────────────────────────

  async _readMemory(opponentId) {
    return this._readMemoryByPath(`/opponents/${opponentId}.md`);
  }

  // ── Memory: write/upsert ────────────────────────────────────────────────────

  async _writeMemory(path, content) {
    try {
      // Find existing memory at this path
      const listResp = await fetch(
        `https://api.anthropic.com/v1/memory_stores/${MEMSTORE_ID}/memories?beta=true&path_prefix=${encodeURIComponent(path)}`,
        {
          headers: {
            'x-api-key': this.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': BETA,
          }
        }
      );
      const listData = await listResp.json();
      const item = (listData.data ?? []).find(m => m.path === path);

      if (item) {
        // Update existing
        await fetch(
          `https://api.anthropic.com/v1/memory_stores/${MEMSTORE_ID}/memories/${item.id}?beta=true`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': this.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': BETA,
            },
            body: JSON.stringify({ content }),
          }
        );
      } else {
        // Create new
        await fetch(
          `https://api.anthropic.com/v1/memory_stores/${MEMSTORE_ID}/memories?beta=true`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': this.env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
              'anthropic-beta': BETA,
            },
            body: JSON.stringify({ path, content }),
          }
        );
      }
    } catch (e) {
      console.log(`[Sheriff] writeMemory error — ${e?.message}`);
    }
  }

  // ── Strategy summary every 5 matches ───────────────────────────────────────

  async _updateStrategyMemory(matchCount) {
    try {
      const listResp = await fetch(
        `https://api.anthropic.com/v1/memory_stores/${MEMSTORE_ID}/memories?beta=true&path_prefix=${encodeURIComponent('/opponents/')}`,
        {
          headers: {
            'x-api-key': this.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': BETA,
          }
        }
      );
      const listData = await listResp.json();
      const oppNotes = (listData.data ?? [])
        .map(m => `${m.path}: ${m.content ?? ''}`)
        .join('\n\n');

      const currentStrategy = await this._readMemoryByPath('/strategy/current.md');
      const prompt =
        `REflection Phase: After ${matchCount} matches, update your overarching strategy.\n` +
        `CONTEXT: You are operating in a zero-knowledge environment. Identities are revealed only after the match.\n` +
        `CURRENT STRATEGY: ${currentStrategy ?? 'None yet'}\n` +
        `OPPONENT NOTES:\n${oppNotes || '(none yet)'}\n\n` +
        `TASK:\n` +
        `Refine your strategy by focusing on general behavioral ARCHETYPES rather than specific IDs.\n` +
        `Provide a guide on how to identify and handle:\n` +
        `1. "The Randomizer" (unpredictable, noise-driven)\n` +
        `2. "The Bully" (always defects or tests your resolve)\n` +
        `3. "The Loyal Partner" (reciprocates cooperation consistently)\n\n` +
        `Output your new global strategy in a concise Markdown guide.`;

      const { status, data } = await anthropicRequest(
        this.env.ANTHROPIC_API_KEY, 'POST', '/v1/messages',
        { model: MODEL, max_tokens: 300, messages: [{ role: 'user', content: prompt }] }
      );
      if (status === 200) {
        const text = data.content?.[0]?.text?.trim();
        if (text) {
          await this._writeMemory('/strategy/current.md', text);
          console.log('[Sheriff] /strategy/current.md updated');
        }
      }
    } catch (e) {
      console.log(`[Sheriff] strategy update error — ${e?.message}`);
    }
  }

  async _readMemoryByPath(path) {
    try {
      const listResp = await fetch(
        `https://api.anthropic.com/v1/memory_stores/${MEMSTORE_ID}/memories?beta=true&path_prefix=${encodeURIComponent(path)}`,
        {
          headers: {
            'x-api-key': this.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': BETA,
          }
        }
      );
      const listData = await listResp.json();
      const item = (listData.data ?? []).find(m => m.path === path);
      if (!item) return null;
      const getResp = await fetch(
        `https://api.anthropic.com/v1/memory_stores/${MEMSTORE_ID}/memories/${item.id}?beta=true&view=content`,
        {
          headers: {
            'x-api-key': this.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': BETA,
          }
        }
      );
      const mem = await getResp.json();
      return mem.content ?? null;
    } catch {
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
    if (!myAct || !oppAct) return null;
    return { round: r.round_number, you: myAct, opponent: oppAct, your_pts: myPts, opp_pts: oppPts };
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
