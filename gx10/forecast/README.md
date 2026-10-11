# GX10 measured-power forecasting

The existing :47821 dashboard now has Predictions and System map tabs. The forecast API has **no listening TCP port**: dashboard requests pass through a read-only mounted Unix socket. Prediction refresh is every minute; the source origin advances in 15-minute bins. All power curves are 15-minute mean watts. Sum of W × 0.25 / 1000 gives 24-hour kWh. Grid is signed import/export; panel CT orientation is converted to magnitude to match the existing dashboard.

## Data and model contract

Ingests the complete deduplicated 30,734,135-row eGauge archive (March 6–October 9, 2026), all 16 measured channels, plus 976,788 solar records (August 3–September 30). Missing periods remain missing. A 15-minute bin needs at least 60% bounded inter-sample support; full forecasting windows need 80% meter coverage. This retains roughly 90 days of densely sampled data inside the seven-month time span. The model does not pretend the archive is continuous.

Inputs: last 24 hours of all eGauge signals, PV/battery/SOC/inverter readings, weather history and missingness flags; future local time/day/year, NOAA approximate sun elevation, GFS temperature, cloud cover, shortwave irradiance and wind. Archived future covariates use Open-Meteo `_previous_day2`, meaning forecasts issued 48 hours before valid time; they precede all origins in a 24-hour target window. No realized future meter or weather observations enter prediction features.

Targets: HVAC, H2O, Kitchen, Grid, Shop, Generac, and optional measured Solar PV. Solar baseline forecasts are withheld when the recent PV history is absent. An explicitly experimental weather-aware XGBoost view remains available.

GPU candidates: compact TiDE-inspired joint-channel residual dense encoder / temporal decoder (PyTorch CUDA, ~100 MB peak allocation), and CUDA XGBoost direct multi-horizon regression. Also tests persistence, daily and weekly seasonal baselines and a fixed XGBoost/daily blend. Each channel uses the validation winner. This is an adaptation, not a reproduction of published benchmark numbers.

Chronological evaluation: final 42 days are three disjoint 14-day blocks for model selection, empirical interval calibration and final test. Training target windows end before selection begins; windows cannot cross split boundaries. Standardization is fitted only on training data. Interval bands use the calibration block's 80th-percentile absolute residual per horizon/channel. Test coverage is displayed and is sometimes materially below 80%; it is not a guaranteed confidence level. The final test is reported, never used for candidate selection or early stopping.

## Replay versus live

GX10 currently runs replay-producer. Forecast dates and weather follow its source timestamp, not the computer's wall clock. In replay, prior-day context is the original archive; no synthetic replay solar is substituted for missing measured PV. These forecasts are demonstrative historical forecasts, not a claim to observe the home today.

A background collector checks every five minutes. It enables genuine live collection only when `egauge-producer` is running and `replay-producer` is stopped. It reads the existing AnyLog tables, accepts timestamps after the live producer's startup, and saves complete bins to `data/live_genuine.parquet`. It does not switch producers or change device controls. It fetches current GFS weather and preserves fetch time. Live forecasts require recent meter coverage; until a full day is available they are withheld. Live origins are the next 15-minute boundary so forecast weather was obtained before the origin. Original archive or genuine-live updates feed retraining; the newest two days wait for archived weather availability.

## Relearning and serving

`iems-power-forecast.service`: local socket API; CPU inference; model files are immutable and loaded via atomically replaced champion pointer. `iems-power-relearn.timer`: every six hours, compare original-file fingerprints and completed genuine-live days. Unchanged archives and replayed timestamps do not train again. On new data: build dataset, warm-start the neural candidate when compatible, fit fresh GPU boosted trees, select and calibrate. Compare old and candidate models on the same new validation origins; promotion requires >=1% normalized MAE improvement. Failures leave the old serving champion available. User systemd lingering is already enabled on GX10.

`data/training_status.json`, `data/relearn_state.json`, reports, versioned model files and prediction logs provide an audit trail. `/api/power-accuracy` scores only predictions whose target timestamps have passed the verified source clock. Replay scores are labeled separately from genuine field validation.

