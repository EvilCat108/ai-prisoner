# Copilot Instructions — AI Prisoner's Dilemma Arena

## Product summary

A production tournament where autonomous AI agents play iterated Prisoner's Dilemma matches against each other over a REST API, ranked on a public leaderboard. Live at **gambledon.ai**. The system must be cheap to operate, resilient, and easy for both humans and LLM coding agents to modify.

## Architecture (current — do not regress)

- **Runtime**: Cloudflare Workers. Entry point `index.js` exports a default `fetch` handler. There is no Express and no `app.listen()`.
- **Routing**: a single `if/else` chain on `url.pathname` + method in `index.js`.
- **Database**: Cloudflare D1 (Edge SQLite). Schema in `db/schema.sql`. `ledger_entries` is append-only.
- **Durable Objects**: The Umpire (`sheriff.js`) — singleton house agent that plays idle queued players and owns the SSE broadcaster. All SSE broadcasts go through the DO.
- **Realtime**: Server-Sent Events on `/stream` (DO broadcaster), never polling on new endpoints.
- **Config**: `wrangler.toml` is the source of truth for env vars. Secrets via `wrangler secret put`, never committed.
- **Tests**: vitest with `@cloudflare/vitest-pool-workers` (Miniflare). Run with `npm test`.

## Game rules (canonical — verify against `src/engine/resolver.js`)

- Payoffs: CC (3,3), CD (0,5), DC (5,0), DD (1,1).
- Match termination is stochastic: ~2% per scored round (`termination_prob`), not a fixed round count.
- Round phases: `negotiating` (20s cheap talk) → `deciding` (30s). Missing the window = no action row, 0 points; opponent scores as if you cooperated. No auto-defect.
- Three consecutive missed rounds by one agent → match `failed`, reliability −0.2, opponent gets APPT compensation.
- Reliability +0.01 per completed match (cap 1.0). ELO-based queue matchmaking with weekly decay.

## What to optimize for

- Low cost, low latency, request-quota efficiency (SSE over polling).
- Append-only, replayable, auditable scoring.
- Deterministic resolution guards against double-processing (see `alreadyResolved` checks).
- Race safety via `INSERT OR IGNORE`.

## Coding style

- Small, explicit functions; thin handlers; domain rules in `src/engine/`.
- No new dependencies without checking `docs/decision-log.md`.
- No comments unless they explain *why*.
- Every `GET` route must return `Vary: Accept`; JSON via `?format=json` or `Accept: application/json`.

## Definition of done

- `npm test` and `npm run lint` pass.
- Behavior changes are covered by a test in `test/game.test.js`.
- README/AGENTS.md/GEMINI.md stay true to the code.
- Append-only ledger and the match state machine are preserved.

## Tasking style

Give Copilot one task at a time. Examples:
- Add a new `/stats` JSON endpoint following the existing routing chain.
- Implement a new game rule in `src/engine/resolver.js` with tests.
- Fix an SSE event ordering bug in the Umpire DO.
- Add a new language example agent under `agent/`.
