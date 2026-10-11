# retraining

Outline and supporting pieces for the cloud retraining pipeline. The training code
itself stays in `microgrid-manager` under `services/iems/training`, and the review
prompt and snapshot code come from `gemma-anomaly`. This folder holds what connects
them to the edge split.

| File | Purpose | State |
|---|---|---|
| `pipeline.yaml` | Stage configuration: schedule, selection, review, training, promotion, publishing | Design |
| `select_windows.sql` | Ranks recent windows by uncertainty, model and rules disagreement, and label scarcity | Ready to run against the archive |
| `make_manifest.py` | Builds the manifest that `pi/scripts/pull_models.sh` verifies | Ready |
| `manifest.example.json` | Shape of a published model set | Reference |

## Stages

| # | Stage | Runs on | Output |
|---|---|---|---|
| 1 | Export new windows from the archive | VM | Parquet in object storage |
| 2 | Rules replay over new windows | VM | `rules` labels |
| 3 | Window selection | VM | Review list and daily human questions |
| 4 | Label review with Gemma | GPU instance | `review` labels or abstentions |
| 5 | Train per panel, source-weighted | CPU instance | Candidate checkpoints |
| 6 | ONNX export and feature check | CPU instance | Candidate ONNX set |
| 7 | Shadow replay and held-out scoring | CPU instance | Evaluation report |
| 8 | Publish if promoted | VM | `vN/` in the registry and an updated `latest` |

## Registry contract

```
iems-models/
  latest                 text, e.g. "v13"
  v13/
    manifest.json        built by make_manifest.py
    nilm_panel1.onnx
    nilm_panel2.onnx
    nilm_panel3.onnx
    panel1_norm_bilstm.json
    panel2_norm_bilstm.json
    panel3_norm_bilstm.json
    report.html
```

`latest` is written last, after every file and the manifest are in place, so the Pi
never sees a half-published set.

Design: [docs/08-retraining-pipeline.md](../../docs/08-retraining-pipeline.md).
