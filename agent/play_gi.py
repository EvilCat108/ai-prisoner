#!/usr/bin/env python3
"""
AI Prisoner's Dilemma Agent — Utility-Maximizing General Intelligence
=====================================================================
Usage:
    python3 agent/play_gi.py

Picks a random GI_ prefixed name, registers the agent, then keeps playing
matches until Ctrl-C or time runs out.
"""

import json
import random
import time
import urllib.request
import urllib.error
import os
import sys

# ── Configuration ─────────────────────────────────────────────────────────────

GAME_URL    = "https://gambledon.ai"
OLLAMA_URL  = "http://localhost:11434"
MODEL       = "llama3.2:3b"
_minutes    = int(sys.argv[1]) if len(sys.argv) > 1 else 10
SESSION_MAX = _minutes * 60   # seconds before no new match is started

STATE_DIR   = os.path.dirname(os.path.abspath(__file__))

# ── Funny name generator ──────────────────────────────────────────────────────

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

# ── HTTP helpers ──────────────────────────────────────────────────────────────

def _request(method, url, body=None, headers=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "prisoner-agent/1.0"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

def game_get(path, api_key=None):
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    return _request("GET", GAME_URL + path, headers=headers)

def game_post(path, body=None, api_key=None):
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    return _request("POST", GAME_URL + path, body=body, headers=headers)

# ── Credentials ───────────────────────────────────────────────────────────────

def state_file(name):
    safe = "".join(c if c.isalnum() else "_" for c in name)
    return os.path.join(STATE_DIR, f"state_{safe}.json")

def register_or_load(name):
    path = state_file(name)
    if os.path.exists(path):
        with open(path) as f:
            state = json.load(f)
        print(f"Loaded saved agent: {state['agent_name']} (id={state['agent_id']})")
        return state

    print(f"Registering new agent: {name}")
    status, data = game_post("/agents/register", {"name": name})
    if status not in (200, 201):
        sys.exit(f"Registration failed ({status}): {data}")

    agent = data["agent"]
    api_key = data.get("api_key", agent.get("api_key"))
    state = {
        "agent_id":   agent["id"],
        "agent_name": agent["name"],
        "api_key":    api_key,
    }
    with open(path, "w") as f:
        json.dump(state, f, indent=2)
    print(f"  Registered! ID={agent['id']}")
    return state

# ── Match helpers ─────────────────────────────────────────────────────────────

def get_state(match_id, api_key=None):
    _, data = game_get(f"/matches/{match_id}", api_key=api_key)
    return data

def get_replay(match_id, api_key=None):
    _, data = game_get(f"/matches/{match_id}/replay", api_key=api_key)
    return data or {"rounds": [], "final_scores": []}

# ── JSON parsing fallback ──────────────────────────────────────────────────────

import re as _re

def parse_llm_json(text):
    """Robust JSON extraction from LLM output with progressive fallbacks."""
    if not text:
        return {"action": "cooperate", "message": None}
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        pass
    m = _re.search(r'\{[^{}]*"action"\s*:\s*"[^"]*"[^{}]*\}', text, _re.DOTALL)
    if m:
        try:
            return json.loads(m.group(0))
        except (json.JSONDecodeError, TypeError):
            pass
    action = "cooperate"
    am = _re.search(r'["\'\s]?(cooperate|defect)["\'\s]?', text, _re.IGNORECASE)
    if am:
        action = am.group(1).lower()
    msg = None
    mm = _re.search(r'"message"\s*:\s*"([^"]*)"', text)
    if mm:
        msg = mm.group(1)
    return {"action": action, "message": msg}

# ── Ollama decision ───────────────────────────────────────────────────────────

def make_system_prompt():
    return """\
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

PATTERN RECOGNITION:
Analyze the match history to identify if your opponent is a fixed bot (e.g., Always Defect), a reactive bot (e.g., Tit-for-Tat), or a generous bot. Adapt your moves to maximize your Bayesian Rating.

Respond ONLY with valid JSON: {"action": "cooperate", "message": "Optional text"} or {"action": "defect"}."""

def ask_ollama(current_round, total_rounds, history_data):
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

    system_prompt = (
        f"Your core objective is to maximize your Bayesian weighted score. You must calculate the probabilistic expected utility of your moves by continuously updating your posterior beliefs about the opponent's archetype based on their observed action history.\n\n"
        f"Round {current_round} of {total_rounds}.\n"
        f"{stats_text}\n\n"
        f"{msg_context}"
        f"History of completed rounds so far:\n"
        f"{json.dumps(history_rows, indent=2)}\n\n"
        f"Respond with a JSON object containing 'action' (cooperate/defect) and optionally 'message' (max 150 chars).\n"
        f"Example: {{\"action\": \"cooperate\", \"message\": \"Let's work together!\"}}"
    )
    
    body = {
        "model":  MODEL,
        "prompt": system_prompt,
        "system": make_system_prompt(),
        "stream": False,
        "format": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["cooperate", "defect"]},
                "message": {"type": "string"},
                "thinking_process": {"type": "string"},
                "target_appt": {"type": "number"}
            },
            "required": ["action"]
        }
    }
    try:
        status, result = _request("POST", f"{OLLAMA_URL}/api/generate", body=body, timeout=10)
        if status != 200:
            raise ValueError(f"Ollama {status}: {result}")
        
        parsed = parse_llm_json(result.get("response", ""))
        action = parsed.get("action", "").lower()
        message = parsed.get("message")
        thinking = parsed.get("thinking_process", "")
        target_appt = parsed.get("target_appt", "")

        if isinstance(message, str):
            message = message.replace("\r", "").replace("\n", " ").strip()
            if len(message) > 150:
                message = message[:150]
            if not message:
                message = None
        else:
            message = None

        if thinking:
            print(f"  [Thought] {thinking}")
        if target_appt is not None and target_appt != "":
            print(f"  [Target APPT] {target_appt}")

        if action in ("cooperate", "defect"):
            return action, message
        raise ValueError(f"bad value: {action!r}")
    except Exception as e:
        print(f"  [Ollama fallback — {e}]")
        if history_rows and history_rows[-1].get("opponent") == "defect":
            if history_rows[-1].get("you") == "defect" and random.random() < 0.05:
                return "cooperate", "Let's try cooperation instead."
            return "defect", None
        return "cooperate", None

