#!/usr/bin/env bash
# Install the IEMS edge services and the EdgeLake node on a bootstrapped Pi.
#
#   sudo ./install.sh            install and enable, do not start
#   sudo ./install.sh --start    also start iems-edge.target
#
# Expects:
#   /opt/iems/iems-pi-edge        this repository
#   /opt/iems/microgrid-manager   the services checkout (branch dev_fin)
#   /etc/iems/edge.env            filled from pi/config/edge.env.example
#   /etc/iems/edgelake.env        filled from pi/config/edgelake.env.example
#
# Creates:
#   /opt/iems/python311           uv-managed Python 3.11 (numpy<2 has no 3.13 wheels)
#   /opt/iems/venv                IEMS services, from pi/requirements.txt
#   /opt/iems/venv-edgelake       EdgeLake node, from pi/requirements-edgelake.txt
#   /opt/iems/edgelake            EdgeLake and its deployment scripts at pinned commits
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

REPO=/opt/iems/iems-pi-edge
EL=/opt/iems/edgelake
EDGELAKE_REF=${EDGELAKE_REF:-faba50ddf8ee}
SCRIPTS_REF=${SCRIPTS_REF:-45b830b473a5}
START=${1:-}

for d in "$REPO" /opt/iems/microgrid-manager; do
  [[ -d $d ]] || { echo "missing $d"; exit 1; }
done

echo "== Python 3.11 via uv"
if ! command -v uv >/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh
fi
export UV_PYTHON_INSTALL_DIR=/opt/iems/python311
uv python install 3.11
PY311=$(uv python find 3.11)

echo "== IEMS virtualenv"
[[ -d /opt/iems/venv ]] || uv venv --python "$PY311" /opt/iems/venv
uv pip install --python /opt/iems/venv/bin/python -r "$REPO/pi/requirements.txt"
/opt/iems/venv/bin/python -c "import onnxruntime, numpy; print('onnxruntime', onnxruntime.__version__, 'numpy', numpy.__version__)"

echo "== EdgeLake at $EDGELAKE_REF, deployment scripts at $SCRIPTS_REF"
mkdir -p "$EL"
fetch() {  # fetch <url> <dir> <ref>
  if [[ ! -d $2/.git ]]; then git clone --filter=blob:none "$1" "$2"; fi
  git -C "$2" fetch --quiet origin
  git -C "$2" checkout --quiet "$3"
}
fetch https://github.com/EdgeLake/EdgeLake.git "$EL/EdgeLake" "$EDGELAKE_REF"
fetch https://github.com/EdgeLake/deployment-scripts.git "$EL/deployment-scripts" "$SCRIPTS_REF"
# Message clients for the eGauge and solar topics, run by the node on every start.
install -m 0644 "$REPO/streaming/edgelake_msg_client.al" "$EL/deployment-scripts/node-deployment/local_script.al"

echo "== EdgeLake virtualenv"
[[ -d /opt/iems/venv-edgelake ]] || uv venv --python "$PY311" /opt/iems/venv-edgelake
uv pip install --python /opt/iems/venv-edgelake/bin/python -r "$REPO/pi/requirements-edgelake.txt"
PYTHONPATH="$EL/EdgeLake" /opt/iems/venv-edgelake/bin/python -c "import edge_lake.cmd.user_cmd; print('EdgeLake imports ok')"

echo "== models"
# The services load models from services/iems/models relative to the repo root.
# Point that path at the versioned store so pull_models.sh can swap sets.
MODELS_LINK=/opt/iems/microgrid-manager/services/iems/models
if [[ -d $MODELS_LINK && ! -L $MODELS_LINK ]]; then mv "$MODELS_LINK" "$MODELS_LINK.checkout"; fi
ln -sfn /srv/iems/models/current "$MODELS_LINK"
[[ -e /srv/iems/models/current ]] || echo "!! no model set yet. Seed one, see docs/04-pi-setup.md"

echo "== permissions"
chown -R root:root /opt/iems
chmod -R a+rX /opt/iems
mkdir -p /srv/iems/{edgelake,models,buffer}
chown -R iems:iems /srv/iems
if [[ -f /etc/iems/ha_token ]]; then
  chown root:iems /etc/iems/ha_token
  chmod 0640 /etc/iems/ha_token
fi

echo "== systemd units"
install -m 0644 "$REPO"/pi/systemd/*.service "$REPO"/pi/systemd/*.timer "$REPO"/pi/systemd/*.target /etc/systemd/system/
chmod 0755 "$REPO"/pi/scripts/*.sh
systemctl daemon-reload
systemctl enable iems-edge.target edgelake-operator.service iems-egauge-producer.service \
  iems-solar-producer.service iems-inference.service iems-backend.service \
  iems-dashboard.service iems-pull-models.timer iems-healthcheck.timer

missing=0
for f in edge.env edgelake.env; do
  if [[ -f /etc/iems/$f ]]; then chmod 0600 "/etc/iems/$f"; else
    echo "!! /etc/iems/$f not found. Copy pi/config/$f.example and fill it."; missing=1
  fi
done
(( missing )) && { echo "== installed, not started"; exit 0; }

if [[ $START == "--start" ]]; then
  systemctl start iems-edge.target
  sleep 20
  systemctl --no-pager --lines=0 status edgelake-operator 'iems-*' || true
fi
echo "== done"
du -sh /opt/iems/python311 /opt/iems/venv /opt/iems/venv-edgelake "$EL" 2>/dev/null || true
