#!/usr/bin/env bash
# Pull the latest promoted NILM model set from the registry, verify it, and
# activate it by flipping the /srv/iems/models/current symlink.
#
# Registry layout (written by the cloud retraining pipeline):
#   $MODEL_REGISTRY_URL/latest              -> text file containing e.g. v13
#   $MODEL_REGISTRY_URL/v13/manifest.json   -> {"version":"v13","files":[{"name":..,"sha256":..,"n_features":..}],...}
#   $MODEL_REGISTRY_URL/v13/<file>
#
# Usage:
#   pull_models.sh              pull and activate if newer
#   pull_models.sh --rollback   point current at the previous version and pin it
#   pull_models.sh --unpin      allow automatic pulls again after a rollback
set -euo pipefail

ROOT=${MODELS_ROOT:-/srv/iems/models}
URL=${MODEL_REGISTRY_URL:?MODEL_REGISTRY_URL not set}
AUTH=()
[[ -n ${MODEL_REGISTRY_TOKEN:-} ]] && AUTH=(-H "Authorization: Bearer $MODEL_REGISTRY_TOKEN")
PY=${PYTHON:-/opt/iems/venv/bin/python3}

# The service runs unprivileged. It leaves a flag that the unit's ExecStartPost,
# which runs as root, turns into a restart of the inference loop.
activate() {
  touch "$ROOT/.activated"
  if [[ $EUID -eq 0 ]] && systemctl try-restart iems-inference.service 2>/dev/null; then
    rm -f "$ROOT/.activated"
  fi
  return 0
}

current=$(basename "$(readlink -f "$ROOT/current" 2>/dev/null || echo none)")

if [[ ${1:-} == --rollback ]]; then
  prev=$(cat "$ROOT/previous" 2>/dev/null || true)
  [[ -n $prev && -d $ROOT/$prev ]] || { echo "no previous version recorded"; exit 1; }
  ln -sfn "$ROOT/$prev" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
  echo "$current" > "$ROOT/previous"
  echo "$prev" > "$ROOT/pinned"
  activate
  echo "rolled back $current -> $prev and pinned. Run --unpin to resume automatic pulls."
  exit 0
fi

if [[ ${1:-} == --unpin ]]; then rm -f "$ROOT/pinned"; echo "unpinned"; exit 0; fi
if [[ -f $ROOT/pinned ]]; then echo "pinned to $(cat "$ROOT/pinned"), skipping pull"; exit 0; fi

latest=$(curl -fsS -m 30 "${AUTH[@]}" "$URL/latest" | tr -d '[:space:]')
[[ $latest =~ ^v[0-9]+$ ]] || { echo "bad latest pointer: '$latest'"; exit 1; }
if [[ $latest == "$current" ]]; then echo "already on $current"; exit 0; fi

stage=$(mktemp -d "$ROOT/.stage.XXXX")
trap 'rm -rf "$stage"' EXIT
curl -fsS -m 60 "${AUTH[@]}" "$URL/$latest/manifest.json" -o "$stage/manifest.json"

# Download and hash-check every file in the manifest.
"$PY" - "$stage" "$URL/$latest" "${MODEL_REGISTRY_TOKEN:-}" <<'EOF'
import hashlib, json, sys, urllib.request
stage, base, token = sys.argv[1], sys.argv[2], sys.argv[3]
man = json.load(open(f"{stage}/manifest.json"))
for f in man["files"]:
    req = urllib.request.Request(f"{base}/{f['name']}")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    data = urllib.request.urlopen(req, timeout=120).read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != f["sha256"]:
        sys.exit(f"hash mismatch for {f['name']}")
    open(f"{stage}/{f['name']}", "wb").write(data)
print(f"downloaded {len(man['files'])} files for {man['version']}")
EOF

# Assert every ONNX model's input feature count matches the manifest.
"$PY" - "$stage" <<'EOF'
import json, sys
import onnxruntime as ort
stage = sys.argv[1]
man = json.load(open(f"{stage}/manifest.json"))
for f in man["files"]:
    if not f["name"].endswith(".onnx") or "n_features" not in f:
        continue
    sess = ort.InferenceSession(f"{stage}/{f['name']}", providers=["CPUExecutionProvider"])
    last = sess.get_inputs()[0].shape[-1]
    if last != f["n_features"]:
        sys.exit(f"{f['name']}: model expects {last} features, manifest says {f['n_features']}")
print("feature counts verified")
EOF

rm -rf "${ROOT:?}/$latest"
mv -T "$stage" "$ROOT/$latest"
trap - EXIT
ln -sfn "$ROOT/$latest" "$ROOT/current.new" && mv -T "$ROOT/current.new" "$ROOT/current"
echo "$current" > "$ROOT/previous"
activate
echo "activated $latest (previous $current)"

# Keep the three newest versions.
ls -1d "$ROOT"/v* 2>/dev/null | sort -V | head -n -3 | xargs -r rm -rf
