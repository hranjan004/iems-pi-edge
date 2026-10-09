# 10. Migration plan

The order matters more than the speed. Each step is reversible until Phase 4, and no
step changes two things at once, so any regression can be traced to one change.

## Phase 0. Slim the existing host

| Step | Change | Check | Rollback |
|---|---|---|---|
| 0.1 | Register the `egauge` message client | `get msg client` lists it | `exit msg client <id>` |
| 0.2 | Run the MQTT producer into a parallel table for 24 h | Counts within 1% | Stop the producer |
| 0.3 | Switch the MQTT producer to `energy_readings`, stop Kafka services by name | Row rate unchanged | Restart Kafka services |
| 0.4 | Point Ask and MCP at the cloud model, stop Ollama | Ask returns, latency logged | Restart Ollama, revert env |
| 0.5 | Add the IEMS backend to compose | `docker compose config` lists it | Remove the service block |
| 0.6 | Fix the dashboard sources query | Response under 2 s | Revert `server.js` |
| 0.7 | Stop Grafana | Nothing depends on it | Restart it |

Exit criterion: host swap under 500 MB for 48 hours with all dashboards complete.

## Phase 1. Prerequisites

Sign convention, DSS state type, telling the sponsor about the move to EdgeLake, and data
sharing sign-off. See [11-open-questions.md](11-open-questions.md).

## Phase 2. Pi in shadow

1. Build the Pi per [04-pi-setup.md](04-pi-setup.md)
2. Benchmark inference on real models and record results in `bench_results/`
3. Install services with inference writing to `nilm_disaggregated_shadow`
4. Run seven days alongside the host

Exit criterion: no OOM kill, peak RSS under 750 MB, inference p95 under 10 s, shadow
states match the host on 99% of ticks.

## Phase 3. Cloud side

1. Provision the VM on the tailnet
2. Deploy master, archive operator, Postgres and GUI from [cloud/](../cloud/)
3. Join the Pi operator to the cloud master
4. Enable archive transfer and run a forced two-hour outage test

Exit criterion: gap-free backfill and correct routing of network queries.

## Phase 4. Cut over

1. Point the meter producer on the Pi at `energy_readings` as the authoritative path
2. Switch inference from the shadow table to `nilm_disaggregated`
3. Stop the host containers one at a time, oldest dependency last
4. Keep the host disk untouched for 30 days

Exit criterion: fourteen days with the host off and no data loss.

## Phase 5. Retraining

Feedback capture, label store, nightly review, retraining, promotion and model pull,
per [08-retraining-pipeline.md](08-retraining-pipeline.md).

## Timeline sketch

| Phase | Effort | Blocked by |
|---|---|---|
| 0 | 2 to 3 days | Nothing |
| 1 | 1 week elapsed, mostly waiting on answers | Sponsor, site owner |
| 2 | 1 week build, 1 week shadow | Hardware on hand |
| 3 | 3 to 4 days | Cloud account under a project owner |
| 4 | 2 weeks elapsed | Phases 2 and 3 |
| 5 | 2 to 3 weeks | Phase 1 sign convention |
