#!/usr/bin/env bash
# One-time OS hardening for the IEMS edge Pi. Idempotent, safe to rerun.
#
#   sudo SSD_UUID=<uuid> TS_AUTHKEY=<tailscale pre-auth key> ./bootstrap.sh
#
# Leave TS_AUTHKEY empty to skip bringing Tailscale up. Leave SSD_UUID empty to
# skip the data mount (not recommended beyond testing).
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
[[ "$(uname -m)" == "aarch64" ]] || { echo "64-bit OS required, found $(uname -m)"; exit 1; }

say() { printf '\n== %s\n' "$*"; }
BOOT_CFG=/boot/firmware/config.txt
[[ -f $BOOT_CFG ]] || BOOT_CFG=/boot/config.txt

add_line() { grep -qxF "$2" "$1" 2>/dev/null || echo "$2" >> "$1"; }

say "Firmware settings in $BOOT_CFG"
add_line "$BOOT_CFG" "gpu_mem=16"
add_line "$BOOT_CFG" "dtoverlay=disable-wifi"
add_line "$BOOT_CFG" "dtoverlay=disable-bt"

say "Packages"
apt-get update
apt-get install -y --no-install-recommends \
  python3-venv python3-dev build-essential git curl jq zram-tools unattended-upgrades nodejs
apt-get purge -y triggerhappy 2>/dev/null || true

say "Volatile journald, capped at 32 MB"
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/iems.conf <<'EOF'
[Journal]
Storage=volatile
RuntimeMaxUse=32M
EOF
systemctl restart systemd-journald

say "log2ram"
if ! command -v log2ram >/dev/null; then
  echo "deb [signed-by=/usr/share/keyrings/azlux-archive-keyring.gpg] http://packages.azlux.fr/debian/ $(. /etc/os-release; echo "$VERSION_CODENAME") main" \
    > /etc/apt/sources.list.d/azlux.list
  curl -fsSL https://azlux.fr/repo.gpg -o /usr/share/keyrings/azlux-archive-keyring.gpg
  apt-get update && apt-get install -y log2ram || echo "log2ram unavailable for this release, journald is already volatile"
fi
[[ -f /etc/log2ram.conf ]] && sed -i 's/^SIZE=.*/SIZE=64M/' /etc/log2ram.conf

say "zram swap, no SD swap"
cat > /etc/default/zramswap <<'EOF'
ALGO=zstd
SIZE=256
PRIORITY=100
EOF
systemctl enable --now zramswap
if systemctl list-unit-files | grep -q dphys-swapfile; then
  dphys-swapfile swapoff || true
  systemctl disable --now dphys-swapfile || true
fi

say "noatime on root"
sed -i -E '/\s\/\s/ s/defaults(,noatime)?/defaults,noatime/' /etc/fstab

say "Hardware watchdog"
mkdir -p /etc/systemd/system.conf.d
cat > /etc/systemd/system.conf.d/watchdog.conf <<'EOF'
[Manager]
RuntimeWatchdogSec=15
RebootWatchdogSec=2min
EOF

say "Unattended security upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades

say "Service user"
id iems >/dev/null 2>&1 || useradd --system --home /opt/iems --shell /usr/sbin/nologin iems

if [[ -n "${SSD_UUID:-}" ]]; then
  say "SSD at /srv/iems"
  mkdir -p /srv/iems
  add_line /etc/fstab "UUID=$SSD_UUID /srv/iems ext4 defaults,noatime,nofail,x-systemd.device-timeout=30 0 2"
  systemctl daemon-reload
  mount /srv/iems || true
  mkdir -p /srv/iems/{edgelake,models,buffer}
  chown -R iems:iems /srv/iems
fi

say "Tailscale"
if ! command -v tailscale >/dev/null; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if [[ -n "${TS_AUTHKEY:-}" ]]; then
  tailscale up --authkey "$TS_AUTHKEY" --hostname iems-edge --ssh
fi

say "Done. Reboot to apply firmware and watchdog settings."
free -m
