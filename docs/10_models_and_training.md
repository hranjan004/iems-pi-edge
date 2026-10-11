# Models and training

This document is the single reference for every model the IEMS runs on the ASUS
Ascent GX10 (NVIDIA GB10, 128 GB unified memory, arm64). It covers what each
model decides, what it is trained on, how it is trained and validated, how it is
served, and the numbers measured on 2026-10-11. The step-by-step commands are in
`gx10/README.md`. The older Mac and Pat's box training path is
`04_training_pipeline.md`.

| layer | model | decides | where it lives |
|---|---|---|---|
| supervision | physics labeller v2 | the training labels, with abstention | `services/iems/training/physical_labeler_v2.py` |
| NILM teacher and fallback | per-panel BiLSTM (ONNX) | ON/OFF for 22 appliances | `services/iems/training/train_rolling.py`, `services/iems/models/` |
| NILM live engine | Nemotron 3.5 Lightning 30B-A3B + LoRA | ON/OFF for 22 appliances | `gx10/nemotron/`, `services/iems/inference/nemotron_engine.py` |
| power and battery forecasts | TiDE-inspired network, CUDA XGBoost, seasonal baselines | 24 h of 15 min power per channel, battery SOC and temperature | `gx10/forecast/` |
| appliance-usage forecast | transformer, LightGBM, climatology ensemble | 24 h of P(on) and kWh quantiles per appliance | `~/iems` on the GX10 (not in this repository) |
| decision support | dynamic-programming scheduler | when to run optional heavy loads | `gx10/forecast/smart_dss.py` |
| readiness | rules over public feeds | normal or prepare mode | `services/iems/web/readiness.js` |
| Ask | Nemotron 3.5 Lightning in Ollama | answers grounded in live telemetry | `services/iems/backend/iems_ask.py` |
| system map | NVIDIA txt2kg + verified graph builder | the deployment graph | `gx10/knowledge/` |

---

## 1. Data

| source | content | span |
|---|---|---|
| eGauge archive | 30,734,135 deduplicated rows, all 16 channels, 1 s | 2026-03-06 to 2026-10-09 |
| Pat's box export | 70 days on the 6 s grid, plus raw 1 s for 2026-10-07 to 2026-10-09 | 2026-08-01 to 2026-10-09 |
| Solar Assistant | 976,788 rows of PV, battery power, SOC, grid, load and inverter mode | 2026-08-03 to 2026-09-30 |
| live, from 2026-10-11 | authenticated read-only web collectors: eGauge every 10 s, Solar Assistant every 30 s | ongoing |
| weather | Open-Meteo forecasts and the previous-runs archive, NWS alerts, PG&E outage and PSPS feeds | ongoing |

The 16 eGauge channels are Grid Power (signed), Generac Power, Panel1 (HVAC),
Panel2 (H2O), Panel3 (Kitchen), Shop, and per-leg VrmsA, VrmsB, I11, I12, I21,
I22, I31, I32, F1 and Current on Utility Tie. The eGauge has no PV channel, so
measured PV comes from Solar Assistant.

`gx10/scripts/build_dataset.py` merges the archive and the export onto one 6 s
grid. It uses the same last-reading-at-or-before rule as
`feature_builder._resample_uniform`, so training windows match the runtime.

---

## 2. Physics labeller v2 (supervision without submeters)

The house has no per-appliance meters, so there is no ground truth. The
labeller writes down the physics instead. Each rule either sets a label with a
confidence weight $w\in[0,1]$, or abstains (NaN):

* **water heater OFF** when all of Panel2 draws less than 1,600 W, because the
  element draws 2,000 to 4,300 W (weight 0.7);
* **dishwasher OFF** when the Panel3 oscillation component is under 100 W and the
  raw panel is under 400 W. Every active phase (motor 200 W+, heater 1,200 W+)
  lifts the oscillation (weight 0.6);
* **solar circulation pump OFF** when the sun is below the night elevation
  threshold (weight 0.9);
* **quiet envelope:** every appliance is OFF where the panel sits under its
  quiet percentile (weight 0.85);
* **refrigeration split:** compressor cycles are assigned to the refrigerator,
  garage fridge and garage freezer by cycle shape (weights 0.3 to 0.6).

The full history was relabelled on the GX10: 1,956,739 timestamps. Weights of
zero are written wherever the label is NaN, so abstentions never train the model.

