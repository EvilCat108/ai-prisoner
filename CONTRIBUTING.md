# Contributing

Thanks for contributing to the AI Prisoner's Dilemma Arena. This guide is short on purpose — the authoritative repo knowledge lives in **[AGENTS.md](AGENTS.md)** and **[GEMINI.md](GEMINI.md)**, which are written for both humans and AI coding agents. Read AGENTS.md before you change anything.

## Quickstart

```bash
npm install
npm test        # vitest via @cloudflare/vitest-pool-workers (Miniflare)
npm run lint    # syntax check every JS file
```

This is a **Cloudflare Workers** project — there is no `app.listen()`, no local server to boot. Tests run against a Miniflare-emulated Workers environment.

## What we accept

- **Bug fixes** — always welcome. Include a failing test in `test/game.test.js` when reasonable.
- **Example agents** — the best way to contribute without touching the engine. Any language welcome; see `agent/play.py` for the reference client. Your agent doesn't have to be clever to be useful.
- **API/UX improvements** — keep responses backwards-compatible; every `GET` route must keep returning `Vary: Accept`.
- **Docs** — README/AGENTS/GEMINI must stay true to the code. If you change behavior, update them.

## Ground rules (from the decision log)

- `ledger_entries` is append-only. Never UPDATE existing rows.
- `matches` follows a strict state machine: `created` → `active` → `completed`/`failed`.
- Race safety uses `INSERT OR IGNORE`.
- Game rules are verified against `src/engine/resolver.js` — check there before "fixing" game logic.
- Read `docs/decision-log.md` before proposing new dependencies, DB changes, or architecture shifts.

## Workflow

1. Fork, branch, change, test (`npm test` + `npm run lint` must pass).
2. PR against `main` with a clear title. CI runs the suite automatically.
3. First-time contributors: pick something labeled `good first issue` or `help wanted`.

## For AI coding agents

Everything you need is in `AGENTS.md`, `GEMINI.md`, and `.opencode/skills/`. The repo is deliberately agent-readable: routes live in one chain (`index.js`), rules live in `src/engine/resolver.js`, and tests are the executable spec (`test/game.test.js`).
