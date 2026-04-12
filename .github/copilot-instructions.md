# Copilot Instructions — Lean Agent Arena MVP

## Product summary
Build a minimal agent-only repeated Prisoner’s Dilemma arena where autonomous agents register, authenticate, play repeated matches, and are ranked on a public leaderboard. The system must be simple to run, easy to deploy, and cheap to operate.

## Architecture goals
- Prefer a single VPS deployment.
- Prefer a single backend binary or small service set.
- Prefer SQLite for the MVP unless the repo already uses Postgres.
- Keep the codebase easy to reason about and easy for an LLM to modify.
- Avoid unnecessary infrastructure, queues, microservices, or external dependencies.

## What to optimize for
- Low cost.
- Simple deployment.
- Clear code paths.
- Replayability and auditability.
- Append-only score history.
- Deterministic game resolution.

## Tech stack guidance
Use the existing repo stack if present. If starting from scratch, prefer:
- Backend: Go or a similarly simple compiled backend.
- Database: SQLite with WAL mode enabled.
- Frontend: minimal server-rendered pages or a lightweight web UI.
- Deployment: one host, one process, one database file.
- LLM usage: use Copilot for implementation guidance and boilerplate, but keep all game logic local and deterministic.

## Game scope
Only implement:
- Agent registration.
- API authentication.
- Repeated Prisoner’s Dilemma matches.
- Append-only ledger.
- Replay page.
- Leaderboard.

Do not add:
- Real-money betting.
- KYC/AML.
- Multi-game support.
- Complex orchestration systems.
- Microservices.
- Event streaming infrastructure.

## Database guidance
Use SQLite tables for:
- agents
- matches
- match_rounds
- actions
- ledger_entries
- leaderboard_snapshots

Important:
- Treat the ledger as append-only.
- Do not overwrite historical rounds.
- Use WAL mode if SQLite is the database.
- Keep transactions short and avoid long-running write locks.

## Coding style
- Prefer small, explicit functions.
- Keep domain rules in one game/rules module.
- Keep handlers thin.
- Make API responses simple and stable.
- Avoid clever abstractions unless they clearly reduce complexity.
- Write code that is easy to inspect and replay.

## Copilot tasking style
Give Copilot one task at a time.
Examples:
- Create the agent registration API.
- Implement the Prisoner’s Dilemma round engine.
- Add the append-only ledger schema.
- Build replay from stored match events.
- Build the leaderboard query and page.

## Definition of done
A task is complete only when:
- It compiles or runs cleanly.
- It passes existing tests or a new focused test.
- It preserves append-only history.
- It is understandable from the replay.
- It does not introduce unnecessary infrastructure.
- It keeps runtime and operational cost low.

## Success criteria
The MVP is successful if:
- A single VPS can run it.
- SQLite can persist all required data reliably.
- A match can be played end-to-end by two agents.
- The replay exactly matches stored events.
- The leaderboard reflects final settled scores.
- The app can be deployed and understood without enterprise tooling.