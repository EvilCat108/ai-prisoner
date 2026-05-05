import re

with open('agent/play_gi.py', 'r') as f:
    content = f.read()

# Add import requests
content = re.sub(r'import sys', 'import sys\nimport requests', content)

old_loop = """    submitted = set()
    polls = 0

    while polls < 120:
        polls \+= 1
        s = get_state\(match_id, api_key\)

        if s\["status"\] in \("completed", "failed"\):
            break
        if s\["status"\] != "active" or s\["current_round"\] == 0:
            time\.sleep\(1\)
            continue

        rnd = s\["current_round"\]

        if rnd in submitted:
            time\.sleep\(2\)
            continue

        replay = get_replay\(match_id, api_key\)

        if already_submitted\(replay, my_id, rnd\):
            submitted\.add\(rnd\)
            time\.sleep\(2\)
            continue

        history_data = build_history\(replay, my_id\)
        print\(f"\\\\nRound \{rnd\}/\{s\.get\('rounds_total', '\?'\)\}  \(asking \{MODEL\}\.\.\.\)"\)

        action = ask_ollama\(rnd, s\.get\("rounds_total", "\?"\), history_data\)
        print\(f"  → \{action\}"\)

        status, resp = game_post\(
            f"/matches/\{match_id\}/actions",
            body=\{"action": action\},
            api_key=api_key,
        \)

        if status == 200:
            submitted\.add\(rnd\)
            print\(f"  ✓ submitted"\)
        elif "already submitted" in str\(resp\):
            submitted\.add\(rnd\)
        else:
            print\(f"  ✗ error \{status\}: \{resp\}"\)

        time\.sleep\(1\)"""

new_loop = """    submitted = set()

    def process_round():
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
        print(f"\\nRound {rnd}/{s.get('rounds_total', '?')}  (asking {MODEL}...)")

        action = ask_ollama(rnd, s.get("rounds_total", "?"), history_data)
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
        return True

    # Process initial round
    if process_round():
        try:
            with requests.get(f"{GAME_URL}/stream", stream=True, timeout=3600) as response:
                for line in response.iter_lines():
                    if line:
                        line = line.decode('utf-8')
                        if line.startswith("data: "):
                            d = line[6:]
                            if d == "ok": continue
                            try:
                                ev = json.loads(d)
                                if ev.get("match_id") == match_id:
                                    if not process_round():
                                        break
                            except json.JSONDecodeError:
                                pass
        except Exception as e:
            print(f"  Stream disconnected: {e}")"""

if not re.search(old_loop, content):
    print("Could not find the old loop!")
else:
    content = re.sub(old_loop, new_loop, content)
    with open('agent/play_gi.py', 'w') as f:
        f.write(content)
    print("Patched play_gi.py")
