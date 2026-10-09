# cloud

| File | Purpose |
|---|---|
| `docker-compose.yml` | Always-on services: AnyLog master, archive operator, Postgres, AnyLog GUI |
| `.env.example` | Every variable the compose file reads |
| `retraining/` | Batch pipeline for label review, retraining, evaluation and publishing |

The compose file is a skeleton. AnyLog environment variable names follow the AnyLog
docker-makefiles convention and must be checked against the image version in use. The
GUI's language model variables depend on how the IEMS overlay wires the MCP client.

## Bring-up order

1. Join the VM to the tailnet and note its address
2. Fill `.env`
3. `docker compose up -d postgres master`
4. Confirm the master answers on `TAILNET_IP:32049`
5. `docker compose up -d archive iems-gui`
6. Point the Pi operator's `LEDGER_CONN` at the master and restart it
7. From the GUI, run a network query and confirm rows from the Pi come back

Details: [docs/07-cloud.md](../docs/07-cloud.md).