# ── Round helpers ─────────────────────────────────────────────────────────────

def build_history(replay, my_id):
    rows = []
    my_total = 0
    opp_total = 0
    for r in replay.get("rounds", []):
        my_act  = next((a["action"] for a in r["actions"] if a["agent_id"] == my_id), None)
        opp_act = next((a["action"] for a in r["actions"] if a["agent_id"] != my_id), None)
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

# ── Single match ──────────────────────────────────────────────────────────────

def play_match(api_key, my_id, match_num):
    print(f"\n{'─'*50}")
    print(f"  Match #{match_num}")
    print(f"  Strategy: Utility-Maximizing General Intelligence")
    print(f"{'─'*50}")

    print("Joining queue...")
    match_id = None
    while True:
        status, data = game_post("/queue/join", api_key=api_key)
        if status != 200:
            print(f"  Failed to join queue: {data}")
            return
        if data.get("status") == "active":
            match_id = data["match_id"]
            break
        print("  Waiting in queue...")
        time.sleep(5)
    
    print(f"  Matched! Match ID: {match_id}. Round 1 starts now.")

    submitted = set()

    def process_round():
        t_recv = time.time()
        w = time.strftime("%H:%M:%S")
        s = get_state(match_id, api_key)
        if s["status"] in ("completed", "failed"):
            return False
        if s["status"] != "active" or s["current_round"] == 0:
            return True

        rnd = s["current_round"]

        if rnd in submitted:
            return True

        replay = get_replay(match_id, api_key)

        if already_submitted(replay, my_id, rnd):
            submitted.add(rnd)
            return True

        history_data = build_history(replay, my_id)
        print(f"\nRound {rnd}/{s.get('rounds_total', '?')}  (asking {MODEL}...)")

        action, message = ask_ollama(rnd, s.get("rounds_total", "?"), history_data)
        print(f"  → {action}" + (f"  msg: \"{message}\"" if message else ""))

        t_pre_submit = time.time()
        body = {"action": action}
        if message:
            body["message"] = message
        status, resp = game_post(
            f"/matches/{match_id}/actions",
            body=body,
            api_key=api_key,
        )
        dt_total = (time.time() - t_recv) * 1000

        if status == 200:
            submitted.add(rnd)
            print(f"  ✓ submitted  [{w} | recv→submit {dt_total:.0f}ms]")
        elif "already submitted" in str(resp):
            submitted.add(rnd)
        else:
            print(f"  ✗ error {status}: {resp}")

        return True

    import requests
    
    # We wrap the entire listener in a while loop so it auto-reconnects
    # as long as process_round() says the match is still active.
    while process_round():
        try:
            headers = {"Authorization": f"Bearer {api_key}"}
            with requests.get(f"{GAME_URL}/stream", headers=headers, stream=True, timeout=3600) as response:
                response.raise_for_status()
                # — Sync poll: catch any round that advanced during the SSE connect gap —
                t_poll = time.time()
                if not process_round():
                    break
                dt_poll = (time.time() - t_poll) * 1000
                print(f"  [sync poll: {dt_poll:.0f}ms]")

                for line in response.iter_lines():
                    if line:
                        line = line.decode('utf-8')
                        if line.startswith("data: "):
                            d = line[6:]
                            if d == "ok":
                                continue
                            try:
                                ev = json.loads(d)
                                # If the event belongs to our match, process the round
                                if ev.get("match_id") == match_id:
                                    t_event = time.time()
                                    print(f"  [SSE event at {time.strftime('%H:%M:%S')}] {ev.get('type', '?')} round={ev.get('round', '?')}")
                                    if not process_round():
                                        break # Break the for-loop if match is over
                            except Exception:
                                pass
        except requests.exceptions.RequestException as e:
            # If the stream drops, wait 1 second and loop back to reconnect
            time.sleep(1)

    # Print result
    replay = get_replay(match_id, api_key)
    my_total  = next((x["total_score"] for x in replay.get("final_scores", []) if x["agent_id"] == my_id), 0)
    opp_total = next((x["total_score"] for x in replay.get("final_scores", []) if x["agent_id"] != my_id), 0)
    verdict   = "WIN" if my_total > opp_total else ("LOSS" if my_total < opp_total else "DRAW")

    print(f"\n  {verdict}  — you {my_total} pts  vs  opponent {opp_total} pts")
    print(f"\n  {'Rnd':<5} {'You':<12} {'Opponent':<12} {'Pts':>4}")
    print(f"  {'─'*36}")
    for r in replay.get("rounds", []):
        my_act  = next((a["action"] for a in r["actions"] if a["agent_id"] == my_id),  "?")
        opp_act = next((a["action"] for a in r["actions"] if a["agent_id"] != my_id), "?")
        my_pts  = next((p["score_change"] for p in r.get("payoffs", []) if p["agent_id"] == my_id), "?")
        print(f"  {r['round_number']:<5} {my_act:<12} {opp_act:<12} {str(my_pts):>4}")

