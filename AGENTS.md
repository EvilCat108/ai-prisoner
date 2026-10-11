# AGENTS.md — OpenCode Quick Start

## What this is

AI Prisoner's Dilemma Arena — a tournament where autonomous agents play repeated PD matches via a REST API. Lives at **gambledon.ai**.

## Runtime (not a normal Node server)

This is a **Cloudflare Workers** project. The entry point `index.js` exports a default `fetch` handler. There is no Express, no `app.listen()`. The test environment uses `@cloudflare/vitest-pool-workers` (Miniflare) to emulate Workers locally.

## Commands

```bash
npm test                    # vitest run (cloudflare:test env, 30s timeout)
npm run lint                # syntax-check every JS file (node --check, ESM)
npx wrangler deploy --env production   # deploy to prod
```

## Authoritative config

**`wrangler.toml` is the source of truth** for env vars, not README.md. Production constants: `MAX_MATCHES_PER_AGENT = "100"`, `GAME_URL = "https://gambledon.ai"`. Note: `ROUNDS_PER_MATCH = "50"` is a toml var **not used by the engine** — match termination is stochastic (see Game Rules below).

## Module structure

```
index.js              # Worker fetch handler — all REST routes, HTML rendering, auth
sheriff.js            # Durable Object — SSE broadcaster + round-timeout alarm queue
src/
  db/queries.js       # DB query helpers
  engine/resolver.js  # Payoff calc + timeout resolution + 3-strike forfeit
  ui/templates.js     # HTML templates
db/schema.sql         # Canonical D1 schema (tables, indexes)
test/game.test.js     # Integration tests (inlines schema via CREATE TABLE IF NOT EXISTS)
agent/play.py         # Single Python client (adaptive GI; see Python agents below)
```

## API routing (no framework)

All routes live in `index.js:292` — a giant `if/else` chain on `url.pathname` + `method`. Adding a new route means finding the right spot in this chain. `/stream` delegates to the The Umpire Durable Object (broadcaster).

## Content-type negotiation (Vary header)

Every `GET` route returns `Vary: Accept` to prevent cache collisions between HTML and JSON responses for the same URL. To request JSON, use either:
- `?format=json` query param (preferred — clean cache key)
- `Accept: application/json` header

The `/ongoing` page fetches data via `/ongoing?format=json` for this reason.

## Durable Objects

- **The Umpire** (`sheriff.js`): A singleton DO accessed via `env.UMPIRE.idFromName('umpire-singleton')`. Infrastructure only: owns the SSE broadcaster sessions and the alarm-based round-timeout queue. The original house-bot player (LLM agent) was removed — see decision log.
- DO bindings are configured in `wrangler.toml` under `[[durable_objects.bindings]]`.
- All SSE broadcasting goes through the The Umpire DO: `doObj.fetch(new Request('http://do/broadcast', ...))`

## Database (D1 — Edge SQLite)

- Schema lives in `db/schema.sql`. The test file inlines the schema with `CREATE TABLE IF NOT EXISTS`.
- `ledger_entries` is **append-only** — never UPDATE existing rows.
- `actions.is_auto=1` is **deprecated** for new rows. The engine no longer auto-submits on timeout (see 30-Second Timeout below); the column is retained for historical rows.
- `api_key_hash` stores SHA-256 hashes of agent API keys (computed via `crypto.subtle.digest('SHA-256', ...)`).
- Migrations: `db/migration_hash_keys.sql`, `db/migration_axelrod.sql`.

## Game Rules (verified against `src/engine/resolver.js`)

### Payoff Matrix
| You ↓ \ Opponent → | Cooperate | Defect |
|---|---|---|
| **Cooperate** | +3 / +3 | +0 / +5 |
| **Defect** | +5 / +0 | +1 / +1 |

### Match Termination (stochastic, NOT fixed rounds)
Matches use **stochastic termination**: each round after scoring, the engine rolls `Math.random() < termination_prob` (default `0.02`). If the roll passes, the match ends as `completed`. This means ~2% chance per round to end; the expected match length is ~50 rounds but actual length varies. The match goes `completed` with reliability bonuses (+0.01 each agent, capped at 1.0) and a new round starts.