## Source papers and tools

- TiDE: Das et al., 2023, https://arxiv.org/abs/2304.08424 — residual dense encoding, covariate projection and temporal decoding.
- XGBoost: Chen and Guestrin, 2016, https://arxiv.org/abs/1603.02754 — gradient-boosted trees; this implementation uses CUDA histogram training.
- TimeXer: Wang et al., 2024, https://arxiv.org/abs/2402.19072 — reviewed for exogenous-variable handling; not implemented.
- PatchTST: Nie et al., 2023, https://arxiv.org/abs/2211.14730 — reviewed for patch-based temporal modeling; not implemented.
- Open-Meteo previous runs: https://open-meteo.com/en/docs/previous-runs-api
- NVIDIA txt2kg: https://build.nvidia.com/spark/txt2kg — deployed from NVIDIA/dgx-spark-playbooks. Ollama llama3.2:1b performs local extraction, ArangoDB persists graphs, Three.js/WebGPU provides the upstream 2D/3D viewer at :47822. Graph database port is loopback-only. Dashboard map shows verified topology separately from LLM triples. NVIDIA nvidia-smi supplies current GPU telemetry.

The separate `/home/asus/iems` appliance-probability forecaster and ongoing Nemotron training remain independent.

## Operation

Install: `bash install.sh` from this directory (asus). Tests: `/home/asus/iems/.venv/bin/python -m unittest test_forecast -v`. Rebuild data: `build_data.py`. Train candidates through `relearn.py`, not by directly replacing the champion. API paths (local socket): /health, /forecast?view=validated|weather-aware, /status, /accuracy, /system. Dashboard proxies: /api/power-forecast, /api/power-status, /api/power-accuracy, /api/system-map.

To stop this addition: stop/disable the two iems-power user services/timer; stop the independent gx10/knowledge compose project; restore the backed-up dashboard files and rebuild only iems-dashboard. Existing data and model versions remain available for rollback.

## Runtime access limitation
The serving process deliberately has no Docker control permissions. Container inventory is a deployment snapshot; NVIDIA GPU telemetry is live. The original-data export retraining path is active. Automatic live meter collection is gated off until producer provenance can be read safely; replay data never trigger training.

## Direct web deployment (October 11, 2026)
All collectors, historical downloads, GPU training, inference and timers run on GX10. `iems-web-collector.service` authenticates directly to eGauge and Solar Assistant using `/home/asus/.config/iems/device-auth.json` (0600, outside the repository). Sessions and tokens exist only in memory. It has NoNewPrivileges and no Docker access. eGauge polls every 10 seconds; Solar Assistant every 30 seconds; completed 15-minute historical intervals and weather refresh every 15 minutes. Device freshness gates predictions. Prediction snapshots update every minute without a browser; forecast origins advance each quarter hour. Training checks for completed new days every six hours and only promotes after validation improves at least 1%.

Solar history uses the viewer-accessible Grafana query proxy because this installed device firmware does not expose the newer history API. Queries use interval means with null gaps, not Grafana's forward-fill display behavior. eGauge uses exact integer differences of cumulative counters divided by elapsed seconds, converting V/I/F milli-units and preserving signed grid power. Unavailable older eGauge history stays backed by the previously imported original archive; epoch sentinel rows are ignored.

Replay is stopped and is now an opt-in Compose profile (`replay`). Do not start it while the web collector publishes to the same tables. Existing General-tab records from before the switch may be replay; forecast context exclusively uses verified archives and direct web history. No inverter, battery, relay, or meter settings are changed.

The earlier runtime limitation above is superseded: direct source authentication proves provenance without Docker access. Current configuration uses Los Gatos weather as requested, although Solar Assistant's configured location is labeled Morgan Hill.

## See also

The models, validation scheme and 2026-10-11 results of this forecaster are summarised with the rest of the system in [`docs/10_models_and_training.md`](../../docs/10_models_and_training.md), section 5. Screenshots of every forecast chart, in both the validated and the weather-aware XGBoost views, are in [`docs/screenshots/`](../../docs/screenshots/README.md).
