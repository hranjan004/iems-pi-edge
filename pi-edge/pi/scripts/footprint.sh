#!/usr/bin/env bash
# Print the measured RAM and disk footprint of the IEMS edge stack on the Pi.
# Run it in Phase 2 and compare with docs/03-memory-budget.md.
set -uo pipefail

printf '%-26s %8s %8s\n' "unit" "RSS MB" "swap MB"
for u in edgelake-operator iems-backend iems-inference iems-dashboard iems-egauge-producer iems-solar-producer tailscaled; do
  cg=$(systemctl show -p ControlGroup --value "$u.service" 2>/dev/null)
  [[ -n $cg && -r /sys/fs/cgroup$cg/cgroup.procs ]] || { printf '%-26s %8s\n' "$u" "-"; continue; }
  rss=0; sw=0
  while read -r pid; do
    read -r r s < <(awk '/^VmRSS/{r=$2}/^VmSwap/{s=$2}END{print r+0, s+0}' "/proc/$pid/status" 2>/dev/null)
    rss=$((rss + ${r:-0})); sw=$((sw + ${s:-0}))
  done < "/sys/fs/cgroup$cg/cgroup.procs"
  printf '%-26s %8d %8d\n' "$u" $((rss/1024)) $((sw/1024))
done
echo
free -m
echo
echo "== disk"
du -sh /opt/iems/python311 /opt/iems/venv /opt/iems/venv-edgelake /opt/iems/edgelake /opt/iems/microgrid-manager 2>/dev/null
du -sh /srv/iems/edgelake/EdgeLake/data/dbms /srv/iems/edgelake/EdgeLake/data/archive /srv/iems/models /srv/iems/buffer 2>/dev/null
df -h / /srv/iems 2>/dev/null
