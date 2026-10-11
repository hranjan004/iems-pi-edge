#!/usr/bin/env python3
"""Build manifest.json for a promoted model set, the file pull_models.sh verifies.

    python3 make_manifest.py --dir out/v13 --version v13 --parent v12 \
        --eval out/v13/eval.json

Every file in the directory is hashed. For each .onnx file the input feature count
is read from the model itself, and if a matching panel{n}_norm_bilstm.json exists its
declared feature count must agree, otherwise the manifest is not written.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def onnx_features(path: Path) -> int:
    import onnxruntime as ort

    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    last = sess.get_inputs()[0].shape[-1]
    if not isinstance(last, int):
        raise ValueError(f"{path.name}: feature dimension is dynamic ({last})")
    return last


def declared_features(model_dir: Path, onnx_name: str) -> int | None:
    m = re.search(r"panel(\d)", onnx_name)
    if not m:
        return None
    meta = model_dir / f"panel{m.group(1)}_norm_bilstm.json"
    if not meta.exists():
        return None
    data = json.loads(meta.read_text())
    feats = data.get("features")
    return len(feats) if isinstance(feats, list) else data.get("n_features")


def main() -> int:
    ap = argparse.ArgumentParser(description="Build a model set manifest")
    ap.add_argument("--dir", required=True, type=Path)
    ap.add_argument("--version", required=True)
    ap.add_argument("--parent")
    ap.add_argument("--eval", type=Path, help="evaluation summary JSON to embed")
    args = ap.parse_args()

    if not re.fullmatch(r"v\d+", args.version):
        sys.exit("version must look like v13")

    files, errors = [], []
    for p in sorted(args.dir.iterdir()):
        if p.name == "manifest.json" or not p.is_file():
            continue
        entry = {"name": p.name, "sha256": sha256(p)}
        if p.suffix == ".onnx":
            n = onnx_features(p)
            want = declared_features(args.dir, p.name)
            if want is not None and want != n:
                errors.append(f"{p.name}: model has {n} features, metadata declares {want}")
            entry["n_features"] = n
        files.append(entry)

    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1

    manifest = {
        "version": args.version,
        "created_utc": datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S"),
        "parent": args.parent,
        "files": files,
    }
    if args.eval:
        manifest["evaluation"] = json.loads(args.eval.read_text())
    (args.dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(f"wrote manifest for {args.version} with {len(files)} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
