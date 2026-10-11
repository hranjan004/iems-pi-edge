"""build_dataset.py writes the exact shapes the training code reads."""
from __future__ import annotations

import subprocess
import sys
from datetime import datetime, timezone

import pytest

pd = pytest.importorskip("pandas")
pytest.importorskip("pyarrow")

from conftest import GX10, CHANNELS, write_day


def run(*args):
    return subprocess.run([sys.executable, str(GX10 / "scripts" / "build_dataset.py"), *args],
                          capture_output=True, text=True, check=True)


def test_export_becomes_long_parquet(export_dir, tmp_path):
    out = tmp_path / "out"
    run("--export", str(export_dir), "--out", str(out))
    d = pd.read_parquet(out / "egauge_gx10.parquet")
    assert list(d.columns) == ["ts", "channel", "w"]          # train_rolling.py reads these
    assert set(d["channel"].astype(str)) == set(CHANNELS)
    assert d["ts"].is_monotonic_increasing
    assert not d.duplicated(["ts", "channel"]).any()
    s = pd.read_parquet(out / "solar_gx10.parquet")
    assert s.index.name == "ts" and "pv_power" in s.columns  # solar_features.solar_frame reads this


def test_export_wins_over_archive_on_collision(export_dir, tmp_path):
    t0 = pd.Timestamp("2026-10-07 00:00:00")
    arc = pd.DataFrame({"ts": [t0, pd.Timestamp("2026-03-01")],
                        "channel": ["Shop", "Shop"], "w": [-999.0, 5.0]})
    arc_path = tmp_path / "archive.parquet"
    arc.to_parquet(arc_path)
    out = tmp_path / "out"
    run("--export", str(export_dir), "--archive", str(arc_path), "--out", str(out))
    d = pd.read_parquet(out / "egauge_gx10.parquet")
    shop = d[d["channel"].astype(str) == "Shop"].set_index("ts")["w"]
    assert shop.loc[t0] != -999.0                              # newer export read kept
    assert shop.loc[pd.Timestamp("2026-03-01")] == 5.0         # older history prepended


def test_empty_day_files_are_ignored(export_dir, tmp_path):
    empty = export_dir / "egauge_6s" / "2026-10-09.csv.gz"
    write_day(empty, datetime(2026, 10, 9, tzinfo=timezone.utc), 0, 6)
    out = tmp_path / "out"
    r = run("--export", str(export_dir), "--out", str(out))
    assert "3 days" in r.stdout
