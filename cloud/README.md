# cloud

| File | Purpose |
|---|---|
| `docker-compose.yml` | Always-on services: EdgeLake master, EdgeLake archive operator, Postgres, AnyLog remote GUI |
| `.env.example` | Every variable the compose file reads |
| `retraining/` | Batch pipeline for label review, retraining, evaluation and publishing |

The compose file is a skeleton. EdgeLake reads its configuration from environment
variables with `ANYLOG_` names, as in the EdgeLake docker-compose repository. Build the
EdgeLake image from the same commit the Pi runs, using EdgeLake's own Dockerfile:

```bash
git clone https://github.com/EdgeLake/EdgeLake && cd EdgeLake && git checkout faba50ddf8ee
docker build -t iems-edgelake:faba50ddf8ee .
git clone https://github.com/EdgeLake/deployment-scripts ../edgelake-deployment-scripts
git -C ../edgelake-deployment-scripts checkout 45b830b473a5
```

EdgeLake's Dockerfile clones the `pre-develop` branch of the deployment scripts at build
time. The compose file mounts the pinned checkout over it, so the cloud nodes run the
same scripts as the Pi. The GUI's language model variables depend on how the IEMS
overlay wires the MCP client.

## Bring-up order

1. Join the VM to the tailnet and note its address
2. Fill `.env`
3. `docker compose up -d postgres master`
4. Confirm the master answers on `TAILNET_IP:32049`
5. `docker compose up -d archive iems-gui`, then confirm `get processes` on the archive node lists the operator
6. Point the Pi operator's `LEDGER_CONN` at the master and restart it
7. From the GUI, run a network query and confirm rows from the Pi come back

Details: [docs/07-cloud.md](../docs/07-cloud.md).
