#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy_round.sh  Put a fine-tuned Nemotron round into production on the GX10.
#
#   merge    fold the newest LoRA checkpoint into the BF16 base (/workspace/merged)
#   convert  merged model -> GGUF Q8_0 (/workspace/nilm-nemotron-q8_0.gguf)
#   swap     new GGUF -> ~/models/nilm-nemotron-q8_0.gguf (previous kept as
#            .prev.gguf), restart nilm-nemotron (llama-server :8011), start Ollama
#   score    previous model on :8012 vs the live one on :8011, same held-out
#            windows, agreement with the gated BiLSTM teacher per panel and head
#            -> ~/nilm/rounds/gate.json. GATE=1 makes swap refuse a worse model.
#
#   bash gx10/nemotron/deploy_round.sh all          # merge convert swap score
#   bash gx10/nemotron/deploy_round.sh score
# Training must be stopped first: merge needs ~60 GB of the shared memory.
# ---------------------------------------------------------------------------
set -euo pipefail
NILM=$HOME/nilm; L=$NILM/logs/deploy_round.log; MODELS=$HOME/models
LIVE=$MODELS/nilm-nemotron-q8_0.gguf; PREV=$MODELS/nilm-nemotron-q8_0.prev.gguf
NEW=/workspace/nilm-nemotron-q8_0.gguf
LS=${LLAMA_SERVER:-$NILM/llama.cpp/build/bin/llama-server}
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$NILM/logs"
S() { echo "== $(date -u +%FT%TZ) $*" | tee -a "$L"; }
PW() { if sudo -n true 2>/dev/null; then sudo "$@"; else echo "${SUDO_PW:?set SUDO_PW or allow passwordless sudo for systemctl}" | sudo -S -p "" "$@"; fi; }
health() { for _ in $(seq 1 90); do curl -sf -m3 "localhost:$1/health" >/dev/null && return 0; sleep 4; done; return 1; }

do_merge() {
  CK=$(ls -d /workspace/ckpt/nilm_lora/epoch_*_step_* | sort -V | tail -1)
  S "merge $CK"
  (cd "$REPO/gx10/nemotron" && python3 -c "from pathlib import Path; import recurrent_rounds as r; r.merge(Path('$CK'), Path('$L'))")
  basename "$CK" > "$NILM/state/deployed_ckpt"
  S "merge done"
}
do_convert() {
  S "convert to Q8_0"
  docker exec nilm bash -lc 'cd /workspace/llama.cpp && PYTHONPATH=/workspace/llama.cpp/gguf-py:/workspace/pylibs_gguf \
    python3 convert_hf_to_gguf.py /workspace/merged --outtype q8_0 --outfile /workspace/nilm-nemotron-q8_0.gguf' >> "$L" 2>&1
  S "convert done $(stat -c %s "$NEW") bytes"
}
do_swap() {
  [ -f "$NEW" ] || { S "no new GGUF at $NEW"; exit 1; }
  if [ "${GATE:-0}" = 1 ] && [ -f "$NILM/rounds/gate.json" ] && \
     ! python3 -c "import json,sys; sys.exit(0 if json.load(open('$NILM/rounds/gate.json'))['new_not_worse'] else 1)"; then
    S "gate: new model scored worse, keeping the live one"; return 0
  fi
  S "swap: new model live on :8011"
  PW systemctl stop nilm-nemotron
  mv -f "$LIVE" "$PREV"; mv "$NEW" "$LIVE"
  PW systemctl start nilm-nemotron; health 8011
  PW systemctl start ollama
  curl -s -m 180 localhost:11434/api/chat -d '{"model":"nemotron-3.5-lightning","stream":false,"keep_alive":-1,"messages":[{"role":"user","content":"Reply with the single word ready."}]}' >/dev/null || true
  S "live: $(ls -la "$MODELS" | tail -n +2)"
}
do_score() {
  [ -f "$PREV" ] || { S "no previous model to compare"; return 0; }
  S "score: previous on :8012, live on :8011"
  pkill -f "llama-server.*--port 8012" || true
  setsid nohup "$LS" -m "$PREV" --alias nilm --host 0.0.0.0 --port 8012 -ngl 999 -c 12288 --parallel 3 \
    --jinja --chat-template-kwargs '{"enable_thinking":false}' --temp 0 > "$NILM/logs/prev_8012.log" 2>&1 < /dev/null &
  health 8011; health 8012
  for p in 8012:score_prev 8011:score_live; do
    docker exec nilm bash -lc "cd /workspace/repo && PYTHONPATH=/workspace/pylibs python3 gx10/nemotron/eval_nemotron.py \
      --url http://127.0.0.1:${p%%:*}/v1 --model nilm --sft /workspace/data/sft --out /workspace/rounds/${p##*:} \
      --limit ${SCORE_LIMIT:-30} --workers 3" >> "$L" 2>&1 &
  done
  wait
  pkill -f "llama-server.*--port 8012" || true
  python3 "$REPO/gx10/nemotron/compare_rounds.py" "$NILM/rounds/score_prev/metrics.json" \
    "$NILM/rounds/score_live/metrics.json" --out "$NILM/rounds/gate.json" | tee -a "$L"
}
case "${1:-all}" in
  merge) do_merge ;; convert) do_convert ;; swap) do_swap ;; score) do_score ;;
  all) do_merge; do_convert; do_swap; do_score ;;
  after-merge) do_convert; do_swap; do_score ;;
  *) echo "usage: $0 merge|convert|swap|score|all"; exit 2 ;;
esac