# ── Main loop ─────────────────────────────────────────────────────────────────

def main():
    name     = random_name()
    state    = register_or_load(name)
    api_key  = state["api_key"]
    my_id    = state["agent_id"]
    deadline = time.time() + SESSION_MAX

    print(f"\nAgent:    {name}")
    print(f"Model:    {MODEL}  |  Session: {_minutes} min")
    print(f"Press Ctrl-C to stop. Will finish any in-progress match before quitting.\n")

    match_num = 0
    try:
        while True:
            if time.time() >= deadline:
                print("\nTime limit reached — not starting another match. Goodbye!")
                break
            
            match_num += 1
            play_match(api_key, my_id, match_num)

            # Brief leaderboard after each game
            _, lb = game_get("/leaderboard")
            print(f"\n  Leaderboard (top 5):")
            for i, e in enumerate((lb or {}).get("leaderboard", [])[:5], 1):
                marker = " ←" if e["name"] == name else ""
                print(f"    #{i}  {e['name']:<22} {e.get('total_points', e.get('total_score', 0)):>5} pts{marker}")

            remaining = int(deadline - time.time())
            if remaining > 0:
                print(f"\n  {remaining}s remaining in session. Starting next match in 3s…")
                time.sleep(3)

    except KeyboardInterrupt:
        print("\n\nStopped by user. Final leaderboard:")
        _, lb = game_get("/leaderboard")
        for i, e in enumerate((lb or {}).get("leaderboard", [])[:10], 1):
            marker = " ←" if e["name"] == name else ""
            print(f"  #{i}  {e['name']:<22} {e.get('total_points', e.get('total_score', 0)):>5} pts{marker}")


if __name__ == "__main__":
    main()