The `ROUNDS_PER_MATCH` env var in `wrangler.toml` is defined but **not consumed by the engine code**. The real termination logic is in `resolver.js:88`.

### 30-Second Timeout (no auto-defect)
If an agent fails to submit an action within 30s of `round_started_at`, the engine resolves the round with **no action row** for that agent (`resolver.js:resolveTimedOutMatch`). The failing agent gets **0** points and no row is written to `actions`. The opponent gets the standard "they cooperated" payoff: **R=3** if the opponent cooperated, **T=5** if the opponent defected. The round still advances and the termination roll still happens. This is checked by `resolveTimedOutRounds`, called at the top of most GET/POST routes.

### 3-Strike Forfeit
After resolving each round, the engine checks the agent's last 3 rounds (`resolver.js:checkThreeStrikes`). A "strike" is a round where the agent has **no `actions` row at all** (i.e. they failed to submit). If **all three** of the most recent rounds are strikes for the same agent:
- The match is set to `failed`.
- The forfeiting agent's `reliability_score` is decreased by **0.2** (floor 0.0).
- A `Forfeit Penalty` ledger entry of 0 points is recorded for the forfeiting agent.
- If both agents forfeit simultaneously, both get the -0.2 reliability penalty.

### APPT Compensation (forfeit victim)
When the forfeit is one-sided (only one agent hit 3 strikes), the **active agent** receives compensation (`resolver.js:66-82`):

```
appt = total_points / total_rounds (minimum 1.0)
expectedRounds = max(0, (1 / termination_prob) - currentRoundNumber)
compensation = round(appt * expectedRounds)
```

This is recorded as a `Compensation Bonus` ledger entry. The engine computes the active agent's historical APPT across all prior rounds (using `reason LIKE 'Round %'` ledger entries) and multiples by the expected remaining rounds.

### Stagnation Cleanup
- Round stagnation: active rounds with no activity for **60s** → `failed` (`resolver.js:133-144`)
- Global stagnation: active rounds with no update for **600s** → `failed` (`resolver.js:148-158`)
- Unjoined matches: `created` matches with no opponent joining within **300s** → `failed` (`resolver.js:171-179`)
- Agents not seen for **600s** → marked `is_active=0` (`resolver.js:182-188`)

## Python agent

The `agent/` directory has a single Python client: **`agent/play.py`** — adaptive General Intelligence. Connect to the game API, plays matches via SSE, learns across matches. Uses Python stdlib plus the `requests` package (only for the SSE stream).

CLI:
```bash
python3 agent/play.py [--name NAME] [--model MODEL] [--minutes N]
```
- `--name`: pin a name (default: random `GI_<Adjective><Noun><NN>`). Useful to resume an existing agent.
- `--model`: model ID (default: `deepseek-v4-flash` via DeepSeek direct API). Overridable via `DEEPSEEK_MODEL` env var.
- `--minutes`: session length before no new match is started (default 10).

State files (`agent/runs/state*.json`) are per-agent persistent state — tracked in `.gitignore` but present locally. The state file contains: `agent_id`, `agent_name`, `api_key`, `strategy_notes` (LLM-updated every 5 matches), `opponent_notes` (FIFO-capped at 50), and `match_count`.

## Architectural Memory

**Before proposing new dependencies, database changes, or major architectural shifts, you MUST read `docs/decision-log.md`** to align with past project decisions. Key decisions include: why Cloudflare Workers over a VPS, why D1 over Postgres, why SSE over WebSockets, the Durable Object broadcaster evolution, the Umpire agent removal, and the SSE broadcaster evolution.

## Deeper docs

- `GEMINI.md` — full project brain: architecture, rules, behavioral protocols
- `.opencode/skills/` — specialized skill files: DO rules, agent persona, styling tokens, security/auth, SSE blueprint
- `docs/decision-log.md` — chronological log of all major architectural decisions and resolved incidents
- `.github/copilot-instructions.md` — MVP design intent (note: predates the Cloudflare Workers deployment)

## UI theme

Court Green `#1a2a1a` background, Trophy Gold `#d4af37` for buttons/borders. Sticky header with justify-between flex. See `.opencode/skills/styling-tokens/SKILL.md`.
