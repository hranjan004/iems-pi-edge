# iems-pi-edge

This repository holds the code that is running live on the ASUS Ascent GX10 for the Microgrid Intelligent Energy Management System (IEMS). It covers the whole stack that sits behind the live dashboard on port 47821, from the replayed meter feed through Kafka, AnyLog and PostgreSQL, the per panel NILM models and the Nemotron engine, the decision support layer, the measured power forecasts, the readiness monitor and the AnyLog Remote GUI with its IEMS plugin.

The earlier design bundle for moving the edge role onto a Raspberry Pi 3 B+ is kept intact in `pi-edge/`.

For all queries about this repository, the deployment or the data, contact Harsh Ranjan at hranjan@ucsc.edu.

## What runs on the GX10

The stack is defined in `gx10/docker-compose.gx10.yaml` and runs as the Compose project `microgrid-gx10`. The measured power forecaster runs beside it as user level systemd services that are installed from `gx10/forecast/`.

| Service | Port | Built from |
|---|---|---|
| iems-dashboard | 47821 | `services/iems/web/` |
| iems-backend | 8009 | `services/iems/backend/` and the `services/iems/` package |
| iems-inference | none | `services/iems/inference/` |
| iems-app (Remote GUI with the IEMS plugin and MCP client) | 3001 and 8000 | `services/remote-gui/` with `services/remote-gui-overlay-216/` |
| replay-producer | 8099 | `gx10/replay/` |
| anylog-consumer | none | `streaming/kafka-egauge-pipeline/kafka_to_anylog.py` |
| master and operator1 (AnyLog) | 32048 to 32149, 1883 | `streaming/anylog/docker-makefiles/` and `gx10/config/` |
| postgres1 | 5432 | `streaming/postgres/` |
| kafka and kafka-ui | 9092, 9094 and 8080 | upstream images |
| iems-knowledge (graph view) | 47822 on localhost | `gx10/knowledge/` |
| measured power forecast | Unix socket, no TCP port | `gx10/forecast/` |

## Getting started

Copy `gx10/.env.example` to `gx10/.env` and fill in the blank values. The AnyLog license, the eGauge credentials, the Postgres password and any storage keys are never committed and must be supplied locally. The device login file read by the forecast collector lives at `~/.config/iems/device-auth.json` on the host and is also kept out of the repository. Then follow `gx10/README.md`, which walks through first boot, Docker and the GPU runtime, dataset export, GPU training, bring up with `gx10/scripts/up.sh` and verification with `gx10/scripts/verify.sh`.

Every password in this repository is a placeholder such as `change-me`, and every address that pointed at a private host has been replaced with a placeholder such as `production-host`. Replace them with your own values before deploying.

## Top level files

| File | Purpose |
|---|---|
| `README.md` | This guide to the repository layout |
| `OVERVIEW.md` | The full system description, covering the data pipeline, the models, the rules engines, the decision support layer and the dashboards |
| `INSTALL.md` | Step by step installation of the production stack on a single host at the house |
| `SETUP.md` | Detailed setup and operations guide for the production containers |
| `README-monitor.md` | The readiness monitor inside the dashboard, its public data sources and its preparation rules |
| `docker-compose.yaml` | The production Compose stack for the house deployment |
| `docker-compose.iems-app-only.yaml.ref` | Reference Compose file for running only the Remote GUI container |
| `.env.example` | Template for the production `.env` |
| `.gitignore` and `.dockerignore` | Paths kept out of Git and out of Docker build contexts |
| `appliance_data_updated.txt` | Appliance inventory with rated power for each panel, used by the rules and the prompts |
| `egauge_python_test.py` | Minimal eGauge API connection test |

## Folders

### `gx10/`

Everything that is specific to the GX10 target. Nothing under `services/` or `streaming/` is forked for it, so the same production code runs on both hosts.

| Path | Purpose |
|---|---|
| `README.md` | The GX10 setup guide from first boot to the demo, plus the Nemotron results |
| `docker-compose.gx10.yaml` | The full arm64 stack with profiles for the LLM runtime |
| `.env.example` | Every setting the GX10 stack reads |
| `config/operator1-gx10.env` | AnyLog operator overrides for the GX10 |
| `anylog-init/init.sh` | Sidecar that keeps operator1 serving data by reapplying the operator setup whenever the node comes up without it |
| `replay/` | The replay producer that plays the recorded meter data into Kafka with live timestamps and exposes a small control API for demos |
| `scripts/` | Bootstrap checks, ordered bring up, health verification, data export from the production host, dataset building, model pulls, Nemotron serving and the test runner |
| `training/` | GPU training of the BiLSTM models on the GB10 inside the NGC PyTorch container |
| `nemotron/` | The Nemotron NILM pipeline, which covers relabelling, supervised fine tuning, recurrent rounds, evaluation, round comparison, deployment and the round monitor |
| `llm-bridge/` | An Ollama compatible bridge in front of a NIM or vLLM endpoint |
| `forecast/` | Measured power forecasting for every channel, battery forecasts, the smart decision support schedule, node details for the system map, feedback scoring, the live collector, recurrent relearning and the systemd units that run them, documented in its own `README.md` and `RECURRENT_LEARNING.md` |
| `knowledge/` | Compose file and graph builder for the local knowledge graph view of the system |
| `tests/` | Pytest suite for the GX10 scripts, the replay producer, the bridge, the monitor, dataset building, ONNX export and a check that no secrets are committed |