---

## 3. Per-panel BiLSTM (teacher and fallback)

**Input.** A window $X\in\mathbb{R}^{100\times 18}$: 100 samples at 6 s (10
minutes) of 18 features. These are:

* the panel's own power;
* the other two panels;
* grid, shop, the leg currents I31, I32, I11 and I21, and VrmsA;
* time of day as $\sin$ and $\cos$;
* solar elevation, clear-sky irradiance, measured PV and a PV-valid flag.

All watts, volts and amps are taken as absolute values. The input is z-scored
with the norm file that ships with the model.

**Heads.** 22 in total.

* **Panel 1:** heat_pump, solar_pump, jacuzzi_pump, strip_heater.
* **Panel 2:** water_heater, hair_dryer, sprinklers, bath_lights.
* **Panel 3:** dryer, washing_machine, dishwasher, microwave, pressure_pump,
  refrigerator, garage_fridge, garage_freezer, computers, tv_stereo, oven,
  cooktop, counter_appliance, garage_opener.

**Architecture.** Two bidirectional LSTM layers (32, then 16 units per
direction) feed an MLP per head (dropout 0.2, 32 to 16 to 1, sigmoid). Panel 3
has a convolutional stem and a separate BiLSTM branch per head, so the fridge's
slow cycling, the dishwasher's stages and the microwave's bursts do not compete
for shared parameters.

**Rolling walk-forward training** (`train_rolling.py`, $K=4$ chronological
folds over windows):

1. for stage $k$, train on folds $0..k-1$, warm-started from the previous stage;
2. predict fold $k$ **before** training on it. These are the per-fold metrics,
   so every reported number comes from a model that had not seen that data;
3. pseudo-label only the windows where the physics labeller abstained, then add
   fold $k$ to the training pool;
4. finish with one consolidation epoch on all folds, then calibrate each head's
   threshold on the last fold's rolling predictions.

**Loss.** A masked, confidence-weighted binary cross-entropy, with
$\text{pos\_weight}$ capped at 200. Heads whose positive weight reaches 50 or
more switch to focal loss (Lin et al., 2017):

$$
\mathcal{L}_{\text{BCE}}=-\frac{\sum_i w_i\big[p_w\,y_i\log p_i+(1-y_i)\log(1-p_i)\big]}{\sum_i w_i},
\qquad
\mathcal{L}_{\text{focal}}=-\alpha(1-p_t)^{\gamma}\log p_t,\ \ \gamma=2,\ \alpha=0.25 .
$$

**Optimiser.** AdamW, learning rate $10^{-3}$, weight decay $10^{-4}$, batch
256, 6 epochs for the first stage and 3 for each rolling stage. On the GX10 it
runs on CUDA (`DEVICE=cuda`).

**Export.** `export_physical.py` writes ONNX with the TorchScript exporter
(`dynamo=False`). The dynamo exporter baked batch 1 into the LSTM reshapes. The
export is checked at batch 64, and any external data file is folded back into
the `.onnx`.

**Production gating.** Calibrated thresholds, a power gate from
`rules_additive.APPLIANCE_SIGNATURE` (an appliance cannot be ON if the panel is
below its signature), and the mutual-exclusion groups. This gated output is
what the dashboards showed, so it is also the teacher in section 4.

**Result on the GX10** (last unseen fold): Panel 1 heat pump F1 0.932.

---

## 4. Nemotron 3.5 Lightning as the NILM engine

### 4.1 Why an LLM, and why distillation

Nemotron 3.5 Lightning 30B-A3B is a hybrid Mamba-2 / mixture-of-experts model
(NemotronH) with about 3B parameters active per token. As the NILM engine it can
use context the BiLSTM cannot: other panels, leg currents, the sun and the
appliance list. It answers in text that can be audited, and the same model
family serves the Ask tab. The labels have no ground truth, so Nemotron is not
trained on raw labels. It is **distilled from the gated BiLSTM** (Hinton et al.,
2015). It learns to reproduce the decision production makes, and so inherits
the physics and the rolling validation behind it.

### 4.2 Prompt and answer contract

`services/iems/inference/nemotron_prompt.py` is imported by both training
(`gx10/nemotron/build_sft.py`) and inference (`nemotron_engine.py`), so the text
is identical byte for byte. For one panel window the user message holds:

* the panel name and a one-line description of its appliances;
* the window length, the local hour and the sample to decide;
* the panel's own watts at every second sample (50 values);
* its mean, median, min, max, the value at the middle sample, the number of
  edges over 100 W and the largest step;
* the other two panels, grid and shop (mean and max);
* the leg currents and VrmsA;
* sun elevation, clear-sky irradiance and measured PV;
* the list of appliances, in head order.

The system message asks for one line per appliance, `name=ON` or `name=OFF`.
Reasoning is off (`enable_thinking: false`) in training and serving. The parser
also accepts pairs separated by commas or semicolons on one line, and drops a
`<think>` block if one appears.

### 4.3 Supervised data

`build_sft.py` runs the gated teacher over the archive windows and writes OpenAI
`messages` JSONL per panel: 2,000 windows per panel on the GX10 (6,000 base
examples), with a validation split by time. Each round adds a fixed 1,500-slot
replay buffer of **hard examples**. These are windows from a training probe that
the previous round got wrong, oversampled for the weakest heads. Hard examples
are never taken from validation.

### 4.4 LoRA fine-tuning with NVIDIA NeMo AutoModel

The recipe is `gx10/nemotron/lora_nilm.yaml`, derived from AutoModel's
single-GPU Nemotron 3.5 Lightning LoRA recipe, which NVIDIA runs in CI on a GB10.
The image is `nvcr.io/nvidia/nemo-automodel:26.08.00`.

$$
W=W_0+\frac{\alpha}{r}BA,\qquad r=16,\ \alpha=32 .
$$

| setting | value |
|---|---|
| base | `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16` |
| adapter targets | Mamba `in_proj`, attention `q,k,v,o`, shared experts, `lm_head` (101 modules); Mamba `out_proj` excluded |
| batch | global 16 (local 2 × 8 gradient accumulation), sequence 1,536 |
| optimiser | AdamW, $\beta=(0.9,0.95)$, weight decay 0.01, $\eta_{\max}=10^{-4}$ |
| schedule | 20 warmup steps, then one cosine to $\eta_{\min}=10^{-5}$ over $T=2000$ steps across **all** rounds |
| memory | activation checkpointing, memory-efficient LoRA, about 67 GiB during training |
| speed | about 15 s per step on the GB10 |

$$
\eta_t=\eta_{\min}+\tfrac12(\eta_{\max}-\eta_{\min})\Big(1+\cos\frac{\pi t}{T}\Big).
$$

AutoModel restores the scheduler state with the checkpoint, and by default the
restored values win over the config. The first run decayed over round 1 only,
so round 2 sat at $10^{-5}$. The config now sets `override_opt_param_scheduler:
true` and `use_checkpoint_opt_param_scheduler: false`, and round 2 resumed at
$9.25\times10^{-5}$.

### 4.5 Recurrent rounds supervised by a Nemotron agent

`gx10/nemotron/recurrent_rounds.py` runs each round:

1. build the round set: 6,000 base examples plus the 1,500-slot replay of hard
   examples, weighted by the current boosts;
2. continue the same LoRA run to the round's step target;
3. merge the adapter into the BF16 base with the PEFT path, using the AutoModel
   install that trained it;
4. serve the merged model with vLLM and score the held-out windows;
5. re-score a training probe and keep its misses as the next hard examples;
6. ask the monitor for a decision.

The monitor (`monitor.py`) is Nemotron 3.5 Lightning in the local Ollama, called
through `gx10/nemotron/agent_with_ollama.sh`. That script starts Ollama only for
the decision and stops it again, because the 26 GB chat model and the 30B
training run do not fit in memory together. The agent receives the metric
history and its budget, and replies with `continue` or `stop`, a reason, the
next step count and per-head boosts. Boosts naming an unknown panel or head are
discarded and replaced by the rules. A budget guard always applies. The rule
fallback stops at agreement 0.985 or on a gain under 0.002, and otherwise
boosts each head with teacher F1 below 0.8:

$$
b_h=1+3\,\frac{0.8-F1_h}{0.8}.
$$

### 4.6 What is measured

The metric is agreement with the gated teacher on held-out windows:

$$
\text{agree}_h=\frac1N\sum_{i=1}^{N}\mathbb 1\big[\hat y_{h,i}=y^{T}_{h,i}\big].
$$

