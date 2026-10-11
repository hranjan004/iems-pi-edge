#!/usr/bin/env bash
# agent_with_ollama.sh  Round monitor wrapper for training on the GX10.
#
# Ollama is kept stopped while Nemotron trains (the 26 GB model and the 30B
# training run do not fit in the shared memory together), so this starts the
# Ollama service only for the agent's decision, pipes monitor.py's prompt to
# local_agent_monitor.sh, and stops the service again.
#   AGENT_CMD="bash /workspace/repo/gx10/nemotron/agent_with_ollama.sh"
HERE="$(cd "$(dirname "$0")" && pwd)"
p=$(cat)
PW() { if sudo -n true 2>/dev/null; then sudo "$@"; else echo "${SUDO_PW:?set SUDO_PW or allow passwordless sudo for systemctl}" | sudo -S -p "" "$@"; fi; }
PW systemctl start ollama >/dev/null 2>&1
for _ in $(seq 1 30); do curl -sf localhost:11434/api/tags >/dev/null && break; sleep 2; done
printf "%s" "$p" | bash "$HERE/local_agent_monitor.sh"
rc=$?
PW systemctl stop ollama >/dev/null 2>&1
exit $rc
