#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# serve_nemotron_nilm.sh  Serve the fine-tuned Nemotron NILM model on the GX10.
#
# Runs llama.cpp's llama-server on the GB10 with the GGUF exported by the Brev
# pipeline (stage 60_gguf), OpenAI-compatible on :8011 under the name `nilm`,
# as a systemd service so it survives reboots. iems-inference reaches it at
# http://host.docker.internal:8011/v1 when NILM_ENGINE=nemotron.
#
#   bash gx10/scripts/serve_nemotron_nilm.sh [path/to/model.gguf]
#   journalctl -u nilm-nemotron -f
# ---------------------------------------------------------------------------
set -euo pipefail
GGUF="${1:-$HOME/models/nilm-nemotron-q8_0.gguf}"
LLAMA="${LLAMA_SERVER:-$HOME/nilm/llama.cpp/build/bin/llama-server}"   # own up-to-date build; ~/llama.cpp stays pinned
PORT="${NILM_PORT:-8011}"
[ -s "$GGUF" ] || { echo "no model at $GGUF (gx10/scripts/pull_nemotron_from_brev.sh)"; exit 1; }
[ -x "$LLAMA" ] || { echo "llama-server not built at $LLAMA"; exit 1; }

# Three panels per tick, so three parallel slots; the prompt is ~700 tokens and
# the answer ~120, so 4k context per slot is ample. Reasoning off: the model was
# fine-tuned to answer directly.
sudo tee /etc/systemd/system/nilm-nemotron.service >/dev/null <<EOF
[Unit]
Description=Nemotron NILM engine (llama.cpp) for the IEMS
After=network-online.target

[Service]
User=$USER
ExecStart=$LLAMA -m $GGUF --alias nilm --host 0.0.0.0 --port $PORT -ngl 999 \\
  -c 12288 --parallel 3 --jinja --chat-template-kwargs '{"enable_thinking":false}' \\
  --temp 0 --metrics
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now nilm-nemotron
echo "waiting for :$PORT ..."
for i in $(seq 1 120); do
  curl -sf "localhost:$PORT/v1/models" >/dev/null && break
  sleep 5
done
curl -s "localhost:$PORT/v1/models" | head -c 300; echo
