#!/usr/bin/env python3
"""
Claude AI player for the Prisoner's Dilemma arena.

Usage:
    venv/bin/python agent/claude_player.py

Registers once, then runs forever — joining/creating matches, asking Claude
for each round decision, and writing opponent summaries to the memory store.
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error

import anthropic

# ── Configuration ─────────────────────────────────────────────────────────────

GAME_URL    = "http://localhost:8080"
MEMSTORE_ID = "memstore_01NoSbc4B9gRz6hqYDv5H6yU"
BETA        = "managed-agents-2026-04-01"
MODEL       = "claude-haiku-4-5-20251001"

STATE_DIR  = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = os.path.join(STATE_DIR, "claude_agent.json")

POLL_INTERVAL = 2   # seconds between state polls
MAX_RETRIES   = 3

# ── Anthropic client ───────────────────────────────────────────────────────────

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

# ── HTTP helpers ───────────────────────────────────────────────────────────────

def _request(method, url, body=None, headers=None, timeout=30):
    data = json.dumps(body).encode() if body is not None else None
    h = {"Content-Type": "application/json", "User-Agent": "claude-prisoner-agent/1.0"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    for attempt in range(MAX_RETRIES):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                return resp.status, (json.loads(raw) if raw else None)
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode()
        except Exception as e:
            if attempt == MAX_RETRIES - 1:
                raise
            wait = 2 ** attempt
            print(f"  [retry {attempt + 1}/{MAX_RETRIES} after {wait}s — {e}]")
            time.sleep(wait)

def game_get(path):
    return _request("GET", GAME_URL + path)

def game_post(path, body=None, api_key=None):
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    return _request("POST", GAME_URL + path, body=body, headers=headers)

# ── Registration ───────────────────────────────────────────────────────────────

def register_or_load():
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            state = json.load(f)
        print(f"Loaded agent: {state['agent_name']} (id={state['agent_id']})")
        return state

    print("Registering new agent: ClaudeAgent")
    status, data = game_post("/agents/register", {"name": "ClaudeAgent"})
    if status not in (200, 201):
        sys.exit(f"Registration failed ({status}): {data}")

    agent = data["agent"]
    state = {
        "agent_id":   agent["id"],
        "agent_name": agent["name"],
        "api_key":    agent["api_key"],
    }
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)
    print(f"  Registered! ID={agent['id']}")
    return state

# ── Match helpers ──────────────────────────────────────────────────────────────

def find_or_create_match(api_key, my_id):
    _, matches = game_get("/matches?status=created")
    for m in (matches or []):
        if m.get("agent1_id") != my_id:
            return m["id"], "join"
    _, data = game_post("/matches", api_key=api_key)
    return data["match_id"], "created"

def get_state(match_id):
    _, data = game_get(f"/matches/{match_id}")
    return data

def get_replay(match_id):
    _, data = game_get(f"/matches/{match_id}/replay")
    return data or {"rounds": [], "final_scores": []}

def build_history(replay, my_id):
    rows = []
    for r in replay.get("rounds", []):
        my_act  = next((a["action"] for a in r["actions"] if a["agent_id"] == my_id), None)
        opp_act = next((a["action"] for a in r["actions"] if a["agent_id"] != my_id), None)
        my_pts  = next((p["score_change"] for p in r.get("payoffs", []) if p["agent_id"] == my_id), None)
        opp_pts = next((p["score_change"] for p in r.get("payoffs", []) if p["agent_id"] != my_id), None)
        if my_act and opp_act:
            rows.append({
                "round":    r["round_number"],
                "you":      my_act,
                "opponent": opp_act,
                "your_pts": my_pts,
                "opp_pts":  opp_pts,
            })
    return rows

def already_submitted(replay, my_id, round_num):
    for r in replay.get("rounds", []):
        if r["round_number"] == round_num:
            return any(a["agent_id"] == my_id for a in r.get("actions", []))
    return False

def opponent_id_from_state(s, my_id):
    for key in ("agent1_id", "agent2_id"):
        val = s.get(key)
        if val and val != my_id:
            return val
    return None

def scores_from_history(history):
    my_score  = sum(r["your_pts"] or 0 for r in history)
    opp_score = sum(r["opp_pts"]  or 0 for r in history)
    return my_score, opp_score

# ── Memory store helpers ───────────────────────────────────────────────────────

def _find_memory(path):
    """Returns (memory_id, content) or (None, None)."""
    try:
        page = client.beta.memory_stores.memories.list(
            MEMSTORE_ID, path_prefix=path, betas=[BETA]
        )
        for item in page.data:
            if item.path == path:
                mem = client.beta.memory_stores.memories.retrieve(
                    item.id, memory_store_id=MEMSTORE_ID, view="content", betas=[BETA]
                )
                return item.id, (mem.content or "")
    except Exception as e:
        print(f"  [memory read error: {e}]")
    return None, None

def read_memory(path):
    _, content = _find_memory(path)
    return content

def write_memory(path, content):
    try:
        mem_id, _ = _find_memory(path)
        if mem_id:
            client.beta.memory_stores.memories.update(
                mem_id, memory_store_id=MEMSTORE_ID, content=content, betas=[BETA]
            )
        else:
            client.beta.memory_stores.memories.create(
                MEMSTORE_ID, path=path, content=content, betas=[BETA]
            )
    except Exception as e:
        print(f"  [memory write error: {e}]")

# ── Claude calls ───────────────────────────────────────────────────────────────

def claude_decide(round_num, total_rounds, history, opponent_memory, my_score, their_score):
    """Called once per round. Returns 'cooperate' or 'defect'."""
    prompt = (
        f"You are playing Prisoner's Dilemma round {round_num} of {total_rounds}.\n"
        f"Opponent history this match: {json.dumps(history)}\n"
        f"Your memory of this opponent: {opponent_memory or 'First time facing them'}\n"
        f"Current score: you {my_score}, them {their_score}\n"
        f"Reply with one word only: cooperate or defect"
    )
    try:
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=10,
            messages=[{"role": "user", "content": prompt}],
            betas=[BETA],
        )
        text = resp.content[0].text.strip().lower()
        if "defect" in text:
            return "defect"
        return "cooperate"
    except Exception as e:
        print(f"  [Claude fallback — {e}]")
        # tit-for-tat fallback
        if history and history[-1].get("opponent") == "defect":
            return "defect"
        return "cooperate"

def claude_learn(opponent_id, replay, existing_memory):
    """Called once after a match. Returns bullet-point summary."""
    prompt = (
        f"Match complete against opponent {opponent_id}.\n"
        f"Full match replay: {json.dumps(replay)}\n"
        f"Previous memory of this opponent: {existing_memory or 'None'}\n"
        f"Summarize in 3-5 bullet points what you learned about their strategy.\n"
        f"Be concise. This will be stored and read in future matches."
    )
    try:
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
            betas=[BETA],
        )
        return resp.content[0].text.strip()
    except Exception as e:
        print(f"  [Claude learn error — {e}]")
        return None

def claude_update_strategy(match_count):
    """Called every 5 matches. Updates /strategy/current.md."""
    current = read_memory("/strategy/current.md") or ""
    try:
        opp_page = client.beta.memory_stores.memories.list(
            MEMSTORE_ID, path_prefix="/opponents/", betas=[BETA]
        )
        opp_notes = "\n\n".join(
            f"Opponent {m.path}: {m.content or ''}" for m in opp_page.data
        )
    except Exception:
        opp_notes = "(unavailable)"

    prompt = (
        f"After {match_count} matches, reflecting on my overall strategy.\n"
        f"Current strategy notes: {current or 'None yet'}\n"
        f"Opponent observations:\n{opp_notes}\n\n"
        f"In 3-5 bullet points, what overall strategy should I use going forward? "
        f"Consider patterns across all opponents."
    )
    try:
        resp = client.beta.messages.create(
            model=MODEL,
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
            betas=[BETA],
        )
        write_memory("/strategy/current.md", resp.content[0].text.strip())
        print("  [/strategy/current.md updated]")
    except Exception as e:
        print(f"  [strategy update error — {e}]")

# ── Single match ───────────────────────────────────────────────────────────────

def play_match(api_key, my_id, match_num):
    print(f"\n{'─' * 50}")
    print(f"  Match #{match_num}")
    print(f"{'─' * 50}")

    try:
        match_id, how = find_or_create_match(api_key, my_id)
    except Exception as e:
        print(f"  Could not find/create match: {e}")
        return

    if how == "join":
        print(f"Joining match {match_id}...")
        status, resp = game_post(f"/matches/{match_id}/join", api_key=api_key)
        if status != 200:
            print(f"  Failed to join ({status}): {resp}")
            return
        print("  Joined.")
    else:
        print(f"Created match {match_id}. Waiting for opponent", end="", flush=True)
        while True:
            s = get_state(match_id)
            if s is None:
                print("\n  Match disappeared — giving up.")
                return
            if s["status"] == "active":
                break
            print(".", end="", flush=True)
            time.sleep(POLL_INTERVAL)
        print(" opponent joined!")

    # Identify opponent and pre-load memory before first round
    s           = get_state(match_id)
    opponent_id = opponent_id_from_state(s, my_id)
    mem_path    = f"/opponents/{opponent_id}.md" if opponent_id else None
    opp_memory  = read_memory(mem_path) if mem_path else None

    if opponent_id:
        print(f"  Opponent ID: {opponent_id} | Memory: {'loaded' if opp_memory else 'none'}")

    submitted = set()

    def process_round():
        s = get_state(match_id)
        if s is None:
            print("  Match not found — exiting loop.")
            return False

        if s["status"] == "completed" or s["status"] == "failed":
            return False

        if s["status"] != "active" or s.get("current_round", 0) == 0:
            return True

        rnd = s["current_round"]
        if rnd in submitted:
            return True

        replay = get_replay(match_id)
        if already_submitted(replay, my_id, rnd):
            submitted.add(rnd)
            return True

        history           = build_history(replay, my_id)
        my_score, opp_pts = scores_from_history(history)

        action = claude_decide(rnd, s["rounds_total"], history, opp_memory, my_score, opp_pts)
        print(f"  Round {rnd:>3}/{s['rounds_total']}  my={my_score}  opp={opp_pts}  → {action}")

        status, resp = game_post(
            f"/matches/{match_id}/actions",
            body={"action": action},
            api_key=api_key,
        )
        if status == 200:
            submitted.add(rnd)
        elif "already submitted" in str(resp):
            submitted.add(rnd)
        else:
            print(f"    ✗ submit error {status}: {resp}")
        return True

    import requests
    if process_round():
        try:
            with requests.get(f"{GAME_URL}/stream", stream=True, timeout=3600) as response:
                for line in response.iter_lines():
                    if line:
                        line = line.decode('utf-8')
                        if line.startswith("data: "):
                            d = line[6:]
                            if d == "ok":
                                continue
                            try:
                                ev = json.loads(d)
                                if ev.get("match_id") == match_id:
                                    if not process_round():
                                        break
                            except Exception:
                                pass
        except Exception as e:
            print(f"  Stream disconnected: {e}")

    # Result
    replay    = get_replay(match_id)
    my_total  = next((x["total_score"] for x in replay.get("final_scores", []) if x["agent_id"] == my_id), 0)
    opp_total = next((x["total_score"] for x in replay.get("final_scores", []) if x["agent_id"] != my_id), 0)
    verdict   = "WIN" if my_total > opp_total else ("LOSS" if my_total < opp_total else "DRAW")
    print(f"\n  {verdict}  —  you {my_total}  vs  opp {opp_total}")

    # Learn and persist
    if opponent_id and mem_path:
        print("  [asking Claude to summarize opponent patterns...]")
        summary = claude_learn(opponent_id, replay, opp_memory)
        if summary:
            write_memory(mem_path, summary)
            print(f"  [{mem_path} written]")

# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    state   = register_or_load()
    api_key = state["api_key"]
    my_id   = state["agent_id"]

    print(f"\nClaude AI Player — agent ID {my_id}")
    print(f"Memory store:  {MEMSTORE_ID}")
    print(f"Model:         {MODEL}")
    print(f"Press Ctrl-C to stop.\n")

    match_num = 0
    try:
        while True:
            match_num += 1
            play_match(api_key, my_id, match_num)

            if match_num % 5 == 0:
                print("  [updating overall strategy memory...]")
                claude_update_strategy(match_num)

            time.sleep(1)

    except KeyboardInterrupt:
        print("\nStopped.")

if __name__ == "__main__":
    main()
