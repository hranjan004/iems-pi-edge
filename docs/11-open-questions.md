# 11. Open questions and risks

## Open questions

| # | Question | Owner | Blocks | Status |
|---|---|---|---|---|
| Q1 | Is there a native arm64 AnyLog build? Documented pip wheels are x86_64 only, arm64 exists as a Docker image | AnyLog sponsor | Phase 2 | Open |
| Q2 | Does an operator keep ingesting and serving local SQL with the master unreachable? | AnyLog sponsor | Phase 3 | Open |
| Q3 | Can automated archival transfer push from the Pi operator to the archive operator and prune after confirmation? | AnyLog sponsor | Phase 3 design | Open |
| Q4 | Is the AnyLog license current and does it cover additional nodes? | AnyLog sponsor | Phase 3 | Open |
| Q5 | May readings and labels be stored in a private cloud bucket? | Site owner, AnyLog sponsor | Phases 3 and 5 | Open |
| Q6 | Is the negative sign on subpanel channels CT orientation or the producer's sign convention? | Maintainer | Phase 5 | Open |
| Q7 | Who owns the cloud account, tailnet and model registry after handover? | Lab | Phase 4 | Open |
| Q8 | Which Gemma 4 size is used for label review? | Maintainer | Phase 5 | Leaning 26B MoE |
| Q9 | Which hosted model backs Ask and MCP, and what is the monthly budget? | Maintainer, lab | Phase 0 step 4 | Open |

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| AnyLog operator on the Pi uses far more than 100 MB | Medium | Pi does not fit | Measure in Phase 2, fall back to a 2 GB Pi 5 |
| No native arm64 AnyLog under the license | Medium | Docker overhead returns | EdgeLake on the edge node, or a 2 GB Pi 5 with Docker |
| SD card corruption | Medium over years | Pi down until reflashed | Logs in RAM, data on SSD, spare imaged card on site |
| Review model labels are confidently wrong | Medium | Biased training set | Review labels excluded from validation, random audit sample |
| Cloud account lapses after handover | High without action | Archive and GUI lost, house unaffected | Q7 before Phase 4 |
| Pi 3 CPU too slow for the dashboard sources query | High if unfixed | Dashboard unusable | Phase 0 step 6 |
| Producer spool fills the SSD in a long outage | Low | Ingestion stops | Spool cap with oldest-first pruning and an alert |
