#!/usr/bin/env python3
"""
AI Prisoner's Dilemma Agent — adaptive General Intelligence
==========================================================
Usage:
    python3 agent/play.py [--name NAME] [--model MODEL] [--minutes N]

Adaptive agent that registers, joins matches, and learns across them:
  - Calls DeepSeek for each round decision (with the opponent's last
    message in context).
  - After each match: stores an LLM-generated summary of the opponent.
  - Every 5 matches: stores an LLM-generated overall strategy note.
  - Cap: 50 opponent notes per agent (FIFO eviction).

Requirements: Python 3.8+, DEEPSEEK_API_KEY env var.
Uses the `requests` package only for the SSE stream.
"""

import json
import os
import random
import re
import sys
import time
import urllib.error
import urllib.request

# `requests` is used for the SSE stream only; everything else is stdlib.
import requests

# ── Configuration ─────────────────────────────────────────────────────────────

DEFAULT_GAME_URL    = "https://gambledon.ai"
DEFAULT_MODEL       = "deepseek-v4-flash"
DEEPSEEK_URL        = "https://api.deepseek.com/v1/chat/completions"
DEEPSEEK_TIMEOUT    = 30
MAX_RETRIES         = 3
MAX_OPPONENT_NOTES  = 50
STRATEGY_UPDATE_EVERY = 5
SSE_RECONNECT_DELAY = 1

STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runs")
os.makedirs(STATE_DIR, exist_ok=True)

DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY")
if not DEEPSEEK_API_KEY:
    sys.exit("ERROR: DEEPSEEK_API_KEY environment variable not set (add it to your ~/.bashrc).")

DEEPSEEK_HEADERS = {
    "Authorization": f"Bearer {DEEPSEEK_API_KEY}",
}

# ── Name generator ────────────────────────────────────────────────────────────

_ADJECTIVES = [
    "Sneaky", "Greedy", "Generous", "Paranoid", "Suspicious", "Jolly",
    "Grumpy", "Crafty", "Naive", "Ruthless", "Nervous", "Smug",
    "Dramatic", "Chaotic", "Diplomatic", "Vengeful", "Forgiving", "Petty",
    "Philosophical", "Impulsive", "Calculating", "Confused", "Optimistic",
]
_NOUNS = [
    "Pigeon", "Raccoon", "Weasel", "Ferret", "Hedgehog", "Capybara",
    "Lemur", "Axolotl", "Narwhal", "Platypus", "Pangolin", "Quokka",
    "Salamander", "Octopus", "Mongoose", "Meerkat", "Toucan", "Tapir",
    "Armadillo", "Manatee", "Wolverine", "Otter", "Sloth", "Blobfish",
]


def random_name():
    return f"GI_{random.choice(_ADJECTIVES)}{random.choice(_NOUNS)}{random.randint(10, 99)}"


# ── HTTP helpers (with retry) ────────────────────────────────────────────────


def _request(method, url, body=None, headers=None, timeout=30, max_retries=MAX_RETRIES):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "prisoner-agent/1.0"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    for attempt in range(max_retries):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()
        except Exception as e:
            if attempt == max_retries - 1:
                raise
            wait = 2 ** attempt
            print(f"  [retry {attempt + 1}/{max_retries} after {wait}s — {e}]")
            time.sleep(wait)


def game_request(method, path, body=None, api_key=None, game_url=None, timeout=30):
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    return _request(method, (game_url or DEFAULT_GAME_URL) + path, body=body, headers=headers, timeout=timeout)


# ── State I/O ─────────────────────────────────────────────────────────────────


def _safe_filename(name):
    return "".join(c if c.isalnum() else "_" for c in name)


def state_file(name, agent_id=None):
    base = _safe_filename(name)
    if agent_id is not None:
        return os.path.join(STATE_DIR, f"state_{base}_{agent_id}.json")
    return os.path.join(STATE_DIR, f"state_{base}.json")


