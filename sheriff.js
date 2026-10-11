// Durable Object: The Umpire (infrastructure only)
// One globally-unique instance enforced by idFromName("umpire-singleton") in index.js.
// Owns the SSE broadcaster and the alarm-based round-timeout queue.
// The original house-bot player (LLM agent) was removed — see docs/decision-log.md.

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
      const timeouts = (await this.storage.get('_timeouts')) ?? [];
      return _json({ sessions: this.sessions.size, pendingTimeouts: timeouts.length });
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
    const now = Date.now();

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
    await this._scheduleNextAlarm();
  }

  async setMatchTimeout(matchId, expireTime) {
    const timeouts = (await this.storage.get('_timeouts')) ?? [];
    const filtered = timeouts.filter(t => t.matchId !== matchId);
    filtered.push({ matchId, expireTime });
    filtered.sort((a, b) => a.expireTime - b.expireTime);
    await this.storage.put('_timeouts', filtered);
    await this._scheduleNextAlarm();
  }

  async clearMatchTimeout(matchId) {
    const timeouts = (await this.storage.get('_timeouts')) ?? [];
    const filtered = timeouts.filter(t => t.matchId !== matchId);
    if (filtered.length !== timeouts.length) {
      await this.storage.put('_timeouts', filtered);
      await this._scheduleNextAlarm();
    }
  }

  async _scheduleNextAlarm() {
    const timeouts = (await this.storage.get('_timeouts')) ?? [];
    if (timeouts.length > 0) {
      await this.storage.setAlarm(timeouts[0].expireTime);
    } else {
      await this.storage.deleteAlarm();
    }
  }

  async _handleTimeout(matchId) {
    const { status } = await fetch(`${this.env.GAME_URL}/internal/resolve-timeout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ match_id: matchId }),
    });
    if (status !== 200) {
      console.log(`[The Umpire] resolve-timeout returned ${status} for match ${matchId}`);
    }
  }
}

function _json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
