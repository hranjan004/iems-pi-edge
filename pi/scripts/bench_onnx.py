#!/usr/bin/env python3
"""Benchmark the deployed NILM ONNX models the way the inference loop uses them.

Loads every *.onnx file in a directory, builds a random input that matches each
model's declared input shape (dynamic dimensions are filled from --batch and
--window), and times one "tick", meaning one forward pass of every model in turn.
Reports load time, p50, p95 and max tick latency, and the process peak RSS.

Run it on the current host first, then on the Pi, and compare. The Phase 2
acceptance threshold is a p95 tick under 10 s with peak RSS well under the
iems-inference MemoryMax.

    python3 bench_onnx.py --models /srv/iems/models/current --ticks 50 --threads 2
    python3 bench_onnx.py --models ./models --json bench_results/pi3.json
"""
from __future__ import annotations

import argparse
import json
import platform
import resource
import statistics
import sys
import time
from pathlib import Path


def peak_rss_mb() -> float:
    ru = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return ru / (1024 * 1024) if sys.platform == "darwin" else ru / 1024


def concrete_shape(shape, batch: int, window: int) -> list[int]:
    out = []
    for i, d in enumerate(shape):
        if isinstance(d, int) and d > 0:
            out.append(d)
        elif i == 0:
            out.append(batch)
        else:
            out.append(window)
    return out


NP_TYPES = {
    "tensor(float)": "float32",
    "tensor(double)": "float64",
    "tensor(int64)": "int64",
    "tensor(int32)": "int32",
}


def main() -> int:
    ap = argparse.ArgumentParser(description="Benchmark NILM ONNX models")
    ap.add_argument("--models", required=True, type=Path, help="directory containing *.onnx")
    ap.add_argument("--pattern", default="*.onnx", help="glob, default *.onnx")
    ap.add_argument("--ticks", type=int, default=30)
    ap.add_argument("--warmup", type=int, default=3)
    ap.add_argument("--threads", type=int, default=2, help="intra-op threads per session")
    ap.add_argument("--batch", type=int, default=1, help="value for a dynamic batch dimension")
    ap.add_argument("--window", type=int, default=720, help="value for other dynamic dimensions")
    ap.add_argument("--json", type=Path, help="write results to this file")
    args = ap.parse_args()

    import numpy as np
    import onnxruntime as ort

    files = sorted(p for p in args.models.glob(args.pattern) if ".bak" not in p.name)
    if not files:
        print(f"no models matching {args.pattern} in {args.models}", file=sys.stderr)
        return 2

    so = ort.SessionOptions()
    so.intra_op_num_threads = args.threads
    so.inter_op_num_threads = 1
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    rng = np.random.default_rng(0)
    sessions = []
    t_load = time.perf_counter()
    for f in files:
        sess = ort.InferenceSession(str(f), so, providers=["CPUExecutionProvider"])
        feeds = {}
        for inp in sess.get_inputs():
            shape = concrete_shape(inp.shape, args.batch, args.window)
            dtype = NP_TYPES.get(inp.type, "float32")
            feeds[inp.name] = rng.standard_normal(shape).astype(dtype)
        sessions.append((f.name, sess, feeds))
        print(f"loaded {f.name}: inputs " + ", ".join(
            f"{i.name}{concrete_shape(i.shape, args.batch, args.window)}" for i in sess.get_inputs()))
    load_s = time.perf_counter() - t_load

    for _ in range(args.warmup):
        for _, sess, feeds in sessions:
            sess.run(None, feeds)

    ticks, per_model = [], {name: [] for name, _, _ in sessions}
    for _ in range(args.ticks):
        t0 = time.perf_counter()
        for name, sess, feeds in sessions:
            m0 = time.perf_counter()
            sess.run(None, feeds)
            per_model[name].append(time.perf_counter() - m0)
        ticks.append(time.perf_counter() - t0)

    def q(xs, p):
        xs = sorted(xs)
        return xs[min(len(xs) - 1, int(round(p * (len(xs) - 1))))]

    result = {
        "host": platform.node(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "onnxruntime": ort.__version__,
        "threads": args.threads,
        "models": [n for n, _, _ in sessions],
        "load_s": round(load_s, 3),
        "tick_p50_ms": round(statistics.median(ticks) * 1000, 2),
        "tick_p95_ms": round(q(ticks, 0.95) * 1000, 2),
        "tick_max_ms": round(max(ticks) * 1000, 2),
        "per_model_p50_ms": {n: round(statistics.median(v) * 1000, 2) for n, v in per_model.items()},
        "peak_rss_mb": round(peak_rss_mb(), 1),
    }
    print(json.dumps(result, indent=2))
    if args.json:
        args.json.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
