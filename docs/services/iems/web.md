# Web Folder

`services/iems/web/` — the standalone IEMS dashboard. Two files only:

```
services/iems/web/
├── server.js       # the whole dashboard (UI + API proxy) in one file
└── Dockerfile      # Node:20-alpine, zero npm deps, port 47821
```

## `server.js`

A single-file Node.js HTTP server (Node built-ins only — no npm install). Serves inline HTML/CSS/JS for the dashboard and proxies `/api/*` to two backends:

- AnyLog REST at `127.0.0.1:32149` for the time series (`egauge_kafka`, `nilm_disaggregated`)
- The IEMS FastAPI at `127.0.0.1:8000` for `/iems/cycle`, `/iems/health`, `/iems/weather`, etc.

Default URL is `http://localhost:47821`. Configuration is all env vars (`ANYLOG_HOST`, `ANYLOG_PORT`, `IEMS_HOST`, `IEMS_PORT`) with the localhost defaults shown above.

This file has its own dedicated reference page — see [`server.md`](server.md) for the full API surface, the inline UI components, the NILM rendering pipeline, and the DSS card layout.

## `Dockerfile`

Bare-minimum container so the dashboard can be brought up alongside the rest of the stack from the root `docker-compose.yaml`:

```Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY services/iems/web/server.js /app/server.js
ENV NODE_ENV=production PORT=47821
EXPOSE 47821
CMD ["node", "/app/server.js"]
```

No package.json, no npm install — the comment in the file is the reason: *"server.js uses only Node built-ins (http). No npm install needed."* The dashboard is also runnable straight from the host (`node services/iems/web/server.js`), which is how `scripts/start.sh` brings it up.

## On the GX10 (2026-10-11)

The folder has grown beyond the two files above.

| file | role |
|---|---|
| `server.js` | still the whole dashboard and its API proxy, now also proxying the forecast socket, the system map and node detail |
| `forecast.html` | the Predictions tab (`/forecast-view`): per-channel 24 h power forecasts with bands, battery outlook, and the weather-aware XGBoost view |
| `system-map.html` | the System map tab (`/system-view`): the verified deployment graph and the node inspector |
| `readiness.js`, `readiness.test.js` | the readiness monitor and its tests |
| `chart-analysis.js` | shared chart controls: zoom, pan, peaks, dips, selected time |

The tabs are General, Predictions, System map, Weather, Appliances, Anomalies and Ask, plus a hidden Relay tab. Every one is shown in [`docs/screenshots/`](../../screenshots/README.md).
