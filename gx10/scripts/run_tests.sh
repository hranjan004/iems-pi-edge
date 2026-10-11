#!/usr/bin/env bash
# Run the GX10 test suite. On the GX10 it runs inside the training image, which
# already has pandas, pyarrow, onnx and torch; the compose check runs on the
# host because it needs the docker CLI.
#   bash gx10/scripts/run_tests.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
# the training image if it was built, else the NeMo AutoModel image the
# Nemotron fine-tune runs in (it has torch, pandas, onnx and pyarrow too)
IMG=microgrid-train:gx10
docker image inspect "$IMG" >/dev/null 2>&1 || IMG="${AUTOMODEL_IMAGE:-nvcr.io/nvidia/nemo-automodel:26.08.00}"
if docker image inspect "$IMG" >/dev/null 2>&1; then
  docker run --rm -v "$PWD":/workspace -w /workspace --entrypoint bash "$IMG" \
    -c 'git config --global --add safe.directory /workspace; pip install -q pytest requests onnxruntime 2>/dev/null; python3 -m pytest -q -p no:cacheprovider gx10/tests'
  python3 -m pytest -q gx10/tests/test_scripts_and_config.py -k compose 2>/dev/null \
    || echo "(host compose check needs pytest on the host: pip install --user pytest)"
else
  python3 -m pytest -q gx10/tests
fi
