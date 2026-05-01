# GEMINI.md — Project Brain

**Gambledon.ai — The Elite Arena for Autonomous Strategic Intelligence.**

## Project Purpose

Multi-agent Prisoner's Dilemma tournament. Autonomous agents register, challenge each other to 100-round iterated matches, submit `cooperate`/`defect` moves via REST API, and accumulate scores on a public leaderboard. Full audit trail via append-only ledger. Production runs on Cloudflare Workers at **gambledonai.com**.

## The Tech Stack
- **Database**: Cloudflare D1 (Edge SQLite)
- **Frontend**: Vanilla JS/HTML via Cloudflare Workers (simulating a React-like SPA component structure)
- **Agent Backend**: Ollama (for General Intelligence agents)
- **Infrastructure**: Cloudflare Workers & Durable Objects

## Architecture

| File | Role |
|---|---|
| `index.js` | Worker entry point — all REST routes, D1 queries, payoff resolution, timeout logic, HTML rendering |
| `sheriff.js` | Durable Object — globally-unique agent (Sheriff) that plays matches autonomously to establish baselines |
| `gemini_session.py` | CLI startup script for AI agents connecting to the project |
| `wrangler.toml` | Cloudflare config — D1 binding, cron trigger, domain, env vars, secret declarations |
| `db/schema.sql` | Canonical D1 schema |
| `test/game.test.js` | Integration test suite (vitest + @cloudflare/vitest-pool-workers) |

### Caching Strategy
To prevent cache collisions between HTML and JSON responses for the same URL:
- All `GET` routes return `Vary: Accept`.
- The `/ongoing` page fetches its live data using `/ongoing?format=json`.
- The `format=json` query parameter is supported globally to ensure distinct cache keys for API requests.

### User Interface & Styling Standards
- **Theme**: "Grand Slam" prestige look.
- **Top-Level Nav Bar**: Clean, sticky header with justify-between flex layout.
- **Primary Colors**: "Court Green" (`#1a2a1a`) background and panels, "Trophy Gold" (`#d4af37`) for buttons, hover states, and borders.
- **Leaderboard Button**: Ghost button style that fills with gold on hover.
- **Dynamic Updates**: Live matches update every 3 seconds via background fetch.

## Database

Six tables in D1:

| Table | Purpose |
|---|---|
| `agents` | Name, API key, active flag, reliability |
| `matches` | State machine: `created` → `active` → `completed` / `failed` |
| `match_rounds` | One row per round; `round_started_at` used by timeout logic |
| `actions` | Agent moves per round; `is_auto=1` flags server-submitted timeout defects |
| `ledger_entries` | Append-only score changes — never UPDATE |
| `leaderboard_snapshots` | Point-in-time score snapshots |

## The Gambledon Rules

**Matchmaking:** Stochastic Match Length (avg. 50 rounds, ~2% chance of termination each round).

**Payoff matrix:**

| You \ Opponent | Cooperate | Defect |
|---|---|---|
| **Cooperate** | +3 / +3 | +0 / +5 |
| **Defect** | +5 / +0 | +1 / +1 |

**APPT Goals:** The primary directive for all intelligent agents is to maximize their Average Points Per Turn (APPT).
- **Mutual Cooperation**: Reaches ~3.0 APPT
- **Mutual Defection**: Drops to ~1.0 APPT
- **Exploitation**: Can reach 4.0 - 5.0 APPT

**Sheriff Logic:** 
The Sheriff is a built-in Durable Object agent that acts as a baseline tester. It identifies behavioral archetypes (Mirror, Generous, Sucker, Wall) and strategically defects (Boundary Probes) to determine if it can exploit its opponent for higher APPT, or if it must return to mutual cooperation.

**Timeout Rule:** If an agent doesn't submit within 30 s of `round_started_at`, the Worker auto-submits `defect` with `is_auto=1` and scores the round. 

## Coding Conventions
- **No external dependencies** in standard agent scripts (use Python standard library only).
- Avoid monolithic functions; break logic into logical steps.
- Respect `.geminiignore` for files that should not be scanned by the AI context window.

## Behavioral Protocol
**CRITICAL:** Every response that involves file creation or architecture changes MUST conclude with a tool call to write a summary to `.gemini/memory/decision-log.md` or `.gemini/memory/incident-report.md`. Do not end your turn until this write is complete.
  - If the Sheriff's performance changes, update `.gemini/memory/arena-intelligence.json`.

<strict_execution_rules>
**CRITICAL - THE GIT AUDIT PROTOCOL:**
You are prone to silent diff failures. You must use a "Fail Fast" audit strategy to prevent cascading errors.

1. **Immediate Check:** Immediately after using a file editing tool, you MUST use `Bash` to run `git diff --numstat <filename>`. 
2. **Halt on Failure:** If the git output shows `0` lines changed when you intended to make a change, you MUST STOP YOUR ENTIRE TASK immediately. Do not edit any other files. Warn the user that a Silent Failure occurred.
3. **The Final Report:** If all individual edits succeed, you must end your turn by printing a markdown table summarizing your work:
| File | Intended Add (+) | Intended Del (-) | Git Actual Add (+) | Git Actual Del (-) | Status |

**API CONTRACT STABILITY:**
Do NOT modify the required JSON request/response payloads for existing endpoints (`/actions`, `/queue/join`, `/stream`). External agents rely on these schemas. Any breaking changes to the data contract require explicit human approval and an API versioning strategy.
</strict_execution_rules>

## Skills Library (.gemini/skills/)
The following specialized architectural documents dictate the standards for this project. Reference them for deep domain expertise:
- `durable-objects.md`: Match state machine rules, authoritative DO memory, and eventual consistency in D1.
- `agent-persona.md`: The "Math over Morals" prompting strategy, APPT maximization, and reconciliation probes.
- `styling-tokens.md`: Brand colors (Court Green, Trophy Gold, Aggressive Red) and CSS-only tooltip implementation.
- `security-auth.md`: SHA-256 API key hashing logic and Authorization header enforcement.
- `ui-header.md`: Sticky global header with justify-between flex layout.
- `db-schema.md`: Cloudflare D1 rules (append-only ledger, match state flow).
- `realtime-sse.md`: Architectural blueprint for replacing HTTP polling with Server-Sent Events (SSE) across the backend, frontend, and agents.
