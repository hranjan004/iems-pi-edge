#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# deploy_on_gx10.sh  Put the retrained models into the live GX10 stack.
#
#   1. retrained BiLSTM ONNX + norms -> services/iems/models (the fallback,
#      and the 18 feature contract the Nemotron prompt is built from)
#   2. fine-tuned Nemotron GGUF -> ~/models, served by llama.cpp on :8011
#   3. NILM_ENGINE=nemotron in gx10/.env, rebuild + recreate iems-inference
#      and iems-backend (models are baked into the image), verify
#
# Previous models are kept in gx10/data/model_backups/<stamp>/ for rollback:
#   cp gx10/data/model_backups/<stamp>/* services/iems/models/ && NILM_ENGINE=bilstm ...
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/../.."
SRC="${SRC:-/workspace}"
stamp=$(date +%Y%m%d_%H%M%S)
bak="gx10/data/model_backups/$stamp"; mkdir -p "$bak" ~/models
cp services/iems/models/nilm_panel?.onnx services/iems/models/panel?_norm_bilstm.json "$bak"/
echo "[deploy] backed up current models -> $bak"

for f in nilm_panel1.onnx nilm_panel2.onnx nilm_panel3.onnx \
         panel1_norm_bilstm.json panel2_norm_bilstm.json panel3_norm_bilstm.json; do
  cp "$SRC/repo/services/iems/models/$f" services/iems/models/
done
${PY:-python3} - <<'PY'
import json, onnxruntime as ort, numpy as np
for p in (1, 2, 3):
    d = json.load(open(f"services/iems/models/panel{p}_norm_bilstm.json"))
    s = ort.InferenceSession(f"services/iems/models/nilm_panel{p}.onnx")
    s.run(None, {"window": np.zeros((8, d["window"], len(d["features"])), "float32")})
    print(f"  panel{p}: {len(d['features'])} features, {len(d['heads'])} heads, batch 8 OK")
PY

if [ -s "$SRC/nilm-nemotron-q8_0.gguf" ]; then
  [ -s ~/models/nilm-nemotron-q8_0.gguf ] && cmp -s "$SRC/nilm-nemotron-q8_0.gguf" ~/models/nilm-nemotron-q8_0.gguf \
    || cp "$SRC/nilm-nemotron-q8_0.gguf" ~/models/
  bash gx10/scripts/serve_nemotron_nilm.sh ~/models/nilm-nemotron-q8_0.gguf
  sed -i 's/^NILM_ENGINE=.*/NILM_ENGINE=nemotron/' gx10/.env
else
  echo "[deploy] no GGUF yet; keeping NILM_ENGINE=$(grep ^NILM_ENGINE gx10/.env | cut -d= -f2)"
fi

C=(docker compose -f gx10/docker-compose.gx10.yaml --env-file gx10/.env)
"${C[@]}" build iems-inference && "${C[@]}" build iems-backend
"${C[@]}" up -d --no-deps iems-inference iems-backend anylog-init
sleep 75
docker logs --tail 5 iems-inference
bash gx10/scripts/verify.sh || true
