#-----------------------------------------------------------------------------
# AnyLog message clients for the edge operator.
#
# The operator runs its own MQTT broker (broker = local). Each client subscribes
# to one topic and maps JSON fields onto table columns with "bring".
#
# energy_readings schema, verified against the live operator:
#   ts timestamp, dev varchar, nm varchar, tp char(1), w float, kwh float
#
# Register from the operator CLI, or append to the operator's local script so
# the clients come back after a restart. Check with:
#   get msg client
#-----------------------------------------------------------------------------

# eGauge registers, one message per register per second
run msg client where broker = local and log = false and topic = (name = egauge and dbms = customers and table = energy_readings and column.ts.timestamp = "bring [ts]" and column.dev.str = "bring [dev]" and column.nm.str = "bring [nm]" and column.tp.str = "bring [tp]" and column.w.float = "bring [w]" and column.kwh.float = "bring [kwh]")

# Solar Assistant snapshot, unchanged from the current deployment
run msg client where broker = local and log = false and topic = (name = solar and dbms = customers and table = solar_data and column.ts.timestamp = "bring [ts]" and column.pv_power.float = "bring [pv_power]" and column.battery_power.float = "bring [battery_power]" and column.battery_soc.float = "bring [battery_soc]" and column.grid_power.float = "bring [grid_power]" and column.load_power.float = "bring [load_power]" and column.device_mode.str = "bring [device_mode]")

# Parallel-run variant for the Kafka cutover day. Publish with
# EGAUGE_TOPIC=egauge_shadow and compare against energy_readings, then remove.
# run msg client where broker = local and log = false and topic = (name = egauge_shadow and dbms = customers and table = energy_readings_mqtt and column.ts.timestamp = "bring [ts]" and column.dev.str = "bring [dev]" and column.nm.str = "bring [nm]" and column.tp.str = "bring [tp]" and column.w.float = "bring [w]" and column.kwh.float = "bring [kwh]")
