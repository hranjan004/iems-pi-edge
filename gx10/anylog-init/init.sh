#!/bin/sh
# anylog-init: keeps operator1 serving data, whatever its startup scripts did.
#
# On the arm64 AnyLog image the node policy script aborts at
# node_policy.al line 5 ("Failed to configure node based on !node_type ID"),
# and because AnyLog stops every script on that error, local_script.al never
# runs either. The node comes up with REST and TCP but no Streamer, no
# Operator and no Kafka consumer, so every PUT is buffered and nothing reaches
# Postgres. Pat's box hit the same failure and worked around it by hard coding
# its operator_id into local_script.al.
#
# This sidecar does that generically and keeps doing it: every INTERVAL seconds
# it asks operator1 for its processes, and declares whatever is missing, with
# the operator policy id looked up from the blockchain rather than hard coded.
# It is idempotent, so it is harmless when everything is already running.
set -u
AL="${ANYLOG_URL:-http://host.docker.internal:32149}"
INTERVAL="${INTERVAL:-60}"
NAME="${OPERATOR_NAME:-operator1}"
get()  { curl -s -m 15 "$AL" -H "User-Agent: AnyLog/1.23" -H "command: $1"; }
post() { curl -s -m 15 -X POST "$AL" -H "User-Agent: AnyLog/1.23" -H "command: $1" >/dev/null; echo "[anylog-init] $1" | cut -c1-120; }
running() { get "get processes" | grep -E "^ *$1 *\|" | grep -q "Running"; }

KAFKA='run kafka consumer where ip = host.docker.internal and port = 9094 and reset = latest and topic = (name = egauge-energy and dbms = customers and table = egauge_kafka and column.ts.timestamp = "bring [ts]" and column.dev.str = "bring [dev]" and column.nm.str = "bring [nm]" and column.tp.str = "bring [tp]" and column.w.float = "bring [w]" and column.kwh.float = "bring [kwh]")'

while :; do
  if get "get status" | grep -qi running; then
    if ! running Streamer; then
      post "set buffer threshold where time = 2 seconds and volume = 10000 and write_immediate = true"
      post "run streamer"
    fi
    if ! running Operator; then
      OPID=$(get "blockchain get operator where name = $NAME bring [operator][id]" | tr -d ' \r\n"')
      if [ -n "$OPID" ]; then
        post "partition customers * using insert_timestamp by month"
        post "run operator where policy = $OPID and create_table = true and update_tsd_info = true and compress_json = true and master_node = !ledger_conn"
      else
        echo "[anylog-init] no operator policy for $NAME on the blockchain yet"
      fi
    fi
    running "Kafka Consumer" || post "$KAFKA"
  else
    echo "[anylog-init] waiting for $AL"
  fi
  sleep "$INTERVAL"
done