### `services/iems/`

The IEMS application, organised by the four domains of the Adabi (2016) architecture.

| Path | Purpose |
|---|---|
| `runner.py` | `run_iems_cycle()`, the single entry point the user interfaces call |
| `config.py` | Channels, appliances, time of use rates, load panels and critical appliances |
| `weather.py` | Open-Meteo weather fetcher used as context by NILM and decision support |
| `backend/` | The FastAPI service on port 8009, with `main_api.py`, the IEMS router and the Ask endpoint in `iems_ask.py` that answers questions through the local LLM |
| `web/` | The Node dashboard on port 47821. `server.js` serves the dashboard and its APIs, `forecast.html` is the Predictions tab, `system-map.html` is the System map tab, `readiness.js` is the readiness monitor with its tests in `readiness.test.js`, `chart-analysis.js` provides the shared chart analysis controls for measured and forecast views and `patches/` holds the scripted edits applied to the history detector |
| `inference/` | The 30 second inference loop, feature construction, the ONNX disaggregator, the Nemotron engine and its prompt, the appliance map and the additive rules that reconcile model output with measured watts |
| `load/` | AnyLog queries, the LLM disaggregation path, anomaly checks, mobile load reconciliation and load shedding ranking |
| `detect/` | Breaker margin checks, stuck off detection, HVAC shedding, the Home Assistant client and the anomaly store |
| `generation/` | Solar forecast and grid analytics, including time of use classification |
| `storage/` | Modelled battery state of charge and dispatch policy |
| `decision_support/` | Recommendations priced in dollars, the optimiser, the rule tree that tags actions as automatic or user driven, and the shedding bridge |
| `monitoring/` | Data gap watchdog |
| `prompts/` | Prompt templates for disaggregation and anomaly explanation |
| `models/` | The trained ONNX and PyTorch NILM models for each panel with their normalisation files |
| `training/` | The offline training pipeline, which covers data pulls, physical labellers, rules engines, window building, model definitions, training, evaluation, threshold tuning and ONNX export, with reports and phase notes in `reports/` and `matnilm/` |
| `tests/` | Unit tests for breaker margin, the Nemotron engine, the solar pipeline and the register inventory |

### `services/` (other folders)

| Path | Purpose |
|---|---|
| `remote-gui/` | Vendored copy of the AnyLog Remote GUI with its Python backend and React frontend |
| `remote-gui-overlay-216/` | The overlay that adds the IEMS page and the MCP client to Remote GUI 2.1.6, which is what the live `iems-app` container runs |
| `remote-gui-overlay-212/` | The earlier overlay for Remote GUI 2.1.2 |
| `remote-gui-iems-plugin/` | The original IEMS plugin, a backend router plus the frontend page, appliance list and API client |

### `streaming/`

| Path | Purpose |
|---|---|
| `kafka-egauge-pipeline/` | The eGauge to Kafka producer, the Kafka to AnyLog consumer, their Dockerfiles and a standalone Kafka Compose file |
| `solar-pipeline/` | The Solar Assistant MQTT producer |
| `anylog/docker-makefiles/` | Base, advanced and local script configuration for the AnyLog master and operator nodes |
| `postgres/` | Postgres Compose file, environment template and the init script that creates the AnyLog database user |
| `launchd/` | macOS launchd template for running the inference loop on a Mac |

### `docs/`

The technical reference, written against the running production deployment. `docs/README.md` is the index. The numbered files cover the architecture, the file inventory, the physical labellers, the rules engines, the training pipeline, the inference runtime, every API route, streaming and storage, all scripts, and the GX10 target. `docs/services/` and `docs/streaming/` document each folder of the code, and `anylog_query_cookbook.md` collects useful AnyLog queries.

### Other folders

| Path | Purpose |
|---|---|
| `scripts/` | Start and stop scripts for the production host and the Remote GUI deployment script |
| `tests/` | Integration tests for the IEMS package |
| `tools/` | Small utilities for probing Home Assistant, configuring Solar Assistant MQTT, dumping MQTT traffic, and `uns/` for building the Unified Namespace graph of the site |
| `analysis/inventory/` | Breaker ratings and the eGauge register inventory with the script that builds it |
| `pi-edge/` | The Raspberry Pi 3 B+ edge and cloud design, with its own README, architecture notes, decision records, systemd units, cloud retraining pipeline and SQL |

## What is not in this repository

Credentials, `.env` files, tokens, private keys, raw meter exports, training datasets, logs and backup copies are deliberately left out. Locations are given only at city level.

## Contact

For all queries, contact Harsh Ranjan at hranjan@ucsc.edu.
