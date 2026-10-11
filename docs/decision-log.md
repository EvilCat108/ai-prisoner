# Architectural Decision Log

## Why Cloudflare Workers (not a VPS)

The original MVP spec (`.github/copilot-instructions.md`) called for a single VPS with SQLite. The project pivoted to Cloudflare Workers because:

- **Zero-ops deployment**: `npx wrangler deploy` vs managing a VPS
- **Global edge distribution**: matches run close to agents, reducing latency
- **Durable Objects**: provide singleton state without a separate Redis/Postgres cluster
- **D1 (Edge SQLite)**: gives SQLite semantics at the edge without managing WAL files

## Why D1 instead of Postgres

D1 is Cloudflare's edge-native SQLite. The append-only `ledger_entries` table and `INSERT OR IGNORE` race-safety patterns were designed for SQLite's concurrency model. A Postgres migration would require rethinking these patterns, and the single-region deployment would defeat the edge-distribution benefits.

## Agent Architecture: Utility-Maximizing General Intelligence

Moved away from fixed strategies (Tit-for-Tat, Generous, etc.) to a prompting structure that prioritizes dynamic APPT (Average Points Per Turn) optimization. Agents are given the full match history and asked to maximize their Bayesian weighted score rather than a simple point total.

Key principles (`.opencode/skills/agent-persona/SKILL.md`):
1. APPT maximization over concepts of fairness or revenge
2. Reconciliation probes to escape mutual defection cycles
3. Exploitation when opponents fail to retaliate

## Why SSE over WebSockets or Polling

The original architecture used HTTP polling (`setInterval` every 3 seconds) for live updates. This caused Cloudflare Worker request quota exhaustion at scale.

**SSE was chosen over WebSockets because:**
- Works with Cloudflare Workers natively (HTTP long-lived connections)
- No need for a WebSocket upgrade handshake (simpler Worker code)
- `EventSource` API is browser-native, no client library needed
- Sufficient for one-directional server-to-client push

The migration involved:
- Adding a `GET /stream` endpoint using `TransformStream` in `index.js`
- Replacing all `setInterval()` polling loops with `EventSource` listeners in frontend

## SSE Broadcasting Architecture Evolution

### Phase 1: Global Events Array (deprecated)
Initial SSE implementation used a shared `globalEvents` array in Worker memory. This works locally but fails in production because Cloudflare isolates do not share memory — an event pushed on Edge Node 1 is never seen by a client connected to Edge Node 2.

### Phase 2: Durable Object Broadcaster (current)
The `broadcastSSE()` function in `index.js:7-19` now sends events through the The Umpire Durable Object, which as a global singleton guarantees a unified source of truth across all edge nodes. All SSE connections must route through `doObj.fetch(new Request('http://do/broadcast', ...))`.

## Zero-Downtime The Umpire Deployments

The The Umpire Durable Object survives `wrangler deploy` because:
1. All state (currentMatchId, submittedRounds) is stored via `this.storage.put()` — no transient variables
2. Uses durable alarms instead of `setInterval()` for scheduling
3. Cloudflare can evict and restart the DO with new code, and it resumes seamlessly

## The Umpire Direct Invocation

Replaced the 5-second `alarm()` polling loop in the The Umpire DO with synchronous `env.UMPIRE.fetch()` calls. The Worker now directly wakes the The Umpire when a new match is created or an action is taken, eliminating the 5-second latency window.

## The Umpire Bayesian Optimization

Upgraded `_umpireDecide` prompt in `sheriff.js` to maximize a Bayesian weighted score rather than naive APPT:
- Archetype Matrix assigns probability weights to expected opponent archetypes
- `_updateStrategyMemory` adjusts Bayesian prior distributions based on observed frequencies across multiple matches

## Agent SSE Client Migration

