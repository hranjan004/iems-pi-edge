# Outline

High-level plan for moving the IEMS edge role onto a Raspberry Pi 3 Model B+ and the
heavy, non-real-time work into the cloud. Each phase ends with an acceptance check
that must pass before the next phase starts.

## 1. Scope

**In scope**

1. Removing Kafka and its UI and bridge from the data path
2. Running ingestion, an EdgeLake operator, NILM inference, the IEMS backend and the
   live dashboard on the Pi
3. Moving the EdgeLake master, the long-term archive, the AnyLog remote GUI and the language
   model to the cloud
4. A cloud retraining pipeline that uses label provenance, human feedback and batch
   label review, and that publishes versioned ONNX models for the Pi to pull

**Out of scope for this repository**

1. Changes to the BiLSTM architecture itself
2. Automated load control. The decision support engine keeps recommending, not acting
3. The anomaly assessment layer, which lives in `gemma-anomaly`

## 2. Target placement

| Component | Today | Target | Reason |
|---|---|---|---|
| eGauge producer | Host, Kafka | Pi, MQTT to local EdgeLake | Kafka is the largest fixed cost in the stack |
| Solar producer | Host, AnyLog MQTT | Pi, EdgeLake MQTT, code unchanged | Already Kafka-free |
| Kafka, Kafka UI, bridge | Host | Removed | About 1.5 GB combined |
| Licensed AnyLog operator | Host, Docker | EdgeLake operator on the Pi, native, SQLite, 3-day retention | Measured at 99 MB, open source, no license |
| Licensed AnyLog master | Host | EdgeLake master in the cloud | Must stay reachable when the house link drops |
| Archive operator and Postgres | Host | Cloud | Long-term record and training source |
| IEMS backend (FastAPI, DSS) | Host, started by hand | Pi | Recommendations must survive an outage |
| NILM inference loop | Host | Pi | 80 MB measured, cheapest workload in the stack |
| Node dashboard | Host | Pi | Live view and thermostat control stay local |
| AnyLog remote GUI and MCP client | Host | Cloud, against the EdgeLake network | Heavy image, not needed for the live view |
| Local LLM (Ollama) | Host | Cloud API | 1.37 GB measured, mostly swapped out |
| Grafana | Host | Removed | Superseded by the dashboard |
| Retraining and label review | Laptop, by hand | Cloud batch | GPU only for label review, CPU for the BiLSTM |

## 3. Phases

### Phase 0. Slim the existing host

1. Replace the Kafka producer with [streaming/egauge_mqtt_producer.py](streaming/egauge_mqtt_producer.py)
   and register the matching message client
2. Stop Kafka, Kafka UI and the bridge
3. Point the Ask box and MCP client at the cloud model and stop Ollama
4. Add the IEMS backend to the compose file so it is reproducible
5. Fix the dashboard sources query that pulls about 28,000 rows per poll

**Acceptance.** `energy_readings` row rate matches the pre-change rate within 1% over
24 hours. Swap use on the host falls below 500 MB. No dashboard panel shows a gap.

### Phase 1. Settle the prerequisites

1. Resolve the subpanel sign convention (channels read negative while normalization means are positive)
2. Fix the decision support state type mismatch (`'on'` stored, `1` compared)
3. Tell the AnyLog sponsor that the new deployment runs EdgeLake only, per ADR 0007
4. Confirm with the site owner and the sponsor that data may leave the house to a private cloud bucket

**Acceptance.** Written answer to item 4. Unit tests for items 1 and 2.

### Phase 2. Bring up the Pi alongside the host

1. Flash 64-bit Raspberry Pi OS Lite or DietPi, apply [pi/scripts/bootstrap.sh](pi/scripts/bootstrap.sh)
2. Mount a USB SSD for the EdgeLake data directory
3. Run [pi/scripts/bench_onnx.py](pi/scripts/bench_onnx.py) and [pi/scripts/footprint.sh](pi/scripts/footprint.sh), and record p95 tick time and RSS per unit
4. Install the services with [pi/scripts/install.sh](pi/scripts/install.sh) in shadow mode,
   writing to a separate table so the host stays authoritative

**Acceptance.** Seven days of shadow operation with no OOM kill, peak RSS under 750 MB,
inference p95 under 10 s per tick, and NILM states matching the host on at least 99% of ticks.

### Phase 3. Stand up the cloud side

1. EdgeLake master, archive operator and Postgres from [cloud/docker-compose.yml](cloud/docker-compose.yml), built from the commit the Pi runs
2. AnyLog remote GUI and MCP client pointed at the cloud model and the EdgeLake network, verified working
3. Archive path from the Pi operator to the cloud operator

**Acceptance.** A network query from the cloud GUI returns rows held only on the Pi.
After a forced 2-hour uplink outage the archive backfills with no gaps.

### Phase 4. Cut over

1. Make the Pi authoritative, retire the host containers one at a time
2. Keep the host image for 30 days as a rollback path

**Acceptance.** Fourteen days with the host powered down and no data loss.

### Phase 5. Cloud retraining

1. Feedback capture on the dashboard into `nilm_feedback`
2. Label provenance store and held-out evaluation set
3. Nightly label review, retraining, shadow scoring and promotion
4. Pi pulls promoted models and keeps the previous set for rollback

**Acceptance.** One full retrain cycle promotes a model that beats production on the
held-out set, and the Pi rolls it back cleanly on command.

## 4. Open decisions

Tracked in [docs/11-open-questions.md](docs/11-open-questions.md). The ones that can
change the plan are whether the AnyLog remote GUI and MCP client work unchanged against
EdgeLake, and whether the EdgeLake footprint measured on x86 (99 MB) holds on the Pi.

## 5. Deliverables in this repository

| Deliverable | File |
|---|---|
| Target architecture | [docs/02-architecture.md](docs/02-architecture.md), [architecture/](architecture/) |
| Memory budget | [docs/03-memory-budget.md](docs/03-memory-budget.md) |
| Pi build guide | [docs/04-pi-setup.md](docs/04-pi-setup.md) |
| Kafka removal | [docs/05-kafka-removal.md](docs/05-kafka-removal.md), [streaming/](streaming/) |
| EdgeLake topology | [docs/06-edgelake-topology.md](docs/06-edgelake-topology.md) |
| Footprint measurements | [docs/measurements/2026-10-09-edgelake.md](docs/measurements/2026-10-09-edgelake.md) |
| Cloud services | [docs/07-cloud.md](docs/07-cloud.md), [cloud/](cloud/) |
| Retraining pipeline | [docs/08-retraining-pipeline.md](docs/08-retraining-pipeline.md), [cloud/retraining/](cloud/retraining/), [sql/](sql/) |
| Failure handling | [docs/09-failure-modes.md](docs/09-failure-modes.md) |
| Migration plan | [docs/10-migration-plan.md](docs/10-migration-plan.md) |
| Decisions | [docs/adr/](docs/adr/) |
| References | [docs/resources.md](docs/resources.md) |
