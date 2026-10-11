#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# pull_nemotron_from_brev.sh  Bring the trained artifacts from the Brev box to
# the GX10, verify them, and switch the stack to the Nemotron engine.
#
#   ~/models/nilm-nemotron-q8_0.gguf            fine-tuned Nemotron (llama.cpp)
#   services/iems/models/nilm_panel{1,2,3}.onnx  retrained BiLSTM (fallback)
#   services/iems/models/panel{1,2,3}_norm_bilstm.json
#   gx10/data/brev_results/                      reports, round metrics, logs
#
#   BOX=microgrid-train bash gx10/scripts/pull_nemotron_from_brev.sh
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.local/bin:$PATH"
BOX="${BOX:-microgrid-train}"
mkdir -p ~/models gx10/data/brev_results

echo "[pull] results and BiLSTM models"
brev copy "$BOX:/workspace/repo/services/iems/models/" gx10/data/brev_results/models/
brev copy "$BOX:/workspace/rounds/" gx10/data/brev_results/rounds/
brev copy "$BOX:/workspace/repo/services/iems/training/reports/" gx10/data/brev_results/reports/
brev copy "$BOX:/workspace/data/sft/census.json" gx10/data/brev_results/
brev copy "$BOX:/workspace/logs/" gx10/data/brev_results/logs/

echo "[pull] GGUF (about 32 GB)"
brev copy "$BOX:/workspace/nilm-nemotron-q8_0.gguf.sha256" ~/models/
brev copy "$BOX:/workspace/nilm-nemotron-q8_0.gguf" ~/models/
( cd ~/models && sed 's#/workspace/##' nilm-nemotron-q8_0.gguf.sha256 | sha256sum -c - )

echo "[pull] installing the retrained BiLSTM (fallback engine)"
for f in nilm_panel1.onnx nilm_panel2.onnx nilm_panel3.onnx \
         panel1_norm_bilstm.json panel2_norm_bilstm.json panel3_norm_bilstm.json; do
  cp "gx10/data/brev_results/models/$f" services/iems/models/
done
python3 - <<'PY'
import json
for p in (1, 2, 3):
    d = json.load(open(f"services/iems/models/panel{p}_norm_bilstm.json"))
    print(f"  panel{p}: {len(d['features'])} features, {len(d['heads'])} heads, {d.get('_source')}")
PY
echo "[pull] done. Next: bash gx10/scripts/serve_nemotron_nilm.sh, then set NILM_ENGINE=nemotron"