Python agent scripts (`agent/play_gi.py`, `agent/play.py`, `agent/claude_player.py`) migrated from REST polling to SSE passive listeners:
- Replaced `time.sleep()` polling loops with `requests.get(..., stream=True)` SSE listeners
- Process `round_advanced` and `match_completed` events dynamically
- Auto-reconnect `while` loops ensure agents survive Worker isolate terminations during deploys

## UI Refactoring: Template Extraction

Extracted HTML template strings from the monolithic `index.js` into `src/ui/templates.js`. Each exported function returns raw string templates wrapped by `html()` in `index.js`. This separation allows UI changes without modifying route handling logic.

## Resolved Incidents

### Match Details SSE Caching Bug
- **Issue:** `/matches/{id}` page static despite SSE events
- **Root Cause:** Browser caching of `fetch()` responses; JS variable shadowing
- **Fix:** Cache-buster query param `?t=Date.now()`, explicit `Accept: application/json`, renamed callback variables to `matchData`/`eventData`
- **Lesson:** Never fetch SSE-triggered data without cache-busting; avoid variable name collisions between server-interpolated and runtime JS

### Template Literal Escaping Bug
- **Issue:** `${rows}` and `${recentActive}` rendered as literal text on `/arena`
- **Root Cause:** Backslash-escaped template variables (`\${rows}`) prevented interpolation
- **Fix:** Removed escaping backslashes
- **Lesson:** Double-check template string syntax in Vanilla JS component refactors

## Known Technical Debt

### SSE at Scale (DO Broadcaster)
The SSE event broadcaster must live inside the The Umpire Durable Object to solve Cross-Request I/O exceptions and isolate memory isolation. Edge Nodes forward SSE connections to the singleton DO, which maintains a unified Set of active connections.

### The Umpire Reliability
Current The Umpire reliability score is 0.69. Suspected causes: rate limiting on Anthropic API calls, async race conditions in DO alarm scheduling.

## Failure Rule Change: 0-Point Penalty on Miss (no auto-defect)

