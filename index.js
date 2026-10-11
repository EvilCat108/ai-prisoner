import { resolveTimedOutRounds } from './src/engine/resolver.js';
import { broadcastSSE, logToDb, json } from './src/utils/helpers.js';
import * as agentController from './src/controllers/agentController.js';
import * as matchController from './src/controllers/matchController.js';
import * as arenaController from './src/controllers/arenaController.js';

export { TheUmpire } from './sheriff.js';

async function runWeeklyEloDecay(env, db) {
  const result = await db.prepare(`
    UPDATE agents
       SET elo = MAX(1000, elo - 5)
     WHERE is_provisional = 0
       AND id IN (
         SELECT agent_id FROM agent_stats
          WHERE last_match_at < datetime('now', '-7 days')
             OR last_match_at IS NULL
       )
  `).run();
  const decayed = result?.meta?.changes ?? 0;
  await logToDb(db, 'INFO', `Weekly ELO decay: ${decayed} agents decayed by 5 (floor 1000).`);
  return decayed;
}

export default {
  async scheduled(event, env, ctx) {
    const db = env.DB;
    try {
      if (event.cron === '0 0 * * 0') {
        await runWeeklyEloDecay(env, db);
      }
    } catch (e) {
      console.error('[Worker] scheduled handler failed:', e);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const db = env.DB;

    const accept = request.headers.get('Accept') || '';
    const wantsJson = url.searchParams.get('format') === 'json' || 
                      accept.includes('application/json') || 
                      accept === '*/*' || 
                      accept === '';
    const wantsHtml = !wantsJson && accept.includes('text/html');

    try {

      // ── GET /stream ─────────────────────────────────────────────────────────
      if (path === '/stream' && method === 'GET') {
        const doId = env.UMPIRE.idFromName('umpire-singleton');
        const doObj = env.UMPIRE.get(doId);
        return doObj.fetch(request);
      }

      // ── GET / ───────────────────────────────────────────────────────────────
      if (path === '/' && method === 'GET') {
        return arenaController.handleHomePage(request, env, db, wantsHtml);
      }

      // ── POST /agents/register ───────────────────────────────────────────────
      if (path === '/agents/register' && method === 'POST') {
        return agentController.handleRegisterAgent(request, env, db);
      }

      // ── GET /agents ─────────────────────────────────────────────────────────
      if (path === '/agents' && method === 'GET') {
        return agentController.handleGetAgents(request, env, db, wantsJson);
      }

      // ── GET /arena ──────────────────────────────────────────────────────────
      if (path === '/arena' && method === 'GET') {
        return arenaController.handleArena(request, env, db, wantsJson);
      }

      // ── GET /matches ────────────────────────────────────────────────────────
      if (path === '/matches' && method === 'GET') {
        return matchController.handleGetMatches(request, env, db, wantsJson);
      }

      // ── POST /queue/join ───────────────────────────────────────────────────
      if (path === '/queue/join' && method === 'POST') {
        return agentController.handleQueueJoin(request, env, db);
      }

      // ── GET /matches/{id}/replay ────────────────────────────────────────────
      if (/^\/matches\/\d+\/replay$/.test(path) && method === 'GET') {
        return matchController.handleGetMatchReplay(request, db);
      }

      // ── POST /matches/{id}/actions ──────────────────────────────────────────
      if (/^\/matches\/\d+\/actions$/.test(path) && method === 'POST') {
        return matchController.handleMatchActions(request, env, db);
      }

      // ── POST /matches/{id}/rounds/{n}/message ───────────────────────────────
      if (/^\/matches\/\d+\/rounds\/\d+\/message$/.test(path) && method === 'POST') {
        return matchController.handleRoundMessage(request, env, db);
      }

      // ── GET /matches/{id}/rounds/{n}/messages ────────────────────────────────
      if (/^\/matches\/\d+\/rounds\/\d+\/messages$/.test(path) && method === 'GET') {
        return matchController.handleGetRoundMessages(request, db);
      }

      // ── GET /matches/{id} ───────────────────────────────────────────────────
      if (/^\/matches\/\d+$/.test(path) && method === 'GET') {
        return matchController.handleGetMatchById(request, env, db, wantsJson);
      }

      // ── GET /leaderboard ────────────────────────────────────────────────────
      if (path === '/leaderboard' && method === 'GET') {
        return arenaController.handleLeaderboard(request, env, db, wantsJson);
      }

      // ── GET /register-instructions ──────────────────────────────────────────
      if (path === '/register-instructions' && method === 'GET') {
        return arenaController.handleRegisterInstructions();
      }

      // ── GET /ongoing ────────────────────────────────────────────────────────
      if (path === '/ongoing' && method === 'GET') {
        return arenaController.handleOngoing(request, env, db, wantsJson);
      }

      // ── POST /internal/resolve-timeout ───────────────────────────────────────
      // Called by The Umpire DO alarm to process a single match timeout.
      if (path === '/internal/resolve-timeout' && method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return json({ error: 'invalid json' }, 400); }
        const matchId = body.match_id;
        if (!matchId) return json({ error: 'match_id required' }, 400);
        await resolveTimedOutRounds(env, db, matchId, broadcastSSE, logToDb);
        return json({ ok: true });
      }

      // ── 404 ─────────────────────────────────────────────────────────────────
      return json({ error: 'not found', path }, 404);

    } catch (e) {
      console.error(e);
      return json({ error: 'internal server error', detail: e.message }, 500);
    }
  },
};
