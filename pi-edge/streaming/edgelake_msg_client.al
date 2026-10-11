#-----------------------------------------------------------------------------
# EdgeLake message clients for the edge operator.
#
# The node runs its own MQTT broker on ANYLOG_BROKER_PORT (1883 on the Pi), and
# each client subscribes to one topic and maps JSON fields onto columns with "bring".
# install.sh copies this file to deployment-scripts/node-deployment/local_script.al,
# which the node runs on every start when DEPLOY_LOCAL_SCRIPT=true.
#
# The same commands work unchanged on the current AnyLog host for the Kafka cutover.
# The egauge client was tested on EdgeLake at the site rate on 2026-10-09.
#
# energy_readings schema, verified against the live AnyLog operator:
#   ts timestamp, dev varchar, nm varchar, tp char(1), w float, kwh float
#
# Check registration with:
#   get msg client
#-----------------------------------------------------------------------------

# eGauge registers, one message per register per second
run msg client where broker = local and log = false and topic = (name = egauge and dbms = customers and table = energy_readings and column.ts.timestamp = "bring [ts]" and column.dev.str = "bring [dev]" and column.nm.str = "bring [nm]" and column.tp.str = "bring [tp]" and column.w.float = "bring [w]" and column.kwh.float = "bring [kwh]")

# Solar Assistant snapshot, unchanged from the current deployment
run msg client where broker = local and log = false and topic = (name = solar and dbms = customers and table = solar_data and column.ts.timestamp = "bring [ts]" and column.pv_power.float = "bring [pv_power]" and column.battery_power.float = "bring [battery_power]" and column.battery_soc.float = "bring [battery_soc]" and column.grid_power.float = "bring [grid_power]" and column.load_power.float = "bring [load_power]" and column.device_mode.str = "bring [device_mode]")

# Parallel-run variant for the Kafka cutover day. Publish with
# EGAUGE_TOPIC=egauge_shadow and compare against energy_readings, then remove.
# run msg client where broker = local and log = false and topic = (name = egauge_shadow and dbms = customers and table = energy_readings_mqtt and column.ts.timestamp = "bring [ts]" and column.dev.str = "bring [dev]" and column.nm.str = "bring [nm]" and column.tp.str = "bring [tp]" and column.w.float = "bring [w]" and column.kwh.float = "bring [kwh]")
