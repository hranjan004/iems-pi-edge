#!/usr/bin/env bash
# local_agent_monitor.sh  The round monitor as a local AI agent on the GX10.
#
# monitor.py pipes its prompt (metric history, budget, round cost) on stdin and
# reads the first JSON object of the reply. This sends it to Nemotron 3.5
# Lightning in the host Ollama, reasoning on, then unloads the model again so
# the next training round has the GB10's memory back. Free, and used instead of
# the NemoClaw VM once that VM's $2 cap is spent.
set -euo pipefail
MODEL="${AGENT_MODEL:-nemotron-3.5-lightning}"
URL="${AGENT_URL:-http://127.0.0.1:11434}"
prompt=$(cat)
python3 - "$URL" "$MODEL" "$prompt" <<'PY'
import json, sys, urllib.request
url, model, prompt = sys.argv[1:4]
body = {"model": model, "stream": False, "think": True,
        "messages": [{"role": "user", "content": prompt}],
        "options": {"temperature": 0.2, "num_ctx": 8192}}
req = urllib.request.Request(url + "/api/chat", data=json.dumps(body).encode(),
                             headers={"Content-Type": "application/json"})
print(json.loads(urllib.request.urlopen(req, timeout=600).read())["message"]["content"])
PY
ollama stop "$MODEL" >/dev/null 2>&1 || true
