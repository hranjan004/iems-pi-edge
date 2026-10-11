#!/usr/bin/env bash
# IEMS edge healthcheck. Prints one line per check and exits nonzero on failure.
# With --fix, restarts a producer whose heartbeat is stale and prunes the spool
# when the SSD passes 90%.
set -uo pipefail

FIX=${1:-}
HOST=${ANYLOG_HOST:-127.0.0.1}
PORT=${ANYLOG_PORT:-32149}
UA=${ANYLOG_USER_AGENT:-AnyLog/1.23}
HB=${HEARTBEAT_PATH:-/run/iems/egauge.heartbeat}
SPOOL=${SPOOL_PATH:-/srv/iems/buffer/egauge.spool}
fail=0

ok()  { printf 'ok    %s\n' "$*"; }
bad() { printf 'FAIL  %s\n' "$*"; fail=1; }

for u in edgelake-operator iems-egauge-producer iems-solar-producer iems-inference iems-backend iems-dashboard; do
  systemctl is-active --quiet "$u" && ok "$u active" || bad "$u not active"
done

if curl -fsS -m 5 -H "User-Agent: $UA" -H "command: get status" "http://$HOST:$PORT/" >/dev/null; then
  ok "operator REST answers"
else
  bad "operator REST not answering on $HOST:$PORT"
fi

if [[ -f $HB ]]; then
  age=$(( $(date +%s) - $(stat -c %Y "$HB") ))
  if (( age < 60 )); then ok "egauge heartbeat ${age}s"; else
    bad "egauge heartbeat stale ${age}s"
    [[ $FIX == --fix ]] && systemctl restart iems-egauge-producer
  fi
else
  bad "no egauge heartbeat at $HB"
fi

curl -fsS -m 5 "http://127.0.0.1:8009/docs" >/dev/null && ok "backend answers" || bad "backend not answering"
curl -fsS -m 10 "http://127.0.0.1:47821/" >/dev/null && ok "dashboard answers" || bad "dashboard not answering"

if mountpoint -q /srv/iems; then
  use=$(df --output=pcent /srv/iems | tail -1 | tr -dc 0-9)
  if (( use < 80 )); then ok "ssd ${use}% used"; else bad "ssd ${use}% used"; fi
  if (( use >= 90 )) && [[ $FIX == --fix && -s $SPOOL ]]; then
    n=$(wc -l < "$SPOOL"); tail -n $(( n / 2 )) "$SPOOL" > "$SPOOL.tmp" && mv "$SPOOL.tmp" "$SPOOL"
    echo "pruned oldest half of spool"
  fi
else
  bad "/srv/iems not mounted"
fi

swap_kb=$(awk '/SwapTotal/{t=$2}/SwapFree/{f=$2}END{print t-f}' /proc/meminfo)
(( swap_kb < 65536 )) && ok "swap in use $((swap_kb/1024)) MB" || bad "swap in use $((swap_kb/1024)) MB"

avail_mb=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
(( avail_mb > 150 )) && ok "memory available ${avail_mb} MB" || bad "memory available ${avail_mb} MB"

if command -v vcgencmd >/dev/null; then
  thr=$(vcgencmd get_throttled | cut -d= -f2)
  [[ $thr == 0x0 ]] && ok "no throttling or undervoltage" || bad "throttled flags $thr"
fi

exit $fail