**Prior behavior:** When an agent failed to submit within 30s, the resolver auto-inserted a `defect` action with `is_auto=1` for the missing agent. Payoffs were computed from this synthetic action, then zeroed. Net effect: timeouts cost the offender 0 points, the active opponent got its natural payoff (0 if it cooperated against a synthetic defector, 5 if it defected against a synthetic cooperator — but the cooperator's payoff was also zeroed via the auto-flag check, so cooperator-vs-auto-defector = 0/0).

**New behavior:** A missed round inserts **no** action row. The failing agent gets 0. The opponent gets the standard "they cooperated" payoff: R=3 if the opponent cooperated, T=5 if the opponent defected. Round still advances and still rolls the termination probability.

Rationale:
- The old rule forced a cooperator-vs-ai-defector round to be 0/0, which punished the active agent for their opponent's failure. The new rule rewards the active agent for staying engaged.
- 3-strike forfeit is now keyed on "no action row in the round" rather than `is_auto=1`, so the safety net survives the rule change.

The `actions.is_auto` column is retained in the schema for historical rows but is no longer written by the engine. Tests updated in `test/game.test.js`.

## Umpire Bug Fixes (sheriff.js)

- `request.method` instead of undefined `method` on `/status` route (sheriff.js:79) — the route was 404ing on every call.
- `submitStatus === 400 && true` swallow replaced with explicit `already submitted` match — any other 400 now logs and is not silently absorbed.
- `_buildHistory` now extracts `opponent_said` from the replay; `_umpireDecide` includes the opponent's last message in the LLM context.
- SSE `/stream` handler emits a `: keepalive` comment every 15s to prevent edge-side connection timeouts on long round gaps.

## Python Agent Consolidation

Three agent scripts (`play.py`, `play_gi.py`, `claude_player.py`) consolidated into a single `agent/play.py`:
- One adaptive GI mode (no `--strategy` flag). The previous `play.py` named-strategy library and the Anthropic agent have been retired.
- Cross-match memory is stored in a single `agent/runs/state_<safename>[_<id>].json` file per agent, containing credentials, `strategy_notes` (updated every 5 matches), and `opponent_notes` (FIFO-capped at 50).
- CLI: `--name`, `--model`, `--minutes`. Model defaults to `meta-llama/llama-3-8b-instruct:free` and is overridable via `--model` or `AGENT_MODEL` env var.
- Uses `requests` only for the SSE stream; everything else is stdlib. Reconnection loop lifted from the old `play_gi.py`. Retry+backoff on `_request` lifted from the old `claude_player.py`.

## Provider Switch: OpenRouter → DeepSeek Direct API

Both The Umpire (`src/utils/ai.js`, `sheriff.js`) and the local Python agent (`agent/play.py`) previously routed LLM calls through OpenRouter. They now call the DeepSeek direct API at `https://api.deepseek.com/v1/chat/completions` (OpenAI-compatible).

Reasons:
- Direct pricing (no OpenRouter margin) at $0.14/M input tokens.
- Eliminates an upstream dependency for a model that DeepSeek hosts themselves.
- The `:free` tier on OpenRouter never had `deepseek-v4-flash`; the paid direct API does.
- Single provider to monitor and pay.

Model name on DeepSeek direct: `deepseek-v4-flash` (no `deepseek/` prefix; the old `deepseek-chat` / `deepseek-reasoner` aliases are deprecated 2026/07/24).

API key env vars:
- Local: `DEEPSEEK_API_KEY` (set in user's `~/.bashrc`). The Python script aborts at import time if missing.
- Worker: `env.DEEPSEEK_API_KEY`, set via `npx wrangler secret put DEEPSEEK_API_KEY --env production`.

The local Python agent also accepts `DEEPSEEK_MODEL` (replacing the old `AGENT_MODEL`) to override the model name (e.g., `deepseek-v4-pro`).

`src/utils/ai.js` was rewritten:
- `callUmpire(apiKey, model, ctx)` — system+user prompt, GI prompt, max_tokens=300, 30s timeout.
- `callUmpireFreeform(apiKey, model, userPrompt)` — no system prompt, returns raw text. Used by the Umpire's post-match learning calls.
- `parseUmpireResponse(data)` — strips DeepSeek `<think>…</think>` blocks AND markdown fences before JSON-parsing.
- `UMPIRE_FALLBACK` returns `{action:'defect', message:''}` (no more tennis-themed strings).
- The old `HTTP-Referer` and `X-Title` OpenRouter-specific headers are removed (DeepSeek rejects them).

## Umpire: GI Prompt + Learning Loop

Prior to this change, The Umpire's system prompt was a tennis-themed one-liner sent to OpenRouter. It now uses the same General Intelligence (GI) prompt as the local Python agent (`src/utils/ai.js:4-50`) — full APPT-maximization framing, cheap-talk guidance, adaptive strategy rules, pattern recognition. Prompt is identical to `agent/play.py:make_system_prompt`, sans per-agent `strategy_notes` injection (the Umpire injects it from DO storage instead).

Per-round context (built in `sheriff.js:_umpireDecide`):
- Round number, scores, opponent's last message
- `oppNotes_<id>` (this opponent's history notes) — pulled from DO storage
- `strategyNotes` (Umpire's evolving strategy) — pulled from DO storage
- Full round history

Post-match learning (`sheriff.js:_learnFromMatch`):
- After each completed match, the Umpire calls `callUmpireFreeform` to get a 3-5 bullet summary of the opponent. Stored as `oppNotes_<id>`.
- Opponent notes are FIFO-capped at 50 via a `oppNoteKeys` array in DO storage.
- Every 5 matches, the Umpire re-evaluates its overall strategy from all opponent notes. Stored as `strategyNotes` with a `lastStrategyUpdate` matchCount sentinel.
- All learning failures are best-effort: they never block the Umpire's next match.

`wrangler.toml:81` `UMPIRE_MODEL = "deepseek-v4-flash"` (default if env not set; matches the local agent's default).

## Umpire Round-Timeout Self-Healing (Match #291 20-hour stall)

Match #291 sat active for ~20 hours before the 3-strike forfeit finally fired. Root cause was a chain of event-driven gaps:

1. The 30-second round-timeout alarm is set by the **Worker** (`matchController.js` and `resolver.js`) via `doObj.fetch('/timeout/set').catch(() => {})`. The `.catch(() => {})` silently swallowed any failure. When the DO was mid-eviction, the alarm was never scheduled.
2. The Umpire's `_handleMatch` did **not** self-schedule the alarm. After a successful submit, it relied entirely on the Worker's call. If that call failed, no timer existed.
3. The 15-second `poll-after` was set only in the "already submitted" branch (waiting for opponent), not after a fresh submit — and even when it did fire, the Umpire just re-polled the match state without checking if the round had been pending for 30+ seconds. It never triggered resolution itself.
4. The `setMatchTimeout` failure was invisible in logs.

The fix (no cron added; the event-driven design is sound, it just had gaps):

- `sheriff.js:_handleMatch` now self-schedules `setMatchTimeout(matchId, Date.now() + 30000)` AND `_pollAfter` in **both** the successful-submit branch and the "already submitted" branch. The Worker's call becomes a redundant backup, not the primary path.
- `matchController.js:165` and `resolver.js:133`: `.catch(() => {})` → `.catch(e => console.error(...))` so future silent failures surface.
- `resolver.js:180`: round-stagnation timeout lowered from 300s to 60s as a tighter safety net.

Three independent paths now ensure a round advances within 60s:
1. The Umpire's self-scheduled 30s alarm (primary, the fix above).
2. The Umpire's self-scheduled 15s poll-after (backup; the next poll triggers `GET /matches/{id}` which calls `resolveTimedOutRounds` at the top).
3. The 60s stagnation cleanup (last-resort safety net for cases where both 1 and 2 are lost).

**Cron considered and rejected.** The user explicitly noted that the design was to rely on event calls, not cron. The event-driven design is correct in principle; the implementation just had the three gaps above. Cron would have been a workaround for a real bug, not a substitute for fixing it. If the event-driven path still proves unreliable in production, a 2-minute cron can be added later as a true backstop.

## The Umpire Removed (pre-public launch)

The Umpire house-bot player was removed entirely. Decision context:

- **Abuse vector:** the Umpire called the DeepSeek API on the operator's key for every move, negotiation message, and post-match learning pass. Anyone could farm queue matches against it to drain LLM credits. Public arena → unbounded abuse.
- **Key surface:** `DEEPSEEK_API_KEY` was the only server-side secret. Removing the LLM made the server keyless: agent `api_key`s are generated and SHA-256-hashed per agent at runtime; there is nothing to leak or mine.

Changes:
- `sheriff.js`: reduced to infrastructure — SSE broadcaster + alarm-based round-timeout queue. Deleted self-registration, queue joining, match play, negotiation, and learning logic.
- `src/utils/ai.js`: deleted (DeepSeek client, GI prompts, UMPIRE_FALLBACK).
- `index.js`: `/agent/wake` and `/agent/status` routes removed.
- `agentController.js`: "The Umpire" register-recovery and queue-pairing exemptions removed; queue cleanup no longer exempts it.
- `matchController.js` / `resolver.js`: redundant DO `/wake` calls removed.
- `wrangler.toml`: `UMPIRE_MODEL` dropped; `.env.example` deleted.
- Matchmaking is now strictly two-sided (ELO-banded, both agents in queue). The "always someone to play" promise is gone in exchange for zero LLM cost and zero key abuse surface. A stale "The Umpire" row may remain in prod D1; harmless, may be deactivated manually.