The report also gives precision, recall and F1 against the teacher and against
the physics labels, and counts unanswered heads. Agreement with the teacher is
not submetered accuracy, and is never presented as such.

### 4.7 Results (2026-10-11, 100 held-out windows per panel)

| | round 1 | round 2 (live) |
|---|---|---|
| LoRA steps | 350 | 400 |
| overall agreement | 0.8214 | **0.9191** |
| Panel 1 (HVAC) | 0.912 | 0.938 |
| Panel 2 (H2O) | 0.787 | 0.945 |
| Panel 3 (Kitchen) | 0.805 | 0.906 |

Per head, agreement (and teacher F1):

| head | round 1 | round 2 |
|---|---|---|
| solar_pump | 0.65 (0.41) | 0.75 (0.78) |
| water_heater | 0.95 (0.93) | 1.00 (1.00) |
| hair_dryer | 0.64 (0.31) | 1.00 (1.00) |
| sprinklers | 0.72 (0.00) | 0.97 (0.95) |
| bath_lights | 0.84 (0.87) | 0.81 (0.86) |
| washing_machine | 0.78 (0.61) | 0.93 (0.91) |
| dishwasher | 0.86 (0.70) | 0.94 (0.91) |
| microwave | 0.75 (0.56) | 0.94 (0.93) |
| refrigerator | 0.79 (0.00) | 0.83 (0.26) |
| garage_fridge | 0.64 (0.00) | 0.76 (0.48) |
| garage_freezer | 0.67 (0.20) | 0.75 (0.47) |
| computers | 0.81 (0.58) | 0.93 (0.88) |
| tv_stereo | 0.79 (0.51) | 0.96 (0.93) |
| cooktop | 0.85 (0.62) | 0.96 (0.93) |
| counter_appliance | 0.80 (0.55) | 0.93 (0.90) |
| garage_opener | 0.81 (0.54) | 0.88 (0.82) |

heat_pump, jacuzzi_pump, strip_heater, dryer, pressure_pump and oven were at or
near 1.00 agreement in both rounds. No head went unanswered. Round 1 was scored
with vLLM on the BF16 merge, and round 2 with llama.cpp on the Q8_0 GGUF that
serves production. Q8_0 matched BF16 on 166 of 176 head decisions in round 1.
The refrigerator, garage fridge and garage freezer remain the weakest heads.

### 4.8 Serving and fallback

The merged model is converted to GGUF Q8_0 (33.6 GB) and served by llama.cpp
(`~/nilm/llama.cpp`, built for CUDA arch 121) as the systemd unit
`nilm-nemotron` on :8011, alias `nilm`. It runs with 3 parallel slots and
temperature 0. With `NILM_ENGINE=nemotron`, `iems-inference` sends one request
per panel per 30 s tick, about 1.5 s each. A head the model does not answer, or
a tick where the server is unreachable, falls back to that head's BiLSTM. The
written row's model field records which engine decided. The postprocess gates
and the panel rules run after either engine.

`gx10/nemotron/deploy_round.sh` does the production swap after training stops:

* `merge` folds the newest checkpoint into the base;
* `convert` writes the Q8_0 GGUF;
* `swap` keeps the previous model as `.prev.gguf`, restarts `nilm-nemotron` and
  starts Ollama;
* `score` serves the previous model on :8012 beside the live one and compares
  them with `compare_rounds.py`.

`GATE=1` makes `swap` refuse a model that scores worse.

### 4.9 Running the pipeline

`gx10/nemotron/run_on_gx10.sh` drives `box_pipeline.sh`. The stages are
resumable, and each writes `~/nilm/state/<stage>.done`:

| stage | work |
|---|---|
| 10_dataset | archive and export merged into the training parquet |
| 20_relabel | physics labeller v2 over the full history |
| 30_bilstm | rolling BiLSTM per panel on CUDA, then ONNX export |
| 40_sft | teacher pass, chat JSONL per panel, small validation file |
| 50_rounds | recurrent LoRA rounds with the monitor |
| 60_gguf | merged model to GGUF Q8_0 |

Training needs the live `nilm-nemotron` (about 34 GB) and the Ollama chat model
(about 26 GB) stopped. Model load peaks near 119 GB. While training runs, the
dashboards stay up on the BiLSTM fallback.