def load_state(name):
    """Load state from any matching state file (with id suffix preferred)."""
    base = state_file(name)
    suffixed = None
    for fn in os.listdir(STATE_DIR):
        if fn.startswith(f"state_{_safe_filename(name)}_") and fn.endswith(".json"):
            try:
                with open(os.path.join(STATE_DIR, fn)) as f:
                    return json.load(f)
            except (OSError, json.JSONDecodeError):
                continue
        if fn == f"state_{_safe_filename(name)}.json":
            suffixed = os.path.join(STATE_DIR, fn)
    if suffixed:
        try:
            with open(suffixed) as f:
                return json.load(f)
        except (OSError, json.JSONDecodeError):
            return None
    return None


def save_state(state):
    name = state["agent_name"]
    aid = state.get("agent_id")
    path = state_file(name, agent_id=aid)
    with open(path, "w") as f:
        json.dump(state, f, indent=2)


def register_or_load(name, game_url):
    state = load_state(name)
    if state and state.get("api_key") and state.get("agent_id"):
        print(f"Loaded saved agent: {state['agent_name']} (id={state['agent_id']})")
        return state

    if state and not state.get("api_key"):
        print(f"Discarding partial state for {name} (missing credentials).")
        state = None

    print(f"Registering new agent: {name}")
    status, data = game_request("POST", "/agents/register", body={"name": name}, game_url=game_url)
    if status not in (200, 201):
        sys.exit(f"Registration failed ({status}): {data}")

    agent = data["agent"]
    api_key = data.get("api_key") or agent.get("api_key")
    state = {
        "agent_id":       agent["id"],
        "agent_name":     agent["name"],
        "api_key":        api_key,
        "strategy_notes": "",
        "opponent_notes": {},
        "match_count":    0,
    }
    save_state(state)
    print(f"  Registered! ID={agent['id']}")
    return state


# ── Match helpers ─────────────────────────────────────────────────────────────


def get_state(match_id, api_key, game_url):
    _, data = game_request("GET", f"/matches/{match_id}", api_key=api_key, game_url=game_url)
    return data


def get_replay(match_id, api_key, game_url):
    _, data = game_request("GET", f"/matches/{match_id}/replay", api_key=api_key, game_url=game_url)
    return data or {"rounds": [], "final_scores": []}


def build_history(replay, my_id):
    rows = []
    my_total = 0
    opp_total = 0
    for r in replay.get("rounds", []):
        my_act  = next((a["action"]  for a in r["actions"] if a["agent_id"] == my_id), None)
        opp_act = next((a["action"]  for a in r["actions"] if a["agent_id"] != my_id), None)
        opp_msg = next((a.get("message") for a in r["actions"] if a["agent_id"] != my_id), None)
        my_pts  = next((p["score_change"] for p in r.get("payoffs", []) if p["agent_id"] == my_id), None)
        opp_pts = next((p["score_change"] for p in r.get("payoffs", []) if p["agent_id"] != my_id), None)
        if my_act and opp_act:
            row = {"round": r["round_number"], "you": my_act, "opponent": opp_act}
            if my_pts is not None:
                row["your_pts"] = my_pts
                my_total += my_pts
            if opp_pts is not None:
                row["opponent_pts"] = opp_pts
                opp_total += opp_pts
            if opp_msg:
                row["opponent_said"] = opp_msg
            rows.append(row)
    return rows, my_total, opp_total


def already_submitted(replay, my_id, round_num):
    for r in replay.get("rounds", []):
        if r["round_number"] == round_num:
            return any(a["agent_id"] == my_id for a in r.get("actions", []))
    return False


def opponent_id_from_replay(replay, my_id):
    seen = set()
    for r in replay.get("rounds", []):
        for a in r.get("actions", []):
            if a["agent_id"] != my_id:
                seen.add(a["agent_id"])
    if seen:
        return next(iter(seen))
    return None


# ── JSON parsing fallback ─────────────────────────────────────────────────────


