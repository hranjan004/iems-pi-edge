#!/usr/bin/env bash
# Install the IEMS edge services on a bootstrapped Pi.
#
#   sudo ./install.sh                 # install, enable, do not start
#   sudo ./install.sh --start         # also start iems-edge.target
#
# Expects:
#   /opt/iems/iems-pi-edge        this repository
#   /opt/iems/microgrid-manager   the services checkout (branch dev_fin)
#   /opt/iems/anylog              the AnyLog or EdgeLake node, see docs/06
#   /etc/iems/edge.env            filled from pi/config/edge.env.example
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

REPO=/opt/iems/iems-pi-edge
VENV=/opt/iems/venv
START=${1:-}

for d in "$REPO" /opt/iems/microgrid-manager; do
  [[ -d $d ]] || { echo "missing $d"; exit 1; }
done

echo "== virtualenv"
[[ -d $VENV ]] || python3 -m venv "$VENV"
"$VENV/bin/pip" install --upgrade pip wheel
"$VENV/bin/pip" install -r "$REPO/pi/requirements.txt"
"$VENV/bin/python" -c "import onnxruntime, numpy; print('onnxruntime', onnxruntime.__version__)"

echo "== permissions"
chown -R root:root /opt/iems
chmod -R a+rX /opt/iems
mkdir -p /srv/iems/{anylog,models,buffer}
chown -R iems:iems /srv/iems
if [[ -f /etc/iems/ha_token ]]; then
  chown root:iems /etc/iems/ha_token
  chmod 0640 /etc/iems/ha_token
fi

echo "== systemd units"
install -m 0644 "$REPO"/pi/systemd/*.service "$REPO"/pi/systemd/*.timer "$REPO"/pi/systemd/*.target /etc/systemd/system/
chmod 0755 "$REPO"/pi/scripts/*.sh
systemctl daemon-reload
systemctl enable iems-edge.target anylog-operator.service iems-egauge-producer.service \
  iems-solar-producer.service iems-inference.service iems-backend.service \
  iems-dashboard.service iems-pull-models.timer iems-healthcheck.timer

if [[ ! -f /etc/iems/edge.env ]]; then
  echo "!! /etc/iems/edge.env not found. Copy pi/config/edge.env.example, fill it, then rerun with --start."
  exit 0
fi
chmod 0600 /etc/iems/edge.env

if [[ $START == "--start" ]]; then
  systemctl start iems-edge.target
  sleep 10
  systemctl --no-pager --lines=0 status anylog-operator 'iems-*' || true
fi
echo "== done"
