"""Shared fixtures for the GX10 tests.

The GX10 modules live in folders with dashes (llm-bridge) and are run as
scripts, so they are loaded by path rather than imported as packages.
Run from the repo root:  python3 -m pytest -q gx10/tests
"""
from __future__ import annotations

import csv
import gzip
import importlib.util
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

GX10 = Path(__file__).resolve().parents[1]
REPO = GX10.parent

CHANNELS = {
    "Panel1 (HVAC)": -200.0, "Panel2 (H2O)": -150.0, "Panel3 (Kitchen)": -400.0,
    "Shop": 10.0, "Grid Power": 760.0, "Generac Power": 0.0, "VrmsA": 121.0,
    "VrmsB": 121.4, "F1": 60.0, "I11": 0.8, "I12": 0.8, "I21": 0.6, "I22": 0.6,
    "I31": 1.7, "I32": 1.7, "Current on Utility Tie": 3.2,
}


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="session")
def rp():
    os.environ.setdefault("DRY_RUN", "1")
    return load_module("replay_producer", GX10 / "replay" / "replay_producer.py")


@pytest.fixture(scope="session")
def bridge():
    return load_module("ollama_bridge", GX10 / "llm-bridge" / "ollama_bridge.py")


def write_day(path: Path, start: datetime, seconds: int, step: int, offset_w: float = 0.0):
    """One export day file in the pat_export_remote.sh format (ts, channel, w)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["ts", "channel", "w"])
        for k in range(0, seconds, step):
            t = (start + timedelta(seconds=k)).strftime("%Y-%m-%d %H:%M:%S")
            for ch, v in CHANNELS.items():
                w.writerow([t, ch, v + (offset_w if ch.startswith("Panel") else 0.0) + k * 0.001])


def write_solar(path: Path, start: datetime, rows: int, step: int = 5):
    with gzip.open(path, "wt", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["ts", "pv_power", "battery_power", "battery_soc", "grid_power",
                    "load_power", "device_mode"])
        for k in range(rows):
            t = (start + timedelta(seconds=k * step)).strftime("%Y-%m-%d %H:%M:%S")
            w.writerow([t, 1000 + k, -20, 90, -200, 800, "Solar first"])


@pytest.fixture()
def export_dir(tmp_path: Path) -> Path:
    """A tiny export: two 6 s days, one 1 s hour, solar rows, in the real layout."""
    d0 = datetime(2026, 10, 7, tzinfo=timezone.utc)
    write_day(tmp_path / "egauge_6s" / "2026-10-07.csv.gz", d0, 600, 6)
    write_day(tmp_path / "egauge_6s" / "2026-10-08.csv.gz", d0 + timedelta(days=1), 600, 6)
    write_day(tmp_path / "egauge_1s" / "2026-10-07.csv.gz", d0, 3600, 1)
    write_solar(tmp_path / "solar.csv.gz", datetime(2026, 9, 29, tzinfo=timezone.utc), 2 * 17280)
    return tmp_path
