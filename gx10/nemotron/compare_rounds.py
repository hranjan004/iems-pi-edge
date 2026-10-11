#!/usr/bin/env python3
"""Compare two eval_nemotron.py reports (same held-out windows): overall and
per-panel agreement with the gated BiLSTM teacher, and every head that moved.

  python3 gx10/nemotron/compare_rounds.py prev/metrics.json new/metrics.json --out gate.json
"""
from __future__ import annotations

import argparse
import json


def panel_agree(heads: dict) -> float:
    return round(sum(h["agree"] for h in heads.values()) / max(len(heads), 1), 4)


def compare(prev: dict, new: dict) -> dict:
    out = {"overall": {"prev": prev["agreement"], "new": new["agreement"]}, "panels": {}}
    for p, heads in prev["panels"].items():
        nh = new["panels"].get(p, {})
        out["panels"][p] = {
            "prev": panel_agree(heads), "new": panel_agree(nh) if nh else None,
            "heads": {h: {"prev": v["agree"], "new": nh[h]["agree"]}
                      for h, v in heads.items() if h in nh},
        }
    out["new_not_worse"] = new["agreement"] >= prev["agreement"]
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("prev"); ap.add_argument("new"); ap.add_argument("--out")
    a = ap.parse_args()
    res = compare(json.load(open(a.prev)), json.load(open(a.new)))
    if a.out:
        json.dump(res, open(a.out, "w"), indent=2)
    print(f"overall agreement: previous {res['overall']['prev']:.4f}  new {res['overall']['new']:.4f}")
    for p, d in res["panels"].items():
        moved = {h: v for h, v in d["heads"].items() if v["prev"] != v["new"]}
        print(f"panel {p}: previous {d['prev']}  new {d['new']}  heads moved: "
              + (", ".join(f"{h} {v['prev']:.2f}->{v['new']:.2f}" for h, v in moved.items()) or "none"))
    print("new model not worse:", res["new_not_worse"])


if __name__ == "__main__":
    main()