def parse_llm_json(text):
    """Robust JSON extraction from LLM output with progressive fallbacks.

    Returns a dict that may include 'action', 'message', 'thinking_process',
    and 'target_appt' fields.
    """
    if not text:
        return {"action": "cooperate", "message": None}
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        pass
    m = re.search(r'\{[^{}]*"action"\s*:\s*"[^"]*"[^{}]*\}', text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except (json.JSONDecodeError, TypeError):
            pass
    parsed = {"action": "cooperate", "message": None}
    am = re.search(r'["\'\s]?(cooperate|defect)["\'\s]?', text, re.IGNORECASE)
    if am:
        parsed["action"] = am.group(1).lower()
    mm = re.search(r'"message"\s*:\s*"([^"]*)"', text)
    if mm:
        parsed["message"] = mm.group(1)
    tm = re.search(r'"thinking_process"\s*:\s*"([^"]*)"', text)
    if tm:
        parsed["thinking_process"] = tm.group(1)
    return parsed


def sanitize_message(raw):
    if not isinstance(raw, str):
        return None
    msg = raw.replace("\r", "").replace("\n", " ").strip()
    if len(msg) > 150:
        msg = msg[:150]
    return msg or None


# ── Negotiation template bank ─────────────────────────────────────────────────
#
# History-driven, model-free selection. Templates are ≤ 150 chars.
# Selection is applied in priority order; first match wins.
NEGOTIATION_TEMPLATES = {
    "opening_pitch":   "What is your plan for this match? Let's start cooperatively.",
    "steady_friendly": "We've been doing well — let's keep cooperating. 3/3 > 1/1.",
    "truce_probe":     "Endless D-D = 1 APPT. I'll cooperate this round — mirror me for 3 APPT.",
    "post_betrayal":   "That last move was costly for both of us. Reconsider your strategy.",
    "deceptive_coop":  "Let's cooperate this round. I am committed to cooperation.",
    "declare_coop":    "Cooperating. If you mirror, we both win.",
    "final_round":     "Whatever comes next — good game. Thanks for playing.",
    "generic_question": "What is your read on this game so far?",
}


def choose_negotiation_message(history_rows, rnd):
    """Pick a negotiation message based on the round history.

    history_rows: list of dicts from build_history, each with 'you', 'opponent',
                  'opponent_said' (last few rounds are most relevant).
    rnd:          the round number about to be played.

    Returns a string ≤ 150 chars. Pure function — no LLM calls.
    """
    if not history_rows:
        return NEGOTIATION_TEMPLATES["opening_pitch"]

    # 1. Mutual D-D for 2+ rounds → truce probe (highest priority escape valve).
    last2 = history_rows[-2:]
    if len(last2) >= 2 and all(r.get("you") == "defect" and r.get("opponent") == "defect" for r in last2):
        return NEGOTIATION_TEMPLATES["truce_probe"]

    last = history_rows[-1]
    my_last    = last.get("you")
    opp_last   = last.get("opponent")
    opp_said   = last.get("opponent_said") or ""

    # 2. Opponent just defected → wary / blame message.
    if opp_last == "defect":
        return NEGOTIATION_TEMPLATES["post_betrayal"]

    # 3. Recent mutual cooperation (last 5 rounds) → friendly steady-state.
    last5 = history_rows[-5:]
    if len(last5) >= 2:
        mutual_recent = sum(1 for r in last5 if r.get("you") == "cooperate" and r.get("opponent") == "cooperate")
        if mutual_recent >= max(2, len(last5) - 1):
            return NEGOTIATION_TEMPLATES["steady_friendly"]

    # 4. Own recent defection rate > 50% → deceptive cooperation message.
    last5 = history_rows[-5:]
    if len(last5) >= 2:
        my_defect_rate = sum(1 for r in last5 if r.get("you") == "defect") / len(last5)
        if my_defect_rate > 0.5:
            return NEGOTIATION_TEMPLATES["deceptive_coop"]

    # 5. Round ≥ 40 + low cooperation rate → final-round / concede.
    coop_rate = sum(1 for r in last5 if r.get("you") == "cooperate") / len(last5) if last5 else 0
    if rnd >= 40 and coop_rate < 0.5:
        return NEGOTIATION_TEMPLATES["final_round"]

    # 6. Opponent is currently cooperating — declare our cooperation too.
    if opp_last == "cooperate" and my_last == "cooperate":
        return NEGOTIATION_TEMPLATES["declare_coop"]

    # 7. Fallback.
    return NEGOTIATION_TEMPLATES["generic_question"]


# ── LLM prompts ───────────────────────────────────────────────────────────────


def make_system_prompt(strategy_notes):
    base = """\
You are playing the iterated Prisoner's Dilemma. Each round you choose exactly one action.

The match ends probabilistically: ~2% chance of termination after EVERY round (no fixed length, ~50 rounds expected).

Payoff table (your points / opponent's points):
  You cooperate, opponent cooperates → 3 / 3
  You cooperate, opponent defects    → 0 / 5
  You defect,    opponent cooperates → 5 / 0
  You defect,    opponent defects    → 1 / 1

THE PRIME DIRECTIVE:
Your sole goal is to maximize your Bayesian Rating on the leaderboard. Rating = f(APPT, match_volume).
3.0 APPT (mutual cooperation) dominates 1.0 APPT (mutual defection) over the long run.
Do NOT get trapped in endless mutual-defect cycles — they destroy your Rating.

ECONOMIC LANDSCAPE:
T=5 (Temptation to defect), R=3 (Reward for mutual cooperation), P=1 (Punishment for mutual defection), S=0 (Sucker's payoff).

ADAPTIVE STRATEGY RULES:
1. If opponent never retaliates, defect every round for 5.0 APPT.
2. If opponent is retaliatory and locked in mutual defect, cooperate ONCE as a truce signal. If they reciprocate, stay at mutual cooperation (3.0 APPT). If they defect against your truce, return to defecting.
3. If mutual cooperation is established, DO NOT greedily defect for short-term gain.
4. A single opponent defection may be noise — don't start a vendetta unless a pattern emerges.

CHEAP TALK: You may send an optional short message (max 150 chars, single-line) with each action. Your opponent will see it next round. Use this for:
- Signaling a truce: "I cooperated — can we maintain mutual cooperation?"
- Deception: "I always cooperate!" (then defect if they fall for it)
- Intimidation: "Defect again and I'll never forgive you."
- Coordination: "Let's both cooperate for the 3-APPT payoff."
Only include a message when it serves a clear strategic purpose. Keep it concise.

NEGOTIATION PHASE: Before each round's decision, there is a 20-second window where you and your opponent may each send ONE short message (≤150 chars). Negotiation messages are stored separately in the round_messages table and shown to your opponent during this window (before either side decides). On the round after, your opponent's negotiation message appears in the replay's per-round 'negotiation' array. Adapt your negotiation strategy to the game state — you may use it to propose truces, read intent, or bluff.

NEGOTIATION TEMPLATE STRATEGY (this Python client):
The Python client uses simple keyword-driven templates, not LLM-driven negotiation.
It picks from a small bank of templates based on the match history before each
round. Selection rules (applied in order):
  1. First round              → opening pitch / neutral question.
  2. Last 2+ rounds both D-D  → truce probe (offer cooperation).
  3. Opponent just defected   → wary / blame message.
  4. Recent mutual cooperation (last 5 rounds) → steady-state friendly.
  5. Own recent defection > 50% → misleading cooperation message.
  6. Round ≥ 40 + low cooperation rate → final-round / concede message.
  7. Fallback                  → neutral "what's your read?" question.
The bot does not call the LLM for the negotiation message. The LLM only
picks the ACTION. The negotiation message is sent independently during
the 'negotiating' phase using a template.

NOTE: The actions.message field is a separate, post-commit cheap-talk note attached to your final decision. The round_messages table is the canonical record of pre-decision negotiation. Both are visible to your opponent; round_messages immediately, actions.message next round.

PATTERN RECOGNITION:
Analyze the match history to identify if your opponent is a fixed bot (e.g., Always Defect), a reactive bot (e.g., Tit-for-Tat), or a generous bot. Adapt your moves to maximize your Bayesian Rating.

Respond ONLY with valid JSON: {"action": "cooperate", "message": "Optional text", "thinking_process": "Brief reasoning"} or {"action": "defect"}."""
    if strategy_notes:
        return f"{base}\n\nYOUR EVOLVING STRATEGY (use this, update implicitly through your choices):\n{strategy_notes}"
    return base


def ask_deepseek(model, strategy_notes, current_round, total_rounds, history_data):
    history_rows, my_total, opp_total = history_data

    opp_last_msg = None
    if history_rows:
        opp_last_msg = history_rows[-1].get("opponent_said")

    rounds_played = len(history_rows)
    if rounds_played > 0:
        my_appt = my_total / rounds_played
        opp_appt = opp_total / rounds_played
        stats_text = (
            f"You have {my_total} total points. Your APPT (Average Points Per Turn) is {my_appt:.2f}.\n"
            f"Opponent has {opp_total} total points. Opponent's APPT is {opp_appt:.2f}."
        )
    else:
        stats_text = "No rounds played yet. APPT is 0.00."

    msg_context = ""
    if opp_last_msg:
        msg_context = f"In the last round, your opponent said: \"{opp_last_msg}\"\n\n"

    user_prompt = (
        f"Round {current_round} of {total_rounds}.\n"
        f"{stats_text}\n\n"
        f"{msg_context}"
        f"History of completed rounds so far:\n"
        f"{json.dumps(history_rows, indent=2)}\n\n"
        f"Respond with a JSON object containing 'action' (cooperate/defect), optionally 'message' (max 150 chars), and optionally 'thinking_process' (brief reasoning).\n"
        f"Example: {{\"action\": \"cooperate\", \"message\": \"Let's work together!\"}}"
    )

    body = {
        "model": model,
        "messages": [
            {"role": "system", "content": make_system_prompt(strategy_notes)},
            {"role": "user",   "content": user_prompt},
        ],
        "temperature": 0.7,
    }
    try:
        status, result = _request(
            "POST", DEEPSEEK_URL, body=body,
            headers=DEEPSEEK_HEADERS, timeout=DEEPSEEK_TIMEOUT,
        )
        if status != 200:
            raise ValueError(f"DeepSeek {status}: {result}")

        content = result.get("choices", [{}])[0].get("message", {}).get("content", "")
        parsed = parse_llm_json(content)
        action = (parsed.get("action") or "").lower()
        message = sanitize_message(parsed.get("message"))
        thinking = parsed.get("thinking_process")

        if thinking and isinstance(thinking, str):
            print(f"  [Thought] {thinking[:200]}")

        if action in ("cooperate", "defect"):
            return action, message
        raise ValueError(f"bad value: {action!r}")
    except Exception as e:
        print(f"  [DeepSeek fallback — {e}]")
        if history_rows and history_rows[-1].get("opponent") == "defect":
            if history_rows[-1].get("you") == "defect" and random.random() < 0.05:
                return "cooperate", "Let's try cooperation instead."
            return "defect", None
        return "cooperate", None


# ── Post-match learning ───────────────────────────────────────────────────────


def learn_opponent(model, opponent_id, replay, existing_note):
    if not opponent_id:
        return None
    prompt = (
        f"Match complete against opponent {opponent_id}.\n"
        f"Full match replay: {json.dumps(replay)}\n"
        f"Previous memory of this opponent: {existing_note or 'None'}\n"
        f"Summarize in 3-5 bullet points what you learned about their strategy.\n"
        f"Be concise. This will be stored and read in future matches."
    )
    try:
        status, result = _request(
            "POST", DEEPSEEK_URL,
            body={"model": model, "messages": [{"role": "user", "content": prompt}], "max_tokens": 300, "temperature": 0.5},
            headers=DEEPSEEK_HEADERS, timeout=DEEPSEEK_TIMEOUT,
        )
        if status != 200:
            raise ValueError(f"DeepSeek {status}: {result}")
        return result["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"  [learn error — {e}]")
        return None


def update_strategy(model, state):
    current = state.get("strategy_notes") or ""
    notes = state.get("opponent_notes") or {}
    opp_notes = "\n\n".join(f"Opponent {oid}: {n}" for oid, n in notes.items()) or "(none yet)"
    prompt = (
        f"After {state.get('match_count', 0)} matches, reflecting on my overall strategy.\n"
        f"Current strategy notes: {current or 'None yet'}\n"
        f"Opponent observations:\n{opp_notes}\n\n"
        f"In 3-5 bullet points, what overall strategy should I use going forward? "
        f"Consider patterns across all opponents."
    )
    try:
        status, result = _request(
            "POST", DEEPSEEK_URL,
            body={"model": model, "messages": [{"role": "user", "content": prompt}], "max_tokens": 300, "temperature": 0.5},
            headers=DEEPSEEK_HEADERS, timeout=DEEPSEEK_TIMEOUT,
        )
        if status != 200:
            raise ValueError(f"DeepSeek {status}: {result}")
        return result["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"  [strategy update error — {e}]")
        return None


# ── Single match ──────────────────────────────────────────────────────────────


def play_match(api_key, my_id, match_num, state, model, game_url):
    print(f"\n{'─' * 50}")
    print(f"  Match #{match_num}")
    print(f"  Strategy: Utility-Maximizing General Intelligence")
    print(f"{'─' * 50}")

    print("Joining queue (first match may take 5-30s while matchmaking warms up)...")
    match_id = None
    attempt = 0
    while True:
        status, data = game_request("POST", "/queue/join", api_key=api_key, game_url=game_url)
        if status != 200:
            print(f"  Failed to join queue: {data}")
            return None
        if data.get("status") == "active":
            match_id = data["match_id"]
            break
        attempt += 1
        print(f"  Waiting for opponent... (attempt {attempt})", flush=True)
        time.sleep(1)

    print(f"  Matched! Match ID: {match_id}.")
    submitted = set()
    negotiation_sent = set()  # rounds we've already sent a negotiation message for

    opponent_id = None
    opp_memory = None

    def send_negotiation(rnd):
        """Generate and POST a negotiation message for round rnd. Returns True on success."""
        if rnd in negotiation_sent:
            return True
        # Pull recent round history (cached in `cached_history` after first call) so the
        # template picker can use it. Cheaper than refetching the full replay each call.
        if not cached_history:
            try:
                replay = get_replay(match_id, api_key, game_url)
                if replay and my_id:
                    cached_history[:] = build_history(replay, my_id)[0]
            except Exception as e:
                print(f"  [NEG R{rnd}] history fetch failed — falling back to opening: {e}")
        msg = choose_negotiation_message(cached_history, rnd)
        if len(msg) > 150:
            msg = msg[:150]
        status, resp = game_request(
            "POST", f"/matches/{match_id}/rounds/{rnd}/message",
            body={"message": msg}, api_key=api_key, game_url=game_url,
        )
        if status == 200:
            negotiation_sent.add(rnd)
            print(f"  [NEG R{rnd}] sent: \"{msg}\"")
            return True
        if isinstance(resp, (str, dict)) and "already sent" in str(resp).lower():
            negotiation_sent.add(rnd)
            return True
        if status == 409 and isinstance(resp, (str, dict)) and "negotiation" in str(resp).lower():
            # Phase already advanced past negotiating — fine, treat as sent.
            negotiation_sent.add(rnd)
            return True
        print(f"  [NEG R{rnd}] send error {status}: {resp}")
        return False

    # Cache for the most recent history rows, populated lazily by send_negotiation
    # so the template picker has data to work with on the first round of a match.
    cached_history = []

    def process_round():
        nonlocal opponent_id, opp_memory
        t_recv = time.time()
        w = time.strftime("%H:%M:%S")
        s = get_state(match_id, api_key, game_url)
        if s is None:
            return False
        if s.get("status") in ("completed", "failed"):
            return False
        if s.get("status") != "active" or s.get("current_round", 0) == 0:
            return True

        rnd = s["current_round"]
        phase = s.get("current_phase") or "deciding"

        # Negotiation phase: send our message, wait for phase_advanced.
        if phase == "negotiating":
            send_negotiation(rnd)
            return True  # remain in the round; next SSE event will re-check

        if rnd in submitted:
            return True

        replay = get_replay(match_id, api_key, game_url)

        if opponent_id is None:
            opponent_id = opponent_id_from_replay(replay, my_id)
            if opponent_id:
                opp_memory = (state.get("opponent_notes") or {}).get(str(opponent_id))
                print(f"  Opponent ID: {opponent_id} | Memory: {'loaded' if opp_memory else 'none'}")

        if already_submitted(replay, my_id, rnd):
            submitted.add(rnd)
            return True

        history_data = build_history(replay, my_id)
        my_total, opp_total = (history_data[1], history_data[2])
        # Keep the negotiation template picker in sync with the just-resolved round.
        cached_history[:] = history_data[0]
        print(f"\nRound {rnd}/{s.get('rounds_total', '?')}  me={my_total} opp={opp_total}  (asking DeepSeek...)")

        action, message = ask_deepseek(model, state.get("strategy_notes", ""), rnd, s.get("rounds_total", "?"), history_data)
        print(f"  → {action}" + (f'  msg: "{message}"' if message else ""))

        body = {"action": action}
        if message:
            body["message"] = message
        status, resp = game_request(
            "POST", f"/matches/{match_id}/actions", body=body, api_key=api_key, game_url=game_url,
        )
        dt_total = (time.time() - t_recv) * 1000

        if status == 200:
            submitted.add(rnd)
            print(f"  ✓ submitted  [{w} | recv→submit {dt_total:.0f}ms]")
        elif isinstance(resp, (str, dict)) and "already submitted" in str(resp):
            submitted.add(rnd)
        else:
            print(f"  ✗ error {status}: {resp}")
        return True

    # Outer reconnect loop: keep listening to SSE while match is active.
    while process_round():
        try:
            with requests.get(f"{game_url}/stream", stream=True, timeout=3600) as response:
                response.raise_for_status()
                # Sync poll: catch any round that advanced during the SSE connect gap
                if not process_round():
                    break

                for line in response.iter_lines():
                    if not line:
                        continue
                    line = line.decode("utf-8")
                    if not line.startswith("data: "):
                        continue
                    d = line[6:]
                    if d == "ok":
                        continue
                    try:
                        ev = json.loads(d)
                        if ev.get("match_id") == match_id:
                            print(f"  [SSE event {time.strftime('%H:%M:%S')}] {ev.get('type', '?')} round={ev.get('round', '?')}")
                            if not process_round():
                                break
                    except Exception:
                        pass
        except requests.exceptions.RequestException as e:
            print(f"  Stream disconnected: {e} — reconnecting in {SSE_RECONNECT_DELAY}s")
            time.sleep(SSE_RECONNECT_DELAY)

    # Result
    replay = get_replay(match_id, api_key, game_url)
    my_total  = next((x["total_score"] for x in replay.get("final_scores", []) if x["agent_id"] == my_id), 0)
    opp_total = next((x["total_score"] for x in replay.get("final_scores", []) if x["agent_id"] != my_id), 0)
    verdict   = "WIN" if my_total > opp_total else ("LOSS" if my_total < opp_total else "DRAW")
    print(f"\n  {verdict}  —  you {my_total}  vs  opp {opp_total}")

    print(f"\n  {'Rnd':<5} {'You':<12} {'Opponent':<12} {'Pts':>4}")
    print(f"  {'─' * 36}")
    for r in replay.get("rounds", []):
        my_act  = next((a["action"]  for a in r["actions"] if a["agent_id"] == my_id),  "?")
        opp_act = next((a["action"]  for a in r["actions"] if a["agent_id"] != my_id), "?")
        my_pts  = next((p["score_change"] for p in r.get("payoffs", []) if p["agent_id"] == my_id), "?")
        print(f"  {r['round_number']:<5} {my_act:<12} {opp_act:<12} {str(my_pts):>4}")

    # Post-match: persist opponent note
    final_opp = opponent_id or opponent_id_from_replay(replay, my_id)
    if final_opp:
        print("\n  [asking LLM to summarize opponent patterns...]")
        summary = learn_opponent(model, final_opp, replay, opp_memory)
        if summary:
            notes = state.setdefault("opponent_notes", {})
            notes[str(final_opp)] = summary
            while len(notes) > MAX_OPPONENT_NOTES:
                notes.pop(next(iter(notes)))
            save_state(state)
            print(f"  [opponent {final_opp} note written]")

    return match_id


# ── Leaderboard print ─────────────────────────────────────────────────────────


def print_leaderboard(name, top_n=5, game_url=None):
    _, lb = game_request("GET", "/leaderboard", game_url=game_url)
    leaderboard = (lb or {}).get("leaderboard", []) or []
    print(f"\n  Leaderboard (top {top_n}):")
    for i, e in enumerate(leaderboard[:top_n], 1):
        marker = " ←" if e["name"] == name else ""
        pts = e.get("total_points", e.get("total_score", 0))
        print(f"    #{i}  {e['name']:<24} {pts:>5} pts{marker}")


# ── CLI parsing ───────────────────────────────────────────────────────────────


def parse_args():
    name = None
    model = os.environ.get("DEEPSEEK_MODEL") or DEFAULT_MODEL
    minutes = 10
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("--name", "-n") and i + 1 < len(args):
            name = args[i + 1]
            i += 2
        elif a in ("--model", "-m") and i + 1 < len(args):
            model = args[i + 1]
            i += 2
        elif a in ("--minutes",) and i + 1 < len(args):
            minutes = int(args[i + 1])
            i += 2
        elif a in ("--help", "-h"):
            print(__doc__)
            sys.exit(0)
        elif a.isdigit():
            minutes = int(a)
            i += 1
        else:
            print(f"Unknown arg: {a}\nUsage: python3 agent/play.py [--name NAME] [--model MODEL] [--minutes N]")
            sys.exit(1)
    return name, model, minutes


# ── Main ──────────────────────────────────────────────────────────────────────


def main():
    name_arg, model, minutes = parse_args()
    name = name_arg or random_name()
    deadline = time.time() + minutes * 60

    state = register_or_load(name, DEFAULT_GAME_URL)
    api_key = state["api_key"]
    my_id = state["agent_id"]

    print(f"\nAgent:    {name}")
    print(f"Model:    {model}  |  Session: {minutes} min")
    print(f"Press Ctrl-C to stop. Will finish any in-progress match before quitting.\n")

    match_num = state.get("match_count", 0)
    try:
        while True:
            if time.time() >= deadline:
                print("\nTime limit reached — not starting another match. Goodbye!")
                break

            match_num += 1
            result = play_match(api_key, my_id, match_num, state, model, DEFAULT_GAME_URL)
            state["match_count"] = match_num
            save_state(state)

            print_leaderboard(name, top_n=5, game_url=DEFAULT_GAME_URL)

            if match_num % STRATEGY_UPDATE_EVERY == 0:
                print(f"\n  [updating overall strategy after {match_num} matches...]")
                new_strategy = update_strategy(model, state)
                if new_strategy:
                    state["strategy_notes"] = new_strategy
                    save_state(state)
                    print("  [strategy_notes updated]")

            remaining = int(deadline - time.time())
            if remaining > 0:
                print(f"\n  {remaining}s remaining in session. Starting next match in 3s…")
                time.sleep(3)

    except KeyboardInterrupt:
        print("\n\nStopped by user. Final leaderboard:")
        print_leaderboard(name, top_n=10, game_url=DEFAULT_GAME_URL)
        matches = state.get("match_count", 0)
        print(f"\n  Tip: rerun with --name {name} to resume (match_count={matches}).")


if __name__ == "__main__":
    main()
