# 02. Target architecture

## Summary

The Raspberry Pi is the hub. Everything the household needs in real time runs on it.
Everything that is heavy, long-lived or shared across viewers runs in the cloud.
The two sides are joined by a Tailscale tailnet and by a single EdgeLake network.
Every node runs EdgeLake, the open-source distribution of AnyLog ([ADR 0007](adr/0007-edgelake-only.md)).

| Tier | Runs | Must work offline |
|---|---|---|
| House LAN | eGauge, Solar Assistant, Home Assistant | Yes |
| Pi | Producers, EdgeLake operator, IEMS backend with NILM inference, Node dashboard | Yes |
| Cloud | EdgeLake master, EdgeLake archive operator, Postgres, AnyLog remote GUI, cloud LLM, retraining | No |

Diagrams: [system overview](../architecture/system-overview.md),
[data flow](../architecture/data-flow.md), [deployment](../architecture/deployment.md).

## Placement decisions

These were settled in the design discussion and are recorded as ADRs.

| Decision | Choice | ADR |
|---|---|---|
| Message transport | Kafka removed, producers publish to AnyLog's MQTT broker | [0001](adr/0001-remove-kafka.md) |
| Language model | Cloud API, no local model on any house machine | [0002](adr/0002-cloud-llm.md) |
| NILM inference | On the Pi, not the cloud | [0003](adr/0003-inference-on-pi.md) |
| Dashboards | Node dashboard on the Pi, AnyLog GUI in the cloud | [0004](adr/0004-dashboard-split.md) |
| Pi process model | Native systemd services, no Docker | [0005](adr/0005-native-services-on-pi.md) |
| Retraining | Cloud batch, Pi pulls promoted models | [0006](adr/0006-cloud-retraining-pull-model.md) |

## Components on the Pi

### Producers

`egauge_mqtt_producer.py` polls the meter's register API once per second and publishes
one JSON message per register to the local EdgeLake broker on topic `egauge`. An EdgeLake
message client maps that topic to the `energy_readings` table. The solar producer is
unchanged and keeps publishing to topic `solar`, mapped to `solar_data`.

### EdgeLake operator

Runs natively from source under systemd with SQLite storage, measured at 96 to 99 MB.
It is the broker for both producers, the local query point for the backend, inference
and dashboard, and the source for the archive copy in the cloud. Partitions are daily
and three are kept. The data directory lives on a USB SSD, not the SD card.
Configuration: [pi/config/edgelake.env.example](../pi/config/edgelake.env.example).
Topology and settings: [06-edgelake-topology.md](06-edgelake-topology.md).

### IEMS backend and NILM inference

The FastAPI service (`main_api:app`) and the inference loop
(`iems.inference.inference_loop`) both import the `iems` package and each loads
onnxruntime. They start as two systemd services with memory limits. Merging them into
one process, with the loop running as a background task inside the API, saves the
second runtime and is a follow-up item once both are stable on the Pi.

Inference runs every 30 seconds, reads a window from the local operator, writes one row
per appliance to `nilm_disaggregated`, and the decision support engine reads those rows.

### Node dashboard

The existing `server.js`, unchanged except for configuration. It reads from the local
operator and the local backend, and calls Home Assistant on the LAN for thermostat
control. The Home Assistant token never leaves the Pi. The Accept, Defer and Dismiss
buttons call the backend on the Pi directly instead of going through the cloud GUI plugin.

## Components in the cloud

### EdgeLake master

Holds the network metadata. It lives in the cloud because every node needs to reach
it and the house uplink is the least reliable link in the system. The Pi keeps a local
copy of the metadata so that loss of the master does not stop local operation.

### Archive operator and Postgres

A second EdgeLake operator in the same network, backed by Postgres, holds the full
history. It is the source for retraining and for any query that spans more than the
Pi's retention window.

### AnyLog remote GUI, MCP client and Ask

The remote GUI image with the IEMS plugin, pointed at the cloud LLM. Its REST and MCP
connections go to the cloud archive node, which has a query database and the MCP
endpoint enabled. A network query
from the GUI is routed by EdgeLake to whichever operator holds the data, so recent rows
come from the Pi and history comes from the archive without custom plumbing.

### Retraining

Batch jobs, never always-on. Label review uses a GPU rented by the hour. BiLSTM
retraining runs on CPU. Promoted models are published to a versioned registry that the
Pi pulls from. See [08-retraining-pipeline.md](08-retraining-pipeline.md).

## Interfaces and ports

| Service | Host | Port | Consumers |
|---|---|---|---|
| EdgeLake operator TCP | Pi | 32148 | EdgeLake network |
| EdgeLake operator REST | Pi | 32149 | Backend, inference, dashboard, cloud network queries |
| EdgeLake MQTT broker | Pi | 1883, LAN and loopback only | Producers |
| IEMS backend | Pi | 8009 | Dashboard, cloud GUI plugin |
| Node dashboard | Pi | 47821 | Household on the LAN, operators over Tailscale |
| EdgeLake master TCP and REST | Cloud | 32048, 32049 | All nodes |
| EdgeLake archive operator, MCP endpoint | Cloud | 32158, 32159 | EdgeLake network, MCP client |
| AnyLog remote GUI | Cloud | 3001 | Operators over Tailscale |

Ports follow the existing deployment so that scripts and documentation carry over.
The archive operator ports are new and are placeholders until the cloud compose is finalized.

## Security boundaries

1. Nothing in the cloud has a route into the house LAN. The Pi initiates every connection outward.
2. Home Assistant credentials stay on the Pi.
3. The MQTT broker binds to loopback and the LAN, never to the tailnet.
4. Cloud services are reachable only over Tailscale. No public ports.
5. Data leaving the house requires sign-off from the site owner and the project sponsor (Phase 1).
