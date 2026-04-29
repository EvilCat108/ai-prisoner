import re

with open("agent/play.py", "r") as f:
    content = f.read()

# Replace find_or_create_match and the start of play_match
pattern = r"def find_or_create_match.*?def get_state"
replacement = "def get_state"
content = re.sub(pattern, replacement, content, flags=re.DOTALL)

pattern = r"def play_match\(.*?print\(\f\"  Match \#\{match_num\}\"\)\n    print\(\f\"\{'─'\*50\}\"\)\n.*?(?:print\(\" opponent joined!\"\)|s = get_state\(match_id\))"

replacement = """def play_match(api_key, my_id, match_num, strategy):
    print(f"\\n{'─'*50}")
    print(f"  Match #{match_num}")
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
"""

content = re.sub(r"def play_match\(.*?(?=submitted = set\(\))", replacement, content, flags=re.DOTALL)

# Handle API key logic one more time just in case
content = re.sub(
    r'"api_key":\s*agent\["api_key"\],',
    r'"api_key":    data.get("api_key", agent.get("api_key")),',
    content
)

# And make sure get_state and get_replay use api_key
content = re.sub(
    r'def get_state\(match_id\):.*?return data',
    r'def get_state(match_id, api_key=None):\n    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}\n    _, data = game_get(f"/matches/{match_id}")\n    return data',
    content, flags=re.DOTALL
)

with open("agent/play.py", "w") as f:
    f.write(content)