---

## 5. Power and battery forecasting (`gx10/forecast/`)

**Targets.**

* **Power:** Panel1 (HVAC), Panel2 (H2O), Panel3 (Kitchen), Grid (signed), Shop,
  Generac and measured Solar PV, as 15 min mean watts for the next 24 h (96
  steps).
* **Battery:** state of charge and battery sensor temperature, by a separate
  battery model.

**Inputs.**

* the last 24 h of all signals, with missingness flags;
* PV, battery, SOC and inverter readings;
* future local time, day and year;
* NOAA approximate sun elevation;
* GFS temperature, cloud cover, shortwave irradiance and wind.

Archived future covariates use Open-Meteo `_previous_day2`, forecasts issued 48
h before the valid time, so no realised future weather enters a backtest. A 15
min bin needs 60% inter-sample support, and a full window needs 80% meter
coverage.

**Candidates.**

* **TiDE-inspired network** (Das et al., 2023). A residual dense encoder with
  two residual blocks of width 128 runs over the 96-step history and
  missingness masks. A future-covariate projection of width 16 and a temporal
  decoder of width 64 predict a residual added to the daily pattern. It trains
  jointly over channels on the GB10 in seconds, with about 95 MB peak GPU
  allocation.
* **CUDA XGBoost** (Chen and Guestrin, 2016). Direct multi-horizon regression on
  recent observation summaries, daily and weekly lags, future weather, calendar
  features and the horizon index.
* **Baselines and blend:** persistence, daily and weekly seasonal baselines, and
  a fixed XGBoost/daily blend.

**Selection, chronologically.** The final 42 days are three disjoint 14-day
blocks: selection, calibration and test. Training windows end before selection
begins. Standardisation is fitted on training data only. Each channel keeps the
candidate with the lowest validation MAE. As captured on 2026-10-11:

* HVAC and grid: XGBoost/daily blend
* H2O and kitchen: TiDE
* shop and generator: XGBoost
* PV: daily baseline

For the battery, SOC uses the daily baseline (test MAE 2.33 percentage points)
and temperature uses TiDE (2.75 °F).

**Intervals.** For horizon $h$ and channel $c$ the band is
$\hat y\pm q_{0.8}\big(|y-\hat y|\big)$ over the calibration block. Test coverage
is shown on every chart, even when it is below 80%.

**Weather-aware XGBoost view.** A second view in the Predictions tab fits CUDA
XGBoost with the live GFS forecast as inputs for every channel. It is labelled
experimental and uncalibrated, and has no bands.

**Recurrent learning.** The timer `iems-power-relearn.timer` runs every 20
minutes on the GX10. It refreshes the verified history, trains new power and
battery candidates on the GPU, and scores old and new on the same new
validation origins. A candidate is promoted, by an atomic champion pointer swap,
only if it improves normalised MAE by at least 1%. On 2026-10-11 at 12:00 PT the
battery candidate was promoted (0.1897 to 0.1852). The power candidate was kept
out (0.2180 vs 0.2176), so the 10:10 PT power champion stayed. Feedback
corrections wait for 24 completed target times per base version.

---

## 6. Appliance-usage forecaster (`~/iems` on the GX10)

For every appliance and every 15 min step of the next 24 h it predicts:

* $P(\text{on})$;
* the expected on-fraction;
* energy quantiles at p10, p50 and p90, with pinball loss.

Three families train in parallel while the server keeps answering: a
transformer (GPU worker, capped near 8 GB), LightGBM (CPU worker) and a
climatology baseline. Each version is backtested on the same rows. The best
version of each family forms an ensemble:

$$
w_m=\frac{e^{-\mathrm{BS}_m}}{\sum_j e^{-\mathrm{BS}_j}},\qquad
\mathrm{BS}=\frac1N\sum_i (p_i-y_i)^2 .
$$

The ensemble is promoted (`rev+1`) only if it beats the champion by a margin.
The server loads and warms the new members in a background thread before
swapping a pointer, so there is no downtime. The live champion is revision 21
(LightGBM): Brier 0.0857, skill 0.157 over climatology. Its trainer has been
idle since the replayed history reached 2026-10-09. The service runs on :8765,
outside this repository.

---

## 7. Decision support (`gx10/forecast/smart_dss.py`)

