#!/usr/bin/env python3
"""Score a Nemotron NILM model on the held-out windows.

Sends every validation prompt (gx10/data/sft/val.jsonl) to an OpenAI-compatible
endpoint (vLLM on the training box, llama.cpp or Ollama on the GX10), parses the
name=ON/OFF lines and reports, per panel and head,

  agreement with the BiLSTM teacher  (what the model was trained to copy)
  precision / recall / F1 vs teacher
  precision / recall / F1 vs the physical label, where one exists
  format failures (heads the model did not answer)

Validation windows are only ever scored. Hard examples for the next recurrent
round are mined with --mine from a probe sample of the TRAINING set (the
expected answer is the example's own assistant turn), so nothing from the
validation split can leak back into training.

  python3 gx10/nemotron/eval_nemotron.py --url http://127.0.0.1:8000/v1 \
      --model nilm --out gx10/data/rounds/r1
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pandas as pd

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "services"))
from iems.inference.nemotron_prompt import parse_answer, PANEL_OF  # noqa: E402

MIN_POS = 20


def ask(url: str, model: str, messages: list, timeout: float = 120) -> str:
    body = {"model": model, "messages": messages, "temperature": 0.0, "max_tokens": 256,
            "chat_template_kwargs": {"enable_thinking": False}}
    req = urllib.request.Request(url.rstrip("/") + "/chat/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())["choices"][0]["message"].get("content") or ""


def prf(pred, true):
    tp = sum(1 for p, t in zip(pred, true) if p == 1 and t == 1)
    fp = sum(1 for p, t in zip(pred, true) if p == 1 and t == 0)
    fn = sum(1 for p, t in zip(pred, true) if p != 1 and t == 1)
    P = tp / max(tp + fp, 1); R = tp / max(tp + fn, 1)
    return P, R, 2 * P * R / max(P + R, 1e-9), tp + fn


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8000/v1")
    ap.add_argument("--model", default="nilm")
    ap.add_argument("--sft", default="gx10/data/sft")
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0, help="per panel, 0 = all")
    ap.add_argument("--workers", type=int, default=32)
    ap.add_argument("--mine", type=int, default=0,
                    help="also score N random training examples and write the misses")
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    if a.mine:
        mine(a, out)

    rows = [json.loads(l) for l in open(Path(a.sft) / "val.jsonl")]
    meta = pd.read_parquet(Path(a.sft) / "val_meta.parquet")
    assert len(rows) == len(meta), "val.jsonl and val_meta.parquet are out of step"
    if a.limit:
        keep = meta.groupby("panel").head(a.limit).index
        rows = [rows[i] for i in keep]; meta = meta.loc[keep].reset_index(drop=True)

    prompts = [r["messages"][:-1] for r in rows]
    t0 = time.time()
    with ThreadPoolExecutor(a.workers) as ex:
        answers = list(ex.map(lambda m: _safe(a.url, a.model, m), prompts))
    dt = time.time() - t0

    report = {"n": len(rows), "seconds": round(dt, 1),
              "per_window_s": round(dt / max(len(rows), 1) * a.workers, 3), "panels": {}}
    agg_agree, agg_n = 0, 0
    for panel in sorted(meta["panel"].unique()):
        sel = meta.index[meta["panel"] == panel]
        heads = [c[2:] for c in meta.columns if c.startswith("t_")
                 and meta.loc[sel, c].notna().any()]
        heads = [h for h in heads if h in rows[sel[0]]["messages"][1]["content"]]
        parsed = [parse_answer(answers[i], heads) for i in sel]
        ph = {}
        for h in heads:
            pred = [p[h] for p in parsed]
            teach = meta.loc[sel, f"t_{h}"].astype(int).tolist()
            agree = sum(1 for p, t in zip(pred, teach) if p == t)
            agg_agree += agree; agg_n += len(pred)
            P, R, F1, npos = prf(pred, teach)
            phys = meta.loc[sel, f"y_{h}"]
            m = phys.notna().to_numpy()
            if m.sum():
                pp = [p for p, k in zip(pred, m) if k]
                Pp, Rp, F1p, nposp = prf(pp, phys[m].astype(int).tolist())
            else:
                Pp = Rp = F1p = None; nposp = 0
            ph[h] = {"agree": round(agree / len(pred), 4),
                     "teacher": {"P": round(P, 3), "R": round(R, 3), "F1": round(F1, 3),
                                 "n_pos": npos} if npos >= MIN_POS else {"n_pos": npos, "F1": None},
                     "physical": {"P": None if Pp is None else round(Pp, 3),
                                  "R": None if Rp is None else round(Rp, 3),
                                  "F1": None if F1p is None else round(F1p, 3),
                                  "n_pos": nposp},
                     "unanswered": sum(1 for p in pred if p is None)}
        report["panels"][int(panel)] = ph
    report["agreement"] = round(agg_agree / max(agg_n, 1), 4)
    (out / "metrics.json").write_text(json.dumps(report, indent=2))
    with open(out / "answers.jsonl", "w") as f:
        for i, ans in enumerate(answers):
            f.write(json.dumps({"i": i, "answer": ans}) + "\n")
    print(json.dumps({"agreement": report["agreement"], "n": report["n"],
                      "seconds": report["seconds"]}))


def mine(a, out: Path) -> None:
    """Score a random training probe; misses become next round's hard examples."""
    import random
    rows = [json.loads(l) for l in open(Path(a.sft) / "train.jsonl")]
    random.Random(len(list(out.parent.glob("r*")))).shuffle(rows)
    rows = rows[:a.mine]
    with ThreadPoolExecutor(a.workers) as ex:
        answers = list(ex.map(lambda r: _safe(a.url, a.model, r["messages"][:-1]), rows))
    hard, per_head = [], {}
    for r, ans in zip(rows, answers):
        exp_txt = r["messages"][-1]["content"]
        heads = [l.split("=")[0] for l in exp_txt.splitlines()]
        exp, got = parse_answer(exp_txt, heads), parse_answer(ans, heads)
        wrong = [h for h in heads if got[h] != exp[h]]
        for h in wrong:
            per_head[h] = per_head.get(h, 0) + 1
        if wrong:
            hard.append({"messages": r["messages"],
                         "chat_template_kwargs": r.get("chat_template_kwargs", {}),
                         "_wrong": wrong})
    with open(out / "hard_examples.jsonl", "w") as f:
        for r in hard:
            f.write(json.dumps(r) + "\n")
    (out / "mine.json").write_text(json.dumps({"probe": len(rows), "missed": len(hard),
                                               "misses_by_head": per_head}, indent=2))
    print(json.dumps({"probe": len(rows), "missed": len(hard)}))


def _safe(url, model, m):
    for attempt in range(3):
        try:
            return ask(url, model, m)
        except Exception as e:  # noqa: BLE001
            err = str(e); time.sleep(2 * (attempt + 1))
    return f"ERROR {err}"


if __name__ == "__main__":
    main()
