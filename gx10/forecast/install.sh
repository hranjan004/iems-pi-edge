#!/bin/bash
set -euo pipefail
root=/home/asus/Microgrid-UCSC/gx10/forecast
mkdir -p /home/asus/.config/systemd/user "$root/run"
cat > /home/asus/.config/systemd/user/iems-power-forecast.service <<EOF
[Unit]
Description=IEMS measured-power forecasting API (local socket only)
After=network-online.target
[Service]
WorkingDirectory=$root
ExecStart=/home/asus/iems/.venv/bin/python -m uvicorn service:app --uds $root/run/forecast.sock
Restart=on-failure
RestartSec=10
Environment=OMP_NUM_THREADS=2
Environment=OPENBLAS_NUM_THREADS=2
MemoryMax=3G
[Install]
WantedBy=default.target
EOF
cat > /home/asus/.config/systemd/user/iems-power-relearn.service <<EOF
[Unit]
Description=Validate and retrain power forecasts on new original data
[Service]
Type=oneshot
WorkingDirectory=$root
ExecStart=/home/asus/iems/.venv/bin/python -u $root/relearn.py
Environment=OMP_NUM_THREADS=2
Environment=OPENBLAS_NUM_THREADS=2
MemoryMax=6G
Nice=10
TimeoutStartSec=100min
EOF
cat > /home/asus/.config/systemd/user/iems-power-relearn.timer <<EOF
[Unit]
Description=Check genuine forecasting data updates every six hours
[Timer]
OnBootSec=10min
OnUnitActiveSec=6h
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now iems-power-forecast.service iems-power-relearn.timer
