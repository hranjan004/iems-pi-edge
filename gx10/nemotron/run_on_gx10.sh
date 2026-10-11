#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# run_on_gx10.sh  Relabel, retrain the BiLSTM and fine-tune Nemotron on the
# GX10 itself (GB10, 128 GB unified memory), with the same resumable pipeline
# the Brev box runs (box_pipeline.sh). No cloud spend.
#
# NVIDIA's single-GPU LoRA recipe for Nemotron 3.5 Lightning is CI-tested on a
# GB10, so this is the box it was written for. It is slower than a discrete
# Blackwell card, so the run is sized to finish in hours: 2000 windows per panel,
# ~0.6 epoch per recurrent round, at most 4 rounds and MAX_HOURS of wall clock.
#
# Layout: /workspace -> ~/nilm (symlink), so host and container paths agree.
#   /workspace/repo   a local clone of ~/Microgrid-UCSC (the live stack is
#                     never touched until deploy)
#   /workspace/hf     BF16 weights      /workspace/data   export + archive
#
#   bash gx10/nemotron/run_on_gx10.sh        # setup once, then the pipeline
#   tail -f ~/nilm/logs/pipeline.log ~/nilm/rounds/rounds.log
# ---------------------------------------------------------------------------
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NILM="$HOME/nilm"
IMAGE="${AUTOMODEL_IMAGE:-nvcr.io/nvidia/nemo-automodel:26.08.00}"
mkdir -p "$NILM"/{hf,data,logs,state,rounds,ckpt,pylibs}
[ -L /workspace ] || [ -d /workspace ] || sudo ln -s "$NILM" /workspace
[ "$(readlink -f /workspace)" = "$(readlink -f "$NILM")" ] || { echo "/workspace is not $NILM"; exit 1; }

# repo clone at the current commit, and the data
if [ ! -d /workspace/repo/.git ]; then git clone -q "$REPO" /workspace/repo; fi
git -C /workspace/repo fetch -q "$REPO" HEAD && git -C /workspace/repo checkout -q FETCH_HEAD
[ -d /workspace/data/export ] || cp -r "$REPO/gx10/data/export" /workspace/data/
for f in egauge_merged_mar_aug.parquet solar_history.parquet; do
  [ -f /workspace/data/$f ] || [ ! -f "$HOME/gx10_incoming/$f" ] || cp "$HOME/gx10_incoming/$f" /workspace/data/
done
[ -f /workspace/state/gpu_started_at ] || date -u +%FT%TZ > /workspace/state/gpu_started_at

# weights (resumable)
if [ ! -f /workspace/state/weights.done ]; then
  [ -x "$NILM/venv/bin/hf" ] || { python3 -m venv "$NILM/venv"; "$NILM/venv/bin/pip" install -q huggingface_hub; }
  "$NILM/venv/bin/hf" download nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16 \
     --local-dir /workspace/hf/Nemotron-3.5-Lightning-BF16
  date -u > /workspace/state/weights.done
fi

# training container (host network, so vLLM on :${VLLM_PORT:-8020} is localhost)
if ! docker ps --format '{{.Names}}' | grep -qx nilm; then
  docker rm -f nilm >/dev/null 2>&1 || true
  docker run -d --name nilm --gpus all --ipc=host --network host --ulimit memlock=-1 \
    --ulimit stack=67108864 -v /workspace:/workspace -e HF_HOME=/workspace/hf_cache \
    "$IMAGE" sleep infinity
fi
if [ ! -f /workspace/state/container.done ]; then
  docker exec nilm bash -lc 'cd /workspace && ([ -d Automodel ] || git clone -q https://github.com/NVIDIA-NeMo/Automodel.git) &&
    pip install -q --no-deps -e /workspace/Automodel &&
    pip install -q --target /workspace/pylibs "pandas>=2.1,<2.3" "pyarrow>=15,<19" onnx onnxruntime'
  date -u > /workspace/state/container.done
fi

# The GB10's memory is shared with the running stack. Free Ollama's resident
# model while training; it reloads on the next question.
ollama stop nemotron-3.5-lightning >/dev/null 2>&1 || true
# and the live Nemotron server (~34 GB); dashboards fall back to the BiLSTM.
# Put it back after training with gx10/nemotron/deploy_round.sh.
sudo -n systemctl stop nilm-nemotron ollama 2>/dev/null || true

export RATE_PER_HR=0 BUDGET_USD=1000 RESERVE_USD=0          # local: no spend
export MAX_PER_PANEL="${MAX_PER_PANEL:-2000}" EPOCHS_FIRST="${EPOCHS_FIRST:-6}" EPOCHS_ROLL="${EPOCHS_ROLL:-3}"
export ROUND_STEPS="${ROUND_STEPS:-350}" MAX_ROUNDS="${MAX_ROUNDS:-4}" REPLAY_SLOTS="${REPLAY_SLOTS:-1500}"
export MAX_HOURS="${MAX_HOURS:-16}" VLLM_GPU_UTIL="${VLLM_GPU_UTIL:-0.55}" VLLM_PORT="${VLLM_PORT:-8020}"
export EVAL_LIMIT="${EVAL_LIMIT:-100}" MINE_N="${MINE_N:-600}"
# round monitor: Nemotron 3.5 Lightning in the local Ollama (NemoClaw's $2 is spent)
export AGENT_CMD="${AGENT_CMD:-bash /workspace/repo/gx10/nemotron/agent_with_ollama.sh}" AGENT_NAME="${AGENT_NAME:-local-nemotron}"
exec bash /workspace/repo/gx10/nemotron/box_pipeline.sh
