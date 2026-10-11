#!/usr/bin/env python3
"""Distillation data for Nemotron: BiLSTM teacher -> chat JSONL, per panel.

For every 100-sample window (stride 10, the train_rolling.py contract) this
rebuilds the exact 18 feature frame the trainer used, runs the retrained
BiLSTM ONNX model for that panel as the teacher, and records the physical
label at the window middle. Each kept window becomes one chat example whose
prompt is nemotron_prompt.build_messages() and whose answer is the teacher's
per-head state, so Nemotron learns to reproduce the BiLSTM.

The teacher is what production decides from the window, not the raw network:
the BiLSTM state at its calibrated threshold, then the same mutual exclusion
and power gate rules_additive applies (the BiLSTM is recall-biased by design
and relies on that gate to remove impossible ONs), with the panel draw taken
at the window middle where the label sits.

Target selection (TARGET env)
  teacher   gated BiLSTM state                                     (default)
  physical  the physics label where it exists, teacher elsewhere
Sampling keeps every window where any head is ON (rare heads first), plus an
equal share of all-OFF windows, chronologically split: the last VAL_FRAC of
windows is validation and never trained on.

Outputs  gx10/data/sft/{train,val}.jsonl, panel{N}_{train,val}.jsonl,
         gx10/data/sft/val_meta.parquet (teacher + physical per val example),
         gx10/data/sft/census.json
Env      EGAUGE_PARQUET SOLAR_PARQUET LABELS_NAME TARGET MAX_PER_PANEL VAL_FRAC
         EXTRA_WEIGHTS (json {panel: {head: factor}}, used by recurrent rounds)
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "services"))
sys.path.insert(0, str(REPO / "services/iems/training"))
from iems.inference.nemotron_prompt import build_messages, format_answer, PANEL_NAME  # noqa: E402
from solar_features import solar_frame  # noqa: E402
from iems.inference.rules_additive import APPLIANCE_SIGNATURE, MUTEX_GROUPS  # noqa: E402

EG = os.environ.get("EGAUGE_PARQUET", "gx10/data/egauge_gx10.parquet")
SOL = os.environ.get("SOLAR_PARQUET", "gx10/data/solar_gx10.parquet")
LAB = os.environ.get("LABELS_NAME", "labels_physical_v2.parquet")
TARGET = os.environ.get("TARGET", "teacher")
MAX_PER_PANEL = int(os.environ.get("MAX_PER_PANEL", "9000"))
VAL_FRAC = float(os.environ.get("VAL_FRAC", "0.15"))
EXTRA = json.loads(os.environ.get("EXTRA_WEIGHTS", "{}") or "{}")
OUT = Path(os.environ.get("SFT_DIR", "gx10/data/sft"))
W, STRIDE, MID = 100, 10, 50
OWN = {1: "Panel1 (HVAC)", 2: "Panel2 (H2O)", 3: "Panel3 (Kitchen)"}
TAIL = ["Panel1 (HVAC)", "Panel2 (H2O)", "Panel3 (Kitchen)", "VrmsA", "VrmsB", "I31",
        "I32", "F1", "Grid Power", "Shop", "I11", "I21"]


def feature_frame(panel: int, piv: pd.DataFrame, idx: pd.DatetimeIndex) -> pd.DataFrame:
    """Same construction as train_rolling.py (column order, abs, fills, tod, solar)."""
    F = pd.DataFrame(index=idx)
    for c in [OWN[panel]] + TAIL:
        F[c] = piv[c].abs().values if c in piv.columns else 0.0
    F = F.ffill().bfill().fillna(0.0)
    lh = idx.tz_localize("UTC").tz_convert("America/Los_Angeles").hour if idx.tz is None \
        else idx.tz_convert("America/Los_Angeles").hour
    F["tod_sin"] = np.sin(2 * np.pi * lh / 24)
    F["tod_cos"] = np.cos(2 * np.pi * lh / 24)
    S = solar_frame(idx, SOL)
    for c in S.columns:
        F[c] = S[c].values
    return F


def window_starts(idx: pd.DatetimeIndex) -> np.ndarray:
    dt = np.diff(idx.values).astype("timedelta64[s]").astype(float)
    brk = np.r_[0, np.where(dt > 60)[0] + 1, len(idx)]
    out = []
    for a, b in zip(brk[:-1], brk[1:]):
        if b - a >= W:
            out.extend(range(a, b - W + 1, STRIDE))
    return np.array(out)


def teacher_probs(panel: int, Fv: np.ndarray, starts: np.ndarray, norm: dict) -> dict:
    import onnxruntime as ort
    sess = ort.InferenceSession(str(REPO / f"services/iems/models/nilm_panel{panel}.onnx"),
                                providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
    mean, std = np.array(norm["mean"], "float32"), np.array(norm["std"], "float32")
    Z = ((Fv - mean) / std).astype("float32")
    outs = [o.name for o in sess.get_outputs()]
    probs = {h: np.empty(len(starts), "float32") for h in norm["heads"]}
    for a in range(0, len(starts), 2048):
        s = starts[a:a + 2048]
        X = np.stack([Z[i:i + W] for i in s])
        res = sess.run(None, {"window": X})
        for h in norm["heads"]:
            probs[h][a:a + len(s)] = np.asarray(res[outs.index(f"p_{h}")]).reshape(-1)
    return probs


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    print(f"[sft] loading {EG}", flush=True)
    d = pd.read_parquet(EG, columns=["ts", "channel", "w"])
    piv = d.pivot_table(index="ts", columns="channel", values="w", aggfunc="first",
                        observed=False)
    L = pd.read_parquet(REPO / "services/iems/training/data" / LAB)
    idx = L.index
    piv = piv.reindex(idx)
    starts = window_starts(idx)
    n_val0 = int(len(starts) * (1 - VAL_FRAC))
    rng = np.random.default_rng(0)
    census, all_train, all_val, meta = {}, [], [], []

    for panel in (1, 2, 3):
        norm = json.loads((REPO / f"services/iems/models/panel{panel}_norm_bilstm.json").read_text())
        heads, thr = norm["heads"], norm.get("thresholds", {})
        F = feature_frame(panel, piv, idx)
        assert list(F.columns) == norm["features"], "feature order drifted from the norm file"
        Fv = F.to_numpy("float32")
        drift = float(np.abs(Fv.mean(0) - np.array(norm["mean"])).max())
        print(f"[sft] panel{panel}: {len(starts):,} windows, mean drift vs norm {drift:.4f}", flush=True)
        P = teacher_probs(panel, Fv, starts, norm)
        mid = starts + MID
        T = {h: (P[h] >= float(thr.get(h, 0.5))).astype(int) for h in heads}
        # mutual exclusion: highest-probability ON member of each group wins
        for group in MUTEX_GROUPS:
            g = [h for h in group if h in heads]
            if len(g) > 1:
                pm = np.stack([np.where(T[h] == 1, P[h], -1.0) for h in g])
                win = pm.argmax(0)
                for k, h in enumerate(g):
                    T[h] = np.where((T[h] == 1) & (win != k), 0, T[h])
        # power gate on the measured draw around the window middle
        pmid = np.array([Fv[i + MID - 5:i + MID + 5, 0].mean() for i in starts])
        for h in heads:
            sig = APPLIANCE_SIGNATURE.get(h)
            if sig:
                T[h] = np.where(pmid + 120.0 < sig[0], 0, T[h])
        phys = {h: (L[h].to_numpy("float32")[mid] if h in L.columns
                    else np.full(len(mid), np.nan, "float32")) for h in heads}
        Y = {}
        for h in heads:
            y = T[h].copy()
            if TARGET == "physical":
                m = ~np.isnan(phys[h]); y[m] = phys[h][m].astype(int)
            Y[h] = y

        # sampling: rare-positive windows first, then all-OFF fill
        anyon = np.zeros(len(starts), bool)
        score = np.zeros(len(starts))
        boost = EXTRA.get(str(panel), {})
        for h in heads:
            on = Y[h] == 1
            anyon |= on
            rate = max(on.mean(), 1e-4)
            score += on * (1.0 / rate) * float(boost.get(h, 1.0))
        cand_tr = np.arange(n_val0)
        cand_va = np.arange(n_val0 + W // STRIDE, len(starts))   # gap so windows never overlap
        def pick(cands, budget):
            pos = cands[anyon[cands]]
            neg = cands[~anyon[cands]]
            k_pos = min(len(pos), int(budget * 0.7))
            p = score[pos] / score[pos].sum() if len(pos) else None
            sel_pos = rng.choice(pos, size=k_pos, replace=False, p=p) if k_pos else np.array([], int)
            k_neg = min(len(neg), budget - k_pos)
            sel_neg = rng.choice(neg, size=k_neg, replace=False) if k_neg else np.array([], int)
            return np.sort(np.r_[sel_pos, sel_neg]).astype(int)
        tr = pick(cand_tr, MAX_PER_PANEL)
        va = pick(cand_va, max(300, MAX_PER_PANEL // 10))

        def rows(sel, split):
            out = []
            for j in sel:
                i = starts[j]
                msgs = build_messages(panel, Fv[i:i + W], norm["features"], heads)
                st = {h: int(Y[h][j]) for h in heads}
                out.append({"messages": msgs + [{"role": "assistant",
                                                 "content": format_answer(st, heads)}],
                            "chat_template_kwargs": {"enable_thinking": False}})
                if split == "val":
                    meta.append({"panel": panel, "ts": str(idx[i + MID]),
                                 **{f"t_{h}": int(T[h][j]) for h in heads},
                                 **{f"y_{h}": (None if np.isnan(phys[h][j]) else int(phys[h][j]))
                                    for h in heads}})
            return out
        r_tr, r_va = rows(tr, "train"), rows(va, "val")
        for name, rr in ((f"panel{panel}_train.jsonl", r_tr), (f"panel{panel}_val.jsonl", r_va)):
            with open(OUT / name, "w") as f:
                for r in rr:
                    f.write(json.dumps(r) + "\n")
        all_train += r_tr; all_val += r_va
        census[panel] = {"heads": heads, "train": len(r_tr), "val": len(r_va),
                         "teacher_on_rate": {h: round(float(T[h].mean()), 4) for h in heads},
                         "train_on": {h: int(T[h][tr].sum()) for h in heads}}
        print(f"[sft] panel{panel}: train {len(r_tr)} val {len(r_va)} "
              f"on-rates {census[panel]['teacher_on_rate']}", flush=True)

    rng.shuffle(all_train)
    for name, rr in (("train.jsonl", all_train), ("val.jsonl", all_val)):
        with open(OUT / name, "w") as f:
            for r in rr:
                f.write(json.dumps(r) + "\n")
    pd.DataFrame(meta).to_parquet(OUT / "val_meta.parquet")
    (OUT / "census.json").write_text(json.dumps({"target": TARGET, **census}, indent=2))
    print(f"[sft] wrote {len(all_train)} train / {len(all_val)} val examples -> {OUT}", flush=True)


if __name__ == "__main__":
    main()
