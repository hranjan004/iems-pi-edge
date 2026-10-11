#!/bin/bash
set -euo pipefail
root=/home/asus/Microgrid-UCSC/gx10/forecast
mkdir -p /home/asus/.config/systemd/user
cat > /home/asus/.config/systemd/user/iems-web-collector.service <<EOF
[Unit]
Description=Read-only eGauge and Solar Assistant web collection
After=network-online.target
[Service]
WorkingDirectory=$root
ExecStart=/home/asus/iems/.venv/bin/python -u $root/web_collector.py --publish
Restart=on-failure
RestartSec=20
UMask=0077
Environment=OPENBLAS_NUM_THREADS=2
MemoryMax=1G
NoNewPrivileges=true
[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable iems-web-collector.service
