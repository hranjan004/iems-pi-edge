#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# box_pipeline.sh  The whole retrain on the Brev GPU box, resumable.
#
#   10 dataset   Mar-Aug archive + Pat's Aug-Oct export -> egauge_gx10.parquet
#   20 relabel   physical_labeler_v2.py over the full history
#   30 bilstm    rolling walk-forward BiLSTM per panel, more epochs, on the GPU,
#                exported to ONNX (the teacher, and the fallback engine)
#   40 sft       gated-teacher chat JSONL per panel (build_sft.py)
#   50 rounds    recurrent LoRA rounds of Nemotron 3.5 Lightning BF16
#                (recurrent_rounds.py: train, merge, vLLM eval, monitor)
#   60 gguf      merged model -> GGUF Q8_0 for llama.cpp on the GX10
#
# Every stage writes /workspace/state/<stage>.done when it finishes and is
# skipped on the next run, so after a crash, a credit pause or a reboot the
# same command picks up where it stopped:
#   nohup setsid bash /workspace/repo/gx10/nemotron/box_pipeline.sh &
# Progress: /workspace/logs/pipeline.log, /workspace/rounds/rounds.log
# ---------------------------------------------------------------------------
set -euo pipefail
WS=/workspace
LOG=$WS/logs/pipeline.log
mkdir -p $WS/state $WS/logs $WS/data/sft
# gitignored, so absent from a `git archive` of the repo
mkdir -p $WS/repo/services/iems/training/data $WS/repo/services/iems/training/models $WS/repo/services/iems/training/reports
exec >> "$LOG" 2>&1
# Failure watchdog: any failing command marks the run FAILED (with the line and
# time) and stops. On Brev the caller deletes the box when it sees FAILED, so
# a dead pipeline can never keep a paid GPU running.
rm -f $WS/state/FAILED
trap 'echo "[FAILED] line $LINENO at $(date -u +%FT%TZ)"; echo "line $LINENO $(date -u +%FT%TZ)" > $WS/state/FAILED' ERR

D() { docker exec -e PYTHONPATH=/workspace/pylibs:/workspace/repo/services \
        -e EGAUGE_PARQUET=$WS/data/egauge_gx10.parquet \
        -e SOLAR_PARQUET=$WS/data/solar_gx10.parquet nilm bash -lc "cd $WS/repo && $*"; }
stage() { [ -f "$WS/state/$1.done" ] && { echo "[skip] $1"; return 1; }; echo "== $(date -u +%FT%TZ) $1"; return 0; }
done_() { date -u +%FT%TZ > "$WS/state/$1.done"; echo "[done] $1"; }

docker ps --format '{{.Names}}' | grep -qx nilm || { echo "nilm container is not running (box_setup.sh)"; exit 1; }

if stage 10_dataset; then
  ARCH=""; [ -f $WS/data/egauge_merged_mar_aug.parquet ] && ARCH="--archive $WS/data/egauge_merged_mar_aug.parquet"
  SARCH=""; [ -f $WS/data/solar_history.parquet ] && SARCH="--solar-archive $WS/data/solar_history.parquet"
  D python3 gx10/scripts/build_dataset.py --export $WS/data/export --out $WS/data $ARCH $SARCH
  done_ 10_dataset
fi

if stage 20_relabel; then
  D python3 services/iems/training/physical_labeler_v2.py
  done_ 20_relabel
fi

if stage 30_bilstm; then
  mkdir -p $WS/repo/services/iems/training/models $WS/repo/services/iems/training/reports
  for P in 1 2 3; do
    [ -f $WS/state/30_bilstm_p$P.done ] && continue
    D PANEL=$P DEVICE=cuda EPOCHS_FIRST=${EPOCHS_FIRST:-6} EPOCHS_ROLL=${EPOCHS_ROLL:-3} \
      python3 services/iems/training/train_rolling.py
    D python3 services/iems/training/export_physical.py --panel $P
    date -u > $WS/state/30_bilstm_p$P.done
  done
  done_ 30_bilstm
fi

if stage 40_sft; then
  D SFT_DIR=$WS/data/sft MAX_PER_PANEL=${MAX_PER_PANEL:-9000} python3 gx10/nemotron/build_sft.py
  python3 - <<'PY'
import json
rows = [json.loads(l) for l in open("/workspace/data/sft/val.jsonl")]
by = {}
for r in rows:
    k = r["messages"][1]["content"].split("\n")[0]
    by.setdefault(k, []).append(r)
with open("/workspace/data/sft/val_small.jsonl", "w") as f:
    for k, rr in by.items():
        for r in rr[:64]:
            f.write(json.dumps({"messages": r["messages"]}) + "\n")
PY
  done_ 40_sft
fi

if stage 50_rounds; then
  python3 $WS/repo/gx10/nemotron/recurrent_rounds.py
  done_ 50_rounds
fi

if stage 60_gguf; then
  D 'cd /workspace && ([ -d llama.cpp ] || git clone -q --depth 1 https://github.com/ggml-org/llama.cpp) &&
     pip install -q --target /workspace/pylibs_gguf -r llama.cpp/requirements/requirements-convert_hf_to_gguf.txt >/dev/null 2>&1;
     PYTHONPATH=/workspace/pylibs_gguf:/workspace/llama.cpp/gguf-py python3 llama.cpp/convert_hf_to_gguf.py \
       /workspace/merged --outtype q8_0 --outfile /workspace/nilm-nemotron-q8_0.gguf'
  sha256sum $WS/nilm-nemotron-q8_0.gguf > $WS/nilm-nemotron-q8_0.gguf.sha256
  done_ 60_gguf
fi
echo "== $(date -u +%FT%TZ) pipeline complete"