The scheduler places optional heavy cycles $j$ (dishwasher, washer, dryer) at
start times $s_j$. It minimises the added grid-import cost under the time of use
tariff:

$$
\min_{\{s_j\}}\ \sum_t \pi_t\,\max\Big(0,\ \hat g^{\,\text{upper}}_t+\sum_j e_j(t-s_j)-\widehat{\text{PV}}_t\Big)
$$

The constraints are:

* daytime windows from 8 AM to 9 PM;
* one optional heavy cycle at a time;
* washer before dryer, within two hours;
* predicted SOC at or above 30%.

It enumerates job orders and solves each by dynamic programming. The dollar
figures are configured-cycle tariff scenarios, not observed savings. Export
credits and account adjustments are unknown, so the planner does not claim
full bill optimisation.

---

## 8. Readiness and prepare mode (`services/iems/web/readiness.js`)

Every 300 s the readiness monitor reads three sources:

* Open-Meteo 24 h temperature and wind;
* NWS active alerts for the point;
* PG&E's public aggregate outage and PSPS weather feeds.

Prepare mode is triggered by any of these:

* customers affected in Los Gatos;
* a Santa Clara County PSPS elevated, watch or warning level;
* a severe or extreme NWS alert, or a fire, wind, flood or thunderstorm alert;
* forecast gusts of 35 mph or more.

Heat of 95 °F or more adds cooling advice. Prepare mode suppresses optional
schedules and turns advice toward keeping the battery full. A failed source is
"unknown", never "no outage". No device command is ever issued.

---

## 9. Ask (`services/iems/backend/iems_ask.py`)

Ask answers questions from a context built out of live meter, solar and
appliance data, using Nemotron 3.5 Lightning in the local Ollama. Each answer
shows the model, its latency and its token count. The answer includes a
consistency check. When the appliances reported ON for a panel do not add up to
its measured power, the answer says that ON list is not reliable.

---

## 10. System map (`gx10/knowledge/`)

`build_graph.py` builds a verified graph from the deployment itself, with 73
nodes and 103 verified relationships on 2026-10-11. The nodes are hardware,
external sources, datasets, services, models, meters, meter channels and
appliances. Relationships extracted from the documentation by NVIDIA txt2kg, using
`llama3.2:1b` in Ollama with ArangoDB storage, are kept separate as inferred
(24 on 2026-10-11). Selecting a node opens its live evidence:

* **GPU:** utilisation, temperature and power;
* **collector:** feed health;
* **meter:** every reading;
* **panel:** measured history and its 24 h forecast;
* **appliance:** the NILM estimate, confidence and nominal power.

---

## References

1. G. W. Hart, "Nonintrusive appliance load monitoring," Proc. IEEE 80(12), 1992.
2. J. Kelly and W. Knottenbelt, "Neural NILM," BuildSys 2015. arXiv:1507.06594.
3. A. Graves and J. Schmidhuber, "Framewise phoneme classification with bidirectional LSTM," Neural Networks 18, 2005.
4. T.-Y. Lin et al., "Focal loss for dense object detection," ICCV 2017. arXiv:1708.02002.
5. G. Hinton, O. Vinyals and J. Dean, "Distilling the knowledge in a neural network," 2015. arXiv:1503.02531.
6. E. J. Hu et al., "LoRA: Low-rank adaptation of large language models," ICLR 2022. arXiv:2106.09685.
7. A. Gu and T. Dao, "Mamba," 2023. arXiv:2312.00752.
8. N. Shazeer et al., "Sparsely-gated mixture-of-experts," ICLR 2017. arXiv:1701.06538.
9. NVIDIA, "Nemotron-H," 2025. arXiv:2504.03624.
10. A. Das et al., "Long-term forecasting with TiDE," TMLR 2023. arXiv:2304.08424.
11. T. Chen and C. Guestrin, "XGBoost," KDD 2016. arXiv:1603.02754.
12. G. Ke et al., "LightGBM," NeurIPS 2017.
13. G. W. Brier, "Verification of forecasts expressed in terms of probability," Monthly Weather Review 78(1), 1950.
14. Open-Meteo previous runs API, https://open-meteo.com/en/docs/previous-runs-api
15. NVIDIA txt2kg, https://build.nvidia.com/spark/txt2kg
