import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
import egauge_mqtt_producer as p  # noqa: E402


def test_format_ts_is_utc_without_z():
    assert p.format_ts(0) == "1970-01-01 00:00:00.000000"
    assert not p.format_ts(1_700_000_000.5).endswith("Z")


def test_build_messages_matches_energy_readings_schema():
    resp = {"ts": "1700000000.0", "registers": [
        {"name": "Panel1", "type": "P", "rate": 412.7},
        {"name": "Grid", "type": "P", "rate": "-35"},
        {"name": "Odd"},
    ]}
    rows = p.build_messages(resp, "egauge-site")
    assert [r["nm"] for r in rows] == ["Panel1", "Grid", "Odd"]
    for r in rows:
        assert set(r) == {"ts", "dev", "nm", "tp", "w", "kwh"}
        assert isinstance(r["w"], float) and len(r["tp"]) == 1
    assert rows[1]["w"] == -35.0
    assert rows[2]["w"] == 0.0 and rows[2]["tp"] == "P"


def test_spool_replays_in_order_and_keeps_rest_on_failure(tmp_path: Path):
    s = p.Spool(tmp_path / "s.spool", max_bytes=10_000)
    s.append([{"i": i} for i in range(5)])
    got = []

    def flaky(line):
        if len(got) == 3:
            return False
        got.append(json.loads(line)["i"])
        return True

    assert s.drain(flaky) == 3
    assert got == [0, 1, 2]
    assert s.drain(lambda line: got.append(json.loads(line)["i"]) or True) == 2
    assert got == [0, 1, 2, 3, 4]
    assert s.path.read_text() == ""


def test_spool_cap_drops_oldest(tmp_path: Path):
    s = p.Spool(tmp_path / "s.spool", max_bytes=200)
    s.append([{"i": i} for i in range(40)])
    kept = [json.loads(l)["i"] for l in s.path.read_text().splitlines()]
    assert kept[-1] == 39
    assert kept[0] > 0
    assert kept == sorted(kept)
