# GX10 recurrent power and battery learning

`iems-power-relearn.timer` runs at minute 00, 20 and 40 of each hour. The user systemd manager has lingering enabled; this runs on GX10 without the desktop session. The service has an 18-minute deadline, an 8 GiB memory limit, low scheduling priority and a shared nonblocking lock to prevent overlapping retraining jobs.

Each cycle:
1. Refresh authenticated eGauge and Solar Assistant history, including battery temperature. Only completed 15-minute measurements enter the cycle.
2. Match immutable issued forecasts to actual measurements. Skip missing actuals, unfinished intervals and forecasts issued after their target time. Deduplicate overlapping horizons by target time, channel and model version.
3. Update per-channel residual-bias candidates once there are 24 distinct completed target times for that deployed base version. Fit on the earliest 75%, validate on the latest 25%, and activate only with at least 1% lower validation MAE. Corrections never carry silently to a new base model.
4. Create an isolated training snapshot with the original deduplicated archive, refreshed web observations and issue-safe historical weather. Train power neural/tree candidates and battery neural/baseline candidates. Neural training reuses compatible prior weights; CPU fallback handles an unavailable GPU. The installed XGBoost build uses CPU.
5. Retain the existing chronological train/selection/calibration/test split. Recent data are context and holdout evidence, not fabricated training labels. Promote each model family independently only with at least 1% better validation error against its current champion on the same origins.
6. Publish artifacts before atomically switching the champion metadata; keep old model artifacts for rollback. Existing forecasts continue while candidates train.

The service records both power and battery forecasts every minute, independently of dashboard visits. Logs live in `data/issued_forecasts`; corrections in `data/feedback_models.json`; measured error counts in `data/feedback_status.json`; latest cycle status in `data/recurrent_status.json`. Candidate logs and snapshots live under `/home/asus/forecast-runs/recurrent-*`.

The Predictions page displays cycle status. Base-model uncertainty bands and historical test coverage do not become newly calibrated simply because an online correction is applied. A 20-minute trigger does not guarantee improved accuracy or a new promoted model every run. Corrections wait for sufficient measured evidence.

Manual run: `systemctl --user start iems-power-relearn.service`
Schedule: `systemctl --user list-timers iems-power-relearn.timer`
Stop future runs: `systemctl --user stop iems-power-relearn.timer`
Inspect latest run: `journalctl --user -u iems-power-relearn.service`

To roll back, inspect an earlier report and verify its referenced checkpoint/tree files exist, then atomically replace the corresponding `champion.json` or `battery_champion.json`. The serving process detects model-version changes without a full dashboard restart.
