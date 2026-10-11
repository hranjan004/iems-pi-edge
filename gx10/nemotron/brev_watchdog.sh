#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# brev_watchdog.sh  Never pay for an idle GPU again.
#
# Runs on the GX10 while a Brev box trains. Every POLL seconds it reads the
# box's /workspace/state and the time it has been up, and deletes the box when
#   - the pipeline wrote state/FAILED          (a stage died)
#   - the pipeline wrote state/60_gguf.done   (finished; results pulled first)
#   - the pipeline log has not grown for IDLE_MIN minutes
#   - runtime x RATE reaches BUDGET dollars
# It logs every decision to ~/brev_watchdog.log.
#
#   BOX=microgrid-train RATE=2.63 BUDGET=24 nohup bash gx10/nemotron/brev_watchdog.sh &
# ---------------------------------------------------------------------------
set -u
export PATH="$HOME/.local/bin:$PATH"
BOX="${BOX:-microgrid-train}"; RATE="${RATE:-2.63}"; BUDGET="${BUDGET:-24}"
POLL="${POLL:-120}"; IDLE_MIN="${IDLE_MIN:-30}"
START="${START:-$(date -u +%s)}"
LOG="$HOME/brev_watchdog.log"
say() { echo "$(date -u +%FT%TZ) $*" | tee -a "$LOG"; }
last_size=0; last_change=$(date +%s)
while :; do
  spent=$(python3 -c "print(round(($(date -u +%s)-$START)/3600*$RATE,2))")
  st=$(timeout 60 brev exec "$BOX" "ls /workspace/state; stat -c %s /workspace/logs/pipeline.log" 2>/dev/null | tr '\r' '\n')
  size=$(echo "$st" | grep -E '^[0-9]+$' | tail -1)
  [ -n "$size" ] && [ "$size" != "$last_size" ] && { last_size=$size; last_change=$(date +%s); }
  idle=$(( ($(date +%s) - last_change) / 60 ))
  reason=""
  echo "$st" | grep -qx FAILED && reason="pipeline FAILED"
  echo "$st" | grep -qx 60_gguf.done && reason="pipeline finished"
  [ "$idle" -ge "$IDLE_MIN" ] && reason="log idle ${idle} min"
  python3 -c "import sys; sys.exit(0 if $spent >= $BUDGET else 1)" && reason="budget \$$spent >= \$$BUDGET"
  say "box=$BOX spent=\$$spent idle=${idle}m ${reason:-ok}"
  if [ -n "$reason" ]; then
    if [ "$reason" = "pipeline finished" ]; then
      bash "$(dirname "$0")/../scripts/pull_nemotron_from_brev.sh" >> "$LOG" 2>&1 || say "pull failed, deleting anyway"
    fi
    say "deleting $BOX: $reason"; brev delete "$BOX" >> "$LOG" 2>&1; exit 0
  fi
  sleep "$POLL"
done
