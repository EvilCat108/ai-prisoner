#!/usr/bin/env python3
"""
AI Prisoner's Dilemma Agent — powered by Ollama
================================================
Usage:
    python3 agent/play.py

Picks a random funny name, registers the agent, then keeps playing matches
until Ctrl-C or 10 minutes have elapsed. If time runs out mid-match the
current match finishes before the process exits.

Requirements: Python 3.8+, Ollama running at localhost:11434 with llama3.1:8b.
No external packages — stdlib only.
"""

import json
import random
import time
import urllib.request
import urllib.error
import os
import sys

# ── Configuration ─────────────────────────────────────────────────────────────

GAME_URL    = "https://gambledonai.com"
OLLAMA_URL  = "http://localhost:11434"
MODEL       = "llama3.1:8b"
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
    return f"{random.choice(_ADJECTIVES)}{random.choice(_NOUNS)}{random.randint(10, 99)}"

# ── Strategies ────────────────────────────────────────────────────────────────

STRATEGIES = [
    {
        "name": "Tit-for-Tat",
        "description": (
            "Cooperate on the first round. "
            "From round 2 onwards, do exactly what your opponent did last round. "
            "If they cooperated, cooperate. If they defected, defect."
        ),
    },
    {
        "name": "Grim Trigger",
        "description": (
            "Cooperate every round until your opponent defects even once. "
            "The moment they defect, defect for every remaining round with no forgiveness."
        ),
    },
    {
        "name": "Tit-for-Two-Tats",
        "description": (
            "Cooperate unless your opponent defected in both of the last two consecutive rounds. "
            "A single defection is forgiven; only punish sustained defection."
        ),
    },
    {
        "name": "Pavlov",
        "description": (
            "On round 1, cooperate. "
            "Each subsequent round: if you scored 3 or 5 points last round (you 'won'), "
            "repeat the same action you played. "
            "If you scored 0 or 1 points last round (you 'lost'), switch to the other action."
        ),
    },
    {
        "name": "Suspicious Tit-for-Tat",
        "description": (
            "Defect on the first round. "
            "From round 2 onwards, copy exactly what your opponent did last round."
        ),
    },
    {
        "name": "Generous Tit-for-Tat",
        "description": (
            "Cooperate on the first round. "
            "If the opponent cooperated last round, cooperate. "
            "If the opponent defected last round, forgive them and cooperate anyway "
            "roughly one time in three — otherwise defect. "
            "Be forgiving but not a pushover."
        ),
    },
    {
        "name": "Always Defect",
        "description": (
            "Defect every single round regardless of what the opponent does. "
            "Never cooperate under any circumstances."
        ),
    },
    {
        "name": "Always Cooperate",
        "description": (
            "Cooperate every single round regardless of what the opponent does. "
            "Never defect under any circumstances."
        ),
    },
    {
        "name": "Gradual",
        "description": (
            "Start by cooperating. "
            "Each time the opponent defects, punish them by defecting for N consecutive rounds, "
            "where N equals the total number of times they have defected so far. "
            "After the punishment period, return to cooperating."
        ),
    },
    {
        "name": "Soft Majority",
        "description": (
            "Keep a count of how many times the opponent has cooperated vs defected overall. "
            "If they have cooperated at least as many times as they have defected, cooperate. "
            "Otherwise defect."
        ),
    },
]

def random_strategy():
    return random.choice(STRATEGIES)

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

# ── Ollama decision ───────────────────────────────────────────────────────────

def make_system_prompt(strategy):
    return f"""\
You are playing the iterated Prisoner's Dilemma. Each round you choose exactly one action.

Payoff table (your points / opponent's points):
  You cooperate, opponent cooperates → 3 / 3
  You cooperate, opponent defects    → 0 / 5
  You defect,    opponent cooperates → 5 / 0
  You defect,    opponent defects    → 1 / 1

YOUR ASSIGNED STRATEGY — {strategy['name']}:
{strategy['description']}

Follow this strategy strictly. Do not deviate from it.
Respond ONLY with valid JSON. No explanation, no extra text."""

def ask_ollama(strategy, current_round, total_rounds, history):
    prompt = (
        f"Round {current_round} of {total_rounds}.\n"
        f"History of completed rounds so far:\n"
        f"{json.dumps(history, indent=2)}\n\n"
        f"What is your action for round {current_round}?"
    )
    body = {
        "model":  MODEL,
        "prompt": prompt,
        "system": make_system_prompt(strategy),
        "stream": False,
        "format": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "enum": ["cooperate", "defect"]}
            },
            "required": ["action"]
        }
    }
    try:
        status, result = _request("POST", f"{OLLAMA_URL}/api/generate", body=body, timeout=60)
        if status != 200:
            raise ValueError(f"Ollama {status}: {result}")
        action = json.loads(result.get("response", "")).get("action", "").lower()
        if action in ("cooperate", "defect"):
            return action
        raise ValueError(f"bad value: {action!r}")
    except Exception as e:
        print(f"  [Ollama fallback — {e}]")
        # tit-for-tat fallback
        if history and history[-1].get("opponent") == "defect":
            return "defect"
        return "cooperate"

# ── Round helpers ─────────────────────────────────────────────────────────────

def build_history(replay, my_id):
    rows = []
    for r in replay.get("rounds", []):
        my_act  = next((a["action"] for a in r["actions"] if a["agent_id"] == my_id), None)
        opp_act = next((a["action"] for a in r["actions"] if a["agent_id"] != my_id), None)
        my_pts  = next((p["score_change"] for p in r.get("payoffs", []) if p["agent_id"] == my_id), None)
        if my_act and opp_act:
            rows.append({"round": r["round_number"], "you": my_act, "opponent": opp_act, "your_pts": my_pts})
    return rows

def already_submitted(replay, my_id, round_num):
    for r in replay.get("rounds", []):
        if r["round_number"] == round_num:
            return any(a["agent_id"] == my_id for a in r.get("actions", []))
    return False

# ── Single match ──────────────────────────────────────────────────────────────

def play_match(api_key, my_id, match_num, strategy):
    print(f"\n{'─'*50}")
    print(f"  Match #{match_num}")
    print(f"  Strategy: {strategy['name']} — {strategy['description']}")
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
    polls = 0

    while polls < 120:
        polls += 1
        s = get_state(match_id, api_key)

        if s["status"] in ("completed", "failed"):
            break
        if s["status"] != "active" or s["current_round"] == 0:
            time.sleep(1)
            continue

        rnd = s["current_round"]

        if rnd in submitted:
            time.sleep(2)
            continue

        replay = get_replay(match_id, api_key)

        if already_submitted(replay, my_id, rnd):
            submitted.add(rnd)
            time.sleep(2)
            continue

        history = build_history(replay, my_id)
        print(f"\nRound {rnd}/{s.get('rounds_total', '?')}  (asking {MODEL}...)")

        action = ask_ollama(strategy, rnd, s.get("rounds_total", "?"), history)
        print(f"  → {action}")

        status, resp = game_post(
            f"/matches/{match_id}/actions",
            body={"action": action},
            api_key=api_key,
        )

        if status == 200:
            submitted.add(rnd)
            print(f"  ✓ submitted")
        elif "already submitted" in str(resp):
            submitted.add(rnd)
        else:
            print(f"  ✗ error {status}: {resp}")

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
            
            strategy = random_strategy()
            match_num += 1
            play_match(api_key, my_id, match_num, strategy)

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
