# 11. Open questions and risks

## Open questions

| # | Question | Owner | Blocks | Status |
|---|---|---|---|---|
| Q1 | Does the AnyLog remote GUI with the IEMS plugin work unchanged against an EdgeLake network? | Maintainer | Phase 3 | Open, expected yes since it uses the node REST API |
| Q2 | Does the Pi operator keep ingesting and answering local SQL with the cloud master down for hours? | Maintainer | Phase 3 | Open, tested by stopping the master |
| Q3 | Does the MCP client get its full tool set from EdgeLake's `/mcp/sse` endpoint? | Maintainer | Phase 3 | Open, endpoint answered in the 2026-10-09 test |
| Q4 | Is the sponsor comfortable with the move to EdgeLake only? | Sponsor | Phase 1 | Open |
| Q5 | May readings and labels be stored in a private cloud bucket? | Site owner, sponsor | Phases 3 and 5 | Open |
| Q6 | Is the negative sign on subpanel channels CT orientation or the producer's sign convention? | Maintainer | Phase 5 | Open |
| Q7 | Who owns the cloud account, tailnet and model registry after handover? | Lab | Phase 4 | Open |
| Q8 | Which Gemma 4 size is used for label review? | Maintainer | Phase 5 | Leaning 26B MoE |
| Q9 | Which hosted model backs Ask and MCP, and what is the monthly budget? | Maintainer, lab | Phase 0 step 4 | Open |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| EdgeLake on the Pi uses much more than the 99 MB measured on x86 | Low | Tighter budget | Measure in Phase 2 with footprint.sh, fall back to a 2 GB Pi 5 |
| EdgeLake defaults fill the disk with archived JSON | High if defaults are kept | SSD fills over weeks | `THRESHOLD_VOLUME=100KB` and `ARCHIVE_DELETE=2`, healthcheck disk alert |
| EdgeLake source moves on and nodes drift apart | Medium | Network incompatibility | Every node pinned to one commit, cloud image built from it |
| Docker Hub EdgeLake image lags the source | Certain today | Wrong version in the cloud | Build the cloud image from the pinned commit |
| EdgeLake lacks the commercial edition's HA and security hardening | Certain | None today, neither is used | Revisit if clustering or hardened auth is ever needed |
| SD card corruption | Medium over years | Pi down until reflashed | Logs in RAM, data on SSD, spare imaged card on site |
| Review model labels are confidently wrong | Medium | Biased training set | Review labels excluded from validation, random audit sample |
| Cloud account lapses after handover | High without action | Archive and GUI lost, house unaffected | Q7 before Phase 4 |
| Pi 3 CPU too slow for the dashboard sources query | High if unfixed | Dashboard unusable | Phase 0 step 6 |
| Producer spool fills the SSD in a long outage | Low | Ingestion stops | Spool cap with oldest-first pruning and an alert |
